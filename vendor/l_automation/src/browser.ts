import { chromium, type BrowserContext, type Page } from "playwright";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { ensureDir, timestamp } from "./utils.js";
import { log } from "./logger.js";

export const ARTIFACTS_DIR = "artifacts";

/**
 * Global serialization for the persistent browser profile. A persistent
 * Chromium profile (`.browser-profile`) can only be open in ONE process at a
 * time — launching a second instance fails with "Opening in existing browser
 * session". Since the app now drives the browser from several places (Pinterest
 * sourcing, ad-library crawls, winner downloads, full remakes) and runs jobs
 * concurrently, every persistent-context launch must wait its turn. This is a
 * simple FIFO async mutex.
 */
let browserChain: Promise<void> = Promise.resolve();

/** Acquire the browser lock; resolves with a release function when it's your turn. */
export function acquireBrowserLock(): Promise<() => void> {
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const prior = browserChain;
  browserChain = prior.then(() => next);
  let released = false;
  const safeRelease = (): void => {
    if (released) return;
    released = true;
    release();
  };
  return prior.then(() => safeRelease);
}

/**
 * Run `fn` with an exclusive persistent browser context, guaranteeing only one
 * such session exists at a time. The context is always closed and the lock
 * always released, even on error.
 */
export async function withBrowser<T>(
  cfg: AppConfig,
  opts: { headless?: boolean },
  fn: (context: BrowserContext, page: Page) => Promise<T>,
): Promise<T> {
  const release = await acquireBrowserLock();
  let context: BrowserContext | null = null;
  try {
    context = await launchContext(cfg, opts);
    const page = await getPage(context);
    return await fn(context, page);
  } finally {
    if (context) {
      try {
        await context.close();
      } catch {
        // best-effort; the lock must still release
      }
    }
    release();
  }
}

/**
 * Launch a persistent Chromium context so Pinterest/Google logins are
 * remembered between runs. Downloads are routed to the configured dir.
 *
 * Google blocks OAuth sign-in in browsers it detects as automated ("this
 * browser or app may not be secure"). To get past that we:
 *  - use the real installed Google Chrome (channel "chrome") instead of the
 *    bundled "Chrome for Testing" build,
 *  - drop the `--enable-automation` flag and the AutomationControlled feature,
 *  - mask `navigator.webdriver` before any page script runs.
 * None of this is guaranteed forever, but it currently lets manual Google
 * login complete in the controlled browser.
 */
export async function launchContext(
  cfg: AppConfig,
  opts: { headless?: boolean } = {},
): Promise<BrowserContext> {
  ensureDir(cfg.browser.profileDir);
  ensureDir(cfg.browser.downloadDir);

  const useChannel = cfg.browser.channel !== "";
  const headless = opts.headless ?? cfg.browser.headless;

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(cfg.browser.profileDir, {
      ...(useChannel ? { channel: cfg.browser.channel } : {}),
      headless,
      slowMo: cfg.browser.slowMoMs,
      acceptDownloads: true,
      viewport: { width: 1440, height: 900 },
      // Remove the "Chrome is being controlled by automated test software" flag
      // that Google keys off of.
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        "--disable-blink-features=AutomationControlled",
        "--no-default-browser-check",
      ],
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (/existing browser session|already in use|ProcessSingleton/i.test(msg)) {
      throw new Error(
        "The browser profile is already in use. Close any Chrome window opened " +
          `from this profile (${cfg.browser.profileDir}) and make sure no other ` +
          "crawl/generation job is running, then retry. If it persists, quit " +
          "Chrome fully (or remove a stale lock) and run again.",
      );
    }
    throw err;
  }

  // tsx/esbuild "keepNames" rewrites helpers into __name(...) calls; when those
  // helpers get serialized into page.evaluate they reference a __name that does
  // not exist in the browser. Define a no-op shim (as a string so esbuild leaves
  // it alone) before any evaluate runs.
  await context.addInitScript({
    content:
      "globalThis.__name = globalThis.__name || function (fn) { return fn; };",
  });

  // Hide the webdriver fingerprint before any site script executes.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  context.setDefaultTimeout(30_000);

  if (useChannel) {
    log.info(`Using Chrome channel "${cfg.browser.channel}" with anti-detection flags.`);
  }
  return context;
}

/** Reuse the first existing page or open a new one. */
export async function getPage(context: BrowserContext): Promise<Page> {
  const existing = context.pages();
  const page = existing.length > 0 ? existing[0]! : await context.newPage();
  await page.bringToFront();
  return page;
}

/** Save a screenshot (used on failures and key checkpoints). */
export async function snapshot(page: Page, label: string): Promise<string> {
  const dir = ensureDir(ARTIFACTS_DIR);
  const file = join(dir, `${timestamp()}_${label}.png`);
  try {
    await page.screenshot({ path: file, fullPage: false });
    log.info(`Saved screenshot: ${file}`);
  } catch (err) {
    log.warn(`Could not capture screenshot: ${(err as Error).message}`);
  }
  return file;
}
