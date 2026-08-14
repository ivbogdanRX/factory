/**
 * One production batch, fanned out onto every ACTIVE ad account that is
 * already spending today. Generates the creatives once (so we don't slam
 * Veo 6×), then uploads the same videos as a fresh factory campaign on
 * each account, spaced out so Meta doesn't see a burst.
 *
 * Ads go live next-day 5am PT — same as the scheduled 10am drop.
 *
 * Usage: npx tsx apps/orchestrator/scripts/launch-on-spending.ts
 */
import { basename } from "node:path";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { loadVerticals, type Vertical } from "../src/verticals.js";
import { createRun, updateRun, addCreative, updateCreative, listCreatives, getRun } from "../src/db.js";
import { runVertical, formatName } from "../src/runner.js";
import {
  getAdAccountHealth,
  uploadVideo,
  extractThumbnail,
  uploadImageFile,
  createCampaign,
  createAdSet,
  createAdFromVideo,
  defaultUsTargeting,
} from "../src/meta.js";
import { nextDayStartIso } from "../src/schedule.js";
import { recordLaunch } from "../src/launch-guard.js";
import { notifyInfo, notifyError, notifyScheduled, notifyAdReview } from "../src/slack.js";
import { env } from "../src/env.js";

const SPENDING = [
  { id: "act_1580820796744259", label: "Spare ·4259", spend: 183.15 },
  { id: "act_1060126476705741", label: "Spare ·5741", spend: 112.56 },
  { id: "act_2641896642874778", label: "Spare ·4778", spend: 64.06 },
  { id: "act_1046718361084665", label: "Spare ·4665", spend: 30.89 },
  { id: "act_2503613803492275", label: "Spare ·2275", spend: 26.93 },
  { id: "act_2418227075367073", label: "Spare ·7073", spend: 22.1 },
];

const GAP_MS = 45_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tail = (id: string) => id.replace(/^act_/, "").slice(-4);

async function assertActive(accountId: string): Promise<void> {
  const health = await getAdAccountHealth(accountId);
  if (health.accountStatus !== 1) {
    throw new Error(`${accountId} is not ACTIVE (status ${health.accountStatus})`);
  }
}

async function publishToAccount(
  vertical: Vertical,
  accountId: string,
  label: string,
  files: { path: string; angle: string | null }[],
): Promise<string> {
  await assertActive(accountId);
  const v: Vertical = { ...vertical, meta: { ...vertical.meta, adAccountId: accountId } };
  const run = createRun(v.id, v.meta.mode);
  updateRun(run.id, { note: `Manual launch on spending account ${label}` });
  for (const f of files) addCreative(run.id, f.path, f.angle ?? undefined);

  const goLiveAt = nextDayStartIso(v.schedule.startHourPt);
  const suffix = ` X${tail(accountId)}`;
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

  const campaignName = `${formatName(v.meta.naming.campaign, v, goLiveAt, 0)}${suffix}`;
  const campaignId = await createCampaign(accountId, {
    name: campaignName,
    objective: v.meta.objective,
    specialAdCategories: v.meta.specialAdCategories,
    dailyBudget: v.meta.cboDailyBudgetCents,
    bidStrategy: v.meta.bidStrategy,
    status: "ACTIVE",
  });
  updateRun(run.id, { meta_campaign_id: campaignId });

  const adSetId = await createAdSet(accountId, {
    name: `${formatName(v.meta.naming.adSet, v, goLiveAt, 0)}${suffix}`,
    campaignId,
    bidAmount: v.meta.bidStrategy === "LOWEST_COST_WITH_BID_CAP" ? v.meta.bidCapCents : undefined,
    billingEvent: "IMPRESSIONS",
    optimizationGoal: v.meta.optimizationGoal,
    targeting: defaultUsTargeting(),
    promotedObject: { pixel_id: v.meta.pixelId, custom_event_type: v.meta.pixelEvent },
    status: "ACTIVE",
    startTime: goLiveAt,
  });
  updateRun(run.id, { meta_adset_id: adSetId });

  let created = 0;
  for (let i = 0; i < uploaded.length; i++) {
    const item = uploaded[i]!;
    const baseName = `${formatName(v.meta.naming.ad, v, goLiveAt, i + 1)}${suffix}`;
    const name = item.angle ? `${baseName} [${item.angle}]` : baseName;
    try {
      const adId = await createAdFromVideo({
        adAccountId: accountId,
        adSetId,
        pageId: v.meta.pageId,
        videoId: item.videoId,
        adName: name,
        copy: v.meta.adSettings,
        thumbnail: item.imageHash ? { imageHash: item.imageHash } : {},
        status: "ACTIVE",
      });
      updateCreative(item.creativeId, { ad_id: adId, ad_name: name, status: "scheduled" });
      created++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateCreative(item.creativeId, { status: "error", error: message });
    }
  }
  if (created === 0) throw new Error(`Every ad creation failed on ${label}`);

  updateRun(run.id, { status: "scheduled", go_live_at: goLiveAt, error: null });
  recordLaunch(accountId);
  notifyScheduled({
    runId: run.id,
    verticalLabel: `${v.label} ${label}`,
    adCount: created,
    goLiveAtIso: goLiveAt,
    adSetId,
    campaignId,
    campaignName,
  });
  void (async () => {
    for (const creative of listCreatives(run.id)) {
      if (!creative.ad_id) continue;
      await notifyAdReview({
        adId: creative.ad_id,
        adName: creative.ad_name ?? basename(creative.output_path),
        videoPath: creative.output_path,
        verticalLabel: `${v.label} ${label}`,
        goLiveAtIso: goLiveAt,
      });
    }
  })();
  return run.id;
}

const vertical = loadVerticals().find((v) => v.enabled);
if (!vertical) throw new Error("No enabled vertical");
if (env.dryRun) throw new Error("DRY_RUN is on — refusing to launch production");

const targets = [];
for (const acct of SPENDING) {
  try {
    await assertActive(acct.id);
    targets.push(acct);
  } catch (error) {
    console.warn(`Skipping ${acct.label}:`, error instanceof Error ? error.message : error);
  }
}
if (targets.length === 0) throw new Error("No ACTIVE spending accounts to launch on");

notifyInfo(
  `:rocket: *Manual production launch* — one creative batch, then upload to ${targets.length} spending account(s): ${targets.map((t) => `${t.label} ($${t.spend.toFixed(0)} today)`).join(", ")}. Live Saturday 5am PT. $100/day each.`,
);

const [first, ...rest] = targets;
console.log(`Generating once, then publishing to ${first!.label}…`);
const firstRunId = await runVertical({
  ...vertical,
  meta: { ...vertical.meta, adAccountId: first!.id },
});
recordLaunch(first!.id);
const firstRun = getRun(firstRunId);
const files = listCreatives(firstRunId)
  .filter((c) => c.output_path && existsSync(c.output_path))
  .map((c) => ({ path: c.output_path, angle: c.angle }));
if (files.length === 0) {
  notifyError(firstRunId, vertical.label, "Manual launch produced no video files — not fanning out");
  throw new Error(`First run ${firstRunId} produced no files (status=${firstRun?.status} error=${firstRun?.error})`);
}
console.log(`First run ${firstRunId} → ${firstRun?.status}; ${files.length} file(s). Fan-out to ${rest.length} more account(s).`);

for (const acct of rest) {
  console.log(`Waiting ${GAP_MS / 1000}s before ${acct.label}…`);
  await sleep(GAP_MS);
  try {
    const id = await publishToAccount(vertical, acct.id, acct.label, files);
    console.log(`Published ${id} on ${acct.label}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Fan-out failed on ${acct.label}:`, message);
    notifyError("manual-fanout", `${vertical.label} ${acct.label}`, message);
  }
}

console.log("Done.");
process.exit(0);
