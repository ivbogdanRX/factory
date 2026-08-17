/**
 * The daily pipeline: generate creatives via the vendored studio, upload them
 * to Meta, create ads scheduled for next-day 5am PT, and keep run state in
 * SQLite. Also implements pause / resume / kill and go-live activation.
 */
import { basename } from "node:path";
import { unlink } from "node:fs/promises";
import { env } from "./env.js";
import { loadVerticals, type Vertical } from "./verticals.js";
import {
  createRun,
  updateRun,
  getRun,
  listRuns,
  listRunsByStatus,
  addCreative,
  updateCreative,
  listCreatives,
  getCreativeByAdId,
  getSetting,
  setSetting,
  type RunRow,
  type CreativeRow,
} from "./db.js";
import { queueCreativeJob, waitForStudioJob } from "./creative.js";
import { pickAngles, angleStats } from "./angles.js";
import { getVertical } from "./verticals.js";
import { getPerformanceReport, formatPerformanceReport } from "./perf.js";
import { maybePushSnapshot } from "./push.js";
import {
  uploadVideo,
  extractThumbnail,
  uploadImageFile,
  getAdSetById,
  createCampaign,
  createAdSet,
  createAdFromVideo,
  setObjectStatus,
  defaultUsTargeting,
  getAdInsights,
} from "./meta.js";
import { nextDayStartIso, PT, todayInTimeZone } from "./schedule.js";
import { maybeExtendFlight, flightExtensionDays } from "./guardrails.js";
import { notifyRunStarted, notifyCreativesReady, notifyScheduled, notifyAdReview, notifyError, notifyInfo } from "./slack.js";

const activeRuns = new Set<string>();

/**
 * Fill a naming template. {date} is the go-live date in the user's M-D
 * convention (e.g. "8-12"), matching their manual "(IB) LNV 8-11" naming.
 * Exported for ad-drafts.ts so published drafts continue the same numbering.
 */
export function formatName(template: string, vertical: Vertical, goLiveIso: string, n: number): string {
  const goLive = new Date(goLiveIso);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: PT, month: "numeric", day: "numeric" }).formatToParts(goLive);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? "0";
  return template
    .replaceAll("{vertical}", vertical.label)
    .replaceAll("{date}", `${get("month")}-${get("day")}`)
    .replaceAll("{n}", String(n))
    .trim();
}

function validateVertical(v: Vertical): string | null {
  if (!v.creativeCampaignId) return "creativeCampaignId is not set";
  if (env.dryRun) return null;
  if (!env.metaToken) return "META_SYSTEM_USER_TOKEN is not set";
  if (!v.meta.adAccountId) return "meta.adAccountId is not set";
  if (!v.meta.pageId) return "meta.pageId is not set";
  if (v.meta.mode === "new-campaign") {
    if (!v.meta.pixelId) return "meta.pixelId is required for new-campaign mode";
    if (!v.meta.objective) return "meta.objective is required for new-campaign mode";
    if (!(v.meta.cboDailyBudgetCents > 0)) return "meta.cboDailyBudgetCents must be > 0";
    if (v.meta.bidStrategy === "LOWEST_COST_WITH_BID_CAP" && !(v.meta.bidCapCents > 0)) {
      return "meta.bidCapCents is required when bidStrategy is LOWEST_COST_WITH_BID_CAP";
    }
  }
  if (v.meta.mode === "new-adset" && !v.meta.parentCampaignId) return "meta.parentCampaignId is required for new-adset mode";
  if (v.meta.mode === "existing-adset" && !v.meta.existingAdSetId) return "meta.existingAdSetId is required for existing-adset mode";
  return null;
}

/** Status just changed — get it onto the hosted glance page immediately. */
function pushNow(): void {
  void maybePushSnapshot(true);
}

/** Run one vertical end to end. Returns the run id. */
export async function runVertical(vertical: Vertical): Promise<string> {
  const run = createRun(vertical.id, vertical.meta.mode);
  activeRuns.add(run.id);
  pushNow();
  try {
    const invalid = validateVertical(vertical);
    if (invalid) throw new Error(`Vertical "${vertical.id}" is not configured: ${invalid}`);

    notifyRunStarted(run.id, vertical.label, vertical.dailyCount);

    // 1. Generate creatives through the vendored studio. When the campaign
    // defines angle variants, pick today's mix weighted by past performance
    // and run one attributable job per creative.
    const angles = pickAngles(vertical.id, vertical.creativeCampaignId, vertical.dailyCount, vertical.angles);
    const outputs: string[] = [];
    const outputAngles: (string | null)[] = [];
    if (angles.length === 0) {
      const job = await queueCreativeJob(vertical.creativeCampaignId, vertical.dailyCount);
      const finished = await waitForStudioJob(job.id);
      for (const output of finished.outputs ?? []) {
        outputs.push(output);
        outputAngles.push(null);
        addCreative(run.id, output);
      }
    } else {
      notifyInfo(
        `:dart: *${vertical.label}* — today's angle mix: ${angles.map((a) => a.name).join(", ")}`,
      );
      const jobs = await Promise.all(
        angles.map((angle) => queueCreativeJob(vertical.creativeCampaignId, 1, angle.index)),
      );
      const results = await Promise.allSettled(jobs.map((job) => waitForStudioJob(job.id)));
      const failures: string[] = [];
      results.forEach((result, i) => {
        const angle = angles[i]!;
        if (result.status === "fulfilled") {
          for (const output of result.value.outputs ?? []) {
            outputs.push(output);
            outputAngles.push(angle.id);
            addCreative(run.id, output, angle.id);
          }
        } else {
          failures.push(`${angle.name}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
        }
      });
      if (failures.length > 0 && outputs.length > 0) {
        notifyInfo(`:warning: *${vertical.label}* — ${failures.length} creative job(s) failed, continuing with ${outputs.length}:\n${failures.map((f) => `> ${f}`).join("\n")}`);
      }
    }
    if (outputs.length === 0) throw new Error("Creative generation produced no outputs");
    notifyCreativesReady(run.id, vertical.label, outputs, outputAngles);
    pushNow();

    if (isCancelled(run.id)) return run.id;

    const goLiveAt = nextDayStartIso(vertical.schedule.startHourPt);

    if (env.dryRun) {
      updateRun(run.id, {
        status: "scheduled",
        go_live_at: goLiveAt,
        note: "DRY RUN — no Meta writes were made",
      });
      for (const creative of listCreatives(run.id)) {
        updateCreative(creative.id, { status: "dry-run" });
      }
      notifyInfo(
        `:test_tube: *${vertical.label}* — DRY RUN complete. ${outputs.length} creative(s) generated; Meta upload skipped. Would go live ${goLiveAt}.`,
      );
      return run.id;
    }

    // 2. Upload videos + thumbnails.
    updateRun(run.id, { status: "uploading" });
    const uploaded: { creativeId: number; videoId: string; imageHash?: string; angle: string | null }[] = [];
    for (const creative of listCreatives(run.id)) {
      try {
        const videoId = await uploadVideo(vertical.meta.adAccountId, creative.output_path, basename(creative.output_path));
        let imageHash: string | undefined;
        try {
          const thumbPath = await extractThumbnail(creative.output_path);
          const image = await uploadImageFile(vertical.meta.adAccountId, thumbPath);
          imageHash = image.hash;
          await unlink(thumbPath).catch(() => {});
        } catch (thumbError) {
          console.warn(`Thumbnail extraction failed for ${creative.output_path}; will fall back to Meta's thumbnail`, thumbError);
        }
        updateCreative(creative.id, { video_id: videoId, status: "uploaded" });
        uploaded.push({ creativeId: creative.id, videoId, imageHash, angle: creative.angle });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateCreative(creative.id, { status: "error", error: message });
      }
    }
    if (uploaded.length === 0) throw new Error("Every video upload failed — see creative errors in the portal");

    if (isCancelled(run.id)) return run.id;

    // 3. Resolve the target campaign + ad set.
    let adSetId = vertical.meta.existingAdSetId;
    let campaignId: string | undefined;
    let campaignName: string | undefined;
    if (vertical.meta.mode === "new-campaign") {
      // Fresh CBO campaign every day: budget lives on the campaign, ad set
      // carries pixel goal + targeting + the future start_time.
      campaignName = formatName(vertical.meta.naming.campaign, vertical, goLiveAt, 0);
      campaignId = await createCampaign(vertical.meta.adAccountId, {
        name: campaignName,
        objective: vertical.meta.objective,
        specialAdCategories: vertical.meta.specialAdCategories,
        dailyBudget: vertical.meta.cboDailyBudgetCents,
        bidStrategy: vertical.meta.bidStrategy,
        status: "ACTIVE",
      });
      updateRun(run.id, { meta_campaign_id: campaignId });

      adSetId = await createAdSet(vertical.meta.adAccountId, {
        name: formatName(vertical.meta.naming.adSet, vertical, goLiveAt, 0),
        campaignId,
        // No daily_budget: CBO campaigns own the budget.
        bidAmount: vertical.meta.bidStrategy === "LOWEST_COST_WITH_BID_CAP" ? vertical.meta.bidCapCents : undefined,
        billingEvent: "IMPRESSIONS",
        optimizationGoal: vertical.meta.optimizationGoal,
        targeting: defaultUsTargeting(),
        promotedObject: { pixel_id: vertical.meta.pixelId, custom_event_type: vertical.meta.pixelEvent },
        // ACTIVE with a future start_time: Meta will not spend until then.
        status: "ACTIVE",
        startTime: goLiveAt,
      });
    } else if (vertical.meta.mode === "new-adset") {
      const template = vertical.meta.templateAdSetId ? await getAdSetById(vertical.meta.templateAdSetId) : null;
      adSetId = await createAdSet(vertical.meta.adAccountId, {
        name: formatName(vertical.meta.naming.adSet, vertical, goLiveAt, 0),
        campaignId: vertical.meta.parentCampaignId,
        dailyBudget: template?.dailyBudget ?? vertical.meta.dailyBudgetCents,
        bidAmount: template?.bidAmount,
        bidStrategy: template?.bidStrategy,
        bidConstraints: template?.bidConstraints,
        billingEvent: template?.billingEvent ?? "IMPRESSIONS",
        optimizationGoal: template?.optimizationGoal ?? vertical.meta.optimizationGoal,
        targeting: defaultUsTargeting(template?.targeting),
        promotedObject: template?.promotedObject,
        status: "ACTIVE",
        startTime: goLiveAt,
      });
    }
    updateRun(run.id, { meta_adset_id: adSetId });

    // 4. Create the ads. In existing-adset mode the ad set is already live, so
    // ads start PAUSED and the go-live tick activates them at 5am next day.
    const initialAdStatus = vertical.meta.mode === "existing-adset" ? "PAUSED" : "ACTIVE";
    let created = 0;
    for (let i = 0; i < uploaded.length; i++) {
      const item = uploaded[i]!;
      const baseName = formatName(vertical.meta.naming.ad, vertical, goLiveAt, i + 1);
      // Angle tag in the ad name so performance is attributable in Ads Manager too.
      const name = item.angle ? `${baseName} [${item.angle}]` : baseName;
      try {
        const adId = await createAdFromVideo({
          adAccountId: vertical.meta.adAccountId,
          adSetId,
          pageId: vertical.meta.pageId,
          videoId: item.videoId,
          adName: name,
          copy: vertical.meta.adSettings,
          thumbnail: item.imageHash ? { imageHash: item.imageHash } : {},
          status: initialAdStatus,
        });
        updateCreative(item.creativeId, { ad_id: adId, ad_name: name, status: "scheduled" });
        created++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateCreative(item.creativeId, { status: "error", error: message });
      }
    }
    if (created === 0) throw new Error("Every ad creation failed — see creative errors in the portal");

    updateRun(run.id, { status: "scheduled", go_live_at: goLiveAt, error: null });
    notifyScheduled({ runId: run.id, verticalLabel: vertical.label, adCount: created, goLiveAtIso: goLiveAt, adSetId, campaignId, campaignName });
    // Per-video review: preview upload + pause/kill buttons for each ad.
    void (async () => {
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
    })();
    return run.id;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateRun(run.id, { status: "error", error: message });
    notifyError(run.id, vertical.label, message);
    return run.id;
  } finally {
    activeRuns.delete(run.id);
    pushNow();
  }
}

function isCancelled(runId: string): boolean {
  return getRun(runId)?.status === "cancelled";
}

/** Run every enabled vertical (the daily cron entry point). */
export async function runDaily(): Promise<void> {
  const verticals = loadVerticals().filter((v) => v.enabled);
  if (verticals.length === 0) {
    notifyInfo(":warning: Daily run triggered, but no verticals are enabled.");
    return;
  }
  // Media-buyer hat: report how yesterday's automated campaigns are doing
  // before launching today's batch.
  try {
    const report = await getPerformanceReport();
    if (report.length > 0) notifyInfo(formatPerformanceReport(report));
  } catch (error) {
    console.warn("Performance report failed", error);
  }
  for (const vertical of verticals) {
    await runVertical(vertical);
  }
}


// ---------------------------------------------------------------------------
// Run controls
// ---------------------------------------------------------------------------

async function setRunAdsStatus(run: RunRow, status: "ACTIVE" | "PAUSED"): Promise<void> {
  if (env.dryRun) return;
  if (run.mode === "new-campaign" && run.meta_campaign_id) {
    await setObjectStatus(run.meta_campaign_id, status);
    return;
  }
  if (run.mode === "new-adset" && run.meta_adset_id) {
    await setObjectStatus(run.meta_adset_id, status);
    return;
  }
  for (const creative of listCreatives(run.id)) {
    if (creative.ad_id) await setObjectStatus(creative.ad_id, status);
  }
}

export async function pauseRun(runId: string): Promise<RunRow> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (run.status !== "scheduled" && run.status !== "live") {
    throw new Error(`Run ${runId} is ${run.status} — nothing to pause`);
  }
  await setRunAdsStatus(run, "PAUSED");
  updateRun(runId, { status: "paused" });
  pushNow();
  return getRun(runId)!;
}

export async function resumeRun(runId: string): Promise<RunRow> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (run.status !== "paused") throw new Error(`Run ${runId} is ${run.status} — nothing to resume`);
  await setRunAdsStatus(run, "ACTIVE");
  const pastGoLive = run.go_live_at !== null && new Date(run.go_live_at).getTime() <= Date.now();
  updateRun(runId, { status: pastGoLive ? "live" : "scheduled" });
  pushNow();
  return getRun(runId)!;
}

export async function killRun(runId: string): Promise<RunRow> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (run.status === "cancelled") return run;
  if (run.status === "scheduled" || run.status === "live" || run.status === "paused") {
    await setRunAdsStatus(run, "PAUSED");
  }
  updateRun(runId, { status: "cancelled" });
  pushNow();
  return getRun(runId)!;
}

// ---------------------------------------------------------------------------
// Per-creative (single ad) controls — used by the Slack per-video buttons.
// ---------------------------------------------------------------------------

function requireCreative(adId: string): CreativeRow {
  const creative = getCreativeByAdId(adId);
  if (!creative) throw new Error(`No creative found for ad ${adId}`);
  return creative;
}

export async function pauseCreative(adId: string): Promise<CreativeRow> {
  const creative = requireCreative(adId);
  if (creative.status === "killed") throw new Error(`Ad ${creative.ad_name ?? adId} was killed — it can't be changed`);
  await setObjectStatus(adId, "PAUSED");
  updateCreative(creative.id, { status: "paused" });
  pushNow();
  return getCreativeByAdId(adId)!;
}

export async function resumeCreative(adId: string): Promise<CreativeRow> {
  const creative = requireCreative(adId);
  if (creative.status === "killed") throw new Error(`Ad ${creative.ad_name ?? adId} was killed — it can't be resumed`);
  await setObjectStatus(adId, "ACTIVE");
  const run = getRun(creative.run_id);
  const pastGoLive = run?.go_live_at != null && new Date(run.go_live_at).getTime() <= Date.now();
  updateCreative(creative.id, { status: pastGoLive ? "live" : "scheduled" });
  pushNow();
  return getCreativeByAdId(adId)!;
}

/** Permanently off: paused on Meta and never re-activated by the system. */
export async function killCreative(adId: string): Promise<CreativeRow> {
  const creative = requireCreative(adId);
  await setObjectStatus(adId, "PAUSED");
  updateCreative(creative.id, { status: "killed" });
  pushNow();
  return getCreativeByAdId(adId)!;
}

/** Find the most recent controllable run, optionally scoped to a vertical. */
export function findControllableRun(verticalId?: string): RunRow | undefined {
  return listRuns(100).find(
    (r) =>
      (r.status === "scheduled" || r.status === "live" || r.status === "paused") &&
      (!verticalId || r.vertical_id === verticalId),
  );
}

// ---------------------------------------------------------------------------
// Scheduler ticks (called from main.ts every 30s)
// ---------------------------------------------------------------------------

export async function activateDueRuns(): Promise<void> {
  for (const run of listRunsByStatus("scheduled")) {
    if (!run.go_live_at || new Date(run.go_live_at).getTime() > Date.now()) continue;
    try {
      // new-adset mode goes live by itself via ad set start_time; the paused
      // ads in existing-adset mode need an explicit flip.
      if (run.mode === "existing-adset") {
        await setRunAdsStatus(run, "ACTIVE");
      }
      updateRun(run.id, { status: "live" });
      notifyInfo(`:rocket: Run \`${run.id}\` (${run.vertical_id}) is now live.`);
      pushNow();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateRun(run.id, { status: "error", error: `Go-live activation failed: ${message}` });
      notifyError(run.id, run.vertical_id, `Go-live activation failed: ${message}`);
    }
  }
}

/**
 * End-of-flight: pause campaigns that have been live for the vertical's
 * flightDays, pull final per-ad numbers, and report the angle breakdown.
 */
let completingExpired = false;

export async function completeExpiredRuns(): Promise<void> {
  if (completingExpired) return;
  completingExpired = true;
  try {
    await completeExpiredRunsOnce();
  } finally {
    completingExpired = false;
  }
}

async function completeExpiredRunsOnce(): Promise<void> {
  for (const run of listRunsByStatus("live")) {
    if (!run.go_live_at) continue;
    const vertical = getVertical(run.vertical_id);
    // Winner extensions (guardrail Rule C) stretch the flight past flightDays.
    const flightDays = (vertical?.schedule.flightDays ?? 3) + flightExtensionDays(run.id);
    const endsAt = new Date(run.go_live_at).getTime() + flightDays * 24 * 60 * 60 * 1000;
    if (endsAt > Date.now()) continue;

    // Guardrail Rule C: a winning campaign (RedTrack CPA under the threshold)
    // earns another day instead of being paused, up to the extension cap.
    try {
      if (await maybeExtendFlight(run)) continue;
    } catch (error) {
      console.warn(`Flight extension check failed for run ${run.id}`, error);
    }

    try {
      await setRunAdsStatus(run, "PAUSED");

      // Final lifetime numbers per ad → stored on the creative, keyed by angle.
      const lines: string[] = [];
      for (const creative of listCreatives(run.id)) {
        if (!creative.ad_id) continue;
        try {
          const m = await getAdInsights(creative.ad_id);
          updateCreative(creative.id, {
            spend: m.spend,
            purchases: m.purchases,
            impressions: m.impressions,
            clicks: m.clicks,
          });
          const cpa = m.purchases > 0 ? `$${(m.spend / m.purchases).toFixed(2)}` : "—";
          lines.push(`> ${creative.ad_name ?? creative.ad_id}${creative.angle ? ` _[${creative.angle}]_` : ""}: $${m.spend.toFixed(2)}, ${m.purchases} purchase(s), CPA ${cpa}`);
        } catch (error) {
          console.warn(`Final insights failed for ad ${creative.ad_id}`, error);
        }
      }

      updateRun(run.id, { status: "completed", note: `Flight ended after ${flightDays} day(s), campaign paused` });

      let angleSummary = "";
      if (vertical) {
        const stats = angleStats(vertical.id, vertical.creativeCampaignId).filter((s) => s.creatives > 0);
        if (stats.length > 0) {
          const ranked = [...stats].sort((a, b) => b.weight - a.weight);
          angleSummary =
            `\n*Angle totals so far (all flights):*\n` +
            ranked
              .map((s) => `> *${s.name}*: $${s.spend.toFixed(2)} over ${s.creatives} ad(s), ${s.purchases} purchase(s), CPA ${s.costPerPurchase !== null ? `$${s.costPerPurchase.toFixed(2)}` : "—"}`)
              .join("\n") +
            `\nTomorrow's mix leans toward *${ranked[0]!.name}*.`;
        }
      }
      notifyInfo(
        `:checkered_flag: *${run.vertical_id}* — run \`${run.id}\` finished its ${flightDays}-day flight; campaign paused.\n${lines.join("\n")}${angleSummary}`,
      );
      pushNow();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Disabled / unsettled accounts cannot accept writes. Stay "live" and
      // Slack every 30s tick used to spam #ad-factory. Close the run once.
      updateRun(run.id, {
        status: "completed",
        error: `Flight auto-off failed: ${message}`,
        note: "Flight ended; Meta refused the pause (account likely disabled). Not retrying.",
      });
      notifyError(run.id, run.vertical_id, `Flight auto-off failed: ${message}`);
      pushNow();
    }
  }
}

export function maybeStartDailyRun(currentHourPt: number, currentMinute: number): void {
  const runHour = Number(getSetting("runHourPt") ?? env.runHourPt);
  if (currentHourPt !== runHour || currentMinute > 4) return;

  const today = todayInTimeZone(PT);
  if (getSetting("lastDailyRunDate") === today) return;
  setSetting("lastDailyRunDate", today);

  if (getSetting("globalPause") === "1") {
    notifyInfo(":double_vertical_bar: Daily run skipped — global pause is on.");
    return;
  }
  if (getSetting("skipNext") === "1") {
    setSetting("skipNext", "0");
    notifyInfo(":fast_forward: Daily run skipped once (requested via /adops skip).");
    return;
  }
  void runDaily();
}

export function hasActiveRuns(): boolean {
  return activeRuns.size > 0;
}
