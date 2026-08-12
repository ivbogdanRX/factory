/**
 * Guardrail engine: automated kill/extend rules for live flights.
 *
 * Data sources are deliberately split:
 * - SPEND comes from Meta insights (RedTrack never knows true ad spend).
 * - CONVERSIONS / REVENUE come from RedTrack (the user doesn't trust Meta's
 *   conversion attribution). Attribution back to Meta ids rides on the sub
 *   params in the ad links: sub1={{ad.id}}, sub3={{campaign.id}}.
 *
 * Rules (thresholds per vertical in config/verticals.yaml → guardrails):
 * - A (ad kill): Meta spend ≥ adKillSpendUsd and 0 RedTrack conversions →
 *   pause that single ad.
 * - B (campaign CPA): Meta spend ≥ campaignGuardMinSpendUsd and RedTrack CPA
 *   (Meta spend / RedTrack conversions) > maxCpaUsd → pause the campaign.
 * - C (winner extension, in runner.ts completeExpiredRuns): at flight end,
 *   RedTrack CPA < extendUnderCpaUsd → extend the flight 1 day, at most
 *   maxExtensionDays total.
 * - D (budget ladder): campaigns launch at the first step (config
 *   cboDailyBudgetCents). Once flight-to-date Meta spend ≥ scaleMinSpendUsd
 *   and RedTrack revenue / Meta spend ≥ scaleAtRoas, the campaign daily
 *   budget climbs one scaleSteps rung — at most one step per 24h. A manual
 *   budget change off the ladder disarms autoscaling for that campaign
 *   (alerted once). An extended flight (Rule C) keeps its scaled budget.
 *
 * Every action is Slack-notified with the triggering numbers and recorded in
 * guardrail_events. An event row is also the dedupe: one (rule, target) fires
 * once ever, so a manual resume after an automated pause is respected — the
 * engine never re-pauses for the same condition.
 */
import Database from "better-sqlite3";
import { join } from "node:path";
import { env, DATA_DIR } from "./env.js";
import { getVertical, type Vertical } from "./verticals.js";
import { listRunsByStatus, listCreatives, updateRun, updateCreative, type RunRow } from "./db.js";
import {
  getCampaignInsights,
  getAdInsights,
  setObjectStatus,
  getCampaignDailyBudgetCents,
  setCampaignDailyBudgetCents,
} from "./meta.js";
import { getStatsBySub, redtrackConfigured, redtrackCampaignIdFromUrl } from "./redtrack.js";
import { postSlack } from "./slack.js";
import { maybePushSnapshot } from "./push.js";
import { PT, todayInTimeZone } from "./schedule.js";

const EVAL_INTERVAL_MS = 15 * 60 * 1000;

// Own connection to the shared SQLite file (WAL mode makes this safe). Keeps
// the guardrail schema self-contained instead of spreading into db.ts.
const gdb = new Database(join(DATA_DIR, "ad-factory.db"));
gdb.pragma("journal_mode = WAL");
gdb.exec(`
CREATE TABLE IF NOT EXISTS guardrail_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  rule TEXT NOT NULL,
  target TEXT NOT NULL,
  metrics TEXT NOT NULL,
  action TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_guardrail_events_rule_target ON guardrail_events (rule, target);
`);

type GuardrailRule = "ad-kill" | "campaign-cpa" | "flight-extend" | "flight-scale" | "scale-standdown";

function hasEvent(rule: GuardrailRule, target: string): boolean {
  return (
    gdb.prepare(`SELECT 1 FROM guardrail_events WHERE rule = ? AND target = ? LIMIT 1`).get(rule, target) !==
    undefined
  );
}

function recordEvent(rule: GuardrailRule, target: string, metrics: Record<string, unknown>, action: string): void {
  gdb
    .prepare(`INSERT INTO guardrail_events (created_at, rule, target, metrics, action) VALUES (?, ?, ?, ?, ?)`)
    .run(Date.now(), rule, target, JSON.stringify(metrics), action);
}

/** Days already added to a run's flight by Rule C. */
export function flightExtensionDays(runId: string): number {
  const row = gdb
    .prepare(`SELECT COUNT(*) AS n FROM guardrail_events WHERE rule = 'flight-extend' AND target = ?`)
    .get(runId) as { n: number };
  return row.n;
}

/** YYYY-MM-DD of an instant in PT (RedTrack account timezone is PT too). */
function ptDate(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PT,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

interface FlightNumbers {
  metaSpend: number;
  rtConversions: number;
  rtRevenue: number;
  /** null means "no conversions yet" (CPA is effectively infinite). */
  rtCpa: number | null;
}

/** Meta spend + RedTrack conversions for one campaign over its flight. */
async function campaignFlightNumbers(run: RunRow, vertical: Vertical): Promise<FlightNumbers | null> {
  if (!run.meta_campaign_id || !run.go_live_at) return null;
  const rtCampaignId = redtrackCampaignIdFromUrl(vertical.meta.adSettings.websiteUrl);
  if (!rtCampaignId) return null;
  // Campaigns are created fresh per day, so Meta "maximum" = the flight.
  // Meta returning no rows just means nothing served yet ($0 spend); a thrown
  // error means we don't know the spend, so the whole check is skipped.
  let metaSpend: number;
  try {
    metaSpend = (await getCampaignInsights(run.meta_campaign_id, "maximum"))?.spend ?? 0;
  } catch (error) {
    console.warn(`Guardrails: Meta campaign insights failed for ${run.meta_campaign_id}`, error);
    return null;
  }
  const stats = await getStatsBySub({
    rtCampaignId,
    group: "sub3",
    dateFrom: ptDate(new Date(run.go_live_at)),
    dateTo: todayInTimeZone(PT),
  });
  if (stats === null) return null; // RedTrack down — skip, never assume 0 conversions
  const rt = stats.get(run.meta_campaign_id) ?? { clicks: 0, conversions: 0, revenue: 0 };
  return {
    metaSpend,
    rtConversions: rt.conversions,
    rtRevenue: rt.revenue,
    rtCpa: rt.conversions > 0 ? metaSpend / rt.conversions : null,
  };
}

// ---------------------------------------------------------------------------
// Rule D — budget ladder (pure decision logic, unit-testable)
// ---------------------------------------------------------------------------

const SCALE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** Budgets are whole dollars; tolerate sub-cent float noise when comparing. */
const BUDGET_EPSILON_USD = 0.5;

export interface ScaleDecisionInput {
  /** Flight-to-date Meta spend (USD). */
  metaSpendUsd: number;
  /** Flight-to-date RedTrack revenue (USD). */
  rtRevenueUsd: number;
  /** Current campaign daily budget read from Meta (USD). */
  currentBudgetUsd: number;
  /**
   * Budgets the engine considers "its own": the last step it set, or — before
   * any scaling — the launch budget and every ladder step (so a campaign
   * launched under an older config isn't treated as manually overridden).
   */
  allowedBudgetsUsd: number[];
  /** Ladder in USD/day, ascending. */
  stepsUsd: number[];
  minSpendUsd: number;
  minRoas: number;
  /** When the engine last scaled this campaign; null = never. */
  lastScaleAtMs: number | null;
  nowMs: number;
}

export type ScaleDecision =
  | { action: "none"; reason: string }
  | { action: "standdown"; reason: string }
  | { action: "scale"; fromUsd: number; toUsd: number; roas: number };

export function decideScale(input: ScaleDecisionInput): ScaleDecision {
  const { metaSpendUsd, rtRevenueUsd, currentBudgetUsd, allowedBudgetsUsd, stepsUsd, minSpendUsd, minRoas, lastScaleAtMs, nowMs } = input;

  if (!allowedBudgetsUsd.some((b) => Math.abs(b - currentBudgetUsd) < BUDGET_EPSILON_USD)) {
    return {
      action: "standdown",
      reason: `current budget ${fmtUsd(currentBudgetUsd)} doesn't match the ladder — manual change assumed`,
    };
  }
  const nextStep = stepsUsd.find((s) => s > currentBudgetUsd + BUDGET_EPSILON_USD);
  if (nextStep === undefined) {
    return { action: "none", reason: `already at the top step (${fmtUsd(currentBudgetUsd)}/day)` };
  }
  if (lastScaleAtMs !== null && nowMs - lastScaleAtMs < SCALE_COOLDOWN_MS) {
    const hoursLeft = Math.ceil((SCALE_COOLDOWN_MS - (nowMs - lastScaleAtMs)) / 3_600_000);
    return { action: "none", reason: `scaled within the last 24h — next step possible in ~${hoursLeft}h` };
  }
  if (metaSpendUsd < minSpendUsd) {
    return { action: "none", reason: `evidence gate: spend ${fmtUsd(metaSpendUsd)} < ${fmtUsd(minSpendUsd)}` };
  }
  const roas = metaSpendUsd > 0 ? rtRevenueUsd / metaSpendUsd : 0;
  if (roas < minRoas) {
    return { action: "none", reason: `ROAS ${roas.toFixed(2)} below the ${minRoas.toFixed(2)} scale target` };
  }
  return { action: "scale", fromUsd: currentBudgetUsd, toUsd: nextStep, roas };
}

/** Latest Rule D scale event for a run (step we last set + when). */
function lastScaleEvent(runId: string): { toUsd: number; atMs: number } | null {
  const row = gdb
    .prepare(`SELECT created_at, metrics FROM guardrail_events WHERE rule = 'flight-scale' AND target = ? ORDER BY created_at DESC LIMIT 1`)
    .get(runId) as { created_at: number; metrics: string } | undefined;
  if (!row) return null;
  try {
    const metrics = JSON.parse(row.metrics) as { toUsd?: number };
    return typeof metrics.toUsd === "number" ? { toUsd: metrics.toUsd, atMs: row.created_at } : null;
  } catch {
    return null;
  }
}

/** Last ladder status per run, for the morning digest. */
const scaleStatus = new Map<string, string>();
/** One-line budget-ladder status for the digest; null when nothing is live. */
export function scaleDigestLine(): string | null {
  if (scaleStatus.size === 0) return null;
  return `*Budget ladder:* ${[...scaleStatus.values()].join(" · ")}`;
}

/** Rule D evaluation for one live run (campaign numbers already fetched). */
async function evaluateScaleRule(run: RunRow, vertical: Vertical, campaign: FlightNumbers): Promise<void> {
  const g = vertical.guardrails;
  if (!run.meta_campaign_id || g.scaleSteps.length === 0) return;
  if (hasEvent("scale-standdown", run.id)) return; // manual override — disarmed

  let currentBudgetUsd: number;
  try {
    const cents = await getCampaignDailyBudgetCents(run.meta_campaign_id);
    if (cents === null) return; // no CBO budget field — nothing to scale
    currentBudgetUsd = cents / 100;
  } catch (error) {
    console.warn(`Guardrails: budget read failed for ${run.meta_campaign_id}`, error);
    return;
  }

  const last = lastScaleEvent(run.id);
  const launchUsd = vertical.meta.cboDailyBudgetCents / 100;
  const decision = decideScale({
    metaSpendUsd: campaign.metaSpend,
    rtRevenueUsd: campaign.rtRevenue,
    currentBudgetUsd,
    allowedBudgetsUsd: last ? [last.toUsd] : [launchUsd, ...g.scaleSteps],
    stepsUsd: g.scaleSteps,
    minSpendUsd: g.scaleMinSpendUsd,
    minRoas: g.scaleAtRoas,
    lastScaleAtMs: last?.atMs ?? null,
    nowMs: Date.now(),
  });

  const label = `${vertical.label} \`${run.meta_campaign_id}\``;
  if (decision.action === "standdown") {
    recordEvent(
      "scale-standdown",
      run.id,
      { currentBudgetUsd, expectedUsd: last?.toUsd ?? launchUsd, steps: g.scaleSteps },
      "autoscaling disarmed",
    );
    scaleStatus.set(run.id, `${vertical.label} at ${fmtUsd(currentBudgetUsd)}/day (manual — autoscaling off)`);
    void postSlack(
      `:hand: *Guardrail — autoscaling disarmed* (${label})\n` +
        `> ${decision.reason} (engine expected ${fmtUsd(last?.toUsd ?? launchUsd)}/day).\n` +
        `> Your budget stays as-is; the scale ladder won't touch this campaign again. Kill/pause rules still apply.`,
    );
    return;
  }

  if (decision.action === "scale") {
    const roasText = decision.roas.toFixed(2);
    try {
      await setCampaignDailyBudgetCents(run.meta_campaign_id, Math.round(decision.toUsd * 100));
      recordEvent(
        "flight-scale",
        run.id,
        { fromUsd: decision.fromUsd, toUsd: decision.toUsd, metaSpend: campaign.metaSpend, rtRevenue: campaign.rtRevenue, roas: decision.roas },
        `scaled budget ${fmtUsd(decision.fromUsd)} → ${fmtUsd(decision.toUsd)}`,
      );
      scaleStatus.set(run.id, `${vertical.label} scaled to ${fmtUsd(decision.toUsd)}/day (ROAS ${roasText})`);
      void postSlack(
        `:chart_with_upwards_trend: *Guardrail — budget scaled* (${label})\n` +
          `> Meta spend ${fmtUsd(campaign.metaSpend)}, RedTrack revenue ${fmtUsd(campaign.rtRevenue)} → ROAS ${roasText} ≥ ${g.scaleAtRoas.toFixed(2)}.\n` +
          `> Daily budget ${fmtUsd(decision.fromUsd)} → *${fmtUsd(decision.toUsd)}*. Next step (if any) in 24h+, same evidence bar.`,
      );
      void maybePushSnapshot(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void postSlack(
        `:rotating_light: Guardrail tried to scale ${label} to ${fmtUsd(decision.toUsd)}/day (ROAS ${roasText}) but Meta refused: ${message}`,
      );
    }
    return;
  }

  scaleStatus.set(run.id, `${vertical.label} held at ${fmtUsd(currentBudgetUsd)}/day (${decision.reason})`);
}

// ---------------------------------------------------------------------------
// Rules A + B — evaluated from the scheduler tick (~15 min while live)
// ---------------------------------------------------------------------------

let lastEvalAt = 0;

/** Snapshot of the last evaluation for the glance portal (per-angle CPA). */
export interface AngleCpaEntry {
  angle: string;
  metaSpend: number;
  rtConversions: number;
  rtCpa: number | null;
}
let lastAngleCpa: { asOf: string; entries: AngleCpaEntry[] } | null = null;
export function guardrailAngleSnapshot(): { asOf: string; entries: AngleCpaEntry[] } | null {
  return lastAngleCpa;
}

/** Called every scheduler tick; internally throttled to EVAL_INTERVAL_MS. */
export async function maybeEvaluateGuardrails(): Promise<void> {
  if (Date.now() - lastEvalAt < EVAL_INTERVAL_MS) return;
  lastEvalAt = Date.now();
  if (env.dryRun || !redtrackConfigured()) return;
  try {
    await evaluateGuardrails();
  } catch (error) {
    console.warn("Guardrail evaluation failed:", error instanceof Error ? error.message : error);
  }
}

/** One full pass over live runs. Exported for the manual CLI check. */
export async function evaluateGuardrails(): Promise<void> {
  const angleAgg = new Map<string, { metaSpend: number; rtConversions: number }>();
  const liveRuns = listRunsByStatus("live");

  // Drop ladder statuses for runs that are no longer live (digest freshness).
  const liveIds = new Set(liveRuns.map((r) => r.id));
  for (const key of [...scaleStatus.keys()]) {
    if (!liveIds.has(key)) scaleStatus.delete(key);
  }

  for (const run of liveRuns) {
    const vertical = getVertical(run.vertical_id);
    if (!vertical || !vertical.guardrails.enabled) continue;
    const rtCampaignId = redtrackCampaignIdFromUrl(vertical.meta.adSettings.websiteUrl);
    if (!rtCampaignId || !run.go_live_at) continue;
    const g = vertical.guardrails;

    // ---- Rule B: campaign CPA guard (checked first — it pauses everything).
    const campaign = await campaignFlightNumbers(run, vertical);
    if (
      campaign &&
      campaign.metaSpend >= g.campaignGuardMinSpendUsd &&
      (campaign.rtCpa === null || campaign.rtCpa > g.maxCpaUsd) &&
      !hasEvent("campaign-cpa", run.id)
    ) {
      const cpaText = campaign.rtCpa === null ? "no conversions" : `CPA ${fmtUsd(campaign.rtCpa)}`;
      try {
        if (run.meta_campaign_id) await setObjectStatus(run.meta_campaign_id, "PAUSED");
        updateRun(run.id, { status: "paused", note: `Guardrail: campaign CPA guard (${cpaText})` });
        recordEvent(
          "campaign-cpa",
          run.id,
          { metaSpend: campaign.metaSpend, rtConversions: campaign.rtConversions, rtCpa: campaign.rtCpa, maxCpaUsd: g.maxCpaUsd },
          "paused campaign",
        );
        void postSlack(
          `:no_entry: *Guardrail — campaign paused* (${vertical.label}, run \`${run.id}\`)\n` +
            `> Meta spend ${fmtUsd(campaign.metaSpend)} ≥ ${fmtUsd(g.campaignGuardMinSpendUsd)} floor, ` +
            `RedTrack ${campaign.rtConversions} conversion(s) → ${cpaText}, over the ${fmtUsd(g.maxCpaUsd)} max CPA.\n` +
            `> Resume from the portal or Slack if this was wrong — the guardrail won't re-fire on this campaign.`,
        );
        void maybePushSnapshot(true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void postSlack(`:rotating_light: Guardrail tried to pause campaign for run \`${run.id}\` (${cpaText}) but Meta refused: ${message}`);
      }
      continue; // campaign handled; no point evaluating its ads
    }

    // ---- Rule D: budget ladder (campaign survived the CPA guard).
    if (campaign) {
      try {
        await evaluateScaleRule(run, vertical, campaign);
      } catch (error) {
        console.warn(`Guardrails: scale evaluation failed for run ${run.id}`, error);
      }
    }

    // ---- Rule A: per-ad kill (spend with zero conversions).
    const sub1 = await getStatsBySub({
      rtCampaignId,
      group: "sub1",
      dateFrom: ptDate(new Date(run.go_live_at)),
      dateTo: todayInTimeZone(PT),
    });
    if (sub1 === null) continue; // RedTrack down — skip this cycle

    for (const creative of listCreatives(run.id)) {
      if (!creative.ad_id) continue;
      if (creative.status === "paused" || creative.status === "killed" || creative.status === "error") continue;
      let adSpend: number;
      try {
        adSpend = (await getAdInsights(creative.ad_id)).spend;
      } catch (error) {
        console.warn(`Guardrails: Meta ad insights failed for ${creative.ad_id}`, error);
        continue;
      }
      const rtConversions = sub1.get(creative.ad_id)?.conversions ?? 0;

      if (creative.angle) {
        const agg = angleAgg.get(creative.angle) ?? { metaSpend: 0, rtConversions: 0 };
        angleAgg.set(creative.angle, { metaSpend: agg.metaSpend + adSpend, rtConversions: agg.rtConversions + rtConversions });
      }

      if (adSpend < g.adKillSpendUsd || rtConversions > 0) continue;
      if (hasEvent("ad-kill", creative.ad_id)) continue; // fired before (maybe manually resumed) — respect the override
      const label = creative.ad_name ?? creative.ad_id;
      try {
        await setObjectStatus(creative.ad_id, "PAUSED");
        updateCreative(creative.id, { status: "paused" });
        recordEvent(
          "ad-kill",
          creative.ad_id,
          { metaSpend: adSpend, rtConversions, adKillSpendUsd: g.adKillSpendUsd },
          "paused ad",
        );
        void postSlack(
          `:scissors: *Guardrail — ad paused* (${vertical.label})\n` +
            `> *${label}*: Meta spend ${fmtUsd(adSpend)} ≥ ${fmtUsd(g.adKillSpendUsd)} with *0 RedTrack conversions*.\n` +
            `> Resume it from the portal or Slack if you disagree — it won't be auto-paused again.`,
        );
        void maybePushSnapshot(true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void postSlack(`:rotating_light: Guardrail tried to pause ad *${label}* (${fmtUsd(adSpend)} spent, 0 conversions) but Meta refused: ${message}`);
      }
    }
  }

  lastAngleCpa = {
    asOf: new Date().toISOString(),
    entries: [...angleAgg.entries()].map(([angle, a]) => ({
      angle,
      metaSpend: a.metaSpend,
      rtConversions: a.rtConversions,
      rtCpa: a.rtConversions > 0 ? a.metaSpend / a.rtConversions : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Rule C — winner extension, called from runner.ts completeExpiredRuns
// ---------------------------------------------------------------------------

/**
 * At flight end: extend by one day when the RedTrack CPA is under the
 * threshold and the extension cap isn't used up. Returns true when extended
 * (the caller should then NOT pause the run this tick).
 */
export async function maybeExtendFlight(run: RunRow): Promise<boolean> {
  if (env.dryRun || !redtrackConfigured()) return false;
  const vertical = getVertical(run.vertical_id);
  if (!vertical || !vertical.guardrails.enabled) return false;
  const g = vertical.guardrails;

  const used = flightExtensionDays(run.id);
  if (used >= g.maxExtensionDays) return false;

  const campaign = await campaignFlightNumbers(run, vertical).catch(() => null);
  // No data (RedTrack/Meta down) → no extension; the normal pause proceeds.
  if (!campaign || campaign.rtCpa === null || campaign.rtCpa >= g.extendUnderCpaUsd) return false;

  recordEvent(
    "flight-extend",
    run.id,
    { metaSpend: campaign.metaSpend, rtConversions: campaign.rtConversions, rtCpa: campaign.rtCpa, extendUnderCpaUsd: g.extendUnderCpaUsd },
    "extended flight 1 day",
  );
  updateRun(run.id, { note: `Guardrail: flight extended ${used + 1} day(s) — RedTrack CPA ${fmtUsd(campaign.rtCpa)}` });
  void postSlack(
    `:trophy: *Guardrail — flight extended 1 day* (${vertical.label}, run \`${run.id}\`)\n` +
      `> RedTrack CPA ${fmtUsd(campaign.rtCpa)} beat the ${fmtUsd(g.extendUnderCpaUsd)} winner threshold ` +
      `(Meta spend ${fmtUsd(campaign.metaSpend)}, ${campaign.rtConversions} conversion(s), revenue ${fmtUsd(campaign.rtRevenue)}).\n` +
      `> Extension ${used + 1} of ${g.maxExtensionDays}.`,
  );
  return true;
}
