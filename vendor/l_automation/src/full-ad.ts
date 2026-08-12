import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { loadConfig, resolvePath, type CampaignConfig } from "./config.js";
import type { CampaignRunChoices } from "./campaigns.js";
import { applyCampaign } from "./campaigns.js";
import { launchContext, getPage, acquireBrowserLock } from "./browser.js";
import { splitTranscriptIntoSegments } from "./spy-classify.js";
import { generateVeoVideo } from "./veo-api.js";
import { generateFlowVideo } from "./flow.js";
import { generateModelImage } from "./nanobanana.js";
import { generateModelImageOpenAI } from "./openai-image.js";
import { addCaptions, tightenSilence } from "./captions.js";
import { concatSegments, trimAndSplice, changeSpeed } from "./video.js";
import { runOverlays, type OverlayKind, type OverlaySource } from "./overlays.js";
import { configureRateLimit } from "./ratelimit.js";
import { DEFAULT_MAX_HOOK_SECONDS } from "./hook-duration.js";
import {
  buildNamedOutputPath,
  releaseOutputPath,
  titleSlug,
  formatDuration,
  ensureDir,
  timestamp,
} from "./utils.js";
import { runWithLogScope, log, type LogEntry } from "./logger.js";
import type { RunResult, ProgressUpdate } from "./pipeline.js";

export interface FullAdOptions {
  /** Topic / vertical, used for prompts and the output filename, e.g. "VA Loans". */
  name: string;
  /** Marketing angle / audience, e.g. "veterans / no money down". */
  angle?: string;
  /** Optional offer/product context injected into every clip's prompt. */
  promptContext?: string;
  /** Optional persona/creator description. Blank = a sensible everyday UGC persona. */
  personaPrompt?: string;
  /**
   * The full ad script. Either:
   *  - one spoken line per clip (autoSplit = false), or
   *  - a free-form blob that gets AI-split into ~8s spoken segments (autoSplit = true).
   */
  script: string;
  /** AI-split the script into ~8s segments instead of splitting by line. */
  autoSplit?: boolean;
  /** Cap on the number of clips when auto-splitting. */
  maxSegments?: number;
  /** Override caption burn-in (defaults to config.captions.enabled). */
  captionsEnabled?: boolean;
  /** Fixed top-bar headline for the first clip. Blank = no bubble. */
  hookBubbleText?: string;
  /**
   * Speed up the finished video by this factor (e.g. 1.1 = 10% faster). Pitch is
   * preserved. Defaults to 1.0 (no change).
   */
  speed?: number;
  /**
   * Add auto-generated B-roll overlays to the finished video. Visuals are
   * generated from script keywords and placed on the words they relate to.
   */
  overlays?: boolean;
  /** Overlay style: "both" (default), "fullframe" cutaways only, or "pip" cards only. */
  overlayStyle?: "both" | OverlayKind;
  /** Overlay visuals as AI stills ("image", default) or AI video clips ("video"). */
  overlaySource?: OverlaySource;
  /** Hard cap on the number of overlays. Default scales with body length. */
  maxOverlays?: number;
  /**
   * Optional reusable body clip (e.g. "./assets/Ndebt body.mov"). When set, the
   * generated script clips become the HOOK and are spliced in front of this body
   * — so you can reuse one body video with fresh hooks for a new audience. When
   * blank, the script clips are stitched into the whole video on their own.
   */
  bodyVideo?: string;
  /**
   * Generation backend. Defaults to "browser" (Flow web UI) so this works
   * without API quota — the page asked for browser-for-now.
   */
  backend?: "api" | "browser";
  configPath?: string;
  onLog?: (entry: LogEntry) => void;
  onProgress?: (update: ProgressUpdate) => void;
  shouldStop?: () => boolean;
}

/**
 * Generate a brand-new, full-length UGC ad from scratch: a user-provided script
 * is broken into spoken clips, one consistent persona image is generated, each
 * clip is generated + captioned, and every clip is stitched into one video.
 *
 * Unlike the spy "full remake", nothing is downloaded or transcribed — the
 * script comes straight from the New Ad form. Defaults to the browser (Flow)
 * backend so it runs without Veo API quota.
 */
export async function runFullAd(opts: FullAdOptions): Promise<RunResult> {
  if (opts.onLog) {
    return runWithLogScope(opts.onLog, () => runFullAdInner(opts));
  }
  return runFullAdInner(opts);
}

function adCampaign(
  vertical: string,
  angle: string,
  promptContext: string,
  segments: string[],
  personaPrompt: string,
  hookBubbleText: string,
): CampaignConfig {
  return {
    id: "full-ad",
    name: vertical,
    vertical,
    angle,
    bodyVideo: "",
    bodyVideos: [],
    outputName: titleSlug(vertical).replace(/_/g, " "),
    promptContext:
      promptContext.trim() ||
      "Brand-new UGC talking-head ad. Recreate an authentic, real-life selfie style.",
    cameraStyle: "",
    cameraPrompts: [],
    creatorPrompts: [personaPrompt],
    scenePrompts: [],
    promptTemplate: "",
    hooks: segments,
    variants: [],
    maxHookSeconds: DEFAULT_MAX_HOOK_SECONDS,
    trimSeconds: 0,
    captionVerticalPosition: 0,
    captionStyle: "",
    captionPosition: "",
    hookBubbleEnabled: hookBubbleText.trim() ? "true" : "",
    hookBubbleText: hookBubbleText.trim(),
    hookBubbleStyle: "",
  };
}

function choicesForSegment(
  segment: string,
  index: number,
  personaPrompt: string,
  bubbleText: string,
): CampaignRunChoices {
  return {
    hook: segment,
    creatorPrompt: personaPrompt,
    scenePrompt: "",
    cameraPrompt: "",
    variantId: "full-ad",
    variantName: "full-ad",
    variantIndex: 0,
    hookIndex: index,
    estimatedSpeakSeconds: DEFAULT_MAX_HOOK_SECONDS,
    bubbleText,
    bodyVideo: "",
  };
}

/** Split the script into clip-sized lines. */
async function resolveSegments(
  opts: FullAdOptions,
  vertical: string,
  angle: string,
): Promise<string[]> {
  const raw = opts.script.trim();
  if (!raw) throw new Error("No script provided. Add a script to generate from.");

  const byLine = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (!opts.autoSplit) {
    if (byLine.length === 0) throw new Error("Script has no usable lines.");
    return byLine;
  }

  const baseCfg = loadConfig(opts.configPath);
  const max = Math.max(1, opts.maxSegments ?? baseCfg.spy.fullRemakeMaxSegments);
  log.step(`Auto-splitting the script into up to ${max} clip(s)…`);
  const segments = await splitTranscriptIntoSegments(
    raw,
    vertical,
    angle,
    max,
    baseCfg,
  );
  if (segments.length === 0) throw new Error("Could not split the script into segments.");
  return segments;
}

async function runFullAdInner(opts: FullAdOptions): Promise<RunResult> {
  const startedAt = Date.now();
  const baseCfg = loadConfig(opts.configPath);
  configureRateLimit(baseCfg.concurrency.apiRequestsPerMinute);

  // Browser-for-now: default to the Flow web UI backend.
  const backend = opts.backend ?? "browser";
  baseCfg.flow.backend = backend;
  if (typeof opts.captionsEnabled === "boolean") {
    baseCfg.captions.enabled = opts.captionsEnabled;
  }

  const vertical = opts.name.trim();
  if (!vertical) throw new Error("A topic / vertical name is required.");
  const angle = (opts.angle ?? "").trim() || "a relatable consumer angle";
  const promptContext = opts.promptContext ?? "";
  const hookBubbleText = opts.hookBubbleText ?? "";

  let bodyVideo: string | undefined;
  if (opts.bodyVideo?.trim()) {
    bodyVideo = resolvePath(opts.bodyVideo.trim());
    if (!existsSync(bodyVideo)) {
      throw new Error(`Body video not found: ${bodyVideo}`);
    }
  }

  const report = (
    phase: ProgressUpdate["phase"],
    runIndex: number,
    runTotal: number,
    extra: Partial<ProgressUpdate> = {},
  ): void => {
    opts.onProgress?.({
      phase,
      runIndex,
      runTotal,
      persona: `New ad · ${vertical}`,
      ...extra,
    });
  };

  const useBrowserGen = backend === "browser";

  let reservedOutput: string | undefined;
  try {
    // 1) Break the script into clip-sized spoken segments.
    report("video", 0, 0);
    const segments = await resolveSegments(opts, vertical, angle);
    log.ok(`New ad: ${segments.length} clip(s) planned.`);
    segments.forEach((s, i) => log.info(`  ${i + 1}. ${s}`));

    // 2) One consistent persona image, reused across every clip.
    const personaPrompt =
      opts.personaPrompt?.trim() ||
      `A candid, real-life UGC selfie of an everyday person who would ` +
        `authentically talk about ${vertical} (${angle}). Natural home setting, ` +
        `older-smartphone selfie look, not polished.`;
    const campaign = adCampaign(
      vertical,
      angle,
      promptContext,
      segments,
      personaPrompt,
      hookBubbleText,
    );

    report("image", 0, segments.length);
    const personaCfg = applyCampaign(
      baseCfg,
      campaign,
      choicesForSegment(segments[0]!, 0, personaPrompt, hookBubbleText || segments[0]!),
    );
    const personaImage =
      baseCfg.imageSource.mode === "nanobanana"
        ? (await generateModelImage(personaCfg)).path
        : (await generateModelImageOpenAI(personaCfg)).path;
    log.ok(`Persona image ready (reused for all clips): ${personaImage}`);

    // 3) Generate a captioned clip per segment.
    const clips: string[] = [];
    let genRelease: (() => void) | null = null;
    let genContext: BrowserContext | null = null;
    let genPage: Page | null = null;
    if (useBrowserGen) {
      genRelease = await acquireBrowserLock();
      genContext = await launchContext(baseCfg, {
        headless: baseCfg.browser.headless,
      });
      genPage = await getPage(genContext);
    }
    try {
      for (let i = 0; i < segments.length; i++) {
        if (opts.shouldStop?.()) {
          log.warn("Stop requested; ending new ad generation.");
          break;
        }
        const segment = segments[i]!;
        log.step(`=== Clip ${i + 1}/${segments.length} ===`);
        const cfg = applyCampaign(
          baseCfg,
          campaign,
          choicesForSegment(
            segment,
            i,
            personaPrompt,
            i === 0 ? hookBubbleText || segment : segment,
          ),
        );
        // Only the first clip carries the static top-bar headline.
        cfg.captions.hookBubble.enabled =
          i === 0 ? campaign.hookBubbleEnabled === "true" : false;

        report("video", i + 1, segments.length, {
          hook: segment,
          imagePath: personaImage,
        });
        let clip = useBrowserGen
          ? await generateFlowVideo(genContext!, genPage!, cfg, personaImage)
          : await generateVeoVideo(cfg, personaImage);

        // Each Veo clip is a fixed ~8s; short lines leave seconds of dead air.
        // Trim down to the spoken span so the stitched ad is tight, not draggy.
        clip = await tightenSilence(clip, cfg);

        if (cfg.captions.enabled) {
          report("captions", i + 1, segments.length, {
            hook: segment,
            imagePath: personaImage,
          });
          clip = await addCaptions(clip, cfg);
        }
        clips.push(clip);
      }
    } finally {
      if (genContext) {
        try {
          await genContext.close();
        } catch {
          /* best-effort */
        }
      }
      if (genRelease) genRelease();
    }

    if (clips.length === 0) {
      throw new Error("No clips were generated; nothing to stitch.");
    }

    // 4) Stitch the clips. With a body video, the clips are the HOOK and get
    //    spliced in front of the reused body; otherwise they ARE the whole ad.
    report("splice", clips.length, segments.length, { imagePath: personaImage });
    const outputVideo = buildNamedOutputPath(baseCfg.video.outputDir, vertical);
    reservedOutput = outputVideo;

    // Post-processing (overlays, speed) needs intermediates; only write straight
    // to the final output path when there's nothing left to do after stitching.
    const speed = opts.speed && opts.speed > 0 ? opts.speed : 1;
    const wantOverlays = opts.overlays === true;
    const needsPost = speed !== 1 || wantOverlays;
    const artifacts = ensureDir("artifacts/full-ad");
    const stitched = needsPost
      ? join(artifacts, `stitched_${timestamp()}.mp4`)
      : outputVideo;

    let kind: string;
    if (bodyVideo) {
      const hookVideo = join(artifacts, `hook_${timestamp()}.mp4`);
      await concatSegments({ clips, outputVideo: hookVideo, trimSeconds: 0 });
      log.step(`Splicing hook in front of body: ${bodyVideo}`);
      await trimAndSplice({
        generatedVideo: hookVideo,
        targetVideo: bodyVideo,
        outputVideo: stitched,
        trimSeconds: 0,
      });
      kind = `${clips.length}-clip hook + body`;
    } else {
      const result = await concatSegments({ clips, outputVideo: stitched, trimSeconds: 0 });
      kind = `${result.segments} clips`;
    }

    // B-roll overlays, timed to script keywords (before the speed change so the
    // timing matches; the speed pass retimes overlays with the frames).
    let working = stitched;
    let overlayCount = 0;
    if (wantOverlays) {
      log.step("Adding B-roll overlays…");
      const ovOut = join(artifacts, `overlaid_${timestamp()}.mp4`);
      const res = await runOverlays(working, opts.script, baseCfg, ovOut, {
        style: opts.overlayStyle ?? "both",
        source: opts.overlaySource ?? "image",
        backend,
        maxOverlays: opts.maxOverlays,
      });
      working = res.output;
      overlayCount = res.count;
    }

    // Finalize to the reserved output path (applying speed, or a clean remux).
    let finalOutput = outputVideo;
    if (speed !== 1) {
      log.step(`Speeding up the final video to ${speed}x...`);
      await changeSpeed(working, outputVideo, speed);
    } else if (working !== outputVideo) {
      await changeSpeed(working, outputVideo, 1);
    }

    log.ok(
      `New ad done in ${formatDuration(Date.now() - startedAt)} ` +
        `(${kind}${overlayCount ? `, ${overlayCount} overlays` : ""}` +
        `${speed !== 1 ? `, ${speed}x` : ""}): ${finalOutput}`,
    );

    report("run-done", clips.length, segments.length, {
      output: finalOutput,
      imagePath: personaImage,
    });
    return { outputs: [finalOutput], elapsedMs: Date.now() - startedAt };
  } catch (err) {
    if (reservedOutput) releaseOutputPath(reservedOutput);
    throw err;
  }
}
