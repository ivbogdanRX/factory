import { existsSync } from "node:fs";
import { loadConfig, type AppConfig } from "./config.js";
import { readRawConfig, writeCampaigns, backupConfig } from "./config-store.js";
import {
  launchContext,
  getPage,
  acquireBrowserLock,
  withBrowser,
} from "./browser.js";
import {
  crawlPage,
  downloadAdVideo,
  cleanAdText,
  extractAdvertiser,
} from "./meta-ad-library.js";
import {
  classifyAds,
  transcribeVideo,
  draftHookVariations,
} from "./spy-classify.js";
import {
  spyStore,
  type SpyAd,
  type Suggestion,
} from "./spy-store.js";
import { runWithLogScope, log, type LogEntry } from "./logger.js";
import { slugify, titleSlug, timestamp } from "./utils.js";

/**
 * Scaling heuristic. Meta's public Ad Library doesn't expose spend, so we infer
 * "this is a winner they're scaling" from public signals: the ad is still
 * active, has been running a long time, and has many active near-duplicate
 * copies (advertisers duplicate winners across ad sets when they scale).
 */
export function scoreAd(ad: {
  active: boolean;
  runDays: number;
  copyCount: number;
}): number {
  const runDayScore = Math.min(ad.runDays / 60, 1) * 60; // caps ~60 days
  const copyScore = Math.min(ad.copyCount, 20) * 4;
  const activeMult = ad.active ? 1 : 0.3;
  return Math.round((runDayScore + copyScore) * activeMult);
}

/** Whether an ad clears the "likely winner" bar from config thresholds. */
export function qualifiesAsWinner(
  ad: { active: boolean; runDays: number; copyCount: number },
  cfg: AppConfig,
): boolean {
  if (!ad.active) return false;
  return ad.runDays >= cfg.spy.minRunDays || ad.copyCount >= cfg.spy.minCopies;
}

// ---------------------------------------------------------------------------
// Crawl manager: a single crawl at a time, with live logs for the UI (SSE).
// ---------------------------------------------------------------------------

export interface CrawlState {
  running: boolean;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  logs: Array<{ level: LogEntry["level"]; message: string; time: string }>;
  summary?: {
    pages: number;
    adsFound: number;
    winners: number;
    suggestions: number;
  };
}

class SpyManager {
  private state: CrawlState = { running: false, logs: [] };

  get(): CrawlState {
    return this.state;
  }

  /** Kick off a crawl in the background. No-op if one is already running. */
  startCrawl(): { started: boolean } {
    if (this.state.running) return { started: false };
    this.state = { running: true, startedAt: Date.now(), logs: [] };
    void this.run();
    return { started: true };
  }

  private async run(): Promise<void> {
    const sink = (entry: LogEntry): void => {
      this.state.logs.push({
        level: entry.level,
        message: entry.message,
        time: entry.time,
      });
      if (this.state.logs.length > 2000) {
        this.state.logs.splice(0, this.state.logs.length - 2000);
      }
    };
    try {
      const summary = await runWithLogScope(sink, () => crawlAllPages());
      this.state.summary = summary;
    } catch (err) {
      this.state.error = (err as Error).message;
      sink({
        level: "error",
        message: `Crawl failed: ${(err as Error).message}`,
        time: new Date().toISOString(),
      });
    } finally {
      this.state.running = false;
      this.state.finishedAt = Date.now();
    }
  }
}

export const spyManager = new SpyManager();

/**
 * Crawl every whitelisted page, persist + score the ads, classify any new ones,
 * then rebuild the ranked suggestions. Returns a small summary.
 */
export async function crawlAllPages(): Promise<{
  pages: number;
  adsFound: number;
  winners: number;
  suggestions: number;
}> {
  const cfg = loadConfig();
  if (!cfg.spy.enabled) {
    throw new Error("Spy subsystem is disabled (set spy.enabled = true).");
  }
  const pages = spyStore.listPages();
  if (pages.length === 0) {
    throw new Error("No tracked pages. Add a Meta Page to the whitelist first.");
  }

  log.step(`Spy crawl: ${pages.length} tracked page(s).`);
  const releaseBrowser = await acquireBrowserLock();
  const context = await launchContext(cfg, { headless: cfg.browser.headless });
  const page = await getPage(context);

  let adsFound = 0;
  const toClassify: Array<{ key: string; text: string }> = [];

  try {
    for (const tracked of pages) {
      try {
        const { ads, pageId } = await crawlPage(context, page, tracked, cfg);
        if (pageId && pageId !== tracked.pageId) {
          spyStore.updatePage(tracked.id, { pageId });
        }
        for (const raw of ads) {
          const score = scoreAd(raw);
          const existing = spyStore.getAd(raw.archiveId);
          const stored: SpyAd = {
            key: raw.archiveId,
            archiveId: raw.archiveId,
            pageRef: tracked.id,
            pageName: raw.advertiser || tracked.label,
            advertiser: raw.advertiser || undefined,
            snapshotUrl: raw.snapshotUrl,
            text: raw.text,
            mediaType: raw.mediaType,
            imageUrl: raw.imageUrl,
            startDateMs: raw.startDateMs,
            runDays: raw.runDays,
            copyCount: raw.copyCount,
            active: raw.active,
            score,
            firstSeen: existing?.firstSeen ?? Date.now(),
            lastSeen: Date.now(),
          };
          const saved = spyStore.upsertAd(stored);
          adsFound++;
          if (!saved.vertical && saved.text.trim()) {
            toClassify.push({ key: saved.key, text: saved.text });
          }
        }
        spyStore.updatePage(tracked.id, {
          lastCrawledAt: Date.now(),
          lastAdCount: ads.length,
        });
      } catch (err) {
        log.error(`Page "${tracked.label}" failed: ${(err as Error).message}`);
      }
    }
  } finally {
    try {
      await context.close();
    } catch {
      /* best-effort */
    }
    releaseBrowser();
  }

  // Classify any newly seen ads, then re-score isn't needed (score is text-free).
  if (toClassify.length > 0) {
    const classes = await classifyAds(toClassify, cfg);
    for (const [key, cls] of classes) {
      spyStore.patchAd(key, {
        vertical: cls.vertical,
        verticalConfidence: cls.confidence,
        angle: cls.angle,
      });
    }
  }

  const built = buildSuggestions(cfg);
  const winners = spyStore
    .listAds()
    .filter((a) => qualifiesAsWinner(a, cfg)).length;

  log.ok(
    `Crawl done. ${adsFound} ad(s) seen, ${winners} winner(s), ` +
      `${built} suggestion(s) ready for review.`,
  );
  return {
    pages: pages.length,
    adsFound,
    winners,
    suggestions: built,
  };
}

/**
 * Rebuild the ranked suggestion set: take qualifying winners, group by vertical,
 * keep the top N per vertical. Preserves already approved/dismissed decisions.
 * Returns how many pending suggestions exist after the rebuild.
 */
export function buildSuggestions(cfg: AppConfig): number {
  const winners = spyStore
    .listAds()
    .filter((a) => qualifiesAsWinner(a, cfg))
    .sort((a, b) => b.score - a.score);

  const byVertical = new Map<string, SpyAd[]>();
  for (const ad of winners) {
    const v = ad.vertical || "unclassified";
    const arr = byVertical.get(v) ?? [];
    if (arr.length < cfg.spy.suggestionsPerVertical) {
      arr.push(ad);
      byVertical.set(v, arr);
    }
  }

  const fresh: Suggestion[] = [];
  for (const [vertical, ads] of byVertical) {
    for (const ad of ads) {
      const days = ad.runDays;
      const cleanText = cleanAdText(ad.text);
      // Old ads may predate advertiser extraction; recover it from the raw text.
      const advertiser =
        ad.advertiser || extractAdvertiser(ad.text) || ad.pageName;
      const reason =
        `Running ${days} day${days === 1 ? "" : "s"}` +
        (ad.copyCount > 1 ? ` with ${ad.copyCount} active copies` : "") +
        ` on ${advertiser}.`;
      fresh.push({
        id: `sug_${ad.archiveId}`,
        vertical,
        angle: ad.angle ?? "",
        adKey: ad.key,
        pageName: advertiser,
        reason,
        evidence: {
          runDays: ad.runDays,
          copyCount: ad.copyCount,
          active: ad.active,
          startDateMs: ad.startDateMs,
        },
        sampleText: (cleanText || ad.text).slice(0, 400),
        previewVideoUrl: ad.localVideo ? undefined : ad.videoUrl,
        score: ad.score,
        status: "pending",
        createdAt: Date.now(),
      });
    }
  }

  spyStore.replacePending(fresh);
  return spyStore.listSuggestions().filter((s) => s.status === "pending").length;
}

export interface ApproveOptions {
  /** Body video to splice the regenerated hooks in front of (relative or abs). */
  bodyVideo: string;
  /** How many videos to generate (defaults to spy.regenerateCount). */
  count?: number;
}

export interface ApproveResult {
  campaignId: string;
  count: number;
  hooks: string[];
  suggestion: Suggestion;
}

/**
 * Approve a suggestion: download the winning video, transcribe it, draft fresh
 * hook variations for the same vertical/angle, write a new campaign into
 * config.json, and mark the suggestion approved. Returns the campaign id + the
 * requested count so the caller can queue generation jobs.
 */
export async function approveSuggestion(
  id: string,
  opts: ApproveOptions,
): Promise<ApproveResult> {
  const cfg = loadConfig();
  const suggestion = spyStore.getSuggestion(id);
  if (!suggestion) throw new Error(`Unknown suggestion: ${id}`);
  const ad = spyStore.getAd(suggestion.adKey);
  if (!ad) throw new Error(`Ad for suggestion ${id} not found.`);
  if (!opts.bodyVideo?.trim()) {
    throw new Error("A body video is required to regenerate.");
  }

  const count = Math.max(1, opts.count ?? cfg.spy.regenerateCount);

  // 1) Make sure we have a local copy of the winner's video.
  let localVideo = ad.localVideo;
  if (!localVideo || !existsSync(localVideo)) {
    localVideo =
      (await withBrowser(cfg, { headless: cfg.browser.headless }, (context, page) =>
        downloadAdVideo(context, page, ad),
      )) ?? undefined;
    if (localVideo) spyStore.patchAd(ad.key, { localVideo });
  }

  // 2) Get the script: transcribe the winner if we have its video, else use the
  //    ad's body copy as the seed.
  let transcript = "";
  if (localVideo && existsSync(localVideo)) {
    try {
      transcript = await transcribeVideo(localVideo, cfg);
    } catch (err) {
      log.warn(`Transcription failed: ${(err as Error).message}`);
    }
  }
  if (!transcript) transcript = ad.text;

  // 3) Draft fresh hooks for the same vertical/angle.
  const vertical = ad.vertical || suggestion.vertical;
  const angle = ad.angle || suggestion.angle;
  const drafted = await draftHookVariations(
    transcript,
    vertical,
    angle,
    Math.max(count, 4),
    cfg,
  );

  // 4) Write a campaign into config.json (appended to existing campaigns).
  const campaignId = `spy-${slugify(vertical)}-${ad.archiveId}`.slice(0, 60);
  const raw = readRawConfig();
  const campaigns = Array.isArray(raw.campaigns) ? [...raw.campaigns] : [];
  const newCampaign = {
    id: campaignId,
    name: `${titleSlug(vertical).replace(/_/g, " ")} (spy ${ad.archiveId})`,
    vertical,
    angle,
    bodyVideo: opts.bodyVideo.trim(),
    outputName: titleSlug(vertical).replace(/_/g, " "),
    promptContext: `Modeled after a competitor ad that has been scaling. ${transcript.slice(0, 240)}`,
    cameraStyle: "",
    cameraPrompts: [],
    creatorPrompts: [],
    scenePrompts: [],
    promptTemplate: "",
    hooks: drafted.hooks,
    variants: [],
    maxHookSeconds: 7.8,
    trimSeconds: 0.2,
    captionVerticalPosition: 0,
    captionStyle: "",
    captionPosition: "",
    hookBubbleEnabled: "",
    hookBubbleText: drafted.bubbleHooks[0] ?? "",
  };
  const existingIdx = campaigns.findIndex(
    (c) => (c as { id?: string }).id === campaignId,
  );
  if (existingIdx >= 0) campaigns[existingIdx] = newCampaign;
  else campaigns.push(newCampaign);

  backupConfig();
  writeCampaigns(campaigns);

  // 5) Mark the suggestion approved.
  spyStore.patchSuggestion(id, { status: "approved", campaignId });
  const updated = spyStore.getSuggestion(id)!;

  log.ok(
    `Approved "${suggestion.vertical}" → campaign ${campaignId} with ` +
      `${drafted.hooks.length} hook(s).`,
  );
  return { campaignId, count, hooks: drafted.hooks, suggestion: updated };
}

/** CLI entry: crawl once and print the summary. Used by `npm run spy`. */
async function cli(): Promise<void> {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* optional */
  }
  const summary = await crawlAllPages();
  log.info(JSON.stringify(summary, null, 2));
}

// Run as a script only when invoked directly (not when imported by the server).
const invokedDirectly =
  process.argv[1]?.endsWith("spy.ts") || process.argv[1]?.endsWith("spy.js");
if (invokedDirectly) {
  cli().catch((err) => {
    log.error((err as Error).stack ?? String(err));
    process.exit(1);
  });
}
