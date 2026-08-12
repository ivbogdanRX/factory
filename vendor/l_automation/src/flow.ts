import {
  statSync,
  readdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { BrowserContext, Page, Locator, Download } from "playwright";
import type { AppConfig } from "./config.js";
import { sleep, waitForEnter, waitForNewDownload } from "./utils.js";
import { snapshot } from "./browser.js";
import { log } from "./logger.js";

const VIDEO_EXTS = [".mp4", ".mov", ".webm", ".m4v"];

/**
 * Flow returns a .zip when a generation produced more than one clip. Pull the
 * largest video file out of it and drop it in destDir; returns the new path.
 */
function extractVideoFromZip(zipPath: string, destDir: string): string | null {
  let tmp = "";
  try {
    // Extract into destDir so the final move stays on the same filesystem.
    tmp = mkdtempSync(join(destDir, "flowzip-"));
    execFileSync("unzip", ["-o", "-j", zipPath, "-d", tmp], { stdio: "ignore" });
    const vids = readdirSync(tmp)
      .filter((n) => VIDEO_EXTS.some((e) => n.toLowerCase().endsWith(e)))
      .map((n) => ({ path: join(tmp, n), size: statSync(join(tmp, n)).size }))
      .sort((a, b) => b.size - a.size);
    if (vids.length === 0) return null;
    const dest = join(destDir, `flow_${Date.now()}.mp4`);
    renameSync(vids[0]!.path, dest);
    return dest;
  } catch (err) {
    log.warn(`Could not extract video from zip: ${(err as Error).message}`);
    return null;
  } finally {
    try {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
    try {
      rmSync(zipPath, { force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * Drives the real Google Flow editor. Selectors below were derived from the
 * live DOM (see `npm run inspect`). Each step still falls back to a manual
 * checkpoint if the UI has drifted, so a run is never permanently stuck.
 */

/** Try a list of locators, returning the first that is visible. */
async function firstVisible(
  page: Page,
  selectors: string[],
  timeoutMs = 8000,
): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = page.locator(sel).first();
      try {
        if (await loc.isVisible()) return loc;
      } catch {
        /* selector may be invalid for current DOM; keep trying */
      }
    }
    await sleep(400);
  }
  return null;
}

/**
 * Open Flow and enter a project editor. The landing page is a project
 * dashboard; the prompt box + upload only exist inside a project, which shows
 * a "Loading..." splash for a while before the editor renders.
 */
async function openFlow(page: Page, cfg: AppConfig): Promise<void> {
  log.step("Opening Google Flow...");
  await page.goto(cfg.flow.url, { waitUntil: "domcontentloaded" });
  await sleep(2500);

  const signIn = await firstVisible(
    page,
    ['a[href*="accounts.google.com"]', 'text=/^sign in$/i'],
    3000,
  );
  if (signIn) {
    log.warn("Google Flow appears to require sign-in.");
    await waitForEnter("Sign in to Google in the browser, then return here.");
  }

  // If we're already inside a project (e.g. resumed), skip creating one.
  if (!/\/project\//.test(page.url())) {
    log.step("Creating a new Flow project...");
    const newProject = await firstVisible(
      page,
      [
        'button:has-text("New project")',
        'button:has-text("New Project")',
        'button:has-text("add_2")',
      ],
      15_000,
    );
    if (newProject) {
      await newProject.click();
    } else {
      const existing = await firstVisible(
        page,
        ['button:has-text("Edit project")'],
        5000,
      );
      if (existing) await existing.click();
      else
        await waitForEnter(
          "Could not find a way into a project. Open/create one, then return here.",
        );
    }
  }

  await page.waitForURL(/\/project\//, { timeout: 30_000 }).catch(() => {});
  log.info(`In project: ${page.url()}`);

  // Wait for the loading splash to clear and real controls to render.
  log.step("Waiting for the editor to load...");
  await page
    .waitForFunction(() => /Loading/i.test(document.body.innerText || ""), {
      timeout: 15_000,
    })
    .catch(() => {});
  try {
    await page.waitForFunction(
      () => {
        const t = (document.body.innerText || "").trim();
        const loading = t.length < 15 && /Loading/i.test(t);
        return !loading && document.querySelectorAll("button").length > 2;
      },
      { timeout: 120_000, polling: 1000 },
    );
    await page.waitForSelector('div[role="textbox"][contenteditable="true"]', {
      timeout: 30_000,
    });
    log.ok("Editor ready.");
  } catch {
    await snapshot(page, "flow_editor_not_ready");
    log.warn("Editor did not fully load; continuing best-effort.");
  }
  await sleep(2000);
}

/**
 * Switch the generation mode to Video (default editor opens in Image mode).
 * Opens the settings/model popover, clicks the Video tab, optionally picks a
 * model, then closes the popover.
 */
async function selectVideoMode(page: Page, cfg: AppConfig): Promise<void> {
  log.step("Opening generation settings...");
  // The settings chip text changes with the current mode/model.
  const chip = await firstVisible(
    page,
    [
      'button:has-text("Video \u00b7")',
      'button:has-text("Nano Banana")',
      'button:has-text("Omni Flash")',
      'button:has-text("Veo")',
      'button:has-text("crop_16_9")',
    ],
    10_000,
  );
  if (!chip) {
    log.warn("Could not find the settings chip; using defaults.");
    return;
  }
  await chip.click();
  await sleep(1500);

  // Switch to the Video tab (role=tab "play_circle Video").
  const videoTab = await firstVisible(
    page,
    ['button[role="tab"]:has-text("Video")'],
    5000,
  );
  if (videoTab) {
    await videoTab.click();
    await sleep(1200);
    log.ok("Video mode selected.");
  } else {
    log.warn("Video tab not found; leaving current mode.");
  }

  // Select the image-to-video sub-mode (Ingredients / Frames).
  if (cfg.flow.mode) {
    const subTab = await firstVisible(
      page,
      [`button[role="tab"]:has-text("${cfg.flow.mode}")`],
      4000,
    );
    if (subTab) {
      await subTab.click();
      await sleep(1000);
      log.ok(`${cfg.flow.mode} mode selected.`);
    } else {
      log.warn(`Sub-mode "${cfg.flow.mode}" tab not found.`);
    }
  }

  // Select the aspect ratio (e.g. 9:16).
  if (cfg.flow.aspectRatio) {
    const ratio = await firstVisible(
      page,
      [`button[role="tab"]:has-text("${cfg.flow.aspectRatio}")`],
      4000,
    );
    if (ratio) {
      await ratio.click();
      await sleep(1000);
      log.ok(`Aspect ratio ${cfg.flow.aspectRatio} selected.`);
    } else {
      log.warn(`Aspect ratio "${cfg.flow.aspectRatio}" not found.`);
    }
  }

  // Choose a specific model. The model combobox is a button containing the
  // "arrow_drop_down" icon; options are role=menuitem entries.
  if (cfg.flow.model) {
    const trigger = await firstVisible(
      page,
      ['button:has-text("arrow_drop_down")'],
      5000,
    );
    if (trigger) {
      await trigger.click();
      await sleep(1200);
      // Anchor with $ so "Veo 3.1 - Lite" does not match
      // "Veo 3.1 - Lite [Lower Priority]".
      const escaped = cfg.flow.model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const opt = page
        .locator('[role="menuitem"]')
        .filter({ hasText: new RegExp(`${escaped}$`) })
        .first();
      if (await opt.isVisible().catch(() => false)) {
        await opt.click();
        log.ok(`Model set to "${cfg.flow.model}".`);
      } else {
        log.warn(`Model "${cfg.flow.model}" not found; using default.`);
      }
      await sleep(1000);
    } else {
      log.warn("Model dropdown not found; using default video model.");
    }
  }

  // Close the popover so it does not cover the prompt/submit controls.
  await page.keyboard.press("Escape").catch(() => {});
  await sleep(800);
}

/**
 * Attach the source image as an ingredient. Flow's flow:
 *   1. click the prompt-bar "+" (add_2) -> opens the asset picker
 *   2. upload the image (file input / "Upload media")
 *   3. click "Add to Prompt" to attach it to the generation
 */
async function uploadImage(page: Page, imagePath: string): Promise<void> {
  log.step("Attaching the source image as an ingredient...");

  // 1. Open the asset picker via the prompt-bar "+".
  const plus = await firstVisible(
    page,
    ['button:has-text("add_2")', 'button:has-text("Add Media")'],
    8000,
  );
  if (plus) {
    await plus.click();
    await sleep(1500);
  } else {
    log.warn('Prompt-bar "+" not found; trying a direct file input.');
  }

  // 2. Upload the image. Prefer the picker's hidden image input; if "Upload
  // media" opens an OS chooser instead, handle that too.
  let uploaded = false;
  const imageInput = page.locator('input[type="file"][accept*="image"]');
  if ((await imageInput.count().catch(() => 0)) > 0) {
    try {
      await imageInput.first().setInputFiles(imagePath);
      uploaded = true;
      log.ok("Image uploaded into the picker.");
    } catch (err) {
      log.warn(`Image file input failed: ${(err as Error).message}`);
    }
  }
  if (!uploaded) {
    const uploadBtn = await firstVisible(
      page,
      ['button:has-text("Upload media")', 'button:has-text("Upload")'],
      4000,
    );
    if (uploadBtn) {
      try {
        const [chooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 8000 }),
          uploadBtn.click(),
        ]);
        await chooser.setFiles(imagePath);
        uploaded = true;
        log.ok("Image uploaded via file chooser.");
      } catch (err) {
        log.warn(`Upload media chooser failed: ${(err as Error).message}`);
      }
    }
  }

  if (!uploaded) {
    await snapshot(page, "flow_upload_manual");
    await waitForEnter(
      `Could not auto-upload the image. Add it manually: ${imagePath}\n   Then return here.`,
    );
    return;
  }

  // 3. Wait for the upload to process, then click "Add to Prompt".
  const addToPrompt = await firstVisible(
    page,
    ['button:has-text("Add to Prompt")', 'button:has-text("Add to prompt")'],
    30_000,
  );
  if (addToPrompt) {
    await addToPrompt.click();
    log.ok("Image added to prompt as an ingredient.");
    await sleep(2000);
  } else {
    await snapshot(page, "flow_add_to_prompt_manual");
    log.warn('Could not find "Add to Prompt".');
    await waitForEnter(
      "Click 'Add to Prompt' for the uploaded image in the browser, then return here.",
    );
  }
}

/** Type the prompt into the contenteditable prompt box. */
async function enterPrompt(page: Page, prompt: string): Promise<void> {
  log.step("Entering the prompt...");
  const field = await firstVisible(
    page,
    [
      'div[role="textbox"][contenteditable="true"]',
      '[contenteditable="true"]',
      "textarea:not([name])",
    ],
    10_000,
  );
  if (!field) {
    await snapshot(page, "flow_prompt_manual");
    await waitForEnter(
      `Could not find the prompt field. Type this manually:\n   "${prompt}"\n   Then return here.`,
    );
    return;
  }
  await field.click();
  // Clear any placeholder/residual content.
  await page.keyboard.press("ControlOrMeta+A").catch(() => {});
  await page.keyboard.press("Delete").catch(() => {});
  // Insert the whole prompt in one input event. The prompt is long (~2-3k
  // chars) and Flow's Slate editor re-renders on every keystroke, so
  // character-by-character typing (field.type) blows past the 30s action
  // timeout. insertText dispatches a single insertText event Slate handles
  // instantly.
  await page.keyboard.insertText(prompt);
  // Verify it landed; if Slate ignored the bulk insert, fall back to a fast
  // type with a generous timeout rather than failing the whole run.
  const landed = await field
    .evaluate((el) => (el.textContent ?? "").trim().length > 0)
    .catch(() => false);
  if (!landed) {
    log.warn("Bulk prompt insert didn't register; retrying via slow type.");
    await field.type(prompt, { delay: 0, timeout: 120_000 });
  }
  log.ok("Prompt entered.");
  await sleep(800);
}

/** Click the submit / Create (arrow_forward) button. */
async function startGeneration(page: Page): Promise<void> {
  log.step("Starting generation...");
  const genBtn = await firstVisible(
    page,
    [
      'button:has-text("arrow_forward")',
      'button:has-text("Generate")',
      'button[aria-label*="generate" i]',
      'button[type="submit"]',
    ],
    10_000,
  );
  if (!genBtn) {
    await snapshot(page, "flow_generate_manual");
    await waitForEnter(
      "Could not find the generate button. Start generation manually, then return here.",
    );
    return;
  }
  await genBtn.click();
  log.ok("Generation requested.");
}

/**
 * Click Flow's Download control and capture the resulting browser download.
 *
 * Flow's download icon is a persistent button on the selected result's
 * toolbar (not behind a hover/"more" menu). Clicking it often opens a small
 * size/quality menu ("Original", "1080p", …) rather than downloading right
 * away, so we click the button, and if no download starts, pick a menu option.
 */
async function clickDownloadControl(page: Page): Promise<Download | null> {
  const dlButton = await firstVisible(
    page,
    [
      'button[aria-label*="download" i]',
      'button[title*="download" i]',
      'button:has-text("file_download")',
      'button:has-text("download")',
      'a[download]',
    ],
    10_000,
  );
  if (!dlButton) return null;

  // First click: it may download immediately, or open a size/quality menu.
  try {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 15_000 }),
      dlButton.click(),
    ]);
    return download;
  } catch {
    /* No immediate download — a menu probably opened. Fall through. */
  }

  // Pick the menu option that triggers the actual download.
  const option = await firstVisible(
    page,
    [
      '[role="menuitem"]:has-text("Original")',
      '[role="menuitem"]:has-text("1080")',
      '[role="menuitem"]:has-text("720")',
      '[role="menuitem"]:has-text("MP4")',
      '[role="menuitem"]:has-text("Download")',
      '[role="menuitem"]',
    ],
    4000,
  );
  if (!option) return null;
  try {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 120_000 }),
      option.click(),
    ]);
    return download;
  } catch (err) {
    log.warn(`Download menu option click failed: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Read the generated video's bytes from inside the page. This works even when
 * the <video> uses a blob: URL (which can't be fetched from Node), because the
 * fetch + FileReader run in the page context where the blob is valid.
 */
async function fetchVideoBytes(page: Page): Promise<Buffer | null> {
  try {
    const dataUrl = await page
      .locator("video")
      .first()
      .evaluate(async (v) => {
        const el = v as HTMLVideoElement;
        const src = el.currentSrc || el.src;
        if (!src) return "";
        const resp = await fetch(src);
        const blob = await resp.blob();
        return await new Promise<string>((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => resolve(String(fr.result));
          fr.onerror = () => reject(fr.error);
          fr.readAsDataURL(blob);
        });
      });
    if (dataUrl && dataUrl.startsWith("data:")) {
      const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
      return Buffer.from(base64, "base64");
    }
  } catch (err) {
    log.warn(`In-page video fetch failed: ${(err as Error).message}`);
  }
  return null;
}

/**
 * Probe the page for "generation finished" signals. Each run starts in a fresh
 * project, so the page has no prior results — any of these means OUR clip is
 * done:
 *   - a <video> element that has an actual source (ready to grab bytes), or
 *   - a result tile showing a play button (Flow's earliest "done" marker —
 *     it appears before the <video> element mounts/becomes visible), or
 *   - a download control on the result toolbar.
 * `generating` is detected from real progress elements (spinner/progressbar),
 * not body text, so stray copy can't keep us blocked.
 */
async function probeResultState(page: Page): Promise<{
  ready: boolean;
  generating: boolean;
} | null> {
  return page
    .evaluate(() => {
      const all = (sel: string) => Array.from(document.querySelectorAll(sel));

      const hasVideo = all("video").some((v) => {
        const el = v as HTMLVideoElement;
        return Boolean(el.currentSrc || el.src) || el.readyState > 0;
      });

      const hasPlay = all('button, [role="button"]').some((b) => {
        const text = (b.textContent || "").toLowerCase();
        const label = (b.getAttribute("aria-label") || "").toLowerCase();
        return /play_circle|play_arrow/.test(text) || /\bplay\b/.test(label);
      });

      const hasDownload = Boolean(
        document.querySelector(
          'button[aria-label*="download" i], button[title*="download" i], a[download]',
        ),
      );

      const generating = Boolean(
        document.querySelector('[role="progressbar"], progress'),
      );

      // A real <video> source is conclusive. Play/download controls only count
      // once the active progress indicator is gone, so a stray button can't
      // trigger a premature "ready" mid-render.
      const ready = hasVideo || ((hasPlay || hasDownload) && !generating);
      return { ready, generating };
    })
    .catch(() => null);
}

/**
 * Actively poll until a generated result is ready, returning the instant a
 * "done" signal shows up instead of blocking on Playwright's visibility checks
 * (which lag badly because Flow shows a poster tile before the <video> mounts).
 */
async function waitForResultReady(page: Page, cfg: AppConfig): Promise<void> {
  const timeout = cfg.flow.generationTimeoutMs;
  const deadline = Date.now() + timeout;
  const start = Date.now();
  let nextHeartbeat = start + 30_000;

  while (Date.now() < deadline) {
    const state = await probeResultState(page);
    if (state?.ready) {
      log.info(
        `Generated result ready after ${Math.round((Date.now() - start) / 1000)}s.`,
      );
      return;
    }
    if (Date.now() >= nextHeartbeat) {
      log.info(
        `Still generating... (${Math.round((Date.now() - start) / 1000)}s elapsed)`,
      );
      nextHeartbeat += 30_000;
    }
    await sleep(1500);
  }
  log.warn("No result detected within the timeout; attempting download anyway.");
}

/**
 * Wait for a generated video to be ready, then download it. Returns the
 * absolute path of the downloaded file in the configured download dir.
 *
 * When interactive is false (batch runs), the manual fallback is skipped and a
 * failure throws instead of blocking on stdin, so the batch can move on.
 */
async function downloadResult(
  page: Page,
  cfg: AppConfig,
  interactive: boolean,
): Promise<string> {
  log.step("Waiting for the video to finish generating (can take minutes)...");
  const since = Date.now();
  await waitForResultReady(page, cfg);
  await sleep(1200);

  // Strategy 1: read the visible <video> bytes from inside the page. This grabs
  // exactly one clip (no zip) and works for blob: URLs. Preferred path.
  const bytes = await fetchVideoBytes(page);
  if (bytes && bytes.length > 0) {
    const dest = join(cfg.browser.downloadDir, `flow_${Date.now()}.mp4`);
    writeFileSync(dest, bytes);
    log.ok(`Video saved from page (${bytes.length} bytes): ${dest}`);
    return dest;
  }

  // Strategy 2: click the toolbar Download control (handles a follow-up
  // size/quality menu). If a generation made multiple clips, Flow returns a
  // .zip — extract the video out of it.
  try {
    const download = await clickDownloadControl(page);
    if (download) {
      const suggested = download.suggestedFilename() || `flow_${Date.now()}.mp4`;
      const dest = join(cfg.browser.downloadDir, suggested);
      await download.saveAs(dest);
      if (suggested.toLowerCase().endsWith(".zip")) {
        const mp4 = extractVideoFromZip(dest, cfg.browser.downloadDir);
        if (mp4) {
          log.ok(`Video extracted from zip: ${mp4}`);
          return mp4;
        }
        log.warn("Downloaded a zip with no video inside; trying other methods.");
      } else {
        log.ok(`Video downloaded: ${dest}`);
        return dest;
      }
    }
  } catch (err) {
    log.warn(`Download control failed: ${(err as Error).message}`);
  }

  // Strategy 3: pull the video src via the context request (cross-origin http
  // with the session's cookies).
  try {
    const src = await page
      .locator("video")
      .first()
      .evaluate(
        (v) => (v as HTMLVideoElement).currentSrc || (v as HTMLVideoElement).src,
      )
      .catch(() => "");
    if (src && src.startsWith("http")) {
      log.info(`Fetching video stream directly: ${src}`);
      const resp = await page.context().request.get(src);
      if (resp.ok()) {
        const buf = await resp.body();
        const dest = join(cfg.browser.downloadDir, `flow_${Date.now()}.mp4`);
        writeFileSync(dest, buf);
        log.ok(`Video saved from stream: ${dest}`);
        return dest;
      }
    }
  } catch (err) {
    log.warn(`Direct stream fetch failed: ${(err as Error).message}`);
  }

  await snapshot(page, "flow_download_manual");

  // Non-interactive (batch): don't block on stdin — fail this run so the batch
  // continues to the next one.
  if (!interactive) {
    throw new Error("Could not auto-download the generated video.");
  }

  // Strategy 4: manual download + folder watcher (interactive only).
  log.warn("Could not auto-download the video.");
  await waitForEnter(
    `Manually download the generated video into:\n   ${cfg.browser.downloadDir}\n   Then return here.`,
  );
  const found = await waitForNewDownload(cfg.browser.downloadDir, since, {
    timeoutMs: 120_000,
    exts: VIDEO_EXTS,
  });
  const size = statSync(found).size;
  log.ok(`Detected downloaded video: ${found} (${size} bytes)`);
  return found;
}

/** Full Flow flow: open -> video mode -> upload -> prompt -> generate -> download. */
export async function generateFlowVideo(
  _context: BrowserContext,
  page: Page,
  cfg: AppConfig,
  imagePath: string,
  interactive = true,
): Promise<string> {
  await openFlow(page, cfg);
  await selectVideoMode(page, cfg);
  await uploadImage(page, imagePath);
  await enterPrompt(page, cfg.flow.prompt);
  await startGeneration(page);
  return downloadResult(page, cfg, interactive);
}
