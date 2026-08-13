/**
 * Glance snapshot: one compact JSON blob with everything the mobile portal
 * shows. Served locally at /api/snapshot and pushed to the Vercel glance app
 * (PORTAL_PUSH_URL + PORTAL_PUSH_SECRET) so the same page works away from the
 * Mac. Perf numbers hit the Meta insights API, so they're cached for 10 min.
 */
import { existsSync } from "node:fs";
import { env } from "./env.js";
import { loadVerticals } from "./verticals.js";
import { listRuns, listCreatives, getSetting } from "./db.js";
import { nextRunAtIso } from "./schedule.js";
import { getDailyPerformance, getPerformanceReport, type PerformanceEntry } from "./perf.js";
import { angleStats, type AngleStats } from "./angles.js";
import { lastHealthReport } from "./healthcheck.js";
import { studioHealthy } from "./creative.js";
import { guardrailAngleSnapshot } from "./guardrails.js";
import { lastAccountsReport, type GlanceAccount } from "./account-health.js";
import { accountCooldownMsLeft } from "./launch-guard.js";
import { listLatestCreatives, loadOffer, prettyMacName } from "./glance-creatives.js";

const PERF_TTL_MS = 10 * 60 * 1000;
// Slightly under the 30s scheduler tick so every tick actually pushes.
const PUSH_INTERVAL_MS = 25 * 1000;

let perfCache: { at: number; entries: PerformanceEntry[] } | null = null;
let perfRefreshing = false;
let lastPushAt = 0;

async function cachedPerf(): Promise<{ asOf: string; entries: PerformanceEntry[] }> {
  const stale = !perfCache || Date.now() - perfCache.at > PERF_TTL_MS;
  if (stale && !perfRefreshing) {
    perfRefreshing = true;
    try {
      perfCache = { at: Date.now(), entries: await getPerformanceReport() };
    } catch (error) {
      console.warn("Perf refresh for snapshot failed", error);
      perfCache = perfCache ?? { at: Date.now(), entries: [] };
    } finally {
      perfRefreshing = false;
    }
  }
  return {
    asOf: new Date(perfCache?.at ?? Date.now()).toISOString(),
    entries: perfCache?.entries ?? [],
  };
}

/** Accounts as the health poller saw them, plus manual-launch cooldown info
 * so the launch picker can grey out accounts that were used recently. */
function accountsWithCooldowns(): { at: string; accounts: (GlanceAccount & { cooldownUntil: string | null })[] } | null {
  const report = lastAccountsReport();
  if (!report) return null;
  return {
    at: report.at,
    accounts: report.accounts.map((a) => {
      const msLeft = accountCooldownMsLeft(a.id);
      return { ...a, cooldownUntil: msLeft > 0 ? new Date(Date.now() + msLeft).toISOString() : null };
    }),
  };
}

export async function buildSnapshot(): Promise<Record<string, unknown>> {
  const verticals = loadVerticals();
  const perf = await cachedPerf();
  const health = lastHealthReport();

  const runs = listRuns(12).map((run) => {
    const vertical = verticals.find((v) => v.id === run.vertical_id);
    const creatives = listCreatives(run.id);
    const flightDays = vertical?.schedule.flightDays ?? 3;
    return {
      id: run.id,
      vertical: vertical?.label ?? run.vertical_id,
      status: run.status,
      createdAt: run.created_at,
      goLiveAt: run.go_live_at,
      flightEndsAt: run.go_live_at
        ? new Date(new Date(run.go_live_at).getTime() + flightDays * 86_400_000).toISOString()
        : null,
      campaignId: run.meta_campaign_id,
      adCount: creatives.filter((c) => c.ad_id).length,
      creativeCount: creatives.length,
      errorCount: creatives.filter((c) => c.status === "error").length,
      angles: [...new Set(creatives.map((c) => c.angle).filter(Boolean))] as string[],
      error: run.error,
      note: run.note,
    };
  });

  let angles: AngleStats[] = [];
  try {
    angles = verticals.flatMap((v) => angleStats(v.id, v.creativeCampaignId));
  } catch {
    // studio config unreadable — glance just skips the angle card
  }

  // Prefer account-wide numbers (include manual/cloned campaigns); fall back
  // to the automated-campaign sums before the first daily refresh lands.
  const daily = getDailyPerformance();
  const ptToday = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
  const todayRow = daily.find((d) => d.date === ptToday);
  const spendToday = todayRow ? todayRow.spend : perf.entries.reduce((sum, e) => sum + e.spend, 0);
  const purchasesToday = todayRow ? todayRow.purchases : perf.entries.reduce((sum, e) => sum + e.purchases, 0);

  const problems: string[] = [];
  if (health && !health.ok) problems.push("healthcheck failing");
  // Only recent failures demand attention; old errored runs stay in the list
  // below but shouldn't keep the hero red forever.
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const errored = runs.filter((r) => r.status === "error" && r.createdAt >= dayAgo).slice(0, 2);
  for (const r of errored) problems.push(`run ${r.id} errored`);
  const studioUp = await studioHealthy();
  if (!studioUp) problems.push("creative studio down");

  const offer = loadOffer();
  const ffmpegFull = existsSync("/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg");
  const healthChecks = (health?.checks ?? []).filter((c) => {
    if (c.name === "OpenAI credits" || c.name === "Gemini key (Veo)") return false;
    return true;
  }).map((c) => {
    if (c.name === "ffmpeg" && ffmpegFull) {
      return { ...c, status: "ok" as const, detail: "ffmpeg-full with libass (captions ready)" };
    }
    return c;
  });
  const healthOk = healthChecks.every((c) => c.status !== "fail");

  return {
    generatedAt: new Date().toISOString(),
    ok: problems.length === 0,
    problems,
    dryRun: env.dryRun,
    globalPause: getSetting("globalPause") === "1",
    skipNext: getSetting("skipNext") === "1",
    studioHealthy: studioUp,
    mac: {
      hostname: prettyMacName(),
      lastSeen: new Date().toISOString(),
      online: true,
    },
    nextRunAt: nextRunAtIso(Number(getSetting("runHourPt") ?? env.runHourPt)),
    offer,
    latestCreatives: listLatestCreatives(4),
    accounts: accountsWithCooldowns(),
    perf: {
      asOf: perf.asOf,
      spendToday,
      purchasesToday,
      cpaToday: purchasesToday > 0 ? spendToday / purchasesToday : null,
      campaigns: perf.entries,
    },
    daily,
    runs,
    angles,
    redtrackAngles: guardrailAngleSnapshot(),
    health: health
      ? { at: health.at, ok: healthOk, checks: healthChecks }
      : null,
  };
}

/** Push the snapshot to the Vercel glance app (no-op when not configured). */
export async function maybePushSnapshot(force = false): Promise<void> {
  if (!env.portalPushUrl || !env.portalPushSecret) return;
  if (!force && Date.now() - lastPushAt < PUSH_INTERVAL_MS) return;
  lastPushAt = Date.now();
  try {
    const snapshot = await buildSnapshot();
    const response = await fetch(env.portalPushUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-adf-secret": env.portalPushSecret,
      },
      body: JSON.stringify(snapshot),
    });
    if (!response.ok) {
      console.warn(`Portal push failed: HTTP ${response.status} ${await response.text().catch(() => "")}`);
    }
  } catch (error) {
    console.warn("Portal push failed:", error instanceof Error ? error.message : error);
  }
}
