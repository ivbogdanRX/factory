/**
 * Performance monitoring for campaigns created by this system (moved out of
 * runner.ts so both the runner and the snapshot pusher can use it without an
 * import cycle).
 */
import { env } from "./env.js";
import { listRuns } from "./db.js";
import { getCampaignInsights } from "./meta.js";

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

export function formatPerformanceReport(entries: PerformanceEntry[]): string {
  const lines = entries.map((e) => {
    const cpa = e.costPerPurchase !== null ? `$${e.costPerPurchase.toFixed(2)}` : "—";
    return `• *${e.verticalId}* \`${e.campaignId}\` (${e.status}): $${e.spend.toFixed(2)} spent today, ${e.purchases} purchase(s), CPA ${cpa}, ${e.clicks} clicks / ${e.impressions} impressions`;
  });
  return `:bar_chart: *Automated campaign performance (today so far)*\n${lines.join("\n")}`;
}
