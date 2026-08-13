/**
 * Server-side Meta Graph client, ported from vendor/ads-uploader/src/lib/meta.ts.
 * Talks straight to graph.facebook.com with the system-user token from env —
 * no Vite proxy, no browser, no VITE_* client bundle exposure.
 */
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { env } from "./env.js";
import { getSetting, setSetting } from "./db.js";
import { postSlack } from "./slack.js";

const execFileAsync = promisify(execFile);

const GRAPH = () => `https://graph.facebook.com/${env.graphVersion}`;

function formatMetaError(errData: unknown, fallback: string): string {
  const err = (errData as { error?: { error_user_msg?: string; message?: string } })?.error;
  return err?.error_user_msg || err?.message || fallback;
}

function isTransientNetworkError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /fetch failed|networkerror|econnreset|etimedout|socket hang up|ssl|timed?\s*out/i.test(msg);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function fetchWithRetry(url: string, init: RequestInit | undefined, label: string, retries = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
      if (!isTransientNetworkError(error) || attempt === retries) throw error;
      const waitMs = 800 * (attempt + 1);
      console.warn(`${label}: transient network error, retry ${attempt + 1}/${retries} in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ---------------------------------------------------------------------------
// Write governor — added after Meta restricted the main ad account for
// "Account Integrity" (2026-08-13). The trigger pattern was machine-speed bulk
// creation: 7 identical cloned campaigns (~60 write calls) across 7 ad
// accounts inside 6 minutes, on top of two daily-run campaigns and a manual
// batch the same day. Every mutating Graph call now passes gateWrite():
//   1. Pacing — consecutive writes are spaced env.metaWriteSpacingSeconds
//      apart, so no burst ever looks like machine-gun bulk activity.
//   2. Caps — rolling 24h ceilings on total writes and on campaign creations;
//      hitting one aborts loudly instead of hammering on.
//   3. Circuit breaker — the first restriction/integrity error from Meta trips
//      a persistent breaker: all further creation writes are refused (and
//      Slack alerted once) until the account status is fixed and the breaker
//      cleared. Pause/kill status changes bypass the governor entirely:
//      cutting spend off must never be blocked.
// State lives in the settings table, so one-off scripts (clone-winner etc.)
// share the same pace and daily budget as the orchestrator process.
// ---------------------------------------------------------------------------

const BREAKER_KEY = "meta_write_breaker";
const WRITE_LOG_KEY = "meta_write_log";
const DAY_MS = 24 * 60 * 60 * 1000;

interface WriteLogEntry {
  t: number;
  kind: string;
}

interface BreakerState {
  at: string;
  label: string;
  message: string;
}

/** Pause/kill must always go through — never block shutting spend off. */
function isSafetyWrite(label: string): boolean {
  return label === "setStatus:PAUSED" || label === "setStatus:DELETED";
}

export function getWriteBreaker(): BreakerState | null {
  const raw = getSetting(BREAKER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BreakerState;
  } catch {
    return { at: "unknown", label: "unknown", message: raw };
  }
}

export function clearWriteBreaker(): void {
  setSetting(BREAKER_KEY, "");
}

const INTEGRITY_ERROR =
  /not eligible for write|account.{0,40}(restricted|disabled)|integrity|deemed abusive|unusual activity|policy violation/i;

/** Trip the breaker (once) when Meta signals a restriction, not a normal validation error. */
function maybeTripBreaker(message: string, label: string): void {
  if (!INTEGRITY_ERROR.test(message)) return;
  if (getWriteBreaker()) return;
  setSetting(BREAKER_KEY, JSON.stringify({ at: new Date().toISOString(), label, message } satisfies BreakerState));
  console.error(`Meta write breaker TRIPPED by ${label}: ${message}`);
  void postSlack(
    `:rotating_light: *Meta write breaker tripped* — \`${label}\` hit a restriction/integrity error:\n> ${message}\n` +
      `All campaign/ad creation writes are now disabled (pause/kill still work). ` +
      `Resolve the account status in Business Support, then clear the breaker:\n` +
      '`sqlite3 data/ad-factory.db "UPDATE settings SET value=\'\' WHERE key=\'meta_write_breaker\'"`',
  ).catch(() => {});
}

function loadWriteLog(): WriteLogEntry[] {
  const cutoff = Date.now() - DAY_MS;
  try {
    const entries = JSON.parse(getSetting(WRITE_LOG_KEY) || "[]") as WriteLogEntry[];
    return entries.filter((e) => Number(e.t) > cutoff);
  } catch {
    return [];
  }
}

/** Gate every mutating Graph call: breaker check, 24h caps, then pacing. */
async function gateWrite(label: string): Promise<void> {
  if (isSafetyWrite(label)) return;

  const breaker = getWriteBreaker();
  if (breaker) {
    throw new Error(
      `Meta writes disabled — breaker tripped ${breaker.at} by ${breaker.label}: ${breaker.message} ` +
        `Fix the account status, then clear the '${BREAKER_KEY}' settings key.`,
    );
  }

  const log = loadWriteLog();
  if (log.length >= env.metaMaxWrites24h) {
    throw new Error(
      `Meta write cap reached (${env.metaMaxWrites24h} writes in 24h) — refusing '${label}'. ` +
        `This cap exists so automation can never look like bulk machine activity again.`,
    );
  }
  if (label === "createCampaign") {
    const creates = log.filter((e) => e.kind === "createCampaign").length;
    if (creates >= env.metaMaxCampaignCreates24h) {
      throw new Error(
        `Campaign-creation cap reached (${env.metaMaxCampaignCreates24h} in 24h) — refusing to create another campaign. ` +
          `Fanning out clones across accounts in one day is what got the main account restricted.`,
      );
    }
  }

  const last = log.reduce((max, e) => Math.max(max, e.t), 0);
  const waitMs = last + env.metaWriteSpacingSeconds * 1000 - Date.now();
  if (waitMs > 0) await sleep(waitMs);

  log.push({ t: Date.now(), kind: label });
  setSetting(WRITE_LOG_KEY, JSON.stringify(log));
}

async function postForm(path: string, params: Record<string, string>, label: string): Promise<Record<string, unknown>> {
  await gateWrite(label);
  const body = new URLSearchParams(params);
  const response = await fetchWithRetry(
    `${GRAPH()}/${path}?access_token=${encodeURIComponent(env.metaToken)}`,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() },
    label,
  );
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || (data as { error?: unknown }).error) {
    const message = formatMetaError(data, `${label} failed (${response.status})`);
    maybeTripBreaker(message, label);
    throw new Error(message);
  }
  return data;
}

async function getJson(path: string, label: string): Promise<Record<string, unknown>> {
  const sep = path.includes("?") ? "&" : "?";
  const response = await fetchWithRetry(
    `${GRAPH()}/${path}${sep}access_token=${encodeURIComponent(env.metaToken)}`,
    undefined,
    label,
  );
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || (data as { error?: unknown }).error) {
    throw new Error(formatMetaError(data, `${label} failed (${response.status})`));
  }
  return data;
}

// ---------------------------------------------------------------------------
// Video upload (chunked resumable, ported from uploadVideoToMeta)
// ---------------------------------------------------------------------------

async function waitForVideoReady(videoId: string): Promise<void> {
  const maxAttempts = 120; // up to ~5 minutes of Meta-side processing
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const data = await getJson(`${videoId}?fields=status`, "video status");
    const status = (data.status ?? {}) as {
      video_status?: string;
      processing_phase?: { status?: string; errors?: { message?: string }[] };
    };
    const videoStatus = String(status.video_status ?? "").toLowerCase();
    const processing = String(status.processing_phase?.status ?? "").toLowerCase();
    if (videoStatus === "ready" || processing === "complete") return;
    if (videoStatus === "error" || processing === "error" || processing === "failed") {
      throw new Error(status.processing_phase?.errors?.[0]?.message ?? "Meta could not process the video");
    }
    await sleep(2500);
  }
  throw new Error("Video uploaded, but Meta did not finish processing it within five minutes");
}

export async function uploadVideo(adAccountId: string, filePath: string, title: string): Promise<string> {
  await gateWrite("uploadVideo");
  const buffer = await readFile(filePath);
  if (buffer.length === 0) throw new Error(`Video file is empty: ${filePath}`);
  const fileName = basename(filePath);
  const endpoint = `${GRAPH()}/${adAccountId}/advideos?access_token=${encodeURIComponent(env.metaToken)}`;

  const MAX_ATTEMPTS = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) await sleep(1000 * attempt);

      const initForm = new FormData();
      initForm.append("upload_phase", "start");
      initForm.append("file_size", String(buffer.length));
      const initRes = await fetchWithRetry(endpoint, { method: "POST", body: initForm }, `advideos:start:${fileName}`);
      const initData = (await initRes.json().catch(() => ({}))) as Record<string, unknown>;
      if (!initRes.ok) throw new Error(formatMetaError(initData, "Failed to init video upload"));
      const uploadSessionId = String(initData.upload_session_id ?? "");
      const videoId = String(initData.video_id ?? "");
      if (!uploadSessionId || !videoId) throw new Error("Meta did not return a video upload session");

      const FALLBACK_CHUNK = 4 * 1024 * 1024;
      let startOffset = Number(initData.start_offset ?? 0);
      let endOffset = Number(initData.end_offset ?? Math.min(FALLBACK_CHUNK, buffer.length));

      while (startOffset < buffer.length) {
        const requestedEnd = endOffset > startOffset
          ? Math.min(endOffset, buffer.length)
          : Math.min(startOffset + FALLBACK_CHUNK, buffer.length);
        const chunk = buffer.subarray(startOffset, requestedEnd);

        const form = new FormData();
        form.append("upload_phase", "transfer");
        form.append("upload_session_id", uploadSessionId);
        form.append("start_offset", String(startOffset));
        form.append("video_file_chunk", new Blob([new Uint8Array(chunk)]), fileName);
        const res = await fetchWithRetry(endpoint, { method: "POST", body: form }, `advideos:transfer:${fileName}@${startOffset}`, 4);
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) throw new Error(formatMetaError(data, "Chunk upload failed"));

        const nextStart = Number(data.start_offset);
        const nextEnd = Number(data.end_offset);
        if (!Number.isFinite(nextStart) || nextStart <= startOffset) {
          throw new Error("Meta video upload stalled at the same byte offset");
        }
        startOffset = nextStart;
        endOffset = Number.isFinite(nextEnd) ? nextEnd : startOffset + FALLBACK_CHUNK;
      }

      const finishForm = new FormData();
      finishForm.append("upload_phase", "finish");
      finishForm.append("upload_session_id", uploadSessionId);
      finishForm.append("title", title);
      const finishRes = await fetchWithRetry(endpoint, { method: "POST", body: finishForm }, `advideos:finish:${fileName}`);
      const finishData = (await finishRes.json().catch(() => ({}))) as Record<string, unknown>;
      if (!finishRes.ok) throw new Error(formatMetaError(finishData, "Failed to finish video upload"));

      await waitForVideoReady(videoId);
      return videoId;
    } catch (error) {
      lastError = error;
      maybeTripBreaker(error instanceof Error ? error.message : String(error), "uploadVideo");
      if (!isTransientNetworkError(error) || attempt === MAX_ATTEMPTS) throw error;
      console.warn(`Retrying video upload "${fileName}" (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ---------------------------------------------------------------------------
// Thumbnails — extract the first frame with ffmpeg, upload as an ad image
// ---------------------------------------------------------------------------

export async function uploadImageFile(adAccountId: string, filePath: string): Promise<{ hash: string; url?: string }> {
  await gateWrite("adimages");
  const buffer = await readFile(filePath);
  const form = new FormData();
  form.append("filename", new Blob([new Uint8Array(buffer)], { type: "image/jpeg" }), basename(filePath));
  const res = await fetchWithRetry(
    `${GRAPH()}/${adAccountId}/adimages?access_token=${encodeURIComponent(env.metaToken)}`,
    { method: "POST", body: form },
    "adimages",
  );
  const data = (await res.json().catch(() => ({}))) as { images?: Record<string, { hash?: string; url?: string }>; error?: unknown };
  if (!res.ok || data.error) {
    const message = formatMetaError(data, "Failed to upload image");
    maybeTripBreaker(message, "adimages");
    throw new Error(message);
  }
  const firstKey = data.images ? Object.keys(data.images)[0] : undefined;
  const info = firstKey ? data.images![firstKey] : undefined;
  if (!info?.hash) throw new Error("Meta accepted the image but returned no hash");
  return { hash: info.hash, url: info.url };
}

/** First decodable frame → JPEG via ffmpeg (server-side replacement for the browser canvas path). */
export async function extractThumbnail(videoPath: string): Promise<string> {
  const out = join(tmpdir(), `adf-thumb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`);
  await execFileAsync("ffmpeg", ["-y", "-ss", "0.1", "-i", videoPath, "-frames:v", "1", "-q:v", "2", out]);
  return out;
}

/** Fallback: Meta-hosted thumbnail for an already-uploaded video. */
export async function getVideoThumbnailUrl(videoId: string): Promise<string | null> {
  try {
    const fields = encodeURIComponent("picture,thumbnails.limit(20){uri,is_preferred}");
    const data = (await getJson(`${videoId}?fields=${fields}`, "video thumbnail")) as {
      picture?: string;
      thumbnails?: { data?: { uri?: string; is_preferred?: boolean }[] };
    };
    const thumbs = data.thumbnails?.data ?? [];
    const preferred = thumbs.find((t) => t.is_preferred);
    return preferred?.uri ?? thumbs[0]?.uri ?? data.picture ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Targeting defaults (ported from targeting.ts buildUsTargeting)
// ---------------------------------------------------------------------------

const FACEBOOK_POSITIONS = ["feed", "right_hand_column", "marketplace", "story", "search", "instream_video", "facebook_reels"];
const INSTAGRAM_POSITIONS = ["stream", "story", "explore", "reels", "profile_feed", "ig_search"];

export function defaultUsTargeting(base?: Record<string, unknown>): Record<string, unknown> {
  const targeting: Record<string, unknown> = {
    ...(base ?? {}),
    geo_locations: (base?.geo_locations as Record<string, unknown>) ?? { countries: ["US"] },
    age_min: typeof base?.age_min === "number" ? base.age_min : 18,
    age_max: typeof base?.age_max === "number" ? base.age_max : 65,
    publisher_platforms: ["facebook", "instagram"],
    facebook_positions: [...FACEBOOK_POSITIONS],
    instagram_positions: [...INSTAGRAM_POSITIONS],
  };
  // SAC rejects exclusions; and drop AN/Messenger if cloned from a source ad set.
  delete targeting.excluded_geo_locations;
  delete targeting.device_platforms;
  delete targeting.messenger_positions;
  delete targeting.audience_network_positions;
  return targeting;
}

// ---------------------------------------------------------------------------
// Campaigns (CBO)
// ---------------------------------------------------------------------------

export interface CreateCampaignParams {
  name: string;
  objective: string;
  specialAdCategories: string[];
  /** Campaign-level (CBO) daily budget in cents. */
  dailyBudget: number;
  bidStrategy: string;
  status?: "ACTIVE" | "PAUSED";
}

export async function createCampaign(adAccountId: string, params: CreateCampaignParams): Promise<string> {
  const data = await postForm(
    `${adAccountId}/campaigns`,
    {
      name: params.name,
      objective: params.objective,
      special_ad_categories: JSON.stringify(params.specialAdCategories),
      daily_budget: String(params.dailyBudget),
      bid_strategy: params.bidStrategy,
      status: params.status ?? "PAUSED",
    },
      "createCampaign",
  );
  return String(data.id);
}

/** Recent campaign names in the account (for same-day naming collisions). */
export async function listCampaignNames(adAccountId: string): Promise<string[]> {
  const data = await getJson(`${adAccountId}/campaigns?fields=name&limit=200`, "listCampaigns");
  return ((data.data ?? []) as { name?: string }[]).map((c) => String(c.name ?? ""));
}

/** Current CBO daily budget in cents; null when the field is unavailable. */
export async function getCampaignDailyBudgetCents(campaignId: string): Promise<number | null> {
  const data = await getJson(`${campaignId}?fields=daily_budget,name`, "getCampaignBudget");
  const cents = Number(data.daily_budget);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

/** Update a CBO campaign's daily budget (used by the guardrail scale ladder). */
export async function setCampaignDailyBudgetCents(campaignId: string, cents: number): Promise<void> {
  await postForm(campaignId, { daily_budget: String(Math.round(cents)) }, "setCampaignBudget");
}

// ---------------------------------------------------------------------------
// Insights (spend / purchases for monitoring)
// ---------------------------------------------------------------------------

export interface CampaignInsights {
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  costPerPurchase: number | null;
}

export async function getCampaignInsights(
  campaignId: string,
  datePreset: "today" | "yesterday" | "last_7d" | "maximum" = "today",
): Promise<CampaignInsights | null> {
  const fields = "spend,impressions,clicks,actions";
  const data = (await getJson(
    `${campaignId}/insights?fields=${fields}&date_preset=${datePreset}`,
    "campaignInsights",
  )) as { data?: Array<Record<string, unknown>> };
  const row = data.data?.[0];
  if (!row) return null;
  const actions = (row.actions ?? []) as Array<{ action_type?: string; value?: string }>;
  const purchases = actions
    .filter((a) => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase")
    .reduce((max, a) => Math.max(max, Number(a.value ?? 0)), 0);
  const spend = Number(row.spend ?? 0);
  return {
    spend,
    impressions: Number(row.impressions ?? 0),
    clicks: Number(row.clicks ?? 0),
    purchases,
    costPerPurchase: purchases > 0 ? spend / purchases : null,
  };
}

export interface AdInsights {
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
}

/** Lifetime metrics for one ad (flights are short, so lifetime = the flight). */
export async function getAdInsights(adId: string): Promise<AdInsights> {
  const data = (await getJson(
    `${adId}/insights?fields=spend,impressions,clicks,actions&date_preset=maximum`,
    "adInsights",
  )) as { data?: Array<Record<string, unknown>> };
  const row = data.data?.[0];
  const actions = ((row?.actions ?? []) as Array<{ action_type?: string; value?: string }>);
  const purchases = actions
    .filter((a) => a.action_type === "purchase" || a.action_type === "offsite_conversion.fb_pixel_purchase")
    .reduce((max, a) => Math.max(max, Number(a.value ?? 0)), 0);
  return {
    spend: Number(row?.spend ?? 0),
    impressions: Number(row?.impressions ?? 0),
    clicks: Number(row?.clicks ?? 0),
    purchases,
  };
}

// ---------------------------------------------------------------------------
// Health monitoring (ad review status + account status)
// ---------------------------------------------------------------------------

export interface AdStatusInfo {
  name: string;
  effectiveStatus: string;
}

/** Batched name/effective_status lookup — one Graph call per 50 ads. */
export async function getAdStatuses(adIds: string[]): Promise<Map<string, AdStatusInfo>> {
  const out = new Map<string, AdStatusInfo>();
  for (let i = 0; i < adIds.length; i += 50) {
    const chunk = adIds.slice(i, i + 50);
    const data = await getJson(
      `?ids=${chunk.join(",")}&fields=name,effective_status`,
      "adStatuses",
    );
    for (const id of chunk) {
      const row = data[id] as { name?: string; effective_status?: string } | undefined;
      if (row) {
        out.set(id, {
          name: String(row.name ?? id),
          effectiveStatus: String(row.effective_status ?? "UNKNOWN"),
        });
      }
    }
  }
  return out;
}

export interface AdAccountHealth {
  /** Meta numeric code: 1=ACTIVE, 2=DISABLED, 3=UNSETTLED, 9=IN_GRACE_PERIOD, ... */
  accountStatus: number;
  disableReason: number;
}

export async function getAdAccountHealth(adAccountId: string): Promise<AdAccountHealth> {
  const data = await getJson(`${adAccountId}?fields=account_status,disable_reason`, "adAccountHealth");
  return {
    accountStatus: Number(data.account_status ?? 0),
    disableReason: Number(data.disable_reason ?? 0),
  };
}

export interface ProblemAd {
  id: string;
  name: string;
  effectiveStatus: string;
  campaignName: string | null;
}

/**
 * Account-wide scan for ads Meta has flagged: one filtered Graph call
 * (paginated if needed) returning only DISAPPROVED / WITH_ISSUES ads across
 * every campaign — manual and automated alike.
 */
export async function listProblemAds(adAccountId: string): Promise<ProblemAd[]> {
  const filtering = encodeURIComponent(
    JSON.stringify([{ field: "effective_status", operator: "IN", value: ["DISAPPROVED", "WITH_ISSUES"] }]),
  );
  const fields = encodeURIComponent("name,effective_status,campaign{name}");
  const out: ProblemAd[] = [];
  let after = "";
  for (let page = 0; page < 5; page++) {
    const data = (await getJson(
      `${adAccountId}/ads?fields=${fields}&filtering=${filtering}&limit=200${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      "listProblemAds",
    )) as {
      data?: Array<{ id?: string; name?: string; effective_status?: string; campaign?: { name?: string } }>;
      paging?: { cursors?: { after?: string }; next?: string };
    };
    for (const row of data.data ?? []) {
      if (!row.id) continue;
      out.push({
        id: String(row.id),
        name: String(row.name ?? row.id),
        effectiveStatus: String(row.effective_status ?? "UNKNOWN"),
        campaignName: row.campaign?.name ? String(row.campaign.name) : null,
      });
    }
    if (!data.paging?.next || !data.paging.cursors?.after) break;
    after = data.paging.cursors.after;
  }
  return out;
}

export interface AdCreativeDetails {
  creativeId: string | null;
  pageId: string | null;
  link: string | null;
}

/**
 * The creative an ad points at, plus the Facebook page and landing link it
 * promotes (needed to build a matching placeholder creative).
 */
export async function getAdCreativeDetails(adId: string): Promise<AdCreativeDetails> {
  const fields = encodeURIComponent("creative{id,object_story_spec,effective_object_story_id}");
  const data = (await getJson(`${adId}?fields=${fields}`, "adCreativeDetails")) as {
    creative?: {
      id?: string;
      effective_object_story_id?: string;
      object_story_spec?: {
        page_id?: string | number;
        link_data?: { link?: string };
        video_data?: { call_to_action?: { value?: { link?: string } } };
      };
    };
  };
  const spec = data.creative?.object_story_spec;
  let pageId = spec?.page_id ? String(spec.page_id) : null;
  if (!pageId && data.creative?.effective_object_story_id?.includes("_")) {
    pageId = data.creative.effective_object_story_id.split("_")[0]!;
  }
  const link = spec?.link_data?.link ?? spec?.video_data?.call_to_action?.value?.link ?? null;
  return { creativeId: data.creative?.id ? String(data.creative.id) : null, pageId, link };
}

/** The creative id an ad currently points at; null when unavailable. */
export async function getAdCreativeId(adId: string): Promise<string | null> {
  try {
    const data = (await getJson(`${adId}?fields=creative`, "adCreativeId")) as {
      creative?: { id?: string };
    };
    return data.creative?.id ? String(data.creative.id) : null;
  } catch {
    return null;
  }
}

/** Simple single-image link creative (used for the compliance placeholder). */
export async function createImageCreative(
  adAccountId: string,
  options: { name: string; pageId: string; imageHash: string; message: string; link: string },
): Promise<string> {
  const data = await postForm(
    `${adAccountId}/adcreatives`,
    {
      name: options.name,
      object_story_spec: JSON.stringify({
        page_id: options.pageId,
        link_data: {
          image_hash: options.imageHash,
          link: options.link,
          message: options.message,
        },
      }),
    },
    "createImageCreative",
  );
  return String(data.id);
}

/** Point an existing ad at a different creative (triggers Meta re-review). */
export async function updateAdCreative(adId: string, creativeId: string): Promise<void> {
  await postForm(adId, { creative: JSON.stringify({ creative_id: creativeId }) }, "updateAdCreative");
}

/** Name of any Graph object (campaign, ad set, ad); null when unavailable. */
export async function getObjectName(objectId: string): Promise<string | null> {
  try {
    const data = await getJson(`${objectId}?fields=name`, "objectName");
    return data.name ? String(data.name) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Ad sets
// ---------------------------------------------------------------------------

export interface AdSetTemplate {
  campaignId: string;
  dailyBudget?: number;
  bidAmount?: number;
  bidStrategy?: string;
  bidConstraints?: Record<string, unknown>;
  billingEvent?: string;
  optimizationGoal?: string;
  targeting?: Record<string, unknown>;
  promotedObject?: Record<string, unknown>;
}

export async function getAdSetById(adSetId: string): Promise<AdSetTemplate> {
  const fields = "campaign_id,daily_budget,bid_amount,bid_strategy,bid_constraints,billing_event,optimization_goal,targeting,promoted_object";
  const data = (await getJson(`${adSetId}?fields=${fields}`, "getAdSetById")) as Record<string, unknown>;
  return {
    campaignId: String(data.campaign_id ?? ""),
    dailyBudget: data.daily_budget ? parseInt(String(data.daily_budget)) : undefined,
    bidAmount: data.bid_amount ? parseInt(String(data.bid_amount)) : undefined,
    bidStrategy: data.bid_strategy as string | undefined,
    bidConstraints: data.bid_constraints as Record<string, unknown> | undefined,
    billingEvent: data.billing_event as string | undefined,
    optimizationGoal: data.optimization_goal as string | undefined,
    targeting: data.targeting as Record<string, unknown> | undefined,
    promotedObject: data.promoted_object as Record<string, unknown> | undefined,
  };
}

export interface CreateAdSetParams {
  name: string;
  campaignId: string;
  dailyBudget?: number;
  bidAmount?: number;
  bidStrategy?: string;
  bidConstraints?: Record<string, unknown>;
  billingEvent?: string;
  optimizationGoal?: string;
  status?: "ACTIVE" | "PAUSED";
  targeting?: Record<string, unknown>;
  promotedObject?: Record<string, unknown>;
  startTime?: string;
  endTime?: string;
}

export async function createAdSet(adAccountId: string, params: CreateAdSetParams): Promise<string> {
  const form: Record<string, string> = {
    name: params.name,
    campaign_id: params.campaignId,
    billing_event: params.billingEvent ?? "IMPRESSIONS",
    status: params.status ?? "PAUSED",
    targeting: JSON.stringify(params.targeting ?? defaultUsTargeting()),
  };
  if (params.dailyBudget !== undefined) form.daily_budget = String(params.dailyBudget);
  if (params.bidAmount !== undefined) form.bid_amount = String(params.bidAmount);
  if (params.bidStrategy) form.bid_strategy = params.bidStrategy;
  if (params.bidConstraints) form.bid_constraints = JSON.stringify(params.bidConstraints);
  if (params.optimizationGoal) form.optimization_goal = params.optimizationGoal;
  if (params.promotedObject) form.promoted_object = JSON.stringify(params.promotedObject);
  if (params.startTime) form.start_time = params.startTime;
  if (params.endTime) form.end_time = params.endTime;

  const data = await postForm(`${adAccountId}/adsets`, form, "createAdSet");
  return String(data.id);
}

// ---------------------------------------------------------------------------
// Ads (creative + ad, ported from createAdFromVideo)
// ---------------------------------------------------------------------------

export interface VideoAdCopy {
  headline: string;
  primaryText: string;
  description: string;
  callToAction: string;
  websiteUrl: string;
  displayUrl: string;
}

export async function createAdFromVideo(options: {
  adAccountId: string;
  adSetId: string;
  pageId: string;
  videoId: string;
  adName: string;
  copy: VideoAdCopy;
  thumbnail: { imageHash?: string; imageUrl?: string };
  status: "ACTIVE" | "PAUSED";
}): Promise<string> {
  const { adAccountId, adSetId, pageId, videoId, adName, copy, status } = options;

  let thumbnail = options.thumbnail;
  if (!thumbnail.imageHash && !thumbnail.imageUrl) {
    const url = await getVideoThumbnailUrl(videoId);
    if (url) thumbnail = { imageUrl: url };
  }
  if (!thumbnail.imageHash && !thumbnail.imageUrl) {
    throw new Error("Could not generate or retrieve the required video thumbnail");
  }

  const videoData: Record<string, unknown> = {
    video_id: videoId,
    title: copy.headline || adName,
  };
  if (thumbnail.imageHash) videoData.image_hash = thumbnail.imageHash;
  else if (thumbnail.imageUrl) videoData.image_url = thumbnail.imageUrl;
  if (copy.primaryText) videoData.message = copy.primaryText;
  if (copy.description) videoData.link_description = copy.description;
  if (copy.websiteUrl) {
    const value: Record<string, string> = { link: copy.websiteUrl };
    if (copy.displayUrl) value.display_url = copy.displayUrl;
    videoData.call_to_action = { type: copy.callToAction || "LEARN_MORE", value };
  }

  const creativeData = await postForm(
    `${adAccountId}/adcreatives`,
    {
      name: `${adName} Creative`,
      object_story_spec: JSON.stringify({ page_id: pageId, video_data: videoData }),
    },
    "createAdCreative",
  );

  const adData = await postForm(
    `${adAccountId}/ads`,
    {
      name: adName,
      adset_id: adSetId,
      creative: JSON.stringify({ creative_id: String(creativeData.id) }),
      status,
    },
    "createAd",
  );
  return String(adData.id);
}

// ---------------------------------------------------------------------------
// Status changes (pause / resume / kill)
// ---------------------------------------------------------------------------

export async function setObjectStatus(objectId: string, status: "ACTIVE" | "PAUSED" | "DELETED"): Promise<void> {
  await postForm(objectId, { status }, `setStatus:${status}`);
}

/** Quick token/connectivity check; returns the token's identity name. */
export async function whoAmI(): Promise<string> {
  const data = await getJson("me?fields=id,name", "whoami");
  return String(data.name ?? data.id ?? "unknown");
}
