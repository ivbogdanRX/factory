#!/usr/bin/env tsx
/**
 * Quick tracking health check — validates your tracking setup without needing
 * historical campaign data.
 */
import { loadVerticals } from "../apps/orchestrator/src/verticals.js";
import { redtrackConfigured, redtrackCampaignIdFromUrl } from "../apps/orchestrator/src/redtrack.js";
import { env } from "../apps/orchestrator/src/env.js";

console.log("🏥 Ad Factory Tracking Health Check\n");
console.log("=" .repeat(80));
console.log();

const vertical = loadVerticals().find((v) => v.id === "va-loans");
if (!vertical) {
  console.log("❌ VA Loans vertical not found in config");
  process.exit(1);
}

let issues = 0;
let warnings = 0;

// Check 1: Meta token
console.log("1️⃣  Meta Access Token");
if (env.metaToken) {
  console.log("   ✅ Configured");
} else {
  console.log("   ❌ Missing META_SYSTEM_USER_TOKEN in .env");
  console.log("      → Cannot upload ads to Meta without this");
  issues++;
}
console.log();

// Check 2: RedTrack
console.log("2️⃣  RedTrack Configuration");
if (redtrackConfigured()) {
  console.log("   ✅ API key configured");
  
  const landingUrl = vertical.meta.adSettings.websiteUrl;
  const rtCampaignId = redtrackCampaignIdFromUrl(landingUrl);
  
  if (rtCampaignId) {
    console.log(`   ✅ Campaign ID extracted: ${rtCampaignId}`);
  } else {
    console.log("   ⚠️  Could not extract RedTrack campaign ID from landing URL");
    console.log(`      URL: ${landingUrl}`);
    console.log("      → Guardrails won't work without this");
    warnings++;
  }
  
  // Check sub parameters
  if (landingUrl.includes("{{ad.id}}") && landingUrl.includes("{{campaign.id}}")) {
    console.log("   ✅ Sub parameters present (sub1={{ad.id}}, sub3={{campaign.id}})");
  } else {
    console.log("   ❌ Missing sub1 or sub3 parameters in landing URL");
    console.log("      → RedTrack can't attribute conversions back to ads");
    issues++;
  }
} else {
  console.log("   ❌ Missing REDTRACK_API_KEY in .env");
  console.log("      → Guardrails (ad kill, scaling, extensions) won't work");
  console.log("      → All campaigns will run blind without conversion data");
  issues++;
}
console.log();

// Check 3: Meta Pixel
console.log("3️⃣  Meta Pixel Configuration");
if (vertical.meta.pixelId) {
  console.log(`   ✅ Pixel ID: ${vertical.meta.pixelId}`);
  console.log(`   ✅ Pixel Event: ${vertical.meta.pixelEvent}`);
  console.log("   ⚠️  Note: Pixel must be installed on your CONVERSION page");
  console.log("      Cannot verify remotely — test with Meta Pixel Helper extension");
} else {
  console.log("   ❌ No pixel ID configured");
  console.log("      → Campaigns won't optimize for conversions");
  issues++;
}
console.log();

// Check 4: Landing URL structure
console.log("4️⃣  Landing URL Structure");
const landingUrl = vertical.meta.adSettings.websiteUrl;
console.log(`   URL: ${landingUrl}`);

const requiredParams = [
  "{{ad.id}}",
  "{{campaign.id}}",
  "utm_source",
  "utm_medium"
];

let urlOk = true;
for (const param of requiredParams) {
  if (!landingUrl.includes(param)) {
    console.log(`   ❌ Missing: ${param}`);
    urlOk = false;
    issues++;
  }
}

if (urlOk) {
  console.log("   ✅ All required parameters present");
}
console.log();

// Check 5: Guardrails
console.log("5️⃣  Guardrails Configuration");
if (vertical.guardrails?.enabled) {
  console.log("   ✅ Enabled");
  console.log(`   📊 Ad Kill: $${vertical.guardrails.adKillSpendUsd} spend with 0 conversions`);
  console.log(`   📊 Campaign CPA Guard: $${vertical.guardrails.campaignGuardMinSpendUsd} min spend, max CPA $${vertical.guardrails.maxCpaUsd}`);
  console.log(`   📊 Extension CPA: Under $${vertical.guardrails.extendUnderCpaUsd}`);
  console.log(`   📊 Scale at: ${vertical.guardrails.scaleAtRoas}x ROAS`);
  
  if (!redtrackConfigured()) {
    console.log("   ⚠️  Guardrails enabled but RedTrack not configured");
    console.log("      → Guardrails will see 0 conversions and kill all campaigns!");
    warnings++;
  }
} else {
  console.log("   ⚠️  Disabled");
  console.log("      → No automated ad killing, scaling, or extensions");
  warnings++;
}
console.log();

// Check 6: Ad Account Setup
console.log("6️⃣  Meta Ad Account");
console.log(`   Account: ${vertical.meta.adAccountId}`);
console.log(`   Page: ${vertical.meta.pageId}`);
console.log(`   Mode: ${vertical.meta.mode}`);
console.log(`   Daily Budget: $${(vertical.meta.cboDailyBudgetCents / 100).toFixed(2)}`);
console.log(`   Bid Cap: $${(vertical.meta.bidCapCents / 100).toFixed(2)}`);
console.log();

// Summary
console.log("=" .repeat(80));
console.log("SUMMARY");
console.log("=" .repeat(80));
console.log();

if (issues === 0 && warnings === 0) {
  console.log("🟢 All checks passed! Your tracking setup looks good.");
  console.log();
  console.log("Next steps:");
  console.log("1. Run a test campaign: npm run dry-run");
  console.log("2. Check tracking: npx tsx scripts/diagnose-tracking.ts");
  console.log("3. Monitor in Slack: /adops status");
} else {
  if (issues > 0) {
    console.log(`🔴 ${issues} critical issue(s) found`);
  }
  if (warnings > 0) {
    console.log(`🟡 ${warnings} warning(s) found`);
  }
  console.log();
  console.log("Critical issues will prevent the system from working correctly.");
  console.log("See docs/ROI-TROUBLESHOOTING.md for detailed fixes.");
  process.exit(1);
}

// Test URL
console.log();
console.log("=" .repeat(80));
console.log("TEST YOUR TRACKING");
console.log("=" .repeat(80));
console.log();
console.log("Visit this URL to test tracking (replace dynamic params):");
console.log();
const testUrl = landingUrl
  .replace("{{ad.id}}", "TEST_AD_" + Date.now())
  .replace("{{adset.id}}", "TEST_ADSET")
  .replace("{{campaign.id}}", "TEST_CAMPAIGN_" + Date.now())
  .replace("{{ad.name}}", "Test+Ad")
  .replace("{{adset.name}}", "Test+AdSet")
  .replace("{{campaign.name}}", "Test+Campaign")
  .replace("{{placement}}", "facebook_feed")
  .replace("{{site_source_name}}", "facebook");
console.log(testUrl);
console.log();
console.log("After completing a test conversion:");
console.log("1. Check RedTrack for 'TEST_AD' and 'TEST_CAMPAIGN' in the sub columns");
console.log("2. Check Meta Events Manager for a Purchase event on your pixel");
console.log("3. If both show up, your tracking is working!");
console.log();
