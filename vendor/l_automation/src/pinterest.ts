import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Locator, Page } from "playwright";
import type { AppConfig } from "./config.js";
import { ensureDir, sleep, timestamp, waitForEnter } from "./utils.js";
import { snapshot } from "./browser.js";
import { SeenStore, pinKey } from "./seen.js";
import { log } from "./logger.js";

export interface SourcedImage {
  /** Absolute path to the saved image file. */
  path: string;
  /** Origin URL the image came from (best-effort). */
  sourceUrl: string;
  /**
   * Dedup key for this pin, or "" for direct-URL sources. The caller marks it
   * as used (via SeenStore) only after the full pipeline succeeds, so a failed
   * generation doesn't waste the pin.
   */
  key: string;
}

const IMAGE_DIR = "downloads/images";

/** Upgrade a Pinterest thumbnail URL to the largest "originals" variant. */
function upscalePinUrl(url: string): string {
  // Pinterest serves sizes like /236x/, /474x/, /564x/, /736x/ ...
  return url.replace(/\/\d+x\d*\//, "/originals/");
}

async function fetchToFile(
  context: BrowserContext,
  url: string,
  destDir: string,
): Promise<string> {
  ensureDir(destDir);
  const resp = await context.request.get(url);
  if (!resp.ok()) {
    throw new Error(`Image request failed (${resp.status()}) for ${url}`);
  }
  const buf = await resp.body();
  const ctype = resp.headers()["content-type"] ?? "";
  const ext = ctype.includes("png")
    ? ".png"
    : ctype.includes("webp")
      ? ".webp"
      : ctype.includes("gif")
        ? ".gif"
        : ".jpg";
  const dest = join(destDir, `pin_${timestamp()}${ext}`);
  writeFileSync(dest, buf);
  return dest;
}

/**
 * Resolve an image from Pinterest.
 * - If cfg.pinterest.imageUrl is set, download it directly.
 * - Otherwise search and pick the result at cfg.pinterest.resultIndex.
 *
 * Primary strategy is a direct HTTP download of the full-res image (most
 * reliable). If that is blocked, falls back to a manual checkpoint.
 */
export async function sourcePinterestImage(
  context: BrowserContext,
  page: Page,
  cfg: AppConfig,
  resultIndexOverride?: number,
): Promise<SourcedImage> {
  const destDir = ensureDir(IMAGE_DIR);

  // Direct URL path: skip the UI entirely.
  if (cfg.pinterest.imageUrl) {
    log.step(`Downloading image from direct URL...`);
    const url = upscalePinUrl(cfg.pinterest.imageUrl);
    const path = await fetchToFile(context, url, destDir);
    log.ok(`Image saved: ${path}`);
    return { path, sourceUrl: cfg.pinterest.imageUrl, key: "" };
  }

  log.step(`Searching Pinterest for: "${cfg.pinterest.query}"`);
  const searchUrl = `https://www.pinterest.com/search/pins/?q=${encodeURIComponent(
    cfg.pinterest.query,
  )}`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded" });

  // Pinterest sometimes gates search behind login.
  if (/\/login\/?/.test(page.url())) {
    log.warn("Pinterest is requiring login before search.");
    await waitForEnter(
      "Log in to Pinterest in the browser, navigate to your search, then return here.",
    );
  }

  // Let the masonry grid populate.
  try {
    await page.waitForSelector('div[data-test-id="pin"] img, img[src*="pinimg.com"]', {
      timeout: 30_000,
    });
  } catch {
    await snapshot(page, "pinterest_no_results");
    throw new Error(
      "No Pinterest pins appeared. The page may have changed or requires login.",
    );
  }
  await sleep(1500);

  const startIndex = Math.max(0, resultIndexOverride ?? cfg.pinterest.resultIndex);
  const seen = new SeenStore();
  log.info(`Skipping ${seen.size} previously-used pin(s).`);

  // Find the first pin we haven't used before. If everything on screen is
  // already used, scroll to lazy-load more results and try again.
  const maxScrolls = 12;
  let chosen:
    | { locator: Locator; rawSrc: string; fullUrl: string; key: string }
    | null = null;

  for (let attempt = 0; attempt <= maxScrolls && !chosen; attempt++) {
    const imgs = page.locator('img[src*="pinimg.com"]');
    const count = await imgs.count();
    if (count === 0 && attempt === 0) {
      await snapshot(page, "pinterest_empty");
      throw new Error("Found the grid but no pin images were readable.");
    }

    const from = attempt === 0 ? Math.min(startIndex, Math.max(count - 1, 0)) : 0;
    for (let i = from; i < count; i++) {
      const locator = imgs.nth(i);
      const rawSrc =
        (await locator.getAttribute("src")) ??
        (await locator.getAttribute("data-src")) ??
        "";
      if (!rawSrc) continue;
      const key = pinKey(rawSrc);
      if (seen.has(key)) continue;
      chosen = { locator, rawSrc, fullUrl: upscalePinUrl(rawSrc), key };
      break;
    }

    if (!chosen) {
      // Scroll to load more pins, then re-scan.
      await page.mouse.wheel(0, 6000);
      await sleep(1500);
    }
  }

  if (!chosen) {
    await snapshot(page, "pinterest_all_seen");
    throw new Error(
      "Couldn't find an unused pin after scrolling. Try a different " +
        "pinterest.query, or clear .state/seen-pins.json to allow reuse.",
    );
  }

  const { locator: pick, rawSrc, fullUrl, key } = chosen;
  await pick.scrollIntoViewIfNeeded().catch(() => {});
  log.info(`Selected new pin -> ${fullUrl}`);

  // Strategy 1: direct HTTP download at full resolution.
  try {
    const path = await fetchToFile(context, fullUrl, destDir);
    log.ok(`Image saved: ${path}`);
    return { path, sourceUrl: fullUrl, key };
  } catch (err) {
    log.warn(`Full-res download failed: ${(err as Error).message}`);
  }

  // Strategy 2: download the thumbnail src as-is.
  try {
    const path = await fetchToFile(context, rawSrc, destDir);
    log.ok(`Image saved (thumbnail fallback): ${path}`);
    return { path, sourceUrl: rawSrc, key };
  } catch (err) {
    log.warn(`Thumbnail download failed: ${(err as Error).message}`);
  }

  // Strategy 3: manual fallback - screenshot the chosen pin element.
  log.warn("Falling back to element screenshot for the selected pin.");
  const shotDir = ensureDir(IMAGE_DIR);
  const shot = join(shotDir, `pin_${timestamp()}_screenshot.png`);
  await pick.screenshot({ path: shot });
  log.ok(`Image captured via screenshot: ${shot}`);
  return { path: shot, sourceUrl: fullUrl, key };
}
