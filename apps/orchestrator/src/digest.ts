/**
 * Morning digest: one compact Slack message every morning (configurable PT
 * hour via the "digestHourPt" setting, default 8am) with yesterday's numbers,
 * what went live this morning, what auto-paused, and pending decisions.
 * Scheduled from the main.ts tick like the weekly healthcheck; also sent on
 * demand via POST /api/digest (→ /adops digest).
 */
import { loadVerticals } from "./verticals.js";
import { familyOf } from "./family.js";
import {
  listRuns,
  listCreatives,
  listHookTestsByStatus,
  getSetting,
  setSetting,
} from "./db.js";
import { getCampaignInsights, getAdInsights, getObjectName } from "./meta.js";
import { nowClockInTimeZone, todayInTimeZone, PT } from "./schedule.js";
import { postSlack } from "./slack.js";
import { scaleDigestLine } from "./guardrails.js";
import { followupDigestLines } from "./followups.js";

export const DEFAULT_DIGEST_HOUR_PT = 8;

const DAY_MS = 24 * 60 * 60 * 1000;

const money = (n: number): string => `$${n.toFixed(2)}`;
const cpaOf = (spend: number, purchases: number): string =>
  purchases > 0 ? money(spend / purchases) : "—";

/** PT calendar date (YYYY-MM-DD) of an ISO instant. */
function ptDate(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PT,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function fmtPtShort(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: PT,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** "ugc-selfie ×2, spouse" style summary of a run's ad angles. */
function angleMix(creatives: { angle: string | null }[]): string {
  const counts = new Map<string, number>();
  for (const c of creatives) {
    const key = c.angle ?? "untagged";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([angle, n]) => (n > 1 ? `${angle} ×${n}` : angle))
    .join(", ");
}

export async function buildDigestText(): Promise<string> {
  const verticals = loadVerticals();
  const runs = listRuns(50);
  const now = Date.now();
  const today = todayInTimeZone(PT);

  // Automated campaigns from the last week that could have numbers.
  const weekRuns = runs.filter(
    (r) =>
      r.meta_campaign_id &&
      now - r.created_at < 7 * DAY_MS &&
      r.status !== "error" &&
      r.status !== "cancelled",
  );

  // --- Spend/purchases: yesterday + flight-to-date, per campaign summed ---
  let ySpend = 0;
  let yPurchases = 0;
  let fSpend = 0;
  let fPurchases = 0;
  const byFamily = new Map<string, { ySpend: number; yPurchases: number; fSpend: number; fPurchases: number }>();
  for (const run of weekRuns) {
    try {
      const y = await getCampaignInsights(run.meta_campaign_id!, "yesterday");
      const f = await getCampaignInsights(run.meta_campaign_id!, "maximum");
      const ys = y?.spend ?? 0;
      const yp = y?.purchases ?? 0;
      const fs = f?.spend ?? 0;
      const fp = f?.purchases ?? 0;
      ySpend += ys;
      yPurchases += yp;
      fSpend += fs;
      fPurchases += fp;
      const vertical = verticals.find((v) => v.id === run.vertical_id);
      const fam = vertical ? familyOf(vertical) : run.vertical_id;
      const cur = byFamily.get(fam) ?? { ySpend: 0, yPurchases: 0, fSpend: 0, fPurchases: 0 };
      cur.ySpend += ys;
      cur.yPurchases += yp;
      cur.fSpend += fs;
      cur.fPurchases += fp;
      byFamily.set(fam, cur);
    } catch (error) {
      console.warn(`Digest insights failed for campaign ${run.meta_campaign_id}`, error);
    }
  }

  // --- Per-angle flight-to-date (flights are short, lifetime ≈ the flight) ---
  const byAngle = new Map<string, { spend: number; purchases: number }>();
  for (const run of weekRuns) {
    for (const c of listCreatives(run.id)) {
      if (!c.ad_id || c.status === "killed") continue;
      try {
        const m = await getAdInsights(c.ad_id);
        if (m.spend === 0 && m.purchases === 0) continue;
        const key = `${run.vertical_id}/${c.angle ?? "untagged"}`;
        const cur = byAngle.get(key) ?? { spend: 0, purchases: 0 };
        cur.spend += m.spend;
        cur.purchases += m.purchases;
        byAngle.set(key, cur);
      } catch {
        // no insights yet (ad hasn't delivered) — skip quietly
      }
    }
  }

  const lines: string[] = [];
  const dateLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: PT,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date());
  lines.push(`:sunrise: *Morning digest — ${dateLabel}*`);

  // 1. Numbers
  if (ySpend === 0 && fSpend === 0) {
    lines.push("*Yesterday:* no spend — automated campaigns haven't started delivering yet.");
  } else {
    lines.push(`*Yesterday:* *${money(ySpend)}* · *${yPurchases}* purchase(s) · CPA *${cpaOf(ySpend, yPurchases)}*`);
    lines.push(`*Flight-to-date:* *${money(fSpend)}* · *${fPurchases}* purchase(s) · CPA *${cpaOf(fSpend, fPurchases)}*`);
    if (byFamily.size > 1) {
      for (const [fam, t] of [...byFamily.entries()].sort()) {
        lines.push(
          `  _${fam}_ yesterday ${money(t.ySpend)} / ${t.yPurchases}p · flight ${money(t.fSpend)} / ${t.fPurchases}p / ${cpaOf(t.fSpend, t.fPurchases)}`,
        );
      }
    }
    const angleLine = [...byAngle.entries()]
      .sort((a, b) => b[1].spend - a[1].spend)
      .map(([angle, t]) => `\`${angle}\` ${money(t.spend)} / ${t.purchases}p / ${cpaOf(t.spend, t.purchases)}`)
      .join(" · ");
    if (angleLine) lines.push(`*By angle (flight):* ${angleLine}`);
  }
  // Budget-ladder status from the last guardrail pass (e.g. held at $100 and why).
  const ladderLine = scaleDigestLine();
  if (ladderLine) lines.push(ladderLine);

  // 2. What went live this morning
  const liveToday = runs.filter(
    (r) => r.go_live_at && ptDate(r.go_live_at) === today && (r.status === "live" || r.status === "completed"),
  );
  const failedRecently = runs.filter((r) => r.status === "error" && now - r.created_at < DAY_MS);
  if (liveToday.length > 0) {
    for (const run of liveToday) {
      const ads = listCreatives(run.id).filter((c) => c.ad_id && c.status !== "killed");
      const name = run.meta_campaign_id ? await getObjectName(run.meta_campaign_id) : null;
      lines.push(
        `*This morning:* :rocket: *${name ?? run.vertical_id}* went live — *${ads.length}* ad(s): ${angleMix(ads)}`,
      );
    }
  } else if (failedRecently.length > 0) {
    const failed = failedRecently[0]!;
    lines.push(`*This morning:* :x: run \`${failed.id}\` *FAILED* — ${failed.error ?? "unknown error"}`);
  } else {
    const next = runs.find(
      (r) => r.status === "scheduled" && r.go_live_at && new Date(r.go_live_at).getTime() > now,
    );
    if (next) {
      const ads = listCreatives(next.id).filter((c) => c.ad_id && c.status !== "killed");
      const paused = ads.filter((c) => c.status === "paused").length;
      lines.push(
        `*This morning:* nothing went live — next go-live *${fmtPtShort(next.go_live_at!)}* PT with *${ads.length}* ad(s)` +
          (paused > 0 ? ` (${paused} paused)` : "") +
          `: ${angleMix(ads)}`,
      );
    } else {
      lines.push("*This morning:* nothing went live and nothing is scheduled.");
    }
  }

  // 3. Auto-paused (flight ended) in the last ~36h + killed ads in recent runs
  const flightEnded: string[] = [];
  for (const run of runs) {
    if (run.status !== "completed" || !run.go_live_at) continue;
    const vertical = verticals.find((v) => v.id === run.vertical_id);
    const flightDays = vertical?.schedule.flightDays ?? 3;
    const endedAt = new Date(run.go_live_at).getTime() + flightDays * DAY_MS;
    if (now - endedAt < 1.5 * DAY_MS && endedAt <= now) {
      flightEnded.push(`${vertical?.label ?? run.vertical_id} \`${run.id}\` (${flightDays}-day flight done)`);
    }
  }
  if (flightEnded.length > 0) lines.push(`*Auto-paused:* ${flightEnded.join(" · ")}`);
  const killed = runs
    .filter((r) => now - r.created_at < 2 * DAY_MS)
    .flatMap((r) => listCreatives(r.id))
    .filter((c) => c.status === "killed" && c.ad_name);
  if (killed.length > 0) lines.push(`*Killed:* ${killed.map((c) => c.ad_name).join(", ")}`);

  // 4. Pending decisions
  const pendingHooks = listHookTestsByStatus("pending");
  const inReview = runs.filter(
    (r) => r.status === "scheduled" && r.go_live_at && new Date(r.go_live_at).getTime() > now,
  );
  const waits: string[] = [];
  if (pendingHooks.length > 0) {
    waits.push(`*${pendingHooks.length}* hook test(s) awaiting approve/reject`);
  }
  for (const run of inReview) {
    const ads = listCreatives(run.id).filter((c) => c.ad_id && c.status !== "killed").length;
    waits.push(`*${ads}* ad(s) in review before go-live ${fmtPtShort(run.go_live_at!)} PT`);
  }
  lines.push(waits.length > 0 ? `*Waiting on you:* ${waits.join(" · ")}` : "*Waiting on you:* nothing — all clear.");
  lines.push(...followupDigestLines());

  return lines.join("\n");
}

/** Build the digest and post it to the Slack channel; returns the text. */
export async function sendDigest(): Promise<string> {
  const text = await buildDigestText();
  await postSlack("Morning digest", [{ type: "section", text: { type: "mrkdwn", text } }]);
  return text;
}

let digestSending = false;

/**
 * Called from the 30s scheduler tick. Fires once per PT day, the first tick
 * at/after the configured hour (so a sleeping laptop still sends on wake).
 */
export function maybeSendMorningDigest(): void {
  if (digestSending) return;
  const today = todayInTimeZone(PT);
  const last = getSetting("lastDigestDate");
  if (last === undefined) {
    // First boot with this feature: don't blast a digest at whatever time the
    // service happened to restart — start with tomorrow morning's.
    setSetting("lastDigestDate", today);
    return;
  }
  if (last === today) return;
  const hour = Number(getSetting("digestHourPt") ?? DEFAULT_DIGEST_HOUR_PT);
  if (nowClockInTimeZone(PT).hour < hour) return;
  digestSending = true;
  setSetting("lastDigestDate", today);
  void sendDigest()
    .catch((error) => console.error("Morning digest failed:", error))
    .finally(() => {
      digestSending = false;
    });
}
