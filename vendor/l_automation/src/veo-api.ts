import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { GoogleGenAI, VideoGenerationReferenceType } from "@google/genai";
import type { AppConfig } from "./config.js";
import { ensureDir, sleep, slugify, timestamp } from "./utils.js";
import { acquireApiSlot } from "./ratelimit.js";
import { recordVeoRequest } from "./veo-usage.js";
import { cropSafeMargins } from "./video.js";
import { log } from "./logger.js";

/**
 * Optional deterministic guard against Veo painting fake phone/browser chrome
 * in a clip's outer margins. Enabled by setting VEO_SAFE_CROP_TOP /
 * VEO_SAFE_CROP_BOTTOM (fractions of height, e.g. 0.11). When unset, generation
 * is unchanged, so existing campaigns keep their exact framing.
 */
function safeCropFractions(): { top: number; bottom: number } | null {
  const top = Number(process.env.VEO_SAFE_CROP_TOP);
  const bottom = Number(process.env.VEO_SAFE_CROP_BOTTOM);
  const t = Number.isFinite(top) && top > 0 ? top : 0;
  const b = Number.isFinite(bottom) && bottom > 0 ? bottom : 0;
  if (t <= 0 && b <= 0) return null;
  return { top: t, bottom: b };
}

async function applySafeCrop(path: string): Promise<string> {
  const frac = safeCropFractions();
  if (!frac) return path;
  const cropped = path.replace(/\.mp4$/i, "_safecrop.mp4");
  log.step(
    `Cropping safe margins to drop any fake phone UI ` +
      `(top ${frac.top}, bottom ${frac.bottom}).`,
  );
  return cropSafeMargins(path, cropped, frac.top, frac.bottom);
}

function mimeFor(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".webp":
      return "image/webp";
    case ".jpg":
    case ".jpeg":
    default:
      return "image/jpeg";
  }
}

/**
 * Thrown when every model in the chain is rate-limited / out of quota (429).
 * The pipeline catches this specifically to fall back to the Flow browser
 * backend, while other API errors (bad key, no access) still hard-fail.
 */
export class VeoRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VeoRateLimitError";
  }
}

/** Turn raw Google API errors into actionable messages. */
function interpretApiError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);

  if (/RESOURCE_EXHAUSTED|"code":\s*429|\b429\b/.test(msg)) {
    return new Error(
      "Veo hit a quota/rate limit (HTTP 429).\n" +
        "  • Veo video models are NOT available on the Gemini API free tier.\n" +
        "    Enable billing on your project: https://aistudio.google.com/ (Settings → Billing),\n" +
        "    or use a key from a Cloud project with billing enabled.\n" +
        "  • If billing is already on, you likely hit a per-minute limit — wait a\n" +
        "    bit and retry, or space runs out with `--interval 60`.\n" +
        "  • Quota details: https://ai.google.dev/gemini-api/docs/rate-limits",
    );
  }
  if (/API_KEY_INVALID|API key not valid|"code":\s*400.*key/i.test(msg)) {
    return new Error(
      "Invalid API key. Check GEMINI_API_KEY in your .env. " +
        "Get a key at https://aistudio.google.com/apikey",
    );
  }
  if (/PERMISSION_DENIED|"code":\s*403/.test(msg)) {
    return new Error(
      "Permission denied. Your key/project may not have access to the " +
        "requested Veo model. Ensure billing is enabled and flow.apiModel is correct.",
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

/** True when an error message indicates a quota / rate-limit failure (429). */
export function isRateLimitMessage(msg: string): boolean {
  return /RESOURCE_EXHAUSTED|"code":\s*429|\b429\b/.test(msg);
}

/** Interpret an API error, tagging quota/rate-limit failures as VeoRateLimitError. */
export function toVeoError(err: unknown): Error {
  const interpreted = interpretApiError(err);
  const msg = err instanceof Error ? err.message : String(err);
  if (isRateLimitMessage(msg)) {
    return new VeoRateLimitError(interpreted.message);
  }
  return interpreted;
}

/**
 * Whether a generation error should trigger the Flow browser fallback: only
 * for quota/rate-limit failures, and only when the user enabled the fallback.
 */
export function shouldFallbackToBrowser(
  err: unknown,
  browserFallback: boolean,
): boolean {
  return browserFallback && err instanceof VeoRateLimitError;
}

/** True when we should try the next model in the chain (quota, access, or missing model). */
function isFallbackModelError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /RESOURCE_EXHAUSTED|"code":\s*429|\b429\b/.test(msg) ||
    /PERMISSION_DENIED|"code":\s*403/.test(msg) ||
    /NOT_FOUND|"code":\s*404/.test(msg) ||
    /model.*not.*(found|available|supported)/i.test(msg)
  );
}

export type VeoModelState =
  | "available"
  | "ok"
  | "rate_limited"
  | "denied"
  | "missing"
  | "error";

export interface VeoModelStatus {
  state: VeoModelState;
  detail?: string;
  updatedAt: number;
}

/** rate_limited entries auto-recover after one window; this avoids stale "blocked". */
const RATE_LIMIT_TTL_MS = 60_000;

const modelStatus = new Map<string, VeoModelStatus>();

function setModelStatus(model: string, state: VeoModelState, detail?: string): void {
  modelStatus.set(model, { state, detail, updatedAt: Date.now() });
}

function classifyModelError(err: unknown): { state: VeoModelState; detail: string } {
  const msg = err instanceof Error ? err.message : String(err);
  if (/RESOURCE_EXHAUSTED|"code":\s*429|\b429\b/.test(msg)) {
    return { state: "rate_limited", detail: "Quota / rate limit (429)" };
  }
  if (/PERMISSION_DENIED|"code":\s*403/.test(msg)) {
    return { state: "denied", detail: "No access (403) — check billing" };
  }
  if (/NOT_FOUND|"code":\s*404|model.*not.*(found|available|supported)/i.test(msg)) {
    return { state: "missing", detail: "Model not found (404)" };
  }
  return { state: "error", detail: msg.split("\n")[0]!.slice(0, 120) };
}

/** Live per-model availability, as observed from recent generation attempts. */
export function getVeoModelStatuses(): Record<string, VeoModelStatus> {
  const now = Date.now();
  const out: Record<string, VeoModelStatus> = {};
  for (const [model, status] of modelStatus) {
    if (status.state === "rate_limited" && now - status.updatedAt > RATE_LIMIT_TTL_MS) {
      out[model] = { state: "available", updatedAt: status.updatedAt };
    } else {
      out[model] = status;
    }
  }
  return out;
}

export function getApiKey(): string {
  const key =
    process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? "";
  if (!key) {
    throw new Error(
      "No API key found. Set GEMINI_API_KEY (or GOOGLE_API_KEY) in your " +
        "environment. Get one at https://aistudio.google.com/apikey",
    );
  }
  return key;
}

/** Generate + poll + download a single video with one specific model. */
async function generateWithModel(
  ai: GoogleGenAI,
  model: string,
  cfg: AppConfig,
  imageBytes: string,
  mimeType: string,
): Promise<string> {
  const aspectRatio = cfg.flow.aspectRatio || "9:16";
  const resolution = cfg.flow.resolution || "720p";

  const baseConfig = {
    aspectRatio,
    resolution,
    numberOfVideos: 1,
    durationSeconds: 8,
  };

  // Lite only supports first-frame image-to-video (no "ingredients"/reference
  // images). Fast/Standard support reference images. Default per model, but
  // also auto-fall back to first-frame if a model rejects reference images.
  let useFirstFrame = /lite/i.test(model);

  const startGeneration = async () => {
    await acquireApiSlot(`Veo generation with ${model}`);
    recordVeoRequest(model);
    if (useFirstFrame) {
      log.step(
        `Veo API: generating with ${model} ` +
          `(${aspectRatio}, ${resolution}, first-frame image).`,
      );
      return ai.models.generateVideos({
        model,
        prompt: cfg.flow.prompt,
        image: { imageBytes, mimeType },
        config: baseConfig,
      });
    }
    log.step(
      `Veo API: generating with ${model} ` +
        `(${aspectRatio}, ${resolution}, reference image).`,
    );
    return ai.models.generateVideos({
      model,
      prompt: cfg.flow.prompt,
      config: {
        ...baseConfig,
        referenceImages: [
          {
            image: { imageBytes, mimeType },
            referenceType: VideoGenerationReferenceType.ASSET,
          },
        ],
      },
    });
  };

  let operation;
  try {
    operation = await startGeneration();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!useFirstFrame && /referenceImages.*(isn't|not) supported/i.test(msg)) {
      log.warn(
        `${model} doesn't support reference images; retrying as first-frame image-to-video.`,
      );
      useFirstFrame = true;
      operation = await startGeneration();
    } else {
      throw err;
    }
  }

  const deadline = Date.now() + cfg.flow.generationTimeoutMs;
  while (!operation.done) {
    if (Date.now() > deadline) {
      throw new Error(
        `Veo generation timed out after ${cfg.flow.generationTimeoutMs}ms.`,
      );
    }
    await sleep(10_000);
    log.info("Waiting for Veo generation to complete...");
    operation = await ai.operations.getVideosOperation({ operation });
  }

  const video = operation.response?.generatedVideos?.[0]?.video;
  if (!video) {
    throw new Error("Veo API returned no video.");
  }

  const dir = ensureDir(join(cfg.browser.downloadDir, "veo"));
  const slug = slugify(cfg.video.name || cfg.pinterest.query || cfg.flow.prompt || "veo");
  const outPath = join(dir, `${timestamp()}_${slug}.mp4`);

  log.step("Downloading generated video...");
  await ai.files.download({ file: video, downloadPath: outPath });
  log.ok(`Veo video downloaded: ${outPath}`);
  return outPath;
}

/**
 * Generate a video with Veo via the Gemini API using the sourced image as a
 * reference ("ingredient"), and download it. Returns the local file path.
 *
 * Tries cfg.flow.apiModel first (best tier you configure), then falls back
 * through cfg.flow.apiModelFallbacks when a model is unavailable, denied, or
 * rate-limited (403/404/429). Default order is Standard → Fast → Lite.
 */
export async function generateVeoVideo(
  cfg: AppConfig,
  imagePath: string,
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: getApiKey() });

  const imageBytes = readFileSync(imagePath).toString("base64");
  const mimeType = mimeFor(imagePath);

  // Build the ordered model chain (primary + fallbacks), de-duplicated.
  const chain = [cfg.flow.apiModel, ...cfg.flow.apiModelFallbacks].filter(
    (m, i, arr) => m && arr.indexOf(m) === i,
  );

  let lastErr: unknown;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i]!;
    try {
      const out = await generateWithModel(ai, model, cfg, imageBytes, mimeType);
      setModelStatus(model, "ok");
      return await applySafeCrop(out);
    } catch (err) {
      lastErr = err;
      const { state, detail } = classifyModelError(err);
      setModelStatus(model, state, detail);
      const isLast = i === chain.length - 1;
      if (isFallbackModelError(err) && !isLast) {
        log.warn(
          `${model} unavailable or rate-limited. Falling back to ${chain[i + 1]}.`,
        );
        continue;
      }
      throw toVeoError(err);
    }
  }
  throw toVeoError(lastErr);
}
