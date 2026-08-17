/**
 * Outbound Slack notifications (chat.postMessage with the bot token).
 * Interactive buttons/commands are handled by apps/slack-bot over Socket Mode;
 * this module only posts. Silently no-ops when Slack env vars are missing.
 */
import { readFile, unlink, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { env } from "./env.js";
import { PT } from "./schedule.js";
import { getSetting, setSetting } from "./db.js";

const execFileAsync = promisify(execFile);

type Block = Record<string, unknown>;

const SLACK_DEDUPE_MS = 24 * 60 * 60 * 1000;

function slackFingerprint(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

function alreadyPosted(text: string): boolean {
  const key = `slackDedupe:${slackFingerprint(text)}`;
  const last = Number(getSetting(key) ?? 0);
  if (last > 0 && Date.now() - last < SLACK_DEDUPE_MS) return true;
  setSetting(key, String(Date.now()));
  return false;
}

export async function postSlack(text: string, blocks?: Block[]): Promise<void> {
  if (!env.slackBotToken || !env.slackChannelId) {
    console.log(`[slack skipped] ${text}`);
    return;
  }
  if (alreadyPosted(text)) {
    console.log(`[slack deduped] ${text.slice(0, 120)}`);
    return;
  }
  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${env.slackBotToken}`,
      },
      body: JSON.stringify({
        channel: env.slackChannelId,
        text,
        unfurl_links: false,
        unfurl_media: false,
        ...(blocks ? { blocks } : {}),
      }),
    });
    const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    if (!data.ok) console.error(`Slack post failed: ${data.error ?? "unknown"}`);
  } catch (error) {
    console.error("Slack post failed:", error);
  }
}

function fmtPt(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: PT,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

export function notifyRunStarted(runId: string, verticalLabel: string, count: number): void {
  void postSlack(`:factory: *${verticalLabel}* — daily run started, generating ${count} creative(s). Run \`${runId}\`.`);
}

/**
 * Upload a file into the channel (files.getUploadURLExternal → bytes →
 * files.completeUploadExternal). Needs the `files:write` bot scope.
 */
export async function uploadFileToSlack(filePath: string, title: string): Promise<boolean> {
  if (!env.slackBotToken || !env.slackChannelId) return false;
  try {
    const buffer = await readFile(filePath);
    const params = new URLSearchParams({ filename: basename(filePath), length: String(buffer.length) });
    const urlRes = await fetch(`https://slack.com/api/files.getUploadURLExternal?${params}`, {
      headers: { Authorization: `Bearer ${env.slackBotToken}` },
    });
    const urlData = (await urlRes.json()) as { ok?: boolean; error?: string; upload_url?: string; file_id?: string };
    if (!urlData.ok || !urlData.upload_url || !urlData.file_id) {
      throw new Error(urlData.error ?? "files.getUploadURLExternal failed");
    }

    const putRes = await fetch(urlData.upload_url, { method: "POST", body: new Blob([new Uint8Array(buffer)]) });
    if (!putRes.ok) throw new Error(`upload POST failed (${putRes.status})`);

    const doneRes = await fetch("https://slack.com/api/files.completeUploadExternal", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${env.slackBotToken}`,
      },
      body: JSON.stringify({
        files: [{ id: urlData.file_id, title }],
        channel_id: env.slackChannelId,
      }),
    });
    const doneData = (await doneRes.json()) as { ok?: boolean; error?: string };
    if (!doneData.ok) throw new Error(doneData.error ?? "files.completeUploadExternal failed");
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/missing_scope/.test(message)) {
      console.warn(
        `Slack video upload needs the files:write bot scope — add it under OAuth & Permissions and reinstall the app (${message})`,
      );
    } else {
      console.warn(`Slack file upload failed for ${filePath}:`, message);
    }
    return false;
  }
}

/**
 * Full renders are ~60MB and Slack's upload endpoint drops slow transfers
 * after ~30s, so we send a compressed preview (a few MB) instead.
 */
async function makePreview(videoPath: string): Promise<string> {
  const out = join(tmpdir(), `adf-preview-${Date.now()}-${basename(videoPath)}`);
  await execFileAsync("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-vf",
    "scale=-2:960",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "28",
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-movflags",
    "+faststart",
    out,
  ]);
  return out;
}

/** Compress + upload a video; returns false if anything failed. */
export async function uploadVideoPreviewToSlack(videoPath: string, title: string): Promise<boolean> {
  if (!env.slackBotToken || !env.slackChannelId) return false;
  let preview: string | null = null;
  try {
    preview = await makePreview(videoPath);
    const size = (await stat(preview)).size;
    if (size > 25_000_000) throw new Error(`preview still too large (${Math.round(size / 1e6)}MB)`);
    // Consecutive uploads occasionally drop — one retry covers the blips.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 3000));
      if (await uploadFileToSlack(preview, title)) return true;
    }
    return false;
  } catch (error) {
    console.warn(`Video preview upload failed for ${videoPath}:`, error instanceof Error ? error.message : error);
    return false;
  } finally {
    if (preview) await unlink(preview).catch(() => {});
  }
}

export function notifyCreativesReady(runId: string, verticalLabel: string, outputs: string[], angles?: (string | null)[]): void {
  const names = outputs.map((p, i) => `• ${basename(p)}${angles?.[i] ? ` [${angles[i]}]` : ""}`).join("\n");
  void postSlack(
    `:clapper: *${verticalLabel}* — ${outputs.length} creative(s) ready, uploading to Meta.\n${names}\n_Videos + per-ad approve/pause buttons arrive once the ads are scheduled (a minute or two)._`,
  );
}

/**
 * Per-video review message: compressed preview upload followed by controls
 * that act on that single Meta ad (works before and after go-live).
 */
export async function notifyAdReview(options: {
  adId: string;
  adName: string;
  videoPath: string;
  verticalLabel: string;
  goLiveAtIso: string;
  paused?: boolean;
}): Promise<void> {
  const { adId, adName, videoPath, verticalLabel, goLiveAtIso, paused } = options;
  const sent = await uploadVideoPreviewToSlack(videoPath, adName);
  const status = paused ? ":double_vertical_bar: currently *paused*" : `go-live ${fmtPt(goLiveAtIso)}`;
  const text = `${sent ? ":point_up_2: " : ""}*${adName}* (${verticalLabel}) — ${status}${sent ? "" : "\n:warning: video preview upload failed — watch it in the portal"}`;
  const blocks: Block[] = [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Pause this ad" },
          action_id: "ad_pause",
          value: adId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Resume" },
          style: "primary",
          action_id: "ad_resume",
          value: adId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Kill this ad" },
          style: "danger",
          action_id: "ad_kill",
          value: adId,
          confirm: {
            title: { type: "plain_text", text: "Kill this ad?" },
            text: { type: "mrkdwn", text: `\`${adName}\` will be paused permanently and never go live.` },
            confirm: { type: "plain_text", text: "Kill it" },
            deny: { type: "plain_text", text: "Keep" },
          },
        },
      ],
    },
  ];
  await postSlack(`${adName} — ${paused ? "paused" : `go-live ${fmtPt(goLiveAtIso)}`}`, blocks);
}

/**
 * Draft-creative review message: compressed video preview followed by
 * Publish/Reject buttons. Nothing reaches Meta until "Publish" is clicked —
 * publishing adds the video as a new ad in the already-scheduled campaign.
 */
export async function notifyAdDraftReview(options: {
  draftId: string;
  angle: string;
  videoPath: string;
  verticalLabel: string;
  /** Go-live of the campaign the draft would join; null = no target found. */
  goLiveAtIso: string | null;
  /** Overrides the target line (manual-launch batches explain their trigger). */
  targetNote?: string;
}): Promise<void> {
  const { draftId, angle, videoPath, verticalLabel, goLiveAtIso, targetNote } = options;
  const sent = await uploadVideoPreviewToSlack(videoPath, `Draft [${angle}]`);
  const target =
    targetNote ??
    (goLiveAtIso
      ? `Approving adds it to the campaign going live *${fmtPt(goLiveAtIso)}*.`
      : ":warning: No scheduled campaign found right now — publishing will fail until one exists.");
  const text =
    `${sent ? ":point_up_2: " : ""}:frame_with_picture: *Draft creative for review* — *${verticalLabel}*, avatar/angle *${angle}*\n` +
    `${target}\n` +
    `*Not uploaded to Meta yet* — it only goes to Facebook if you hit Publish.` +
    (sent ? "" : `\n:warning: video preview upload failed — file: \`${videoPath}\``);
  const blocks: Block[] = [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          // Batch drafts target a manual-launch campaign, not tomorrow's 5am.
          text: { type: "plain_text", text: targetNote ? "Publish" : "Publish to tomorrow's campaign" },
          style: "primary",
          action_id: "draft_publish",
          value: draftId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject" },
          style: "danger",
          action_id: "draft_reject",
          value: draftId,
        },
      ],
    },
  ];
  await postSlack(`Draft creative ready (${angle}) — publish or reject`, blocks);
}

/**
 * Kick-off summary for a manual-launch batch: what was created, how the
 * launch trigger works, and a Launch now escape hatch (goes live with
 * whatever is published so far).
 */
export async function notifyManualBatchStarted(options: {
  runId: string;
  campaignName: string;
  count: number;
  angles: string[];
  dailyBudgetUsd: number;
  bidCapUsd: number;
}): Promise<void> {
  const { runId, campaignName, count, angles, dailyBudgetUsd, bidCapUsd } = options;
  const text =
    `:new: *${campaignName}* created (paused) — $${dailyBudgetUsd}/day CBO, $${bidCapUsd} bid cap.\n` +
    `Rendering ${count} creative(s) now: ${angles.join(", ")}. Each lands here with Publish/Reject buttons as it finishes.\n` +
    `:point_right: The campaign goes live *automatically the moment you've decided all ${count}* (at least one published) — or hit *Launch now* to start early with what's published; later approvals still join it live.`;
  const blocks: Block[] = [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Launch now" },
          style: "primary",
          action_id: "batch_launch",
          value: runId,
          confirm: {
            title: { type: "plain_text", text: "Launch the campaign now?" },
            text: {
              type: "mrkdwn",
              text: `*${campaignName}* starts spending immediately with however many ads are published so far.`,
            },
            confirm: { type: "plain_text", text: "Launch" },
            deny: { type: "plain_text", text: "Wait" },
          },
        },
      ],
    },
  ];
  await postSlack(`${campaignName} created — ${count} creatives rendering`, blocks);
}

/**
 * Hook-test review message: compressed video preview followed by the hook /
 * bubble / angle details and Put into production / Reject buttons. The buttons
 * carry the hook test id, so decisions survive restarts (state is in SQLite).
 */
export async function notifyHookTestReview(options: {
  hookTestId: string;
  angle: string;
  hook: string;
  bubble: string;
  videoPath: string;
}): Promise<void> {
  const { hookTestId, angle, hook, bubble, videoPath } = options;
  const sent = await uploadVideoPreviewToSlack(videoPath, `Hook test [${angle}]`);
  const text =
    `${sent ? ":point_up_2: " : ""}:test_tube: *Hook test ready* — target angle *${angle}*\n` +
    `*Spoken hook:* ${hook}\n` +
    `*Bubble headline:* ${bubble}` +
    (sent ? "" : `\n:warning: video preview upload failed — file: \`${videoPath}\``);
  const blocks: Block[] = [
    { type: "section", text: { type: "mrkdwn", text } },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Put into production" },
          style: "primary",
          action_id: "hook_approve",
          value: hookTestId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject" },
          style: "danger",
          action_id: "hook_reject",
          value: hookTestId,
        },
      ],
    },
  ];
  await postSlack(`Hook test ready (${angle}): ${hook}`, blocks);
}

export function notifyScheduled(options: {
  runId: string;
  verticalLabel: string;
  adCount: number;
  goLiveAtIso: string;
  adSetId?: string;
  campaignId?: string;
  campaignName?: string;
}): void {
  const { runId, verticalLabel, adCount, goLiveAtIso, adSetId, campaignId, campaignName } = options;
  const text = `:white_check_mark: ${verticalLabel} — ${adCount} ad(s) scheduled, go-live ${fmtPt(goLiveAtIso)}`;
  const blocks: Block[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `:white_check_mark: *${verticalLabel}* — ${adCount} ad(s) uploaded and scheduled.\n` +
          `*Go-live:* ${fmtPt(goLiveAtIso)}\n` +
          (campaignId ? `*Campaign:* ${campaignName ? `${campaignName} ` : ""}\`${campaignId}\`\n` : "") +
          (adSetId ? `*Ad set:* \`${adSetId}\`\n` : "") +
          `Run \`${runId}\` — review in the portal before go-live, or use the buttons / \`/adops\`.`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Pause" },
          style: "primary",
          action_id: "run_pause",
          value: runId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Kill" },
          style: "danger",
          action_id: "run_kill",
          value: runId,
          confirm: {
            title: { type: "plain_text", text: "Kill this run?" },
            text: { type: "mrkdwn", text: "Ads will be paused and the run cancelled. It will not go live." },
            confirm: { type: "plain_text", text: "Kill it" },
            deny: { type: "plain_text", text: "Keep" },
          },
        },
      ],
    },
  ];
  void postSlack(text, blocks);
}

const lastErrorByRun = new Map<string, string>();

/** Dead-account / flight-off loops must never hit Slack. Log only. */
const SILENT_ERROR = /flight auto-off|not eligible for write|only active accounts can create or edit/i;

export function notifyError(runId: string, verticalLabel: string, message: string): void {
  if (lastErrorByRun.get(runId) === message) return;
  lastErrorByRun.set(runId, message);
  const line = `:rotating_light: *${verticalLabel}* — run \`${runId}\` failed:\n> ${message}`;
  if (SILENT_ERROR.test(message)) {
    console.warn(`[slack silenced] ${line.replace(/\n/g, " ")}`);
    return;
  }
  void postSlack(line);
}

export function notifyInfo(message: string): void {
  void postSlack(message);
}
