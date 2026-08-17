/**
 * Live (IB) factory campaigns on every Meta ad account that is ACTIVE right
 * now. Generates creatives once, then publishes the same videos to each
 * account with a gap. Campaigns start spending immediately (no next-day wait).
 *
 * Never writes to a campaign whose name is not (IB). Existing (IS)/(J)/(SG)
 * campaigns on shared accounts are left untouched.
 *
 * Usage: npx tsx apps/orchestrator/scripts/launch-on-active.ts
 */
import { basename } from "node:path";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { loadVerticals, type Vertical } from "../src/verticals.js";
import { createRun, updateRun, addCreative, updateCreative, listCreatives } from "../src/db.js";
import { formatName } from "../src/runner.js";
import { pickAngles } from "../src/angles.js";
import { queueCreativeJob, waitForStudioJob } from "../src/creative.js";
import {
  getAdAccountHealth,
  uploadVideo,
  extractThumbnail,
  uploadImageFile,
  createCampaign,
  createAdSet,
  createAdFromVideo,
  defaultUsTargeting,
  isIbCampaignName,
} from "../src/meta.js";
import { recordLaunch } from "../src/launch-guard.js";
import { env } from "../src/env.js";

const GAP_MS = 45_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tail = (id: string) => id.replace(/^act_/, "").slice(-4);

const STATUS_NAMES: Record<number, string> = {
  1: "ACTIVE",
  2: "DISABLED",
  3: "UNSETTLED",
};

/** Every account this token can see — filtered to ACTIVE at runtime. */
const CANDIDATES = [
  { id: "act_2418227075367073", label: "Linh 712634 ·7073" },
  { id: "act_1060126476705741", label: "Linh 827313 ·5741" },
  { id: "act_4570617276549207", label: "Linh 273085 ·9207" },
  { id: "act_1346720040781283", label: "USD 1 ·1283" },
  { id: "act_897039680145135", label: "USD 2 ·5135" },
];

async function generateOnce(vertical: Vertical): Promise<{ path: string; angle: string | null }[]> {
  const angles = pickAngles(vertical.id, vertical.creativeCampaignId, vertical.dailyCount, vertical.angles);
  const files: { path: string; angle: string | null }[] = [];
  if (angles.length === 0) {
    const job = await queueCreativeJob(vertical.creativeCampaignId, vertical.dailyCount);
    const finished = await waitForStudioJob(job.id);
    for (const output of finished.outputs ?? []) files.push({ path: output, angle: null });
    return files;
  }
  console.log(`Generating ${angles.length} creative(s): ${angles.map((a) => a.name).join(", ")}`);
  const jobs = await Promise.all(angles.map((angle) => queueCreativeJob(vertical.creativeCampaignId, 1, angle.index)));
  const results = await Promise.allSettled(jobs.map((job) => waitForStudioJob(job.id)));
  results.forEach((result, i) => {
    const angle = angles[i]!;
    if (result.status === "fulfilled") {
      for (const output of result.value.outputs ?? []) files.push({ path: output, angle: angle.id });
    } else {
      console.warn(`Creative failed (${angle.name}):`, result.reason);
    }
  });
  return files;
}

async function publishNow(
  vertical: Vertical,
  accountId: string,
  label: string,
  files: { path: string; angle: string | null }[],
): Promise<string> {
  const health = await getAdAccountHealth(accountId);
  if (health.accountStatus !== 1) {
    throw new Error(`${label} is ${STATUS_NAMES[health.accountStatus] ?? health.accountStatus} — skipped`);
  }

  const nowIso = new Date().toISOString();
  const suffix = ` X${tail(accountId)}`;
  const campaignName = `${formatName(vertical.meta.naming.campaign, vertical, nowIso, 0)}${suffix}`;
  if (!isIbCampaignName(campaignName)) {
    throw new Error(`Refusing to create "${campaignName}" — not (IB)`);
  }

  const run = createRun(vertical.id, "new-campaign");
  updateRun(run.id, { note: `Manual launch on ACTIVE account ${label} — live immediately` });
  for (const f of files) addCreative(run.id, f.path, f.angle ?? undefined);
  updateRun(run.id, { status: "uploading" });

  const uploaded: { creativeId: number; videoId: string; imageHash?: string; angle: string | null }[] = [];
  for (const creative of listCreatives(run.id)) {
    if (!existsSync(creative.output_path)) {
      updateCreative(creative.id, { status: "error", error: "file missing" });
      continue;
    }
    try {
      const videoId = await uploadVideo(accountId, creative.output_path, basename(creative.output_path));
      let imageHash: string | undefined;
      try {
        const thumbPath = await extractThumbnail(creative.output_path);
        const image = await uploadImageFile(accountId, thumbPath);
        imageHash = image.hash;
        await unlink(thumbPath).catch(() => {});
      } catch (thumbError) {
        console.warn(`Thumbnail failed for ${creative.output_path}`, thumbError);
      }
      updateCreative(creative.id, { video_id: videoId, status: "uploaded" });
      uploaded.push({ creativeId: creative.id, videoId, imageHash, angle: creative.angle });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateCreative(creative.id, { status: "error", error: message });
    }
  }
  if (uploaded.length === 0) throw new Error(`Every video upload failed on ${label}`);

  const campaignId = await createCampaign(accountId, {
    name: campaignName,
    objective: vertical.meta.objective,
    specialAdCategories: vertical.meta.specialAdCategories,
    dailyBudget: vertical.meta.cboDailyBudgetCents,
    bidStrategy: vertical.meta.bidStrategy,
    status: "ACTIVE",
  });
  updateRun(run.id, { meta_campaign_id: campaignId });

  const adSetId = await createAdSet(accountId, {
    name: `${formatName(vertical.meta.naming.adSet, vertical, nowIso, 0)}${suffix}`,
    campaignId,
    bidAmount: vertical.meta.bidStrategy === "LOWEST_COST_WITH_BID_CAP" ? vertical.meta.bidCapCents : undefined,
    billingEvent: "IMPRESSIONS",
    optimizationGoal: vertical.meta.optimizationGoal,
    targeting: defaultUsTargeting(),
    promotedObject: { pixel_id: vertical.meta.pixelId, custom_event_type: vertical.meta.pixelEvent },
    status: "ACTIVE",
    // No startTime — spend starts as soon as ads are ACTIVE.
  });
  updateRun(run.id, { meta_adset_id: adSetId });

  let created = 0;
  for (let i = 0; i < uploaded.length; i++) {
    const item = uploaded[i]!;
    const baseName = `${formatName(vertical.meta.naming.ad, vertical, nowIso, i + 1)}${suffix}`;
    const name = item.angle ? `${baseName} [${item.angle}]` : baseName;
    try {
      const adId = await createAdFromVideo({
        adAccountId: accountId,
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateCreative(item.creativeId, { status: "error", error: message });
    }
  }
  if (created === 0) throw new Error(`Every ad creation failed on ${label}`);

  updateRun(run.id, { status: "live", go_live_at: nowIso, error: null });
  recordLaunch(accountId);
  console.log(`LIVE ${campaignName} on ${label} — ${created} ad(s), $${vertical.meta.cboDailyBudgetCents / 100}/day, run ${run.id}`);
  return run.id;
}

const vertical = loadVerticals().find((v) => v.enabled);
if (!vertical) throw new Error("No enabled vertical");
if (env.dryRun) throw new Error("DRY_RUN is on — refusing");

const targets: { id: string; label: string }[] = [];
for (const acct of CANDIDATES) {
  try {
    const health = await getAdAccountHealth(acct.id);
    if (health.accountStatus !== 1) {
      console.log(`Skip ${acct.label}: ${STATUS_NAMES[health.accountStatus] ?? health.accountStatus}`);
      continue;
    }
    targets.push(acct);
  } catch (error) {
    console.warn(`Skip ${acct.label}:`, error instanceof Error ? error.message : error);
  }
}
if (targets.length === 0) throw new Error("No ACTIVE accounts");

console.log(`ACTIVE targets (${targets.length}): ${targets.map((t) => t.label).join(", ")}`);
const files = await generateOnce(vertical);
if (files.length === 0) throw new Error("Creative generation produced no videos");
console.log(`Generated ${files.length} video(s). Publishing…`);

for (let i = 0; i < targets.length; i++) {
  const acct = targets[i]!;
  if (i > 0) {
    console.log(`Waiting ${GAP_MS / 1000}s before ${acct.label}…`);
    await sleep(GAP_MS);
  }
  try {
    await publishNow(vertical, acct.id, acct.label, files);
  } catch (error) {
    console.error(`FAILED ${acct.label}:`, error instanceof Error ? error.message : error);
  }
}
console.log("Done.");
process.exit(0);
