import { readFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_HOOK_SECONDS } from "./hook-duration.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Project root (one level up from src/). */
export const PROJECT_ROOT = resolve(__dirname, "..");

export interface PinterestConfig {
  /** Search query used when no direct imageUrl is given. */
  query: string;
  /** If set, skip search and use this image URL directly. */
  imageUrl: string;
  /** Which search result to pick (0-based). */
  resultIndex: number;
}

export interface NanoBananaConfig {
  /** Gemini image model id (Nano Banana Pro = "gemini-3-pro-image-preview"). */
  model: string;
  aspectRatio: string;
  /** "1K", "2K", or "4K". */
  imageSize: string;
  /** If set, use this exact prompt instead of the randomized UGC one. */
  promptOverride: string;
}

export interface OpenAIImageConfig {
  /** OpenAI image model id, e.g. "gpt-image-1". */
  model: string;
  /** "auto", "1024x1024", "1024x1536" (portrait), or "1536x1024" (landscape). */
  size: "auto" | "1024x1024" | "1024x1536" | "1536x1024";
  /** "low", "medium", "high", or "auto". */
  quality: "low" | "medium" | "high" | "auto";
  /** If set, use this exact prompt instead of the randomized UGC one. */
  promptOverride: string;
}

export interface ChatGPTImageConfig {
  /** ChatGPT web app URL (a fresh conversation is opened per run). */
  url: string;
  /** Max seconds to wait for the image to render. */
  timeoutSec: number;
  /** If set, use this exact prompt instead of the randomized UGC one. */
  promptOverride: string;
}

export interface ImageSourceConfig {
  /** Where the reference image comes from. */
  mode: "pinterest" | "nanobanana" | "openai" | "chatgpt";
  nanoBanana: NanoBananaConfig;
  openai: OpenAIImageConfig;
  chatgpt: ChatGPTImageConfig;
}

export interface ImageAdsConfig {
  /** OpenAI image model used to render static image-ad variations. */
  model: string;
  /** Output size for generated ads. */
  size: "1024x1024" | "1024x1536" | "1536x1024";
  /** "low", "medium", "high", or "auto". */
  quality: "low" | "medium" | "high" | "auto";
  /** Vision+text model used to study winners and rewrite variation copy. */
  analysisModel: string;
  /** Default number of variations generated per uploaded winner. */
  variationsPerWinner: number;
  /**
   * Variation strategy:
   *  - "edit": remix the uploaded winner (keeps composition, swaps subject/copy).
   *  - "fresh": generate from the study only (more variety, avoids copying art).
   *  - "both": split the count between edit and fresh.
   */
  mode: "edit" | "fresh" | "both";
  /**
   * How many image-generation calls to run in parallel per winner. The shared
   * API rate limiter still paces request starts. Defaults to 4.
   */
  concurrency: number;
}

export interface FlowConfig {
  /**
   * How the video is generated:
   *  - "api": call the Veo model directly via the Gemini API (fast, headless,
   *    reliable; pay-per-second; needs GEMINI_API_KEY).
   *  - "browser": drive the Google Flow web UI with Playwright.
   */
  backend: "api" | "browser";
  /**
   * When the "api" backend is rate-limited / out of quota (HTTP 429), fall back
   * to the "browser" (Flow web UI) backend and stay on it for the rest of the
   * batch instead of retrying the API. No effect when backend is "browser".
   */
  browserFallback: boolean;
  url: string;
  prompt: string;
  /** How long to wait for generation to finish, in ms. */
  generationTimeoutMs: number;
  /**
   * Optional Veo model name to pick in the Video tab (e.g. "Veo 3"). Leave
   * empty to use Flow's current default video model. (browser backend)
   */
  model: string;
  /**
   * Image-to-video sub-mode: "Ingredients" (reference images) or "Frames"
   * (start/end frames). Empty leaves Flow's default. (browser backend)
   */
  mode: string;
  /** Output aspect ratio, e.g. "9:16" or "16:9". Empty leaves default. */
  aspectRatio: string;
  /**
   * Gemini API model id (api backend). Quality tiers, best first:
   * "veo-3.1-generate-preview" (Standard, highest quality),
   * "veo-3.1-fast-generate-preview" (Fast), and
   * "veo-3.1-lite-generate-preview" (Lite, lowest cost / highest volume).
   */
  apiModel: string;
  /**
   * Ordered fallback model ids (api backend). When apiModel is unavailable or
   * rate-limited (403/404/429), generation retries with the next id in this
   * list — typically stepping down from Standard → Fast → Lite.
   */
  apiModelFallbacks: string[];
  /** Output resolution for the api backend: "720p" or "1080p". */
  resolution: string;
  /**
   * Per-model Veo request cap per minute (RPM). Gemini API Tier 1 = 2/min.
   * Used only for the capacity display, not enforcement.
   */
  veoRequestsPerMinute: number;
  /**
   * Per-model Veo request cap per day (RPD). Gemini API Tier 1 = 10/day.
   * This is usually the real ceiling. Resets at midnight Pacific.
   */
  veoRequestsPerDay: number;
}

export interface VideoConfig {
  /** The "other" video the generated clip is spliced in front of. */
  targetVideo: string;
  /** Base dir; final videos go into <outputDir>/<YYYY-MM-DD>/. */
  outputDir: string;
  /** Seconds to cut off the end of the generated clip. */
  trimSeconds: number;
  /** Topic label for output filenames, e.g. "VA Loans" -> VA_Loans_6_15_v1.mp4. */
  name: string;
}

export interface CampaignVariant {
  /** Stable id, e.g. "judge". */
  id: string;
  /** Display name, e.g. "Judge / Courtroom". */
  name: string;
  creatorPrompt: string;
  scenePrompt: string;
  cameraPrompt: string;
  /** Spoken hook lines for this persona (~maxHookSeconds each). */
  hooks: string[];
  /** Short bubble-only headlines (top white box). Random when set; spoken hook stays separate. */
  bubbleHooks: string[];
}

export interface CampaignConfig {
  /** Stable CLI id, e.g. "bathroom-remodel-seniors". */
  id: string;
  /** Human-readable campaign name used in logs. */
  name: string;
  /** What is being sold, e.g. "bathroom remodel". */
  vertical: string;
  /** The marketing angle/audience, e.g. "seniors / safer bathroom". */
  angle: string;
  /** The body clip to append after the generated hook. */
  bodyVideo: string;
  /**
   * Optional extra body clips. When set, each run randomly rotates across
   * `bodyVideo` plus these, so a batch mixes multiple body videos.
   */
  bodyVideos: string[];
  /** Output filename label. Defaults to name/vertical when empty. */
  outputName: string;
  /** Extra product/audience context injected into the generation prompt. */
  promptContext: string;
  /**
   * Optional camera/framing description applied to every run when set.
   * Prefer `cameraPrompts` when each persona needs different framing.
   * Leave empty for the standard handheld selfie look.
   */
  cameraStyle: string;
  /** Per-persona camera/framing prompts, rotated with creatorPrompts. */
  cameraPrompts: string[];
  /** Campaign-specific reference image prompts, rotated per run. */
  creatorPrompts: string[];
  /** Campaign-specific video concept/persona prompts, rotated per run. */
  scenePrompts: string[];
  /**
   * Optional full prompt template. Use {{hook}}, {{vertical}}, {{angle}},
   * {{promptContext}}, {{cameraStyle}}, {{cameraPrompt}}, {{creatorPrompt}},
   * and {{scenePrompt}} placeholders.
   * If empty, a default UGC hook prompt is used.
   */
  promptTemplate: string;
  /** Exact spoken hook lines (legacy flat list; prefer variants[].hooks). */
  hooks: string[];
  /**
   * Persona presets with their own prompts and hook lines. When set, generation
   * picks from these instead of rotating parallel prompt arrays.
   */
  variants: CampaignVariant[];
  /** Target speak time for hook lines in seconds (Veo clip ≈ 8s minus trim). */
  maxHookSeconds: number;
  /** Optional per-campaign trim override; <= 0 uses video.trimSeconds. */
  trimSeconds: number;
  /** Optional caption y-position override; <= 0 uses captions.verticalPosition. */
  captionVerticalPosition: number;
  /** Per-campaign timed caption look. Empty = global. */
  captionStyle: string;
  /** Per-campaign timed caption placement. Empty = global. */
  captionPosition: string;
  /** Per-campaign hook bubble on/off. Empty = global hookBubble.enabled. */
  hookBubbleEnabled: string;
  /**
   * Fixed bubble headline for every run in this campaign. Empty = random from
   * variant bubbleHooks, then falls back to the spoken hook line.
   */
  hookBubbleText: string;
  /** Per-campaign hook bubble look ("box" | "shadow" | "card"). Empty = global hookBubble.style. */
  hookBubbleStyle: string;
}

export interface RunConfig {
  /** How many videos to produce. 0 means loop until stopped (Ctrl+C). */
  count: number;
  /** Seconds to wait between iterations in a loop. */
  delaySeconds: number;
}

export interface ConcurrencyConfig {
  /** How many generation jobs may run in parallel (web server worker pool). */
  maxConcurrentJobs: number;
  /**
   * Global cap on rate-limited API requests per minute (image + video
   * generation), shared across all concurrent jobs. 0 disables the limiter.
   */
  apiRequestsPerMinute: number;
}

export interface MaintenanceConfig {
  /**
   * Auto-delete stale intermediate/helper files at the start of each run
   * (extracted audio, normalized clips, debug screenshots, raw downloads, …).
   * Finished videos in output/ are never touched.
   */
  autoCleanIntermediates: boolean;
  /**
   * Keep intermediates touched within this many hours; anything older is pruned.
   * Defaults to 24h, so the current/recent working set survives but yesterday's
   * leftovers are cleared. Set 0 to wipe all intermediates on every run.
   */
  keepIntermediateHours: number;
}

export interface HookBubbleConfig {
  /** Bold white hook headline in the top letterbox (separate from timed captions). */
  enabled: boolean;
  bold: boolean;
  /** Override text; empty = use the hook dialogue. */
  text: string;
  bubbleColor: string;
  textColor: string;
  /** Inner padding (0 = auto from font size). */
  bubblePadding: number;
  /**
   * Look of the headline:
   * - "box": opaque colored box behind dark text (default). Each line gets its
   *   own box, so two lines of different widths render a stair-step.
   * - "card": ONE rounded rectangle behind the whole headline — cleaner than
   *   "box" for multi-line hooks.
   * - "shadow": white text with a soft blurred dark shadow, no box (CapCut style).
   *   Shadow style also preserves the headline's original casing.
   */
  style: "box" | "shadow" | "card";
}

export interface CaptionsConfig {
  /** Burn captions onto the generated clip before splicing. */
  enabled: boolean;
  /**
   * Caption text. If empty, it's auto-extracted from the Dialogue: '...' part
   * of flow.prompt. The words shown are ALWAYS this exact text (no AI guessing);
   * Whisper is used only to time them.
   */
  dialogue: string;
  /** How many words appear on screen at once (UGC pop style). */
  wordsPerGroup: number;
  /** UPPERCASE the captions (common for UGC). */
  upperCase: boolean;
  /**
   * Text placement guide. "3:4" keeps the video full 9:16 but positions text
   * inside the centered 3:4 safe rectangle (hook near its top edge, captions
   * near its bottom edge). The extra 9:16 headroom/footroom stays text-free.
   */
  layout: "fill" | "3:4";
  /**
   * Timed caption placement (within the bottom safe zone when layout is "3:4").
   */
  position: "top" | "middle" | "bottom";
  /**
   * Timed caption look. Use "default" (outlined text). Hook headlines use
   * hookBubble separately.
   */
  style: "default" | "bubble";
  /**
   * Exact vertical placement as a fraction from the top (0 = top, 1 = bottom).
   * 0 = use the `position` preset instead. e.g. 0.72 = lower third.
   */
  verticalPosition: number;
  /** Bubble fill color when style is "bubble". */
  bubbleColor: string;
  /** Bubble text color when style is "bubble". */
  bubbleTextColor: string;
  /** Extra padding inside a caption bubble when style is "bubble" (legacy). */
  bubblePadding: number;
  /** Static hook headline bubble (top letterbox when layout is "3:4"). */
  hookBubble: HookBubbleConfig;
  fontName: string;
  /** 0 = auto-size from video height. */
  fontSize: number;
  /** Hex colors like "#FFFFFF". */
  primaryColor: string;
  outlineColor: string;
  outlineWidth: number;
  /** Highlight the currently-spoken word (karaoke style). */
  highlightCurrentWord: boolean;
  /** Fill color for the active word when highlighting. */
  highlightColor: string;
  /**
   * Timing engine for word highlighting:
   *  - "auto": faster-whisper if available, else whisper.cpp, else even.
   *  - "faster-whisper": accurate word timestamps (Python venv). Recommended.
   *  - "whisper.cpp": coarse word timing from the whisper-cli binary.
   *  - "even": no transcription; distribute words evenly.
   */
  timingEngine: "auto" | "faster-whisper" | "whisper.cpp" | "even";
  /** Shift all caption times by this many seconds (+ = later). Fine-tuning. */
  timingOffsetSec: number;
  /** Python interpreter with faster-whisper installed. */
  fasterWhisperPython: string;
  /** faster-whisper model name (e.g. "base.en", "small.en") or a local path. */
  fasterWhisperModel: string;
  /** whisper.cpp CLI binary (e.g. "whisper-cli"). */
  whisperBinary: string;
  /** Path to a ggml whisper model (e.g. ggml-base.en.bin). Empty = skip Whisper. */
  whisperModel: string;
}

export interface BrowserConfig {
  headless: boolean;
  /** Persistent profile dir so logins survive between runs. */
  profileDir: string;
  downloadDir: string;
  slowMoMs: number;
  /**
   * Chrome channel to use ("chrome", "chrome-beta", "msedge", ...). Using the
   * real installed Chrome is what lets Google sign-in succeed. Set to "" to
   * fall back to Playwright's bundled Chromium (Google login will likely fail).
   */
  channel: string;
}

export interface SpyConfig {
  /** Master switch for the ad-library research subsystem. */
  enabled: boolean;
  /** Ad Library country filter, e.g. "US". */
  country: string;
  /** Max ads to capture per tracked page during a crawl. */
  maxAdsPerPage: number;
  /** How many times to scroll a page's results to lazy-load more ads. */
  scrollRounds: number;
  /**
   * Scaling heuristic thresholds. An ad is treated as a likely winner when it
   * is still active AND (has run at least `minRunDays` days OR has at least
   * `minCopies` active near-duplicate copies).
   */
  minRunDays: number;
  minCopies: number;
  /** How many top suggestions to surface per detected vertical. */
  suggestionsPerVertical: number;
  /** OpenAI chat model used to classify verticals + draft hook variations. */
  classifierModel: string;
  /** OpenAI transcription model used on an approved winner's audio. */
  transcribeModel: string;
  /** Default number of regenerated videos queued when a suggestion is approved. */
  regenerateCount: number;
  /**
   * Auto-crawl interval in minutes for continuous tracking. 0 disables the
   * scheduler (manual "Crawl now" only). The web server runs this in the
   * background; a crawl is skipped if one is already running.
   */
  autoCrawlMinutes: number;
  /**
   * Max number of ~8s segments when remaking a FULL competitor ad end-to-end.
   * Each segment is one Veo request, so this caps cost/time and daily quota use.
   */
  fullRemakeMaxSegments: number;
}

export interface AppConfig {
  pinterest: PinterestConfig;
  imageSource: ImageSourceConfig;
  imageAds: ImageAdsConfig;
  flow: FlowConfig;
  video: VideoConfig;
  campaigns: CampaignConfig[];
  captions: CaptionsConfig;
  browser: BrowserConfig;
  run: RunConfig;
  concurrency: ConcurrencyConfig;
  maintenance: MaintenanceConfig;
  spy: SpyConfig;
}

/** Resolve a possibly-relative path against the project root. */
export function resolvePath(p: string): string {
  return isAbsolute(p) ? p : resolve(PROJECT_ROOT, p);
}

function fail(msg: string): never {
  throw new Error(`Config error: ${msg}`);
}

/**
 * Load config.json (falling back to a path from CONFIG env or CLI),
 * validate it, and normalize all paths to absolute.
 */
export function loadConfig(explicitPath?: string): AppConfig {
  const candidate =
    explicitPath ??
    process.env.CONFIG ??
    resolve(PROJECT_ROOT, "config.json");
  const configPath = resolvePath(candidate);

  if (!existsSync(configPath)) {
    fail(
      `No config found at ${configPath}. Copy config.example.json to config.json and edit it.`,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    fail(`Could not parse ${configPath}: ${(err as Error).message}`);
  }

  const cfg = raw as Partial<AppConfig>;

  if (!cfg.pinterest) fail("missing 'pinterest' section");
  if (!cfg.flow) fail("missing 'flow' section");
  if (!cfg.video) fail("missing 'video' section");

  const pinterest = cfg.pinterest;
  if (!pinterest.query && !pinterest.imageUrl) {
    fail("provide either pinterest.query or pinterest.imageUrl");
  }

  const flow = cfg.flow;
  if (!flow.prompt) fail("missing flow.prompt");

  const video = cfg.video as Partial<VideoConfig> & { outputVideo?: string };
  // targetVideo is optional for standalone video generation
  // Back-compat: if an old config still sets video.outputVideo (a file path),
  // use its directory as the base output dir.
  const outputDir =
    video.outputDir ??
    (video.outputVideo ? dirname(video.outputVideo) : "./output");

  const browser = cfg.browser ?? ({} as BrowserConfig);
  const runCfg = cfg.run ?? ({} as RunConfig);
  const concurrency = (cfg.concurrency ?? {}) as Partial<ConcurrencyConfig>;
  const maintenance = (cfg.maintenance ?? {}) as Partial<MaintenanceConfig>;
  const spy = (cfg.spy ?? {}) as Partial<SpyConfig>;
  const captions = cfg.captions ?? ({} as Partial<CaptionsConfig>);
  const hookBubbleRaw = (captions as { hookBubble?: Partial<HookBubbleConfig> }).hookBubble ?? {};
  const imageSource = (cfg.imageSource ?? {}) as Partial<ImageSourceConfig>;
  const nano = (imageSource.nanoBanana ?? {}) as Partial<NanoBananaConfig>;
  const openai = (imageSource.openai ?? {}) as Partial<OpenAIImageConfig>;
  const chatgpt = (imageSource.chatgpt ?? {}) as Partial<ChatGPTImageConfig>;
  const imageAds = (cfg.imageAds ?? {}) as Partial<ImageAdsConfig>;
  const campaigns = Array.isArray(cfg.campaigns) ? cfg.campaigns : [];

  return {
    pinterest: {
      query: pinterest.query ?? "",
      imageUrl: pinterest.imageUrl ?? "",
      resultIndex: pinterest.resultIndex ?? 0,
    },
    imageSource: {
      mode:
        imageSource.mode === "nanobanana" ||
        imageSource.mode === "openai" ||
        imageSource.mode === "chatgpt" ||
        imageSource.mode === "pinterest"
          ? imageSource.mode
          : "openai",
      nanoBanana: {
        model: nano.model ?? "gemini-3-pro-image-preview",
        aspectRatio: nano.aspectRatio ?? "9:16",
        imageSize: nano.imageSize ?? "2K",
        promptOverride: nano.promptOverride ?? "",
      },
      openai: {
        model: openai.model ?? "gpt-image-2",
        size: openai.size ?? "1024x1536",
        quality: openai.quality ?? "high",
        promptOverride: openai.promptOverride ?? "",
      },
      chatgpt: {
        url: chatgpt.url ?? "https://chatgpt.com/",
        timeoutSec: chatgpt.timeoutSec ?? 300,
        promptOverride: chatgpt.promptOverride ?? "",
      },
    },
    imageAds: {
      model: imageAds.model ?? "gpt-image-2",
      size:
        imageAds.size === "1024x1536" || imageAds.size === "1536x1024"
          ? imageAds.size
          : "1024x1024",
      quality:
        imageAds.quality === "low" ||
        imageAds.quality === "medium" ||
        imageAds.quality === "auto"
          ? imageAds.quality
          : "high",
      analysisModel: imageAds.analysisModel ?? "gpt-4o-mini",
      variationsPerWinner: Math.max(1, imageAds.variationsPerWinner ?? 4),
      mode:
        imageAds.mode === "edit" || imageAds.mode === "fresh"
          ? imageAds.mode
          : "both",
      concurrency: Math.max(1, imageAds.concurrency ?? 4),
    },
    flow: {
      backend: flow.backend === "api" ? "api" : "browser",
      browserFallback: flow.browserFallback ?? true,
      url: flow.url ?? "https://labs.google/fx/tools/flow",
      prompt: flow.prompt,
      generationTimeoutMs: flow.generationTimeoutMs ?? 600_000,
      model: flow.model ?? "",
      mode: flow.mode ?? "",
      aspectRatio: flow.aspectRatio ?? "",
      apiModel: flow.apiModel ?? "veo-3.1-generate-preview",
      apiModelFallbacks: flow.apiModelFallbacks ?? [
        "veo-3.1-fast-generate-preview",
        "veo-3.1-lite-generate-preview",
      ],
      veoRequestsPerMinute: flow.veoRequestsPerMinute ?? 2,
      veoRequestsPerDay: flow.veoRequestsPerDay ?? 10,
      resolution: flow.resolution ?? "720p",
    },
    video: {
      targetVideo: video.targetVideo ? resolvePath(video.targetVideo) : "",
      outputDir: resolvePath(outputDir),
      trimSeconds: video.trimSeconds ?? 0.5,
      name: video.name ?? "",
    },
    campaigns: campaigns.map((campaign, idx) => {
      const c = campaign as Partial<CampaignConfig>;
      if (!c.id) fail(`campaigns[${idx}] is missing id`);
      const bodyVideo = (c.bodyVideo ?? "").trim();
      if (!Array.isArray(c.hooks) || c.hooks.length === 0) {
        fail(`campaigns[${idx}] must include at least one hook`);
      }
      return {
        id: c.id,
        name: c.name ?? c.id,
        vertical: c.vertical ?? "",
        angle: c.angle ?? "",
        bodyVideo: bodyVideo ? resolvePath(bodyVideo) : "",
        bodyVideos: Array.isArray(c.bodyVideos)
          ? c.bodyVideos
              .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
              .map((v) => resolvePath(v))
          : [],
        outputName: c.outputName ?? "",
        promptContext: c.promptContext ?? "",
        cameraStyle: c.cameraStyle ?? "",
        cameraPrompts: Array.isArray(c.cameraPrompts) ? c.cameraPrompts : [],
        creatorPrompts: Array.isArray(c.creatorPrompts) ? c.creatorPrompts : [],
        scenePrompts: Array.isArray(c.scenePrompts) ? c.scenePrompts : [],
        promptTemplate: c.promptTemplate ?? "",
        hooks: Array.isArray(c.hooks) ? c.hooks : [],
        variants: Array.isArray(c.variants)
          ? (c.variants as CampaignVariant[]).map((v, vi) => ({
              id: v.id ?? `variant-${vi + 1}`,
              name: v.name ?? v.id ?? `Variant ${vi + 1}`,
              creatorPrompt: v.creatorPrompt ?? "",
              scenePrompt: v.scenePrompt ?? "",
              cameraPrompt: v.cameraPrompt ?? "",
              hooks: Array.isArray(v.hooks) && v.hooks.length > 0 ? v.hooks : [],
              bubbleHooks: Array.isArray(v.bubbleHooks) ? v.bubbleHooks : [],
            }))
          : [],
        maxHookSeconds: c.maxHookSeconds ?? DEFAULT_MAX_HOOK_SECONDS,
        trimSeconds: c.trimSeconds ?? 0,
        captionVerticalPosition: c.captionVerticalPosition ?? 0,
        captionStyle: c.captionStyle ?? "",
        captionPosition: c.captionPosition ?? "",
        hookBubbleEnabled: c.hookBubbleEnabled ?? "",
        hookBubbleText: c.hookBubbleText ?? "",
        hookBubbleStyle: c.hookBubbleStyle ?? "",
      };
    }),
    browser: {
      headless: browser.headless ?? false,
      profileDir: resolvePath(browser.profileDir ?? "./.browser-profile"),
      downloadDir: resolvePath(browser.downloadDir ?? "./downloads"),
      slowMoMs: browser.slowMoMs ?? 0,
      channel: browser.channel ?? "chrome",
    },
    captions: {
      enabled: captions.enabled ?? false,
      dialogue: captions.dialogue ?? "",
      wordsPerGroup: captions.wordsPerGroup ?? 3,
      upperCase: captions.upperCase ?? true,
      layout: captions.layout === "3:4" ? "3:4" : "fill",
      position:
        captions.position === "bottom"
          ? "bottom"
          : captions.position === "top"
            ? "top"
            : "middle",
      style: captions.style === "bubble" ? "bubble" : "default",
      verticalPosition: captions.verticalPosition ?? 0,
      bubbleColor: captions.bubbleColor ?? "#FFFFFF",
      bubbleTextColor: captions.bubbleTextColor ?? "#111111",
      bubblePadding: captions.bubblePadding ?? 0,
      hookBubble: {
        enabled: hookBubbleRaw.enabled ?? false,
        bold: hookBubbleRaw.bold ?? true,
        text: hookBubbleRaw.text ?? "",
        bubbleColor: hookBubbleRaw.bubbleColor ?? captions.bubbleColor ?? "#FFFFFF",
        textColor: hookBubbleRaw.textColor ?? captions.bubbleTextColor ?? "#111111",
        bubblePadding: hookBubbleRaw.bubblePadding ?? 0,
        style:
          hookBubbleRaw.style === "shadow"
            ? "shadow"
            : hookBubbleRaw.style === "card"
              ? "card"
              : "box",
      },
      fontName: captions.fontName ?? "Arial",
      fontSize: captions.fontSize ?? 0,
      primaryColor: captions.primaryColor ?? "#FFFFFF",
      outlineColor: captions.outlineColor ?? "#000000",
      outlineWidth: captions.outlineWidth ?? 4,
      highlightCurrentWord: captions.highlightCurrentWord ?? true,
      highlightColor: captions.highlightColor ?? "#22C7F5",
      timingEngine: captions.timingEngine ?? "auto",
      timingOffsetSec: captions.timingOffsetSec ?? 0,
      fasterWhisperPython:
        captions.fasterWhisperPython ?? ".venv-whisper/bin/python",
      fasterWhisperModel: captions.fasterWhisperModel ?? "base.en",
      whisperBinary: captions.whisperBinary ?? "whisper-cli",
      whisperModel: captions.whisperModel ?? "",
    },
    run: {
      count: runCfg.count ?? 1,
      delaySeconds: runCfg.delaySeconds ?? 0,
    },
    concurrency: {
      maxConcurrentJobs: Math.max(1, concurrency.maxConcurrentJobs ?? 2),
      apiRequestsPerMinute: Math.max(0, concurrency.apiRequestsPerMinute ?? 0),
    },
    maintenance: {
      autoCleanIntermediates: maintenance.autoCleanIntermediates ?? true,
      keepIntermediateHours: Math.max(0, maintenance.keepIntermediateHours ?? 24),
    },
    spy: {
      enabled: spy.enabled ?? true,
      country: spy.country ?? "US",
      maxAdsPerPage: Math.max(1, spy.maxAdsPerPage ?? 40),
      scrollRounds: Math.max(0, spy.scrollRounds ?? 8),
      minRunDays: Math.max(0, spy.minRunDays ?? 14),
      minCopies: Math.max(1, spy.minCopies ?? 2),
      suggestionsPerVertical: Math.max(1, spy.suggestionsPerVertical ?? 5),
      classifierModel: spy.classifierModel ?? "gpt-4o-mini",
      transcribeModel: spy.transcribeModel ?? "whisper-1",
      regenerateCount: Math.max(1, spy.regenerateCount ?? 3),
      autoCrawlMinutes: Math.max(0, spy.autoCrawlMinutes ?? 60),
      fullRemakeMaxSegments: Math.max(1, spy.fullRemakeMaxSegments ?? 6),
    },
  };
}
