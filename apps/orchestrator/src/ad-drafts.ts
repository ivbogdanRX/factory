/**
 * Ad drafts: extra creatives generated on demand and reviewed in Slack BEFORE
 * anything touches Meta. Publishing a draft uploads the video as a new ad in
 * the most recent scheduled/live campaign's ad set for that vertical (e.g.
 * extra ads for tomorrow's 5am campaign), continuing the run's ad numbering.
 * Rejecting discards the draft; Meta is never called.
 */
import { basename } from "node:path";
import { unlink } from "node:fs/promises";
import {
  createAdDraft,
  updateAdDraft,
  getAdDraft,
  listAdDraftsByStatus,
  listAdDraftsByTargetRun,
  addCreative,
  updateCreative,
  listCreatives,
  listRuns,
  createRun,
  updateRun,
  getRun,
  type AdDraftRow,
  type RunRow,
} from "./db.js";
import { queueCreativeJob, waitForStudioJob } from "./creative.js";
import { loadAngles } from "./angles.js";
import { getVertical, type Vertical } from "./verticals.js";
import { formatName } from "./runner.js";
import {
  uploadVideo,
  extractThumbnail,
  uploadImageFile,
  createAdFromVideo,
  createCampaign,
  createAdSet,
  setObjectStatus,
  defaultUsTargeting,
  listCampaignNames,
} from "./meta.js";
import { notifyAdDraftReview, notifyManualBatchStarted, notifyInfo } from "./slack.js";
import { maybePushSnapshot } from "./push.js";

/**
 * The campaign a published draft joins: the newest run for the vertical that
 * has a real ad set and is still controllable (scheduled = tomorrow's 5am
 * campaign, live = already delivering).
 */
export function findPublishTargetRun(verticalId: string): RunRow | undefined {
  return listRuns(100).find(
    (r) =>
      r.vertical_id === verticalId &&
      (r.status === "scheduled" || r.status === "live") &&
      r.meta_adset_id !== null,
  );
}

/** Naming template with the run's tag, e.g. "{date}" → "{date} B". */
function taggedTemplate(template: string, tag: string | null): string {
  return tag ? template.replaceAll("{date}", `{date} ${tag}`) : template;
}

/** Reference date for a run's names: go-live when known, else creation. */
function runNameDateIso(run: RunRow): string {
  return run.go_live_at ?? new Date(run.created_at).toISOString();
}

/** The campaign name a run's naming template produces (for Slack copy). */
function campaignLabel(vertical: Vertical, run: RunRow): string {
  return formatName(taggedTemplate(vertical.meta.naming.campaign, run.name_tag), vertical, runNameDateIso(run), 0);
}

/**
 * Queue one draft per requested angle (e.g. ["ugc-selfie","ugc-selfie",
 * "rent-vet","debt-vet"]). Returns immediately; watchers post each finished
 * video to Slack with Publish/Reject buttons.
 */
export async function startAdDrafts(verticalId: string, angleIds: string[], targetRunId?: string): Promise<AdDraftRow[]> {
  const vertical = getVertical(verticalId);
  if (!vertical) throw new Error(`Unknown vertical: ${verticalId}`);
  const angles = loadAngles(vertical.creativeCampaignId);
  const rows: AdDraftRow[] = [];
  for (const angleId of angleIds) {
    const angle = angles.find((a) => a.id === angleId);
    if (!angle) throw new Error(`Unknown angle "${angleId}" in campaign ${vertical.creativeCampaignId}`);
    const row = createAdDraft({ verticalId, angle: angle.id, targetRunId });
    try {
      const job = await queueCreativeJob(vertical.creativeCampaignId, 1, angle.index);
      updateAdDraft(row.id, { studio_job_id: job.id });
      void watchAdDraft(row.id, job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateAdDraft(row.id, { status: "error", error: message });
      throw error;
    }
    rows.push(getAdDraft(row.id)!);
  }
  return rows;
}

async function watchAdDraft(id: string, jobId: string): Promise<void> {
  const draft = getAdDraft(id);
  try {
    const job = await waitForStudioJob(jobId);
    const output = job.outputs?.[0];
    if (!output) throw new Error("Studio job finished without an output video");
    updateAdDraft(id, { status: "pending", video_path: output, error: null });
    const row = getAdDraft(id)!;
    const vertical = getVertical(row.vertical_id);
    const target = row.target_run_id ? getRun(row.target_run_id) : findPublishTargetRun(row.vertical_id);
    // Manual-launch batches have no go-live time: explain the launch trigger.
    let targetNote: string | undefined;
    if (row.target_run_id && target && vertical) {
      const name = campaignLabel(vertical, target);
      targetNote =
        target.status === "live"
          ? `Approving adds it to *${name}* (already live — it starts spending right away).`
          : `Approving adds it to *${name}*, which launches the moment the whole batch is decided (or when you hit Launch now).`;
    }
    await notifyAdDraftReview({
      draftId: row.id,
      angle: row.angle,
      videoPath: output,
      verticalLabel: vertical?.label ?? row.vertical_id,
      goLiveAtIso: target?.go_live_at ?? null,
      targetNote,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateAdDraft(id, { status: "error", error: message });
    notifyInfo(
      `:rotating_light: Draft creative failed (angle *${draft?.angle ?? "?"}*): ${message}`,
    );
    // A dead render still counts as "decided" for the batch launch trigger.
    const row = getAdDraft(id);
    if (row?.target_run_id) void maybeAutoLaunchBatch(row.target_run_id);
  }
}

/** Re-attach watchers for drafts that were generating during a restart. */
export function resumeAdDraftWatches(): void {
  for (const draft of listAdDraftsByStatus("generating")) {
    if (draft.studio_job_id) {
      void watchAdDraft(draft.id, draft.studio_job_id);
    } else {
      updateAdDraft(draft.id, { status: "error", error: "Interrupted by orchestrator restart" });
    }
  }
}

function requirePendingDraft(id: string): AdDraftRow {
  const draft = getAdDraft(id);
  if (!draft) throw new Error(`Ad draft not found: ${id}`);
  if (draft.status !== "pending") {
    throw new Error(`Ad draft is already ${draft.status} — nothing to decide`);
  }
  if (!draft.video_path) throw new Error(`Ad draft ${id} has no video`);
  return draft;
}

/** Next ad number in the run, so published drafts continue v1..vN naming. */
function nextAdName(vertical: Vertical, run: RunRow, angle: string): string {
  const n = listCreatives(run.id).length + 1;
  const base = formatName(taggedTemplate(vertical.meta.naming.ad, run.name_tag), vertical, runNameDateIso(run), n);
  return `${base} [${angle}]`;
}

/**
 * Publish: upload the draft video to Meta and create an ACTIVE ad in the
 * target run's ad set (a scheduled campaign only delivers after its ad set
 * start_time, so "ACTIVE" simply means it rides along at go-live). The ad is
 * registered in the creatives table so guardrails, angle stats, per-ad
 * buttons and the digest treat it like any daily-run ad.
 *
 * Publishes are serialized: two near-simultaneous approvals would otherwise
 * both read the same ad count and mint duplicate v{n} names.
 */
let publishChain: Promise<unknown> = Promise.resolve();

export function publishAdDraft(id: string, userId?: string): Promise<AdDraftRow> {
  const next = publishChain.then(
    () => doPublishAdDraft(id, userId),
    () => doPublishAdDraft(id, userId),
  );
  publishChain = next.catch(() => {});
  return next;
}

async function doPublishAdDraft(id: string, userId?: string): Promise<AdDraftRow> {
  const draft = requirePendingDraft(id);
  const vertical = getVertical(draft.vertical_id);
  if (!vertical) throw new Error(`Unknown vertical: ${draft.vertical_id}`);
  const run = draft.target_run_id ? getRun(draft.target_run_id) : findPublishTargetRun(draft.vertical_id);
  if (!run || !run.meta_adset_id || !["scheduled", "live"].includes(run.status)) {
    throw new Error(`No scheduled or live campaign found for ${vertical.label} — run the daily pipeline first`);
  }

  // Guard against double-clicks: only one publish can move it out of pending.
  updateAdDraft(id, { status: "publishing" });
  try {
    const adName = nextAdName(vertical, run, draft.angle);
    const videoId = await uploadVideo(vertical.meta.adAccountId, draft.video_path!, basename(draft.video_path!));
    let imageHash: string | undefined;
    try {
      const thumbPath = await extractThumbnail(draft.video_path!);
      const image = await uploadImageFile(vertical.meta.adAccountId, thumbPath);
      imageHash = image.hash;
      await unlink(thumbPath).catch(() => {});
    } catch (thumbError) {
      console.warn(`Thumbnail extraction failed for draft ${id}; falling back to Meta's thumbnail`, thumbError);
    }
    const adId = await createAdFromVideo({
      adAccountId: vertical.meta.adAccountId,
      adSetId: run.meta_adset_id,
      pageId: vertical.meta.pageId,
      videoId,
      adName,
      copy: vertical.meta.adSettings,
      thumbnail: imageHash ? { imageHash } : {},
      status: "ACTIVE",
    });

    const creativeId = addCreative(run.id, draft.video_path!, draft.angle);
    updateCreative(creativeId, {
      video_id: videoId,
      ad_id: adId,
      ad_name: adName,
      status: run.status === "live" ? "live" : "scheduled",
    });
    updateAdDraft(id, { status: "published", ad_id: adId, ad_name: adName, error: null });

    const when =
      run.status === "live"
        ? "already-live campaign"
        : run.go_live_at
          ? "campaign going live at its scheduled time"
          : "campaign that launches once the batch is decided";
    notifyInfo(
      `:rocket: ${userId ? `<@${userId}> ` : ""}published draft *${adName}* into run \`${run.id}\` (${when}).`,
    );
    if (draft.target_run_id) await maybeAutoLaunchBatch(draft.target_run_id);
    return getAdDraft(id)!;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Back to pending so the button can be retried after a transient failure.
    updateAdDraft(id, { status: "pending", error: message });
    throw new Error(`Publishing failed (draft is still pending, try again): ${message}`);
  }
}

/** Reject: discard the draft. Meta is never touched. */
export async function rejectAdDraft(id: string, userId?: string): Promise<AdDraftRow> {
  const draft = requirePendingDraft(id);
  updateAdDraft(id, { status: "rejected" });
  notifyInfo(
    `:wastebasket: ${userId ? `<@${userId}> ` : ""}rejected draft creative (angle *${draft.angle}*) — nothing was uploaded to Meta.`,
  );
  if (draft.target_run_id) await maybeAutoLaunchBatch(draft.target_run_id);
  return getAdDraft(id)!;
}

// ---------------------------------------------------------------------------
// Manual-launch batches: a paused campaign created up front, filled by draft
// approvals, and activated the moment the whole batch is decided (or earlier
// via the Launch now button).
// ---------------------------------------------------------------------------

/**
 * Create a PAUSED CBO campaign + delivery-ready ad set right now (same
 * settings as the daily runner: budget, bid cap, pixel goal, special ad
 * category), then queue one draft per requested angle targeting it. Names get
 * a letter tag ("B", "C", ...) so a same-day second campaign never collides.
 */
export async function startManualLaunchBatch(
  verticalId: string,
  angleIds: string[],
): Promise<{ run: RunRow; campaignName: string; drafts: AdDraftRow[] }> {
  const vertical = getVertical(verticalId);
  if (!vertical) throw new Error(`Unknown vertical: ${verticalId}`);
  if (vertical.meta.mode !== "new-campaign") {
    throw new Error(`Manual-launch batches need new-campaign mode (got ${vertical.meta.mode})`);
  }
  if (angleIds.length === 0) throw new Error("At least one angle is required");

  const run = createRun(vertical.id, "new-campaign");
  try {
    // Pick the first free letter tag against the account's existing names.
    const nowIso = new Date(run.created_at).toISOString();
    const baseName = formatName(vertical.meta.naming.campaign, vertical, nowIso, 0);
    const existing = new Set(await listCampaignNames(vertical.meta.adAccountId));
    let tag = "B";
    while (existing.has(`${baseName} ${tag}`)) tag = String.fromCharCode(tag.charCodeAt(0) + 1);
    updateRun(run.id, { name_tag: tag });

    const campaignName = `${baseName} ${tag}`;
    const campaignId = await createCampaign(vertical.meta.adAccountId, {
      name: campaignName,
      objective: vertical.meta.objective,
      specialAdCategories: vertical.meta.specialAdCategories,
      dailyBudget: vertical.meta.cboDailyBudgetCents,
      bidStrategy: vertical.meta.bidStrategy,
      status: "PAUSED",
    });
    updateRun(run.id, { meta_campaign_id: campaignId });

    // Ad set is ACTIVE with no start_time: the paused campaign is the only
    // gate, so flipping it to ACTIVE at launch starts delivery immediately.
    const adSetId = await createAdSet(vertical.meta.adAccountId, {
      name: formatName(taggedTemplate(vertical.meta.naming.adSet, tag), vertical, nowIso, 0),
      campaignId,
      bidAmount: vertical.meta.bidStrategy === "LOWEST_COST_WITH_BID_CAP" ? vertical.meta.bidCapCents : undefined,
      billingEvent: "IMPRESSIONS",
      optimizationGoal: vertical.meta.optimizationGoal,
      targeting: defaultUsTargeting(),
      promotedObject: { pixel_id: vertical.meta.pixelId, custom_event_type: vertical.meta.pixelEvent },
      status: "ACTIVE",
    });
    // "scheduled" with go_live_at null = waiting for the batch decision; the
    // 30s go-live tick skips runs without a go_live_at.
    updateRun(run.id, {
      status: "scheduled",
      meta_adset_id: adSetId,
      note: `Manual-launch batch (${angleIds.length} drafts) — activates when every draft is decided, or via Launch now`,
    });

    const drafts = await startAdDrafts(verticalId, angleIds, run.id);
    await notifyManualBatchStarted({
      runId: run.id,
      campaignName,
      count: drafts.length,
      angles: angleIds,
      dailyBudgetUsd: vertical.meta.cboDailyBudgetCents / 100,
      bidCapUsd: vertical.meta.bidCapCents / 100,
    });
    void maybePushSnapshot(true);
    return { run: getRun(run.id)!, campaignName, drafts };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateRun(run.id, { status: "error", error: message });
    throw error;
  }
}

/**
 * Fires after every draft decision in a batch: once nothing is undecided and
 * at least one ad was published, the campaign goes live on the spot.
 */
async function maybeAutoLaunchBatch(runId: string): Promise<void> {
  const run = getRun(runId);
  // Only un-launched manual batches (scheduled + no go-live time) qualify.
  if (!run || run.status !== "scheduled" || run.go_live_at !== null) return;
  const drafts = listAdDraftsByTargetRun(runId);
  if (drafts.length === 0) return;
  if (drafts.some((d) => d.status === "generating" || d.status === "pending" || d.status === "publishing")) return;

  const published = drafts.filter((d) => d.status === "published").length;
  if (published === 0) {
    notifyInfo(
      `:no_entry_sign: Batch for run \`${runId}\` is fully decided with zero published ads — campaign stays paused.`,
    );
    return;
  }
  try {
    await launchRun(runId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notifyInfo(`:rotating_light: Auto-launch of run \`${runId}\` failed: ${message} — use the Launch now button to retry.`);
  }
}

/**
 * Activate a manual-launch campaign right now with however many ads are
 * published so far. Also the target of the Launch now Slack button. The
 * flight clock (flightDays auto-pause) starts here, not at creation.
 */
export async function launchRun(runId: string, userId?: string): Promise<RunRow> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (run.status === "live") throw new Error(`Run ${runId} is already live`);
  if (run.status !== "scheduled") throw new Error(`Run ${runId} is ${run.status} — it can't be launched`);
  if (!run.meta_campaign_id) throw new Error(`Run ${runId} has no Meta campaign`);
  const vertical = getVertical(run.vertical_id);
  if (!vertical) throw new Error(`Unknown vertical: ${run.vertical_id}`);

  const ads = listCreatives(run.id).filter((c) => c.ad_id && c.status !== "killed" && c.status !== "error");
  if (ads.length === 0) throw new Error("No published ads in this campaign yet — publish at least one draft first");

  await setObjectStatus(run.meta_campaign_id, "ACTIVE");
  // go_live_at = now: completeExpiredRuns counts flightDays from activation.
  updateRun(run.id, { status: "live", go_live_at: new Date().toISOString() });
  for (const creative of ads) {
    if (creative.status === "scheduled") updateCreative(creative.id, { status: "live" });
  }

  const name = campaignLabel(vertical, getRun(run.id)!);
  const stillPending = listAdDraftsByTargetRun(run.id).filter((d) => d.status === "pending" || d.status === "generating").length;
  notifyInfo(
    `:rocket: ${userId ? `<@${userId}> launched ` : ""}*${name}* is LIVE with ${ads.length} ad(s). ` +
      `Flight clock started now (${vertical.schedule.flightDays} days); guardrails and the budget ladder apply.` +
      (stillPending > 0 ? ` ${stillPending} draft(s) still in review — approving them adds ads to the live campaign.` : ""),
  );
  void maybePushSnapshot(true);
  return getRun(run.id)!;
}
