import { existsSync } from "node:fs";
import type { BrowserContext, Page } from "playwright";
import { loadConfig, type CampaignConfig } from "./config.js";
import type { CampaignRunChoices } from "./campaigns.js";
import { applyCampaign } from "./campaigns.js";
import {
  launchContext,
  getPage,
  withBrowser,
  acquireBrowserLock,
} from "./browser.js";
import { downloadAdVideo } from "./meta-ad-library.js";
import {
  transcribeVideo,
  splitTranscriptIntoSegments,
} from "./spy-classify.js";
import { spyStore } from "./spy-store.js";
import { generateVeoVideo } from "./veo-api.js";
import { generateFlowVideo } from "./flow.js";
import { generateModelImage } from "./nanobanana.js";
import { generateModelImageOpenAI } from "./openai-image.js";
import { addCaptions } from "./captions.js";
import { concatSegments } from "./video.js";
import { configureRateLimit } from "./ratelimit.js";
import { DEFAULT_MAX_HOOK_SECONDS } from "./hook-duration.js";
import {
  buildNamedOutputPath,
  releaseOutputPath,
  titleSlug,
  formatDuration,
} from "./utils.js";
import { runWithLogScope, log, type LogEntry } from "./logger.js";
import type { RunResult, ProgressUpdate } from "./pipeline.js";

export interface FullRemakeOptions {
  /** Suggestion to remake in full. */
  suggestionId: string;
  configPath?: string;
  onLog?: (entry: LogEntry) => void;
  onProgress?: (update: ProgressUpdate) => void;
  shouldStop?: () => boolean;
}

/**
 * Recreate an ENTIRE competitor ad (hook + body) end-to-end, not just the hook.
 *
 * Pipeline: download the winner → transcribe it → split the script into ~7s
 * spoken segments (same structure, original wording) → generate one consistent
 * persona image → for each segment generate a Veo clip + burn captions → stitch
 * every segment into a single full-length video. No external body clip needed.
 */
export async function runFullRemake(
  opts: FullRemakeOptions,
): Promise<RunResult> {
  if (opts.onLog) {
    return runWithLogScope(opts.onLog, () => runFullRemakeInner(opts));
  }
  return runFullRemakeInner(opts);
}

/** Build the in-memory campaign used to shape every segment's prompt. */
function remakeCampaign(
  vertical: string,
  angle: string,
  segments: string[],
  personaPrompt: string,
): CampaignConfig {
  return {
    id: "spy-full-remake",
    name: vertical,
    vertical,
    angle,
    bodyVideo: "",
    bodyVideos: [],
    outputName: titleSlug(vertical).replace(/_/g, " "),
    promptContext:
      "This is a full remake of a competitor ad that is currently scaling. " +
      "Recreate the same UGC talking-head style and persuasive flow.",
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
    hookBubbleEnabled: "",
    hookBubbleText: "",
    hookBubbleStyle: "",
  };
}

function choicesForSegment(
  segment: string,
  index: number,
  personaPrompt: string,
): CampaignRunChoices {
  return {
    hook: segment,
    creatorPrompt: personaPrompt,
    scenePrompt: "",
    cameraPrompt: "",
    variantId: "remake",
    variantName: "remake",
    variantIndex: 0,
    hookIndex: index,
    estimatedSpeakSeconds: DEFAULT_MAX_HOOK_SECONDS,
    bubbleText: segment,
    bodyVideo: "",
  };
}

async function runFullRemakeInner(opts: FullRemakeOptions): Promise<RunResult> {
  const startedAt = Date.now();
  const baseCfg = loadConfig(opts.configPath);
  configureRateLimit(baseCfg.concurrency.apiRequestsPerMinute);

  const suggestion = spyStore.getSuggestion(opts.suggestionId);
  if (!suggestion) throw new Error(`Unknown suggestion: ${opts.suggestionId}`);
  const ad = spyStore.getAd(suggestion.adKey);
  if (!ad) throw new Error(`Ad for suggestion ${opts.suggestionId} not found.`);

  const vertical = ad.vertical || suggestion.vertical;
  const angle = ad.angle || suggestion.angle || "a relatable consumer angle";

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
      persona: `Full remake · ${vertical}`,
      ...extra,
    });
  };

  const useBrowserGen = baseCfg.flow.backend === "browser";

  let reservedOutput: string | undefined;
  try {
    // 1) Ensure we have the winner's video locally. Hold the shared browser
    //    lock only for this brief download, then release it so a crawl or other
    //    job can use the profile while we generate.
    report("video", 0, 0);
    let localVideo = ad.localVideo;
    if (!localVideo || !existsSync(localVideo)) {
      localVideo =
        (await withBrowser(baseCfg, { headless: baseCfg.browser.headless }, (ctx, pg) =>
          downloadAdVideo(ctx, pg, ad),
        )) ?? undefined;
      if (localVideo) spyStore.patchAd(ad.key, { localVideo });
    }

    // 2) Transcribe (fall back to the ad copy if we can't get the video).
    let transcript = "";
    if (localVideo && existsSync(localVideo)) {
      try {
        transcript = await transcribeVideo(localVideo, baseCfg);
      } catch (err) {
        log.warn(`Transcription failed: ${(err as Error).message}`);
      }
    }
    if (!transcript) transcript = ad.text;
    if (!transcript.trim()) {
      throw new Error("No transcript or ad copy to remake from.");
    }

    // 3) Split into ~7s segments.
    const segments = await splitTranscriptIntoSegments(
      transcript,
      vertical,
      angle,
      baseCfg.spy.fullRemakeMaxSegments,
      baseCfg,
    );
    log.ok(`Full remake: ${segments.length} segment(s) planned.`);
    segments.forEach((s, i) => log.info(`  ${i + 1}. ${s}`));

    // 4) One consistent persona image, reused across every segment.
    const personaPrompt =
      `A candid, real-life UGC selfie of an everyday person who would ` +
      `authentically talk about ${vertical} (${angle}). Natural home setting, ` +
      `older-smartphone selfie look, not polished.`;
    const campaign = remakeCampaign(vertical, angle, segments, personaPrompt);

    report("image", 0, segments.length);
    const personaCfg = applyCampaign(
      baseCfg,
      campaign,
      choicesForSegment(segments[0]!, 0, personaPrompt),
    );
    const personaImage =
      baseCfg.imageSource.mode === "nanobanana"
        ? (await generateModelImage(personaCfg)).path
        : (await generateModelImageOpenAI(personaCfg)).path;
    log.ok(`Persona image ready (reused for all segments): ${personaImage}`);

    // 5) Generate a captioned clip per segment. The API backend needs no
    //    browser; the browser backend holds one exclusive session for the loop.
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
          log.warn("Stop requested; ending full remake.");
          break;
        }
        const segment = segments[i]!;
        log.step(`=== Segment ${i + 1}/${segments.length} ===`);
        const cfg = applyCampaign(
          baseCfg,
          campaign,
          choicesForSegment(segment, i, personaPrompt),
        );
        // Only the first segment carries the static hook bubble headline.
        cfg.captions.hookBubble.enabled =
          i === 0 ? baseCfg.captions.hookBubble.enabled : false;

        report("video", i + 1, segments.length, {
          hook: segment,
          imagePath: personaImage,
        });
        let clip = useBrowserGen
          ? await generateFlowVideo(genContext!, genPage!, cfg, personaImage)
          : await generateVeoVideo(cfg, personaImage);

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
      throw new Error("No segments were generated; nothing to stitch.");
    }

    // 6) Stitch all segments into one full video.
    report("splice", clips.length, segments.length, { imagePath: personaImage });
    const outputVideo = buildNamedOutputPath(
      baseCfg.video.outputDir,
      `${vertical} full`,
    );
    reservedOutput = outputVideo;
    const result = await concatSegments({
      clips,
      outputVideo,
      trimSeconds: baseCfg.video.trimSeconds,
    });

    report("run-done", clips.length, segments.length, {
      output: result.output,
      imagePath: personaImage,
    });
    log.ok(
      `Full remake done in ${formatDuration(Date.now() - startedAt)} ` +
        `(${result.segments} segments): ${result.output}`,
    );
    return { outputs: [result.output], elapsedMs: Date.now() - startedAt };
  } catch (err) {
    if (reservedOutput) releaseOutputPath(reservedOutput);
    throw err;
  }
}
