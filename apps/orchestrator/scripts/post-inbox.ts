/**
 * Post premade videos from inbox (already transcoded under data/encoded)
 * into a new CBO campaign for one vertical. Does not run the studio.
 *
 * Usage: npx tsx apps/orchestrator/scripts/post-inbox.ts
 */
import { basename } from "node:path";
import { unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/env.js";
import { getVertical, loadVerticals } from "../src/verticals.js";
import { familyIsolationProblems, familyOf } from "../src/family.js";
import { createRun, updateRun, addCreative, updateCreative, listCreatives } from "../src/db.js";
import {
  uploadVideo,
  extractThumbnail,
  uploadImageFile,
  createCampaign,
  createAdSet,
  createAdFromVideo,
  defaultUsTargeting,
  listCampaignNames,
} from "../src/meta.js";
import { formatName } from "../src/runner.js";
import { nextDayStartIso } from "../src/schedule.js";
import { notifyScheduled, notifyAdReview, notifyInfo, notifyError } from "../src/slack.js";

const FILES = [
  { path: join(ROOT, "data/encoded/debt/debt-11.mp4"), angle: "premade-11" },
  { path: join(ROOT, "data/encoded/debt/debt-28.mp4"), angle: "premade-28" },
  { path: join(ROOT, "data/encoded/debt/debt-test-28.mp4"), angle: "premade-test-28" },
];

const vertical = getVertical("debt");
if (!vertical) throw new Error("debt vertical not found");

const mix = familyIsolationProblems(loadVerticals(), vertical);
if (mix.length) throw new Error(mix.join("; "));
if (!vertical.meta.adSettings.websiteUrl) throw new Error("debt websiteUrl is empty");
if (familyOf(vertical) !== "debt") throw new Error("vertical is not family=debt");

for (const file of FILES) {
  if (!existsSync(file.path)) throw new Error(`Missing encoded video: ${file.path}`);
}

const goLiveAt = nextDayStartIso(vertical.schedule.startHourPt);
const run = createRun(vertical.id, vertical.meta.mode);
updateRun(run.id, { note: "Premade inbox videos (not studio-generated)" });

console.log(`Run ${run.id} on ${vertical.meta.adAccountId}, go-live ${goLiveAt}`);
notifyInfo(
  `:package: *${vertical.label} [${familyOf(vertical)}]* — posting ${FILES.length} premade videos to \`${vertical.meta.adAccountId}\` ($${(vertical.meta.cboDailyBudgetCents / 100).toFixed(0)}/day).`,
);

try {
  updateRun(run.id, { status: "uploading" });
  const uploaded: { creativeId: number; videoId: string; imageHash?: string; angle: string }[] = [];
  for (const file of FILES) {
    const creativeId = addCreative(run.id, file.path, file.angle);
    console.log(`uploading ${basename(file.path)}…`);
    const videoId = await uploadVideo(vertical.meta.adAccountId, file.path, basename(file.path));
    let imageHash: string | undefined;
    try {
      const thumbPath = await extractThumbnail(file.path);
      const image = await uploadImageFile(vertical.meta.adAccountId, thumbPath);
      imageHash = image.hash;
      await unlink(thumbPath).catch(() => {});
    } catch (thumbError) {
      console.warn(`thumbnail failed for ${file.path}`, thumbError);
    }
    updateCreative(creativeId, { video_id: videoId, status: "uploaded" });
    uploaded.push({ creativeId, videoId, imageHash, angle: file.angle });
    console.log(`  video ${videoId}`);
  }

  let campaignName = formatName(vertical.meta.naming.campaign, vertical, goLiveAt, 0);
  const existing = new Set(await listCampaignNames(vertical.meta.adAccountId));
  if (existing.has(campaignName)) campaignName = `${campaignName} B`;

  const campaignId = await createCampaign(vertical.meta.adAccountId, {
    name: campaignName,
    objective: vertical.meta.objective,
    specialAdCategories: vertical.meta.specialAdCategories,
    dailyBudget: vertical.meta.cboDailyBudgetCents,
    bidStrategy: vertical.meta.bidStrategy,
    status: "ACTIVE",
  });
  updateRun(run.id, { meta_campaign_id: campaignId });
  console.log(`campaign ${campaignName} ${campaignId}`);

  const adSetId = await createAdSet(vertical.meta.adAccountId, {
    name: formatName(vertical.meta.naming.adSet, vertical, goLiveAt, 0),
    campaignId,
    bidAmount: vertical.meta.bidStrategy === "LOWEST_COST_WITH_BID_CAP" ? vertical.meta.bidCapCents : undefined,
    billingEvent: "IMPRESSIONS",
    optimizationGoal: vertical.meta.optimizationGoal,
    targeting: defaultUsTargeting(),
    promotedObject: { pixel_id: vertical.meta.pixelId, custom_event_type: vertical.meta.pixelEvent },
    status: "ACTIVE",
    startTime: goLiveAt,
  });
  updateRun(run.id, { meta_adset_id: adSetId });
  console.log(`ad set ${adSetId}`);

  let created = 0;
  for (let i = 0; i < uploaded.length; i++) {
    const item = uploaded[i]!;
    const name = `${formatName(vertical.meta.naming.ad, vertical, goLiveAt, i + 1)} [${item.angle}]`;
    const adId = await createAdFromVideo({
      adAccountId: vertical.meta.adAccountId,
      adSetId,
      pageId: vertical.meta.pageId,
      videoId: item.videoId,
      adName: name,
      copy: vertical.meta.adSettings,
      thumbnail: item.imageHash ? { imageHash: item.imageHash } : {},
      status: "ACTIVE",
    });
    updateCreative(item.creativeId, { ad_id: adId, ad_name: name, status: "scheduled" });
    created++;
    console.log(`  ad ${name} ${adId}`);
  }

  updateRun(run.id, { status: "scheduled", go_live_at: goLiveAt, error: null });
  notifyScheduled({
    runId: run.id,
    verticalLabel: vertical.label,
    adCount: created,
    goLiveAtIso: goLiveAt,
    adSetId,
    campaignId,
    campaignName,
  });
  for (const creative of listCreatives(run.id)) {
    if (!creative.ad_id) continue;
    await notifyAdReview({
      adId: creative.ad_id,
      adName: creative.ad_name ?? basename(creative.output_path),
      videoPath: creative.output_path,
      verticalLabel: vertical.label,
      goLiveAtIso: goLiveAt,
    });
  }
  console.log("done", run.id);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  updateRun(run.id, { status: "error", error: message });
  notifyError(run.id, vertical.label, message);
  throw error;
}
