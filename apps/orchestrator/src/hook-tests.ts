/**
 * Hook testing: generate a one-off test video for an exact hook + bubble,
 * post it to Slack for review, and on approval promote the hook + bubble into
 * the studio campaign's production config (vendor/l_automation/config.json).
 * Test videos are generation + Slack only — they never touch Meta.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { VENDOR_STUDIO_DIR } from "./env.js";
import {
  createHookTest,
  updateHookTest,
  getHookTest,
  listHookTestsByStatus,
  type HookTestRow,
} from "./db.js";
import { queueHookTestJob, waitForStudioJob } from "./creative.js";
import { loadAngles } from "./angles.js";
import { notifyHookTestReview, notifyInfo } from "./slack.js";
import { stripDashes } from "./text.js";

/** Persona to clone imagery from when the target angle doesn't exist yet. */
const FALLBACK_VARIANT_ID = "ugc-selfie";

const CONFIG_PATH = join(VENDOR_STUDIO_DIR, "config.json");

interface RawVariant {
  id?: string;
  name?: string;
  creatorPrompt?: string;
  scenePrompt?: string;
  cameraPrompt?: string;
  hooks?: string[];
  bubbleHooks?: string[];
  [key: string]: unknown;
}

interface RawCampaign {
  id?: string;
  variants?: RawVariant[];
  [key: string]: unknown;
}

/**
 * Serialize exactly like the file on disk: 2-space indent, non-ASCII escaped
 * as \uXXXX, no trailing newline. A parse → stringify round trip of the
 * current config.json is byte-identical, so approvals produce minimal diffs.
 */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

function titleCase(id: string): string {
  return id
    .split(/[\s_-]+/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Append an approved hook + bubble to the target variant's production arrays.
 * If the variant doesn't exist (new angle, e.g. "outrage") it is created with
 * ONLY the approved hook + bubble, using the persona the test was generated
 * with when one is stored (falling back to cloning ugc-selfie). Everything
 * else in config.json is preserved byte for byte.
 */
export function promoteHookToConfig(
  campaignId: string,
  angle: string,
  hook: string,
  bubble: string,
  persona?: { creatorPrompt?: string | null; scenePrompt?: string | null },
): void {
  // Belt and braces: rows created before the dash rule may still carry dashes.
  hook = stripDashes(hook);
  bubble = stripDashes(bubble);
  if (!existsSync(CONFIG_PATH)) throw new Error(`Studio config not found at ${CONFIG_PATH}`);
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { campaigns?: RawCampaign[] };
  const campaign = (raw.campaigns ?? []).find((c) => c.id === campaignId);
  if (!campaign) throw new Error(`Campaign "${campaignId}" not found in studio config`);
  const variants = campaign.variants ?? [];

  let variant = variants.find((v) => v.id === angle);
  if (!variant) {
    const template =
      variants.find((v) => v.id === FALLBACK_VARIANT_ID) ?? variants[0];
    if (!template) throw new Error(`Campaign "${campaignId}" has no variants to clone from`);
    variant = {
      id: angle,
      name: titleCase(angle),
      creatorPrompt: persona?.creatorPrompt?.trim() || template.creatorPrompt || "",
      scenePrompt: persona?.scenePrompt?.trim() || template.scenePrompt || "",
      cameraPrompt: template.cameraPrompt ?? "",
      hooks: [hook],
      bubbleHooks: [bubble],
    };
    variants.push(variant);
    campaign.variants = variants;
  } else {
    variant.hooks = variant.hooks ?? [];
    if (!variant.hooks.includes(hook)) variant.hooks.push(hook);
    variant.bubbleHooks = variant.bubbleHooks ?? [];
    if (!variant.bubbleHooks.includes(bubble)) variant.bubbleHooks.push(bubble);
  }

  // Timestamped safety copy before every write (same pattern as the studio).
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.${stamp}.bak`);
  } catch {
    // best-effort backup; never block the approval on it
  }
  writeFileSync(CONFIG_PATH, stableStringify(raw));
}

/** Remove a previously promoted hook/bubble (used only by verification tooling). */
export function demoteHookFromConfig(campaignId: string, angle: string, hook: string, bubble: string): void {
  const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { campaigns?: RawCampaign[] };
  const campaign = (raw.campaigns ?? []).find((c) => c.id === campaignId);
  const variant = campaign?.variants?.find((v) => v.id === angle);
  if (!variant) return;
  variant.hooks = (variant.hooks ?? []).filter((h) => h !== hook);
  variant.bubbleHooks = (variant.bubbleHooks ?? []).filter((b) => b !== bubble);
  // A variant that only ever held this hook was created by the approval — drop it.
  if (variant.hooks.length === 0 && variant.bubbleHooks.length === 0) {
    campaign!.variants = campaign!.variants!.filter((v) => v !== variant);
  }
  writeFileSync(CONFIG_PATH, stableStringify(raw));
}

/** Pick the studio variant index used to generate the test video. */
function resolveVariantIndex(campaignId: string, angle: string): number {
  const angles = loadAngles(campaignId);
  if (angles.length === 0) throw new Error(`Campaign "${campaignId}" has no variants`);
  const exact = angles.find((a) => a.id === angle);
  if (exact) return exact.index;
  const fallback = angles.find((a) => a.id === FALLBACK_VARIANT_ID);
  return (fallback ?? angles[0]!).index;
}

/**
 * Create a hook test and queue its studio generation job. Returns immediately;
 * a background watcher posts the Slack review message when the video is done.
 */
export async function startHookTest(input: {
  campaignId: string;
  angle: string;
  hook: string;
  bubble: string;
  /** Optional persona overrides; stored so an approval reproduces the tested look. */
  creatorPrompt?: string;
  scenePrompt?: string;
}): Promise<HookTestRow> {
  // Veo trips over dashes — clean submitted copy on entry so the test video,
  // the stored row, and any later promotion to config are all dash-free.
  input = {
    ...input,
    hook: stripDashes(input.hook),
    bubble: stripDashes(input.bubble),
    scenePrompt: input.scenePrompt ? stripDashes(input.scenePrompt) : undefined,
  };
  const variantIndex = resolveVariantIndex(input.campaignId, input.angle);
  const row = createHookTest(input);
  try {
    const job = await queueHookTestJob(input.campaignId, variantIndex, input.hook, input.bubble, {
      creatorPrompt: input.creatorPrompt,
      scenePrompt: input.scenePrompt,
    });
    updateHookTest(row.id, { studio_job_id: job.id });
    void watchHookTest(row.id, job.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateHookTest(row.id, { status: "error", error: message });
    throw error;
  }
  return getHookTest(row.id)!;
}

async function watchHookTest(id: string, jobId: string): Promise<void> {
  const test = getHookTest(id);
  try {
    const job = await waitForStudioJob(jobId);
    const output = job.outputs?.[0];
    if (!output) throw new Error("Studio job finished without an output video");
    updateHookTest(id, { status: "pending", video_path: output, error: null });
    const row = getHookTest(id)!;
    await notifyHookTestReview({
      hookTestId: row.id,
      angle: row.angle,
      hook: row.hook,
      bubble: row.bubble,
      videoPath: output,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateHookTest(id, { status: "error", error: message });
    notifyInfo(
      `:rotating_light: Hook test failed (angle *${test?.angle ?? "?"}*): ${message}\n> ${test?.hook ?? id}`,
    );
  }
}

/**
 * Re-attach watchers for hook tests that were still generating when the
 * orchestrator restarted. Works as long as the studio kept the job in memory;
 * otherwise the test is failed visibly instead of hanging forever.
 */
export function resumeHookTestWatches(): void {
  for (const test of listHookTestsByStatus("generating")) {
    if (test.studio_job_id) {
      void watchHookTest(test.id, test.studio_job_id);
    } else {
      updateHookTest(test.id, { status: "error", error: "Interrupted by orchestrator restart" });
    }
  }
}

function requirePendingHookTest(id: string): HookTestRow {
  const test = getHookTest(id);
  if (!test) throw new Error(`Hook test not found: ${id}`);
  if (test.status !== "pending") {
    throw new Error(`Hook test is already ${test.status} — nothing to decide`);
  }
  return test;
}

/** Approve: promote hook + bubble into production config, confirm in Slack. */
export async function approveHookTest(id: string, userId?: string): Promise<HookTestRow> {
  const test = requirePendingHookTest(id);
  promoteHookToConfig(test.campaign_id, test.angle, test.hook, test.bubble, {
    creatorPrompt: test.creator_prompt,
    scenePrompt: test.scene_prompt,
  });
  updateHookTest(id, { status: "approved" });
  notifyInfo(
    `:white_check_mark: ${userId ? `<@${userId}> ` : ""}put a hook into production (angle *${test.angle}*, campaign \`${test.campaign_id}\`):\n> ${test.hook}`,
  );
  return getHookTest(id)!;
}

/** Reject: mark rejected, nothing in production changes. */
export async function rejectHookTest(id: string, userId?: string): Promise<HookTestRow> {
  const test = requirePendingHookTest(id);
  updateHookTest(id, { status: "rejected" });
  notifyInfo(
    `:wastebasket: ${userId ? `<@${userId}> ` : ""}rejected a hook test (angle *${test.angle}*) — production config unchanged.\n> ${test.hook}`,
  );
  return getHookTest(id)!;
}
