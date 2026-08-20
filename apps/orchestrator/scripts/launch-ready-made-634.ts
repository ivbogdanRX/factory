/**
 * Live (IB) factory campaign on Linh 712634 (·7073) using only premade
 * videos from ready-made/va-loans/. Same CBO / bid cap / pixel / copy /
 * targeting as the other (IB) LNV launches. Does not generate UGC and
 * does not touch existing (N)/(SG)/(IS) campaigns.
 *
 * Usage: npx tsx apps/orchestrator/scripts/launch-ready-made-634.ts
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

const ACCOUNT_ID = "act_2418227075367073";
const ACCOUNT_LABEL = "Linh 712634 ·7073";
const READY_DIR = join(ROOT, "ready-made", "va-loans");
const COUNT = 6;

/** Fresh 6.22 premades — not the two videos already on paused LNV 3 X7073. */
const PREFERRED = [
  "DF_LNV_6.22_1.mov",
  "DF_LNV_6.22_2.mov",
  "DF_LNV_6.22_3.mov",
  "DF_LNV_6.22_4.mov",
  "DF_LNV_6.22_5.mov",
  "DF_LNV_6.22_6.mov",
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
const suffix = " X7073";
const campaignName = `${formatName(vertical.meta.naming.campaign, vertical, nowIso, 0)}${suffix}`;
if (!isIbCampaignName(campaignName)) {
  throw new Error(`Refusing to create "${campaignName}" — not (IB)`);
}
const existing = await listCampaignNames(ACCOUNT_ID);
if (existing.includes(campaignName)) {
  throw new Error(`"${campaignName}" already exists`);
}

console.log(`Launching ${campaignName} on ${ACCOUNT_LABEL} — ${files.length} premade(s), $${vertical.meta.cboDailyBudgetCents / 100}/day`);
for (const f of files) console.log(`  ${basename(f)}`);

const run = createRun(vertical.id, "new-campaign");
updateRun(run.id, { note: `Premade-only launch on ${ACCOUNT_LABEL}` });
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
  dailyBudget: vertical.meta.cboDailyBudgetCents,
  bidStrategy: vertical.meta.bidStrategy,
  status: "ACTIVE",
});
updateRun(run.id, { meta_campaign_id: campaignId });

const adSetId = await createAdSet(ACCOUNT_ID, {
  name: `${formatName(vertical.meta.naming.adSet, vertical, nowIso, 0)}${suffix}`,
  campaignId,
  bidAmount: vertical.meta.bidStrategy === "LOWEST_COST_WITH_BID_CAP" ? vertical.meta.bidCapCents : undefined,
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
console.log(`LIVE ${campaignName} ${campaignId} — ${created} premade ad(s), $${vertical.meta.cboDailyBudgetCents / 100}/day, run ${run.id}`);
process.exit(0);
