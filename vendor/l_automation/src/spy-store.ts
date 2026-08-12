import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, timestamp } from "./utils.js";

/**
 * Persistent storage for the ad-library research subsystem. Everything lives
 * under .state/spy/ as small JSON files so a crawl, the suggestions it produces,
 * and your tracked-page whitelist all survive restarts.
 */
const SPY_DIR = join(".state", "spy");

/** A Meta Page (advertiser) you've explicitly allowed the crawler to track. */
export interface TrackedPage {
  /** Stable internal id. */
  id: string;
  /** Friendly label shown in the UI. */
  label: string;
  /**
   * Resolved Meta `view_all_page_id` once known. May be empty if we only have a
   * search query/URL to start from.
   */
  pageId: string;
  /** Original input: a page name, a numeric page id, or a full Ad Library URL. */
  input: string;
  /** Optional manual hint about this advertiser's vertical. */
  verticalHint: string;
  addedAt: number;
  lastCrawledAt?: number;
  /** Number of ads captured on the most recent crawl. */
  lastAdCount?: number;
}

/** Media kind for a captured ad creative. */
export type SpyMediaType = "video" | "image" | "unknown";

/** One ad creative captured from the Ad Library. */
export interface SpyAd {
  /** Dedup key (the Meta "Library ID" / ad archive id when available). */
  key: string;
  archiveId: string;
  /** TrackedPage.id this ad was found under. */
  pageRef: string;
  pageName: string;
  /** Scraped advertiser/page display name, when readable. */
  advertiser?: string;
  /** Direct link back to this ad in the Ad Library. */
  snapshotUrl: string;
  /** The ad's primary text / body copy (best-effort). */
  text: string;
  mediaType: SpyMediaType;
  /** Remote creative URLs captured during the crawl. */
  videoUrl?: string;
  imageUrl?: string;
  /** Path to a downloaded copy of the winning video (set on approval). */
  localVideo?: string;
  /** Epoch ms of "Started running on ...", when parseable. */
  startDateMs?: number;
  /** Days the ad has been running (from startDate to lastSeen). */
  runDays: number;
  /** How many active near-duplicate copies this creative has. */
  copyCount: number;
  active: boolean;
  /** LLM-classified vertical (e.g. "bathroom remodel"). */
  vertical?: string;
  verticalConfidence?: number;
  /** LLM-inferred marketing angle / audience. */
  angle?: string;
  /** Scaling score (higher = more likely a winner). */
  score: number;
  firstSeen: number;
  lastSeen: number;
}

export type SuggestionStatus = "pending" | "approved" | "dismissed";

/** A ranked "this will probably do well" suggestion for a vertical. */
export interface Suggestion {
  id: string;
  vertical: string;
  angle: string;
  /** SpyAd.key this suggestion is built from. */
  adKey: string;
  pageName: string;
  /** Human-readable evidence sentence. */
  reason: string;
  evidence: {
    runDays: number;
    copyCount: number;
    active: boolean;
    startDateMs?: number;
  };
  sampleText: string;
  previewVideoUrl?: string;
  score: number;
  status: SuggestionStatus;
  createdAt: number;
  /** Set once approved: the campaign created + jobs queued. */
  campaignId?: string;
  jobIds?: string[];
}

interface SpyData {
  pages: TrackedPage[];
  ads: Record<string, SpyAd>;
  suggestions: Suggestion[];
}

/** Turn a raw page input into a short, readable default label. */
function friendlyLabel(input: string): string {
  if (/^https?:\/\//i.test(input)) {
    try {
      const id = new URL(input).searchParams.get("view_all_page_id");
      if (id) return `Page ${id}`;
      const q = new URL(input).searchParams.get("q");
      if (q) return q;
    } catch {
      /* fall through */
    }
    return "Ad Library page";
  }
  if (/^\d{5,}$/.test(input)) return `Page ${input}`;
  return input;
}

function file(name: string): string {
  ensureDir(SPY_DIR);
  return join(SPY_DIR, name);
}

function readJson<T>(name: string, fallback: T): T {
  const path = file(name);
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(name: string, value: unknown): void {
  writeFileSync(file(name), JSON.stringify(value, null, 2));
}

/**
 * Tiny façade over the three JSON files. Kept stateless (reads/writes on each
 * call) so the web server and a CLI crawl never fight over an in-memory cache.
 */
export const spyStore = {
  // ---- tracked pages -------------------------------------------------------
  listPages(): TrackedPage[] {
    return readJson<TrackedPage[]>("pages.json", []);
  },

  addPage(input: {
    label?: string;
    input: string;
    pageId?: string;
    verticalHint?: string;
  }): TrackedPage {
    const pages = this.listPages();
    const page: TrackedPage = {
      id: `page_${timestamp()}`,
      label: input.label?.trim() || friendlyLabel(input.input.trim()),
      pageId: input.pageId?.trim() || "",
      input: input.input.trim(),
      verticalHint: input.verticalHint?.trim() || "",
      addedAt: Date.now(),
    };
    pages.push(page);
    writeJson("pages.json", pages);
    return page;
  },

  updatePage(id: string, patch: Partial<TrackedPage>): void {
    const pages = this.listPages();
    const idx = pages.findIndex((p) => p.id === id);
    if (idx < 0) return;
    pages[idx] = { ...pages[idx]!, ...patch };
    writeJson("pages.json", pages);
  },

  removePage(id: string): void {
    const pages = this.listPages().filter((p) => p.id !== id);
    writeJson("pages.json", pages);
  },

  // ---- ads -----------------------------------------------------------------
  listAds(): SpyAd[] {
    const map = readJson<Record<string, SpyAd>>("ads.json", {});
    return Object.values(map);
  },

  getAd(key: string): SpyAd | undefined {
    const map = readJson<Record<string, SpyAd>>("ads.json", {});
    return map[key];
  },

  /** Insert or merge an ad by key, preserving firstSeen + any local download. */
  upsertAd(ad: SpyAd): SpyAd {
    const map = readJson<Record<string, SpyAd>>("ads.json", {});
    const prev = map[ad.key];
    const merged: SpyAd = {
      ...ad,
      firstSeen: prev?.firstSeen ?? ad.firstSeen,
      localVideo: ad.localVideo ?? prev?.localVideo,
      // Keep an existing classification unless the new crawl supplies one.
      vertical: ad.vertical ?? prev?.vertical,
      verticalConfidence: ad.verticalConfidence ?? prev?.verticalConfidence,
      angle: ad.angle ?? prev?.angle,
    };
    map[ad.key] = merged;
    writeJson("ads.json", map);
    return merged;
  },

  patchAd(key: string, patch: Partial<SpyAd>): void {
    const map = readJson<Record<string, SpyAd>>("ads.json", {});
    if (!map[key]) return;
    map[key] = { ...map[key]!, ...patch };
    writeJson("ads.json", map);
  },

  // ---- suggestions ---------------------------------------------------------
  listSuggestions(): Suggestion[] {
    return readJson<Suggestion[]>("suggestions.json", []);
  },

  getSuggestion(id: string): Suggestion | undefined {
    return this.listSuggestions().find((s) => s.id === id);
  },

  /**
   * Replace the pending suggestion set with a freshly computed one, preserving
   * any suggestions you've already approved or dismissed (matched by adKey).
   */
  replacePending(fresh: Suggestion[]): void {
    const existing = this.listSuggestions();
    const decided = existing.filter((s) => s.status !== "pending");
    const decidedKeys = new Set(decided.map((s) => s.adKey));
    const merged = [
      ...decided,
      ...fresh.filter((s) => !decidedKeys.has(s.adKey)),
    ];
    writeJson("suggestions.json", merged);
  },

  patchSuggestion(id: string, patch: Partial<Suggestion>): void {
    const all = this.listSuggestions();
    const idx = all.findIndex((s) => s.id === id);
    if (idx < 0) return;
    all[idx] = { ...all[idx]!, ...patch };
    writeJson("suggestions.json", all);
  },
};
