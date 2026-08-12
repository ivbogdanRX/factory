import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import type { AppConfig } from "./config.js";
import type { SpyAd, SpyMediaType, TrackedPage } from "./spy-store.js";
import { snapshot } from "./browser.js";
import { ensureDir, sleep, timestamp } from "./utils.js";
import { log } from "./logger.js";

const SPY_MEDIA_DIR = "downloads/spy";

/** A raw ad scraped from the Ad Library DOM, before scoring/classification. */
export interface RawAd {
  archiveId: string;
  /** Cleaned primary ad copy (boilerplate stripped). */
  text: string;
  /** Advertiser / page display name when we can read it. */
  advertiser: string;
  snapshotUrl: string;
  mediaType: SpyMediaType;
  imageUrl?: string;
  startDateMs?: number;
  runDays: number;
  copyCount: number;
  active: boolean;
}

/**
 * Strip Ad Library chrome out of a card's text dump so we keep just the ad copy.
 * The DOM concatenates labels with no spaces ("...PlatformsSponsoredImagine..."),
 * so we remove the known boilerplate tokens and the metadata prefix.
 */
export function cleanAdText(raw: string): string {
  let t = raw.replace(/\s+/g, " ").trim();
  // Everything up to and including the last "Sponsored" is metadata/branding;
  // the real copy follows it.
  const sponsored = t.lastIndexOf("Sponsored");
  if (sponsored >= 0) t = t.slice(sponsored + "Sponsored".length);
  // Drop residual UI labels anywhere in the string.
  t = t
    .replace(/\bLibrary ID:?\s*\d+/gi, " ")
    .replace(/\bActive\b|\bInactive\b/gi, " ")
    .replace(/Started running on\s+[A-Za-z]{3,9}\s+\d{1,2},?\s*\d{4}/gi, " ")
    .replace(/\bPlatforms?\b/gi, " ")
    .replace(/\d+\s+ads?\s+use\s+this\s+creative(?:\s+and\s+text)?/gi, " ")
    .replace(/Open Dropdown/gi, " ")
    .replace(/See (?:summary|ad) details/gi, " ")
    .replace(/This ad has multiple versions/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t;
}

/** Pull the advertiser/page name (the token right before "Sponsored"). */
export function extractAdvertiser(raw: string): string {
  const t = raw.replace(/\s+/g, " ");
  const m = t.match(/([A-Z0-9][A-Za-z0-9 .,'&!-]{1,40}?)\s*Sponsored/);
  if (m && m[1]) {
    // Trim leading boilerplate like "See summary details" that can bleed in.
    return m[1]
      .replace(/.*(?:details|Dropdown|Platforms?)/i, "")
      .trim()
      .slice(0, 50);
  }
  return "";
}

interface ResolvedTarget {
  url: string;
  /** Resolved numeric page id, when the input gave us one. */
  pageId: string;
}

/**
 * Turn whatever the user typed (a page name, a numeric page id, or a full Ad
 * Library URL) into the canonical Ad Library URL we should open, plus the page
 * id when we can determine it.
 */
export function resolveTarget(page: TrackedPage, cfg: AppConfig): ResolvedTarget {
  const country = cfg.spy.country || "US";
  const base = "https://www.facebook.com/ads/library/";
  const common =
    `active_status=active&ad_type=all&country=${encodeURIComponent(country)}` +
    `&media_type=all`;

  const input = page.input.trim();

  // Full Ad Library URL: reuse it but force active + country/media filters.
  if (/^https?:\/\//i.test(input) && /facebook\.com\/ads\/library/i.test(input)) {
    try {
      const u = new URL(input);
      const pid = u.searchParams.get("view_all_page_id") ?? page.pageId ?? "";
      u.searchParams.set("active_status", "active");
      u.searchParams.set("ad_type", "all");
      u.searchParams.set("country", country);
      u.searchParams.set("media_type", "all");
      return { url: u.toString(), pageId: pid };
    } catch {
      /* fall through */
    }
  }

  // A known/explicit numeric page id.
  const numeric = page.pageId?.trim() || (/^\d{5,}$/.test(input) ? input : "");
  if (numeric) {
    return {
      url: `${base}?${common}&view_all_page_id=${numeric}&search_type=page`,
      pageId: numeric,
    };
  }

  // Otherwise treat the input as a keyword search.
  return {
    url:
      `${base}?${common}&q=${encodeURIComponent(input)}` +
      `&search_type=keyword_unordered`,
    pageId: "",
  };
}

const MS_PER_DAY = 86_400_000;

/** Parse "Started running on Jan 5, 2024" → epoch ms (best effort). */
function parseStartDate(text: string): number | undefined {
  // Cap to an explicit "Mon D, YYYY" so trailing concatenated labels (e.g.
  // "...2026Platforms48 ads...") don't poison Date.parse.
  const m = text.match(
    /Started running on\s+([A-Za-z]{3,9}\s+\d{1,2},?\s*\d{4})/i,
  );
  if (!m || !m[1]) return undefined;
  const t = Date.parse(m[1].trim());
  return Number.isFinite(t) ? t : undefined;
}

/** Climb the DOM from each "Library ID" marker to a card and pull its fields. */
function extractAdsInPage(): Array<{
  archiveId: string;
  text: string;
  imageUrl: string;
  hasVideo: boolean;
}> {
  const out: Array<{
    archiveId: string;
    text: string;
    imageUrl: string;
    hasVideo: boolean;
  }> = [];
  const seen = new Set<string>();

  const all = Array.from(document.querySelectorAll<HTMLElement>("div, span"));
  for (const el of all) {
    const txt = el.textContent ?? "";
    const m = txt.match(/Library ID:?\s*(\d{6,})/i);
    if (!m) continue;
    const id = m[1] as string;
    if (seen.has(id)) continue;

    // Climb to a reasonably-sized card container.
    let card: HTMLElement = el;
    for (let i = 0; i < 8; i++) {
      const parent = card.parentElement as HTMLElement | null;
      if (!parent) break;
      card = parent;
      const text = card.textContent ?? "";
      if (text.length > 120 && /Library ID/i.test(text)) break;
    }

    // If this card actually contains several Library IDs, it's a wrapper, skip.
    const ids = (card.textContent ?? "").match(/Library ID:?\s*(\d{6,})/gi) ?? [];
    if (ids.length > 1) continue;

    seen.add(id);
    const img = card.querySelector("img");
    const video = card.querySelector("video");
    out.push({
      archiveId: id,
      text: (card.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 1500),
      imageUrl: img?.getAttribute("src") ?? "",
      hasVideo: !!video,
    });
  }
  return out;
}

/** Count active near-duplicate copies referenced by a card's text. */
function parseCopyCount(text: string): number {
  // "5 ads use this creative and text" / "12 ads start running on ..."
  const useThis = text.match(/(\d+)\s+ads?\s+use\s+this/i);
  if (useThis && useThis[1]) return Math.max(1, Number(useThis[1]));
  const total = text.match(/(\d+)\s+ads?\b/i);
  if (total && total[1]) return Math.max(1, Number(total[1]));
  if (/multiple versions/i.test(text)) return 2;
  return 1;
}

/**
 * Crawl one tracked page's active ads from the Meta Ad Library. Returns the raw
 * ads found; the orchestrator handles scoring + classification + persistence.
 *
 * The Ad Library is heavily client-rendered and anti-bot, so this degrades
 * gracefully: it scrolls to lazy-load, extracts via text anchors (not brittle
 * class names), and saves a screenshot if nothing parses.
 */
export async function crawlPage(
  context: BrowserContext,
  page: Page,
  tracked: TrackedPage,
  cfg: AppConfig,
): Promise<{ ads: RawAd[]; pageId: string }> {
  const target = resolveTarget(tracked, cfg);
  log.step(`Ad Library: opening ${tracked.label}`);
  log.info(target.url);

  await page.goto(target.url, { waitUntil: "domcontentloaded" });
  await sleep(2500);

  // Meta sometimes gates behind a login/consent wall.
  if (/\/login|checkpoint|consent/i.test(page.url())) {
    log.warn(
      "Ad Library wants a login/consent step. Run `npm run login`, sign into " +
        "Facebook once in the opened browser, then crawl again.",
    );
  }

  try {
    await page.waitForFunction(
      () => /Library ID/i.test(document.body?.innerText ?? ""),
      { timeout: 25_000 },
    );
  } catch {
    await snapshot(page, `spy_${tracked.id}_no_results`);
    log.warn(`No ads detected for ${tracked.label} (page may need login).`);
    return { ads: [], pageId: target.pageId };
  }

  // Scroll to lazy-load more results.
  const seen = new Map<string, RawAd>();
  for (let round = 0; round <= cfg.spy.scrollRounds; round++) {
    let scraped: Array<{
      archiveId: string;
      text: string;
      imageUrl: string;
      hasVideo: boolean;
    }> = [];
    try {
      scraped = await page.evaluate(extractAdsInPage);
    } catch (err) {
      log.warn(`DOM extraction failed: ${(err as Error).message}`);
    }

    for (const raw of scraped) {
      if (seen.has(raw.archiveId)) continue;
      const startDateMs = parseStartDate(raw.text);
      const runDays = startDateMs
        ? Math.max(0, Math.round((Date.now() - startDateMs) / MS_PER_DAY))
        : 0;
      const active = !/\bInactive\b/i.test(raw.text);
      seen.set(raw.archiveId, {
        archiveId: raw.archiveId,
        text: cleanAdText(raw.text),
        advertiser: extractAdvertiser(raw.text),
        snapshotUrl: `https://www.facebook.com/ads/library/?id=${raw.archiveId}`,
        mediaType: raw.hasVideo ? "video" : raw.imageUrl ? "image" : "unknown",
        imageUrl: raw.imageUrl || undefined,
        startDateMs,
        runDays,
        copyCount: parseCopyCount(raw.text),
        active,
      });
      if (seen.size >= cfg.spy.maxAdsPerPage) break;
    }

    if (seen.size >= cfg.spy.maxAdsPerPage) break;
    await page.mouse.wheel(0, 8000);
    await sleep(1800);
  }

  const ads = [...seen.values()];
  log.ok(`${tracked.label}: captured ${ads.length} ad(s).`);
  return { ads, pageId: target.pageId };
}

/**
 * Open a single ad's detail page and capture its real mp4 URL from the network,
 * then download it. Used at approval time so we fetch exactly the winner's video
 * (rather than guessing during the bulk crawl).
 */
export async function downloadAdVideo(
  context: BrowserContext,
  page: Page,
  ad: SpyAd,
): Promise<string | null> {
  const dir = ensureDir(SPY_MEDIA_DIR);
  let mp4Url = ad.videoUrl ?? "";

  if (!mp4Url) {
    const captured: string[] = [];
    const onResponse = (resp: { url: () => string; headers: () => Record<string, string> }) => {
      const u = resp.url();
      const ctype = resp.headers()["content-type"] ?? "";
      if (/\.mp4(\?|$)/i.test(u) || ctype.startsWith("video/")) captured.push(u);
    };
    page.on("response", onResponse as never);
    try {
      log.step(`Resolving video for ad ${ad.archiveId}...`);
      await page.goto(ad.snapshotUrl, { waitUntil: "domcontentloaded" });
      await sleep(4000);
      // Nudge the player so the source request fires.
      await page.mouse.wheel(0, 600);
      await sleep(3000);
    } finally {
      page.off("response", onResponse as never);
    }
    // Prefer the longest/most specific URL (usually the real asset).
    mp4Url = captured.sort((a, b) => b.length - a.length)[0] ?? "";
  }

  if (!mp4Url) {
    await snapshot(page, `spy_video_${ad.archiveId}_notfound`);
    log.warn(`Could not resolve a video URL for ad ${ad.archiveId}.`);
    return null;
  }

  try {
    const resp = await context.request.get(mp4Url);
    if (!resp.ok()) throw new Error(`HTTP ${resp.status()}`);
    const buf = await resp.body();
    const dest = join(dir, `ad_${ad.archiveId}_${timestamp()}.mp4`);
    writeFileSync(dest, buf);
    log.ok(`Downloaded winner video: ${dest}`);
    return dest;
  } catch (err) {
    log.warn(`Video download failed: ${(err as Error).message}`);
    return null;
  }
}
