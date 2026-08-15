/**
 * Performance monitoring for campaigns created by this system (moved out of
 * runner.ts so both the runner and the snapshot pusher can use it without an
 * import cycle).
 */
import { env } from "./env.js";
import { listRuns } from "./db.js";
import { getCampaignInsights, getDailyInsights } from "./meta.js";

export interface PerformanceEntry {
  runId: string;
  verticalId: string;
  campaignId: string;
  status: string;
  goLiveAt: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  costPerPurchase: number | null;
}

/** Today's insights for every automated campaign from the last N days. */
export async function getPerformanceReport(days = 7): Promise<PerformanceEntry[]> {
  if (!env.metaToken) return [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const runs = listRuns(100).filter(
    (r) => r.meta_campaign_id && r.created_at >= cutoff && r.status !== "error" && r.status !== "cancelled",
  );
  const entries: PerformanceEntry[] = [];
  for (const run of runs) {
    try {
      const insights = await getCampaignInsights(run.meta_campaign_id!, "today");
      entries.push({
        runId: run.id,
        verticalId: run.vertical_id,
        campaignId: run.meta_campaign_id!,
        status: run.status,
        goLiveAt: run.go_live_at,
        spend: insights?.spend ?? 0,
        impressions: insights?.impressions ?? 0,
        clicks: insights?.clicks ?? 0,
        purchases: insights?.purchases ?? 0,
        costPerPurchase: insights?.costPerPurchase ?? null,
      });
    } catch (error) {
      console.warn(`Insights failed for campaign ${run.meta_campaign_id}`, error);
    }
  }
  return entries;
}

export interface DailyPerf {
  /** YYYY-MM-DD */
  date: string;
  spend: number;
  purchases: number;
  clicks: number;
  impressions: number;
  cpa: number | null;
}

const DAILY_TTL_MS = 10 * 60 * 1000;
let dailyCache: { at: number; rows: DailyPerf[] } | null = null;
let dailyRefreshing = false;

/**
 * Last 7 days of spend/purchases summed per day across FACTORY-CREATED
 * campaigns only (runs with a meta_campaign_id) — manual/cloned campaigns on
 * the spare accounts are deliberately excluded; this table answers "how are
 * MY automated ads doing". Serves stale data instantly and refreshes in the
 * background so the glance snapshot never blocks on N Meta insight calls.
 */
export function getDailyPerformance(): DailyPerf[] {
  const stale = !dailyCache || Date.now() - dailyCache.at > DAILY_TTL_MS;
  if (stale && !dailyRefreshing && env.metaToken) {
    dailyRefreshing = true;
    void refreshDaily().finally(() => { dailyRefreshing = false; });
  }
  return dailyCache?.rows ?? [];
}

async function refreshDaily(): Promise<void> {
  const cutoff = Date.now() - 15 * 24 * 60 * 60 * 1000;
  const runs = listRuns(200).filter(
    (r) => r.meta_campaign_id && r.created_at >= cutoff && r.status !== "error" && r.status !== "cancelled",
  );
  const campaignIds = [...new Set(runs.map((r) => r.meta_campaign_id!))];
  const byDate = new Map<string, DailyPerf>();
  for (const campaignId of campaignIds) {
    try {
      for (const d of await getDailyInsights(campaignId)) {
        const cur = byDate.get(d.date) ?? { date: d.date, spend: 0, purchases: 0, clicks: 0, impressions: 0, cpa: null };
        cur.spend += d.spend;
        cur.purchases += d.purchases;
        cur.clicks += d.clicks;
        cur.impressions += d.impressions;
        byDate.set(d.date, cur);
      }
    } catch (error) {
      console.warn(`Daily insights failed for campaign ${campaignId}`, error);
    }
  }
  const rows = [...byDate.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 7);
  for (const r of rows) r.cpa = r.purchases > 0 ? r.spend / r.purchases : null;
  dailyCache = { at: Date.now(), rows };
}

export function formatPerformanceReport(entries: PerformanceEntry[]): string {
  const lines = entries.map((e) => {
    const cpa = e.costPerPurchase !== null ? `$${e.costPerPurchase.toFixed(2)}` : "—";
    return `• *${e.verticalId}* \`${e.campaignId}\` (${e.status}): $${e.spend.toFixed(2)} spent today, ${e.purchases} purchase(s), CPA ${cpa}, ${e.clicks} clicks / ${e.impressions} impressions`;
  });
  return `:bar_chart: *Automated campaign performance (today so far)*\n${lines.join("\n")}`;
}
