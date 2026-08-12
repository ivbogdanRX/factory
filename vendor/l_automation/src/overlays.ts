import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import type { BrowserContext, Page } from "playwright";
import type { AppConfig } from "./config.js";
import { probe } from "./video.js";
import { getWordTimings, type TimedWord } from "./captions.js";
import { generateVeoVideo } from "./veo-api.js";
import { generateFlowVideo } from "./flow.js";
import { launchContext, getPage, acquireBrowserLock } from "./browser.js";
import { acquireApiSlot } from "./ratelimit.js";
import { ensureDir, slugify, timestamp } from "./utils.js";
import { log } from "./logger.js";

const OVERLAY_IMG_DIR = "downloads/overlays";
const WORK_DIR = "artifacts/overlays";

export type OverlayKind = "fullframe" | "pip";
/** Whether B-roll visuals are AI stills (Ken Burns) or AI video clips. */
export type OverlaySource = "image" | "video";

/** A planned overlay: what to show, when, and how. */
export interface OverlaySpec {
  /** Exact-ish quote from the script that this overlay sits on. */
  phrase: string;
  /** Image-generator prompt describing the B-roll visual. */
  visual: string;
  kind: OverlayKind;
  /** Resolved timing (filled in by alignment). */
  start: number;
  end: number;
  /** Local path to the generated visual (filled in by asset generation). */
  asset?: string;
  /** True when `asset` is a video clip (vs a still image). */
  assetIsVideo?: boolean;
}

export interface OverlayPlanOptions {
  /** Allowed styles. "both" lets the planner choose per moment. */
  style?: "both" | "fullframe" | "pip";
  /** Hard cap on overlays. Defaults to ~1 every 4.5s of body, max 7. */
  maxOverlays?: number;
  /** B-roll visuals as AI stills ("image", default) or AI video clips ("video"). */
  source?: OverlaySource;
  /** Backend used to animate video B-roll. Defaults to "browser" (Flow). */
  backend?: "api" | "browser";
}

function run(cmd: string, args: string[]): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve({ stderr })
        : reject(new Error(`${cmd} exited ${code}:\n${stderr}`)),
    );
  });
}

function getClient(): OpenAI {
  const key = process.env.OPENAI_API_KEY ?? "";
  if (!key) {
    throw new Error(
      "No OpenAI API key found. Set OPENAI_API_KEY in your .env to plan/generate overlays.",
    );
  }
  return new OpenAI({ apiKey: key });
}

function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const m = raw.match(/[[{][\s\S]*[\]}]/);
    if (m) {
      try {
        return JSON.parse(m[0]) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Find the [start,end] span of a phrase inside the transcribed words by matching
 * the phrase's token sequence against consecutive spoken words. Returns null if
 * the phrase can't be located.
 */
function alignPhrase(
  phrase: string,
  words: TimedWord[],
): { start: number; end: number } | null {
  const pTokens = norm(phrase).split(" ").filter(Boolean);
  if (pTokens.length === 0) return null;
  const wTokens = words.map((w) => norm(w.text));

  let best: { i: number; j: number; score: number } | null = null;
  for (let i = 0; i < wTokens.length; i++) {
    let matched = 0;
    let j = i;
    for (let k = 0; k < pTokens.length && j < wTokens.length; k++, j++) {
      const a = wTokens[j]!;
      const b = pTokens[k]!;
      if (a === b || a.includes(b) || b.includes(a)) matched++;
    }
    const score = matched / pTokens.length;
    if (score >= 0.6 && (!best || score > best.score)) {
      best = { i, j: Math.min(j, words.length) - 1, score };
      if (score === 1) break;
    }
  }
  if (!best) return null;
  const start = words[best.i]!.start;
  const end = words[Math.max(best.i, best.j)]!.end;
  return { start, end };
}

/**
 * Ask the model which moments in the script deserve a visual, what to show, and
 * whether it should be a full-frame cutaway or a picture-in-picture card. The
 * returned phrases are then aligned to the spoken-word timestamps.
 */
export async function planOverlays(
  script: string,
  words: TimedWord[],
  cfg: AppConfig,
  opts: OverlayPlanOptions = {},
): Promise<OverlaySpec[]> {
  const bodyDur = words.length ? words[words.length - 1]!.end : 0;
  const cap =
    opts.maxOverlays ?? Math.max(2, Math.min(7, Math.round(bodyDur / 4.5)));
  const style = opts.style ?? "both";

  const styleRule =
    style === "both"
      ? 'Choose "fullframe" for big visual moments (a product, a place, a result) and "pip" for smaller supporting callouts that should sit over the speaker.'
      : `Use only "${style}" overlays.`;

  const client = getClient();
  const system =
    "You are a short-form video editor adding B-roll to a talking-head UGC ad. " +
    "Given the spoken script, pick the moments that benefit from a visual and " +
    "describe a single, concrete, photorealistic B-roll image for each (NO text, " +
    "NO logos, NO watermarks in the image). " +
    styleRule +
    ` Return at most ${cap} overlays, spread across the ad, none overlapping. ` +
    'For each, "phrase" MUST be a short exact contiguous quote (3-7 words) copied ' +
    "from the script marking when the visual appears. " +
    'Respond ONLY with JSON: {"overlays":[{"phrase":"...","visual":"...","kind":"fullframe|pip"}]}';
  const user = JSON.stringify({ maxOverlays: cap, style, script });

  let raw = "";
  try {
    await acquireApiSlot("overlays: plan");
    const resp = await client.chat.completions.create({
      model: cfg.spy.classifierModel,
      temperature: 0.6,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    raw = resp.choices[0]?.message?.content ?? "";
  } catch (err) {
    log.warn(`Overlay planning failed (${(err as Error).message}); skipping overlays.`);
    return [];
  }

  const parsed = safeJson<{
    overlays?: Array<{ phrase?: string; visual?: string; kind?: string }>;
  }>(raw);
  const planned = parsed?.overlays ?? [];

  const specs: OverlaySpec[] = [];
  for (const p of planned) {
    const phrase = (p.phrase ?? "").trim();
    const visual = (p.visual ?? "").trim();
    if (!phrase || !visual) continue;
    const kind: OverlayKind =
      style === "fullframe" || style === "pip"
        ? style
        : p.kind === "fullframe"
          ? "fullframe"
          : "pip";
    const span = alignPhrase(phrase, words);
    if (!span) {
      log.warn(`Overlay phrase not found in audio, skipping: "${phrase}"`);
      continue;
    }
    specs.push({ phrase, visual, kind, start: span.start, end: span.end });
  }

  // Order, enforce a minimum on-screen duration, and de-overlap.
  specs.sort((a, b) => a.start - b.start);
  const minDur = 1.6;
  const gap = 0.25;
  let prevEnd = -Infinity;
  const out: OverlaySpec[] = [];
  for (const s of specs) {
    let start = Math.max(s.start - 0.1, prevEnd + gap, 0);
    let end = Math.max(s.end + 0.25, start + minDur);
    if (bodyDur && end > bodyDur) end = bodyDur;
    if (end - start < 0.8) continue; // no room
    s.start = start;
    s.end = end;
    prevEnd = end;
    out.push(s);
  }
  return out.slice(0, cap);
}

/**
 * Generate one B-roll still with gpt-image-1. Portrait for full-frame, square for
 * PiP — unless `forcePortrait` is set (used when the still is the first frame of a
 * 9:16 video clip, which is then cropped per overlay kind during compositing).
 */
export async function generateOverlayImage(
  spec: OverlaySpec,
  cfg: AppConfig,
  forcePortrait = false,
): Promise<string> {
  const client = getClient();
  const model = cfg.imageSource.openai.model || "gpt-image-1";
  const size =
    forcePortrait || spec.kind === "fullframe" ? "1024x1536" : "1024x1024";
  const prompt =
    `${spec.visual}. Photorealistic, high detail, natural lighting, candid. ` +
    "No text, no captions, no logos, no watermarks, no people speaking to camera.";

  log.step(`Overlay image (${spec.kind}, ${size}): ${spec.visual.slice(0, 60)}…`);
  await acquireApiSlot("overlays: image");
  const result = await client.images.generate({
    model,
    prompt,
    size: size as "1024x1024" | "1024x1536",
    quality: cfg.imageSource.openai.quality,
    n: 1,
  });
  const b64 = result.data?.[0]?.b64_json;
  if (!b64) throw new Error("OpenAI returned no overlay image data.");
  const dir = ensureDir(OVERLAY_IMG_DIR);
  const path = join(dir, `ov_${timestamp()}_${slugify(spec.visual, 24)}.png`);
  writeFileSync(path, Buffer.from(b64, "base64"));
  return path;
}

/** Build the motion prompt that animates a B-roll still into a clip. */
function motionPrompt(visual: string): string {
  return (
    `${visual}. Cinematic B-roll, subtle natural camera motion (slow push-in or ` +
    "gentle pan), shallow depth of field, realistic. No text, no captions, no " +
    "logos, no watermarks, nobody talking to the camera."
  );
}

/**
 * Animate a B-roll still into a short video clip via the chosen backend
 * (image-to-video). Returns the clip path. The browser backend needs an open
 * page; the API backend (Veo) needs no browser.
 */
export async function generateOverlayClip(
  spec: OverlaySpec,
  cfg: AppConfig,
  backend: "api" | "browser",
  browser?: { page: Page },
): Promise<string> {
  const clipCfg: AppConfig = {
    ...cfg,
    flow: { ...cfg.flow, prompt: motionPrompt(spec.visual), backend },
    captions: { ...cfg.captions, enabled: false },
  };
  log.step(`Overlay clip (${spec.kind}, ${backend}): ${spec.visual.slice(0, 60)}…`);
  if (backend === "browser") {
    if (!browser?.page) {
      throw new Error("Browser backend selected for overlay clips but no page is open.");
    }
    // generateFlowVideo needs a context arg but only uses the page.
    return generateFlowVideo(
      undefined as unknown as BrowserContext,
      browser.page,
      clipCfg,
      spec.asset!,
      false,
    );
  }
  return generateVeoVideo(clipCfg, spec.asset!);
}

/** Composite a single overlay onto the working video (one ffmpeg pass). */
async function applyOne(
  input: string,
  spec: OverlaySpec,
  dims: { w: number; h: number; fps: number },
  output: string,
): Promise<void> {
  const { w, h, fps } = dims;
  const dur = Math.max(0.3, spec.end - spec.start);
  const start = spec.start.toFixed(3);
  const end = spec.end.toFixed(3);
  const isVideo = spec.assetIsVideo === true;

  // Stills get a slow Ken Burns push (d=1 over the looped frames) so they don't
  // feel static. Video clips already move, so they're only scaled/cropped and
  // trimmed to the window. A single setpts at the end shifts the overlay onto its
  // start time so `enable` reveals it at the right moment.
  const zoom = `zoompan=z='min(zoom+0.0009,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1`;
  const shift = `setpts=PTS-STARTPTS+${start}/TB`;
  const prep = (tw: number, th: number): string => {
    const fit = `scale=${tw}:${th}:force_original_aspect_ratio=increase,crop=${tw}:${th}`;
    return isVideo
      ? `${fit},trim=0:${dur.toFixed(3)}`
      : `${fit},${zoom}:s=${tw}x${th}:fps=${fps}`;
  };

  let filter: string;
  if (spec.kind === "fullframe") {
    filter =
      `[1:v]${prep(w, h)},${shift}[ov];` +
      `[0:v][ov]overlay=0:0:enable='between(t,${start},${end})'[v]`;
  } else {
    const cardW = Math.round(w * 0.52);
    const cardH = Math.round(cardW * 1.0); // square card
    const border = Math.max(4, Math.round(w * 0.006));
    const padW = cardW + border * 2;
    const padH = cardH + border * 2;
    filter =
      `[1:v]${prep(cardW, cardH)},pad=${padW}:${padH}:${border}:${border}:white,${shift}[ov];` +
      `[0:v][ov]overlay=x=(W-w)/2:y=H*0.09:enable='between(t,${start},${end})'[v]`;
  }

  // Image inputs are looped into a clip; video inputs are read as-is.
  const overlayInput = isVideo
    ? ["-i", spec.asset!]
    : ["-loop", "1", "-framerate", String(fps), "-t", dur.toFixed(3), "-i", spec.asset!];

  await run("ffmpeg", [
    "-y",
    "-i",
    input,
    ...overlayInput,
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-map",
    "0:a?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-c:a",
    "copy",
    "-movflags",
    "+faststart",
    output,
  ]);
}

/**
 * Composite all overlays onto the body. Each overlay is one ffmpeg pass so the
 * filter graphs stay simple and debuggable (overlay count is small).
 */
export async function addOverlays(
  bodyVideo: string,
  specs: OverlaySpec[],
  output: string,
): Promise<string> {
  if (specs.length === 0) return bodyVideo;
  const info = await probe(bodyVideo);
  const dims = { w: info.width, h: info.height, fps: Math.round(info.fps) || 30 };
  const work = ensureDir(WORK_DIR);

  let current = bodyVideo;
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i]!;
    if (!spec.asset) continue;
    const isLast = i === specs.length - 1;
    const out = isLast ? output : join(work, `pass_${i}_${timestamp()}.mp4`);
    log.step(
      `Overlay ${i + 1}/${specs.length} (${spec.kind}) ` +
        `@ ${spec.start.toFixed(1)}–${spec.end.toFixed(1)}s: ${spec.phrase}`,
    );
    await applyOne(current, spec, dims, out);
    current = out;
  }
  return current;
}

/**
 * End-to-end: transcribe the body, plan keyword-timed overlays, generate the
 * B-roll visuals, and composite them. Returns the path to the overlaid video
 * (or the original body if nothing could be planned).
 */
export async function runOverlays(
  bodyVideo: string,
  script: string,
  cfg: AppConfig,
  output: string,
  opts: OverlayPlanOptions = {},
): Promise<{ output: string; count: number }> {
  log.step("Transcribing body for overlay timing…");
  const words = await getWordTimings(bodyVideo, cfg);
  if (!words || words.length === 0) {
    log.warn("No word timings available; skipping overlays.");
    return { output: bodyVideo, count: 0 };
  }

  const specs = await planOverlays(script, words, cfg, opts);
  if (specs.length === 0) {
    log.warn("No overlays planned; leaving body as-is.");
    return { output: bodyVideo, count: 0 };
  }
  log.ok(`Planned ${specs.length} overlay(s).`);

  const source = opts.source ?? "image";
  const backend = opts.backend ?? "browser";

  if (source === "video") {
    await generateOverlayClips(specs, cfg, backend);
  } else {
    for (const spec of specs) {
      try {
        spec.asset = await generateOverlayImage(spec, cfg);
      } catch (err) {
        log.warn(`Overlay image failed (${(err as Error).message}); skipping one.`);
      }
    }
  }

  const ready = specs.filter((s) => s.asset);
  if (ready.length === 0) {
    log.warn("No overlay visuals were generated; leaving body as-is.");
    return { output: bodyVideo, count: 0 };
  }

  const result = await addOverlays(bodyVideo, ready, output);
  log.ok(`Composited ${ready.length} overlay(s): ${result}`);
  return { output: result, count: ready.length };
}

/**
 * For each overlay, generate a portrait still then animate it into a B-roll clip.
 * Opens a single shared browser session when the Flow backend is used. Falls back
 * to the still image (Ken Burns) for any overlay whose clip fails.
 */
async function generateOverlayClips(
  specs: OverlaySpec[],
  cfg: AppConfig,
  backend: "api" | "browser",
): Promise<void> {
  // First, the stills (these are the first frames of the clips).
  for (const spec of specs) {
    try {
      spec.asset = await generateOverlayImage(spec, cfg, true);
    } catch (err) {
      log.warn(`Overlay still failed (${(err as Error).message}); skipping one.`);
    }
  }

  let release: (() => void) | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  if (backend === "browser") {
    release = await acquireBrowserLock();
    context = await launchContext(cfg, { headless: cfg.browser.headless });
    page = await getPage(context);
  }
  try {
    for (const spec of specs) {
      if (!spec.asset) continue;
      try {
        const clip = await generateOverlayClip(
          spec,
          cfg,
          backend,
          page ? { page } : undefined,
        );
        spec.asset = clip;
        spec.assetIsVideo = true;
      } catch (err) {
        // Keep the still as a graceful fallback (Ken Burns instead of motion).
        log.warn(
          `Overlay clip failed (${(err as Error).message}); using the still instead.`,
        );
      }
    }
  } finally {
    if (context) {
      try {
        await context.close();
      } catch {
        /* best-effort */
      }
    }
    if (release) release();
  }
}
