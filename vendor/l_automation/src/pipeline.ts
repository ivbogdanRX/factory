import { existsSync } from "node:fs";
import { loadConfig, resolvePath, type AppConfig } from "./config.js";
import { stripDashes } from "./speech-sanitizer.js";
import type { BrowserContext, Page } from "playwright";
import { launchContext, getPage, snapshot, acquireBrowserLock } from "./browser.js";
import { sourcePinterestImage } from "./pinterest.js";
import { generateFlowVideo } from "./flow.js";
import { generateVeoVideo, shouldFallbackToBrowser } from "./veo-api.js";
import { generateModelImage } from "./nanobanana.js";
import { generateModelImageOpenAI } from "./openai-image.js";
import { generateModelImageChatGPT } from "./chatgpt-image.js";
import { trimAndSplice, probe, type SpliceResult } from "./video.js";
import { addCaptions } from "./captions.js";
import { applyCampaign, findCampaign, CampaignBatchPicker } from "./campaigns.js";
import { autoCleanIntermediates } from "./gc.js";
import { SeenStore } from "./seen.js";
import {
  ensureDir,
  sleep,
  buildNamedOutputPath,
  releaseOutputPath,
  formatDuration,
} from "./utils.js";
import { runWithLogScope, log, type LogEntry } from "./logger.js";
import { configureRateLimit } from "./ratelimit.js";

export interface RunOptions {
  /** Path to a config file. Defaults to CONFIG env or ./config.json. */
  configPath?: string;
  /** Skip browser steps and use this already-downloaded clip. */
  generatedVideo?: string;
  /** Skip image generation/Pinterest and feed this local image to the generator. */
  image?: string;
  /** Number of videos to produce. Overrides config.run.count. */
  count?: number;
  /**
   * Override the base output directory (before the per-day subfolder). Used by
   * the batch runner to drop each vertical into output/<Vertical>/<date>/.
   */
  outputDir?: string;
  /** Force the generation backend, overriding config.flow.backend. */
  backend?: "api" | "browser";
  /**
   * Whether manual prompts (e.g. manual Flow download) are allowed. Defaults to
   * true. The batch runner sets this false so a stuck download fails the run
   * instead of blocking the whole batch on stdin.
   */
  interactive?: boolean;
  /** Loop forever until stopped. */
  loop?: boolean;
  /** Seconds between iterations. Overrides config.run.delaySeconds. */
  interval?: number;
  /** Campaign preset id to run, e.g. "bathroom-remodel-seniors". */
  campaignId?: string;
  /** Lock persona/variant index (0=judge, 1=podcast, …). Omit for random. */
  variantIndex?: number;
  /** Lock hook line within the variant (0-based). Omit to shuffle hooks. */
  hookIndex?: number;
  /** Use this exact spoken hook line, bypassing the variant's hooks entirely. */
  hookOverride?: string;
  /** Override the persona's reference-image prompt for this run/batch. */
  creatorPromptOverride?: string;
  /** Override the persona's scene/delivery concept for this run/batch. */
  scenePromptOverride?: string;
  /** Override top bubble headline for this run/batch. */
  hookBubbleText?: string;
  /** Random persona + hook selection (default true). Set false to rotate in order. */
  randomSelection?: boolean;
  /** Optional cooperative cancellation check. Return true to stop the loop. */
  shouldStop?: () => boolean;
  /** Optional per-line log sink (in addition to the console). */
  onLog?: (entry: LogEntry) => void;
  /** Optional structured progress sink for live UI cards. */
  onProgress?: (update: ProgressUpdate) => void;
}

/** A live snapshot of what the pipeline is doing right now, for the UI. */
export interface ProgressUpdate {
  /** Coarse phase of the current run. */
  phase: "image" | "video" | "captions" | "splice" | "run-done";
  /** 1-based index of the run currently in progress. */
  runIndex: number;
  /** Total runs requested (0 = continuous / unknown). */
  runTotal: number;
  persona?: string;
  hook?: string;
  bubble?: string;
  /** Relative path to the generated reference image, once available. */
  imagePath?: string;
  /** Final output path, set on run-done. */
  output?: string;
}

export interface RunResult {
  outputs: string[];
  elapsedMs: number;
}

/** The topic label used to name output files (e.g. "VA Loans"). */
function outputLabel(cfg: AppConfig): string {
  return cfg.video.name || cfg.pinterest.query || "video";
}

/**
 * The core generation pipeline, shared by the CLI (`src/index.ts`) and the web
 * server (`src/server.ts`). Sources/generates a reference image, generates a
 * hook clip, captions it, then trims and splices it onto the campaign body
 * video. Returns the list of produced output paths.
 */
export async function runGeneration(opts: RunOptions = {}): Promise<RunResult> {
  if (opts.onLog) {
    return runWithLogScope(opts.onLog, () => runGenerationInner(opts));
  }
  return runGenerationInner(opts);
}

async function runGenerationInner(opts: RunOptions): Promise<RunResult> {
  const startedAt = Date.now();
  {
    const baseCfg = loadConfig(opts.configPath);
    if (opts.outputDir) baseCfg.video.outputDir = resolvePath(opts.outputDir);
    if (opts.backend) baseCfg.flow.backend = opts.backend;
    const campaign = findCampaign(baseCfg, opts.campaignId);
    configureRateLimit(baseCfg.concurrency.apiRequestsPerMinute);
    ensureDir(baseCfg.browser.downloadDir);
    ensureDir(baseCfg.video.outputDir);

    // Garbage-collect stale helper/intermediate files before we start writing
    // new ones. output/ is never touched.
    if (baseCfg.maintenance.autoCleanIntermediates) {
      autoCleanIntermediates(baseCfg.maintenance.keepIntermediateHours);
    }

    const picker = campaign
      ? new CampaignBatchPicker(campaign, {
          variantIndex: opts.variantIndex,
          hookIndex: opts.hookIndex,
          hookOverride: opts.hookOverride,
          hookBubbleText: opts.hookBubbleText,
          random: opts.randomSelection ?? true,
        })
      : null;

    interface PreparedRun {
      cfg: AppConfig;
      persona?: string;
      hook?: string;
      bubble?: string;
    }

    const configForRun = (runIndex: number): PreparedRun => {
      if (!campaign || !picker) return { cfg: baseCfg };
      const choices = picker.pick(runIndex);
      if (opts.creatorPromptOverride?.trim()) {
        choices.creatorPrompt = opts.creatorPromptOverride.trim();
      }
      if (opts.scenePromptOverride?.trim()) {
        // Overrides bypass the picker, so they get the same dash-free rule.
        choices.scenePrompt = stripDashes(opts.scenePromptOverride.trim());
      }
      log.info(
        `Campaign: ${campaign.id} | Persona: ${choices.variantName} | ` +
          `Hook (~${choices.estimatedSpeakSeconds.toFixed(1)}s): ${choices.hook}`,
      );
      if (choices.bubbleText !== choices.hook) {
        log.info(`Bubble headline: ${choices.bubbleText}`);
      }
      if (choices.bodyVideo) {
        log.info(`Body clip: ${choices.bodyVideo.split("/").pop()}`);
      }
      if (choices.scenePrompt) log.info(`Scene: ${choices.scenePrompt}`);
      return {
        cfg: applyCampaign(baseCfg, campaign, choices),
        persona: choices.variantName,
        hook: choices.hook,
        bubble: choices.bubbleText,
      };
    };

    if (!campaign && baseCfg.video.targetVideo && !existsSync(baseCfg.video.targetVideo)) {
      throw new Error(
        `Target video not found: ${baseCfg.video.targetVideo}. ` +
          `Set video.targetVideo in config.json to the clip you want to splice after.`,
      );
    }

    // Fast path: video already generated, just do the editing step once.
    if (opts.generatedVideo) {
      log.step("Skipping browser steps; using provided generated video.");
      const { cfg } = configForRun(1);
      if (cfg.video.targetVideo && !existsSync(cfg.video.targetVideo)) {
        throw new Error(`Target video not found: ${cfg.video.targetVideo}`);
      }
      let generatedVideo = opts.generatedVideo;
      if (cfg.captions.enabled) {
        generatedVideo = await addCaptions(generatedVideo, cfg);
      }
      const outputVideo = buildNamedOutputPath(cfg.video.outputDir, outputLabel(cfg));
      
      let result: SpliceResult;
      if (!cfg.video.targetVideo) {
        log.step("No target video - outputting standalone generated video.");
        const { copyFile } = await import("node:fs/promises");
        await copyFile(generatedVideo, outputVideo);
        const probeInfo = await probe(generatedVideo);
        result = {
          output: outputVideo,
          generatedTrimmedDuration: probeInfo.durationSec,
        };
      } else {
        result = await trimAndSplice({
          generatedVideo,
          targetVideo: cfg.video.targetVideo,
          outputVideo,
          trimSeconds: cfg.video.trimSeconds,
        });
      }
      log.ok(`Done. Output: ${result.output}`);
      return { outputs: [result.output], elapsedMs: Date.now() - startedAt };
    }

    const count = opts.count ?? (opts.loop ? 0 : baseCfg.run.count);
    const delaySeconds = opts.interval ?? baseCfg.run.delaySeconds;
    const infinite = count <= 0;
    log.info(
      infinite
        ? "Continuous mode: producing videos until stopped."
        : `Producing ${count} video(s).`,
    );
    log.info(
      `Generation backend: ${baseCfg.flow.backend}` +
        (baseCfg.flow.backend === "api" && baseCfg.flow.browserFallback
          ? " (browser fallback on rate limit)"
          : ""),
    );
    if (campaign) log.info(`Using campaign preset: ${campaign.id}`);

    // The browser is only needed to source images from Pinterest, or when the
    // generation backend itself is the Flow web UI. With the API backend and a
    // local --image, no browser is launched at all.
    const usePinterest = !opts.image && baseCfg.imageSource.mode === "pinterest";
    const useChatGPT = !opts.image && baseCfg.imageSource.mode === "chatgpt";
    const needsBrowser = baseCfg.flow.backend === "browser" || usePinterest || useChatGPT;

    // Held in an object so the closure below can populate it without tripping
    // TypeScript's control-flow narrowing of plain `let` bindings.
    const browser: {
      context: BrowserContext | null;
      page: Page | null;
      release: (() => void) | null;
    } = { context: null, page: null, release: null };

    // Lazily launch the shared browser once and reuse it for the rest of the
    // batch. Used up-front for Pinterest/browser backend, and on-demand when
    // the API backend rate-limits and we fall back to the Flow web UI.
    const ensureBrowser = async (headless: boolean): Promise<void> => {
      if (browser.context && browser.page) return;
      if (headless) log.info("Launching browser headless (no window).");
      // Serialize access to the shared persistent profile (a crawl or another
      // job may be using it). Released in the finally below.
      browser.release = await acquireBrowserLock();
      browser.context = await launchContext(baseCfg, { headless });
      browser.page = await getPage(browser.context);
    };

    if (needsBrowser) {
      // ChatGPT is picky about headless browsers (Cloudflare), so it always
      // follows the configured headless setting instead of forcing headless.
      await ensureBrowser(
        baseCfg.flow.backend === "api" && !useChatGPT ? true : baseCfg.browser.headless,
      );
    }

    // The backend in effect right now. Starts at the configured backend and,
    // when flow.browserFallback is on, flips permanently to "browser" the first
    // time the API hits a rate limit — so the rest of the batch reuses Flow.
    let activeBackend = baseCfg.flow.backend;

    const outputs: string[] = [];
    const seen = new SeenStore();

    try {
      let i = 0;
      while (infinite || i < count) {
        if (opts.shouldStop?.()) {
          log.warn("Stop requested; ending run loop.");
          break;
        }
        i += 1;
        const label = infinite ? `#${i}` : `${i}/${count}`;
        log.step(`=== Run ${label} ===`);
        const runStart = Date.now();

        let reservedOutput: string | undefined;
        try {
          const { cfg, persona, hook, bubble } = configForRun(i);
          if (cfg.video.targetVideo && !existsSync(cfg.video.targetVideo)) {
            throw new Error(`Target video not found: ${cfg.video.targetVideo}`);
          }

          let currentImage: string | undefined;
          const report = (
            phase: ProgressUpdate["phase"],
            extra: Partial<ProgressUpdate> = {},
          ): void => {
            opts.onProgress?.({
              phase,
              runIndex: i,
              runTotal: infinite ? 0 : count,
              persona,
              hook,
              bubble,
              imagePath: currentImage,
              ...extra,
            });
          };

          report("image");
          let imagePath = opts.image;
          let pinKey = "";
          if (imagePath) {
            log.step(`Using provided local image: ${imagePath}`);
          } else if (cfg.imageSource.mode === "openai") {
            const model = await generateModelImageOpenAI(cfg);
            imagePath = model.path;
          } else if (cfg.imageSource.mode === "nanobanana") {
            const model = await generateModelImage(cfg);
            imagePath = model.path;
          } else if (cfg.imageSource.mode === "chatgpt") {
            const model = await generateModelImageChatGPT(
              browser.context!,
              browser.page!,
              cfg,
            );
            imagePath = model.path;
          } else {
            const idx = cfg.pinterest.resultIndex + (i - 1);
            const sourced = await sourcePinterestImage(
              browser.context!,
              browser.page!,
              cfg,
              idx,
            );
            imagePath = sourced.path;
            pinKey = sourced.key;
          }
          currentImage = imagePath;

          report("video");
          let generatedVideo: string;
          if (activeBackend === "api") {
            try {
              generatedVideo = await generateVeoVideo(cfg, imagePath);
            } catch (err) {
              if (shouldFallbackToBrowser(err, baseCfg.flow.browserFallback)) {
                log.warn(
                  "Veo API is rate-limited. Falling back to the Flow browser " +
                    "backend for this and all remaining runs in this batch.",
                );
                await ensureBrowser(baseCfg.browser.headless);
                activeBackend = "browser";
                generatedVideo = await generateFlowVideo(
                  browser.context!,
                  browser.page!,
                  cfg,
                  imagePath,
                  opts.interactive ?? true,
                );
              } else {
                throw err;
              }
            }
          } else {
            generatedVideo = await generateFlowVideo(
              browser.context!,
              browser.page!,
              cfg,
              imagePath,
              opts.interactive ?? true,
            );
          }

          if (cfg.captions.enabled) {
            report("captions");
            generatedVideo = await addCaptions(generatedVideo, cfg);
          }

          report("splice");
          const outputVideo = buildNamedOutputPath(
            cfg.video.outputDir,
            outputLabel(cfg),
          );
          reservedOutput = outputVideo;
          
          let result: SpliceResult;
          if (!cfg.video.targetVideo) {
            log.step("No target video - outputting standalone generated video.");
            const { copyFile } = await import("node:fs/promises");
            await copyFile(generatedVideo, outputVideo);
            const probeInfo = await probe(generatedVideo);
            result = {
              output: outputVideo,
              generatedTrimmedDuration: probeInfo.durationSec,
            };
          } else {
            result = await trimAndSplice({
              generatedVideo,
              targetVideo: cfg.video.targetVideo,
              outputVideo,
              trimSeconds: cfg.video.trimSeconds,
            });
          }
          
          if (pinKey) seen.add(pinKey);
          outputs.push(result.output);
          report("run-done", { output: result.output });
          log.ok(
            `Run ${label} saved in ${formatDuration(Date.now() - runStart)}: ${result.output}`,
          );
        } catch (err) {
          if (reservedOutput) releaseOutputPath(reservedOutput);
          if (browser.page) await snapshot(browser.page, `failure_run_${i}`);
          log.error(
            `Run ${label} failed after ${formatDuration(Date.now() - runStart)}: ${(err as Error).message}`,
          );
          // Keep going in loop mode; abort a single run.
          if (!infinite && count === 1) throw err;
        }

        if ((infinite || i < count) && delaySeconds > 0) {
          log.info(`Waiting ${delaySeconds}s before the next run...`);
          await sleep(delaySeconds * 1000);
        }
      }
    } finally {
      if (browser.context) {
        try {
          await browser.context.close();
        } catch {
          /* best-effort */
        }
      }
      if (browser.release) browser.release();
    }

    const elapsedMs = Date.now() - startedAt;
    log.ok(
      `Finished in ${formatDuration(elapsedMs)}. Produced ${outputs.length} video(s)` +
        (outputs.length > 0
          ? ` (avg ${formatDuration(elapsedMs / outputs.length)} each):`
          : ":"),
    );
    for (const o of outputs) log.info(`  ${o}`);
    return { outputs, elapsedMs };
  }
}
