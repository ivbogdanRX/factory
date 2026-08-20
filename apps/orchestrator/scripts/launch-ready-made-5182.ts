/**
 * Live (IB) premade campaign on Linh 852621 (·5182) at $25/day CBO
 * with a $25 bid cap. Uses unused DF_LNV 6.23/6.24 files (not the 6.22
 * set already on 634). Does not touch (J) SSD or the paused LNV 3 clone.
 *
 * Usage: npx tsx apps/orchestrator/scripts/launch-ready-made-5182.ts
 */
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { env, ROOT } from "../src/env.js";
import { loadVerticals } from "../src/verticals.js";
import { formatName } from "../src/runner.js";
import {
  createCampaign,
  createAdSet,
  createAdFromVideo,
  uploadVideo,
  extractThumbnail,
  uploadImageFile,
  listCampaignNames,
  getAdAccountHealth,
  defaultUsTargeting,
  isIbCampaignName,
} from "../src/meta.js";
import { createRun, updateRun, addCreative, updateCreative, listCreatives } from "../src/db.js";
import { recordLaunch } from "../src/launch-guard.js";
import { unlink } from "node:fs/promises";

const ACCOUNT_ID = "act_1109111821645182";
const ACCOUNT_LABEL = "Linh 852621 ·5182";
const READY_DIR = join(ROOT, "ready-made", "va-loans");
const COUNT = 6;
const DAILY_BUDGET_CENTS = 2_500; // $25 CBO
const BID_CAP_CENTS = 2_500; // $25 bid cap

const PREFERRED = [
  "DF_LNV_6.23_1.mov",
  "DF_LNV_6.23_2.mov",
  "DF_LNV_6.23_3.mov",
  "DF_LNV_6.23_4.mov",
  "DF_LNV_6.23_5.mov",
  "DF_LNV_6.24_1.mov",
];

function pickVideos(): string[] {
  const available = new Set(
    readdirSync(READY_DIR).filter((f) => /\.(mov|mp4)$/i.test(f) && !f.startsWith(".")),
  );
  const chosen: string[] = [];
  for (const name of PREFERRED) {
    if (available.has(name)) chosen.push(join(READY_DIR, name));
  }
  if (chosen.length < COUNT) {
    throw new Error(`Need ${COUNT} premades, found ${chosen.length} of ${PREFERRED.join(", ")}`);
  }
  return chosen.slice(0, COUNT);
}

if (env.dryRun) throw new Error("DRY_RUN is on — refusing");

const vertical = loadVerticals().find((v) => v.enabled);
if (!vertical) throw new Error("No enabled vertical");

const health = await getAdAccountHealth(ACCOUNT_ID);
if (health.accountStatus !== 1) {
  throw new Error(`${ACCOUNT_LABEL} is not ACTIVE (status ${health.accountStatus})`);
}

const files = pickVideos();
const nowIso = new Date().toISOString();
const suffix = " X5182";
const campaignName = `${formatName(vertical.meta.naming.campaign, vertical, nowIso, 0)}${suffix}`;
if (!isIbCampaignName(campaignName)) {
  throw new Error(`Refusing to create "${campaignName}" — not (IB)`);
}
const existing = await listCampaignNames(ACCOUNT_ID);
if (existing.includes(campaignName)) {
  throw new Error(`"${campaignName}" already exists`);
}

console.log(`Launching ${campaignName} on ${ACCOUNT_LABEL} — ${files.length} premade(s), $${DAILY_BUDGET_CENTS / 100}/day, $${BID_CAP_CENTS / 100} bid cap`);
for (const f of files) console.log(`  ${basename(f)}`);

const run = createRun(vertical.id, "new-campaign");
updateRun(run.id, { note: `Premade $25 CBO / $25 cap on ${ACCOUNT_LABEL}` });
for (const path of files) addCreative(run.id, path, "ready-made");
updateRun(run.id, { status: "uploading" });

const uploaded: { creativeId: number; videoId: string; imageHash?: string }[] = [];
for (const creative of listCreatives(run.id)) {
  try {
    const videoId = await uploadVideo(ACCOUNT_ID, creative.output_path, basename(creative.output_path));
    let imageHash: string | undefined;
    try {
      const thumbPath = await extractThumbnail(creative.output_path);
      const image = await uploadImageFile(ACCOUNT_ID, thumbPath);
      imageHash = image.hash;
      await unlink(thumbPath).catch(() => {});
    } catch (thumbError) {
      console.warn(`Thumbnail failed for ${creative.output_path}`, thumbError);
    }
    updateCreative(creative.id, { video_id: videoId, status: "uploaded" });
    uploaded.push({ creativeId: creative.id, videoId, imageHash });
    console.log(`uploaded ${basename(creative.output_path)} → ${videoId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateCreative(creative.id, { status: "error", error: message });
    console.error(`upload failed ${basename(creative.output_path)}: ${message}`);
  }
}
if (uploaded.length === 0) {
  updateRun(run.id, { status: "error", error: "Every video upload failed" });
  throw new Error("Every video upload failed");
}

const campaignId = await createCampaign(ACCOUNT_ID, {
  name: campaignName,
  objective: vertical.meta.objective,
  specialAdCategories: vertical.meta.specialAdCategories,
  dailyBudget: DAILY_BUDGET_CENTS,
  bidStrategy: vertical.meta.bidStrategy,
  status: "ACTIVE",
});
updateRun(run.id, { meta_campaign_id: campaignId });

const adSetId = await createAdSet(ACCOUNT_ID, {
  name: `${formatName(vertical.meta.naming.adSet, vertical, nowIso, 0)}${suffix}`,
  campaignId,
  bidAmount: BID_CAP_CENTS,
  billingEvent: "IMPRESSIONS",
  optimizationGoal: vertical.meta.optimizationGoal,
  targeting: defaultUsTargeting({
    geo_locations: { countries: ["US"], location_types: ["home", "recent"] },
    targeting_automation: { advantage_audience: 1 },
  }),
  promotedObject: { pixel_id: vertical.meta.pixelId, custom_event_type: vertical.meta.pixelEvent },
  status: "ACTIVE",
});
updateRun(run.id, { meta_adset_id: adSetId });

let created = 0;
for (let i = 0; i < uploaded.length; i++) {
  const item = uploaded[i]!;
  const name = `${formatName(vertical.meta.naming.ad, vertical, nowIso, i + 1)}${suffix} [ready-made]`;
  try {
    const adId = await createAdFromVideo({
      adAccountId: ACCOUNT_ID,
      adSetId,
      pageId: vertical.meta.pageId,
      videoId: item.videoId,
      adName: name,
      copy: vertical.meta.adSettings,
      thumbnail: item.imageHash ? { imageHash: item.imageHash } : {},
      status: "ACTIVE",
    });
    updateCreative(item.creativeId, { ad_id: adId, ad_name: name, status: "live" });
    created++;
    console.log(`ad ${name} → ${adId}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateCreative(item.creativeId, { status: "error", error: message });
    console.error(`ad failed ${name}: ${message}`);
  }
}
if (created === 0) {
  updateRun(run.id, { status: "error", error: "Every ad creation failed" });
  throw new Error("Every ad creation failed");
}

updateRun(run.id, { status: "live", go_live_at: nowIso, error: null });
recordLaunch(ACCOUNT_ID);
console.log(`LIVE ${campaignName} ${campaignId} — ${created} premade ad(s), $${DAILY_BUDGET_CENTS / 100}/day, $${BID_CAP_CENTS / 100} cap, run ${run.id}`);
process.exit(0);
