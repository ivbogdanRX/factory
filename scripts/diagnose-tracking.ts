#!/usr/bin/env tsx
/**
 * Tracking diagnostic — compares Meta vs RedTrack conversion data to identify
 * attribution issues causing low ROI.
 */
import { loadVerticals } from "../apps/orchestrator/src/verticals.js";
import { listRuns, listCreatives } from "../apps/orchestrator/src/db.js";
import { getCampaignInsights, getAdInsights } from "../apps/orchestrator/src/meta.js";
import { getStatsBySub, redtrackCampaignIdFromUrl, redtrackConfigured } from "../apps/orchestrator/src/redtrack.js";

interface DiagnosticResult {
  campaignId: string;
  campaignName: string;
  status: string;
  goLiveAt: string | null;
  metaSpend: number;
  metaPurchases: number;
  metaCpa: number | null;
  redtrackConversions: number;
  redtrackRevenue: number;
  redtrackCpa: number | null;
  mismatch: boolean;
  mismatchSeverity: "none" | "minor" | "major" | "critical";
}

interface AdDiagnostic {
  adId: string;
  adName: string;
  metaSpend: number;
  metaPurchases: number;
  redtrackConversions: number;
  mismatch: boolean;
}

async function diagnose(daysBack = 7): Promise<void> {
  console.log("🔍 Tracking Diagnostic\n");
  console.log("=" .repeat(80));

  if (!redtrackConfigured()) {
    console.log("❌ RedTrack not configured (missing REDTRACK_API_KEY in env)");
    console.log("   → The system can't track conversions without RedTrack!");
    return;
  }

  const vertical = loadVerticals().find((v) => v.id === "va-loans");
  if (!vertical) {
    console.log("❌ VA Loans vertical not found");
    return;
  }

  const rtCampaignId = redtrackCampaignIdFromUrl(vertical.meta.adSettings.websiteUrl);
  if (!rtCampaignId) {
    console.log("❌ Could not extract RedTrack campaign ID from landing URL");
    console.log(`   URL: ${vertical.meta.adSettings.websiteUrl}`);
    return;
  }

  console.log(`✓ Vertical: ${vertical.label}`);
  console.log(`✓ RedTrack Campaign ID: ${rtCampaignId}`);
  console.log(`✓ Meta Ad Account: ${vertical.meta.adAccountId}`);
  console.log(`✓ Meta Pixel: ${vertical.meta.pixelId}`);
  console.log();

  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const runs = listRuns(100).filter(
    (r) =>
      r.vertical_id === vertical.id &&
      r.meta_campaign_id &&
      r.created_at >= cutoff &&
      r.status !== "error" &&
      r.status !== "cancelled"
  );

  if (runs.length === 0) {
    console.log(`ℹ️  No active campaigns in the last ${daysBack} days`);
    return;
  }

  console.log(`📊 Analyzing ${runs.length} campaign(s)...\n`);

  const results: DiagnosticResult[] = [];
  let totalMetaSpend = 0;
  let totalMetaPurchases = 0;
  let totalRtConversions = 0;
  let totalRtRevenue = 0;

  // Get RedTrack data for all campaigns
  const rtStatsBySub3 = await getStatsBySub(rtCampaignId, "sub3", daysBack);
  
  for (const run of runs) {
    try {
      const insights = await getCampaignInsights(run.meta_campaign_id!, "maximum");
      const metaSpend = insights?.spend ?? 0;
      const metaPurchases = insights?.purchases ?? 0;
      const metaCpa = metaPurchases > 0 ? metaSpend / metaPurchases : null;

      const rtStats = rtStatsBySub3?.get(run.meta_campaign_id!) ?? {
        clicks: 0,
        conversions: 0,
        revenue: 0,
      };
      const redtrackConversions = rtStats.conversions;
      const redtrackRevenue = rtStats.revenue;
      const redtrackCpa = redtrackConversions > 0 ? metaSpend / redtrackConversions : null;

      // Determine mismatch severity
      let mismatch = false;
      let mismatchSeverity: "none" | "minor" | "major" | "critical" = "none";

      if (metaPurchases > 0 && redtrackConversions === 0) {
        mismatch = true;
        mismatchSeverity = "critical"; // Meta sees conversions but RedTrack doesn't
      } else if (metaPurchases === 0 && redtrackConversions > 0) {
        mismatch = true;
        mismatchSeverity = "major"; // RedTrack sees conversions but Meta doesn't
      } else if (Math.abs(metaPurchases - redtrackConversions) > Math.max(1, metaPurchases * 0.3)) {
        mismatch = true;
        mismatchSeverity = "major"; // >30% difference
      } else if (Math.abs(metaPurchases - redtrackConversions) > 0) {
        mismatch = true;
        mismatchSeverity = "minor"; // Small difference
      }

      results.push({
        campaignId: run.meta_campaign_id!,
        campaignName: run.note || run.id,
        status: run.status,
        goLiveAt: run.go_live_at,
        metaSpend,
        metaPurchases,
        metaCpa,
        redtrackConversions,
        redtrackRevenue,
        redtrackCpa,
        mismatch,
        mismatchSeverity,
      });

      totalMetaSpend += metaSpend;
      totalMetaPurchases += metaPurchases;
      totalRtConversions += redtrackConversions;
      totalRtRevenue += redtrackRevenue;
    } catch (error) {
      console.error(`  ⚠️  Failed to get data for campaign ${run.meta_campaign_id}:`, error);
    }
  }

  // Print summary
  console.log("=" .repeat(80));
  console.log("CAMPAIGN SUMMARY");
  console.log("=" .repeat(80));
  console.log();

  const fmt = (n: number) => `$${n.toFixed(2)}`;

  for (const result of results) {
    const icon =
      result.mismatchSeverity === "critical"
        ? "🔴"
        : result.mismatchSeverity === "major"
          ? "🟠"
          : result.mismatchSeverity === "minor"
            ? "🟡"
            : "🟢";

    console.log(`${icon} ${result.campaignName} (${result.status})`);
    console.log(`   Campaign ID: ${result.campaignId}`);
    console.log(`   Meta:      ${fmt(result.metaSpend)} spent, ${result.metaPurchases} purchases, CPA ${result.metaCpa ? fmt(result.metaCpa) : "—"}`);
    console.log(`   RedTrack:  ${result.redtrackConversions} conversions, ${fmt(result.redtrackRevenue)} revenue, CPA ${result.redtrackCpa ? fmt(result.redtrackCpa) : "—"}`);

    if (result.mismatchSeverity === "critical") {
      console.log(`   ⚠️  CRITICAL: Meta shows ${result.metaPurchases} purchases but RedTrack shows 0 conversions!`);
      console.log(`       → Your guardrails think this campaign is failing and will kill it`);
      console.log(`       → Check: RedTrack pixel firing? Sub parameters being passed?`);
    } else if (result.mismatchSeverity === "major") {
      const diff = Math.abs(result.metaPurchases - result.redtrackConversions);
      console.log(`   ⚠️  MAJOR: ${diff} conversion discrepancy between Meta and RedTrack`);
    }
    console.log();
  }

  // Overall totals
  console.log("=" .repeat(80));
  console.log("OVERALL TOTALS");
  console.log("=" .repeat(80));
  console.log();
  console.log(`Meta Total:      ${fmt(totalMetaSpend)} spent, ${totalMetaPurchases} purchases, CPA ${totalMetaPurchases > 0 ? fmt(totalMetaSpend / totalMetaPurchases) : "—"}`);
  console.log(`RedTrack Total:  ${totalRtConversions} conversions, ${fmt(totalRtRevenue)} revenue, CPA ${totalRtConversions > 0 ? fmt(totalMetaSpend / totalRtConversions) : "—"}`);
  console.log();

  const overallMismatch = Math.abs(totalMetaPurchases - totalRtConversions);
  const mismatchPct = totalMetaPurchases > 0 ? (overallMismatch / totalMetaPurchases) * 100 : 0;

  if (totalMetaPurchases > 0 && totalRtConversions === 0) {
    console.log("🔴 CRITICAL ISSUE: Meta reports purchases but RedTrack shows ZERO conversions!");
    console.log();
    console.log("   This means:");
    console.log("   1. Your campaigns ARE generating conversions (per Meta pixel)");
    console.log("   2. But RedTrack isn't tracking them");
    console.log("   3. Your guardrails think everything is failing and kill good ads");
    console.log();
    console.log("   Root cause is likely:");
    console.log("   → RedTrack pixel not installed on conversion page");
    console.log("   → Sub parameters not being passed through to conversion page");
    console.log("   → Landing page redirect breaking tracking");
    console.log("   → RedTrack campaign ID mismatch");
    console.log();
    console.log("   To fix:");
    console.log("   1. Visit your landing page with test sub params:");
    console.log(`      ${vertical.meta.adSettings.websiteUrl.replace("{{ad.id}}", "TEST_AD").replace("{{campaign.id}}", "TEST_CAMPAIGN")}`);
    console.log("   2. Complete a test conversion");
    console.log("   3. Check RedTrack for the TEST_AD and TEST_CAMPAIGN sub values");
    console.log("   4. If not there, your tracking integration is broken");
  } else if (mismatchPct > 30) {
    console.log(`🟠 WARNING: ${mismatchPct.toFixed(0)}% mismatch between Meta and RedTrack conversions`);
    console.log();
    console.log("   This level of discrepancy suggests:");
    console.log("   → Attribution window differences");
    console.log("   → Some conversions not being tracked by one system");
    console.log("   → Pixel or RedTrack tracking intermittently failing");
  } else if (overallMismatch > 0) {
    console.log(`🟡 Minor discrepancy: ${overallMismatch} conversions difference (${mismatchPct.toFixed(0)}%)`);
    console.log("   This is normal due to attribution window differences");
  } else {
    console.log("🟢 Tracking looks healthy! Meta and RedTrack data align.");
  }

  // Check guardrail status
  console.log();
  console.log("=" .repeat(80));
  console.log("GUARDRAIL SETTINGS");
  console.log("=" .repeat(80));
  console.log();
  console.log(`Ad Kill Threshold:    ${fmt(vertical.guardrails!.adKillSpendUsd)} spend with 0 RedTrack conversions`);
  console.log(`Campaign CPA Guard:   ${fmt(vertical.guardrails!.campaignGuardMinSpendUsd)} min spend, ${fmt(vertical.guardrails!.maxCpaUsd)} max CPA`);
  console.log(`Extension CPA:        Under ${fmt(vertical.guardrails!.extendUnderCpaUsd)} CPA → extend flight`);
  console.log(`Scale Threshold:      ${fmt(vertical.guardrails!.scaleMinSpendUsd)} spend at ${vertical.guardrails!.scaleAtRoas}x ROAS`);
  console.log();

  if (totalMetaPurchases > 0 && totalRtConversions === 0) {
    console.log("⚠️  With 0 RedTrack conversions, your guardrails are:");
    console.log("   → Killing every ad that spends over $50");
    console.log("   → Pausing campaigns that spend over $100");
    console.log("   → Never extending or scaling winners");
    console.log();
    console.log("   This is why your ROI is low — good campaigns are being killed!");
  }
}

// Run diagnostic
diagnose(7).catch((error) => {
  console.error("Diagnostic failed:", error);
  process.exit(1);
});
