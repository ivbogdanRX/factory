import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import type { AppConfig } from "./config.js";
import { buildUgcPrompt, type GeneratedModelImage } from "./nanobanana.js";
import { snapshot } from "./browser.js";
import { ensureDir, timestamp } from "./utils.js";
import { log } from "./logger.js";

const IMAGE_DIR = "downloads/images";

/**
 * Generate the UGC reference image by driving the ChatGPT web UI with the
 * shared persistent browser profile (same trick as the Flow browser backend).
 * Uses your ChatGPT plan's image generation instead of the OpenAI API, so no
 * API credits are needed. Log in once with `npm run login`.
 *
 * The ChatGPT DOM changes over time — selectors here are best-effort with
 * fallbacks, and failures screenshot to artifacts/ for quick diagnosis.
 */
export async function generateModelImageChatGPT(
  context: BrowserContext,
  page: Page,
  cfg: AppConfig,
): Promise<GeneratedModelImage> {
  const cc = cfg.imageSource.chatgpt;
  const prompt = cc.promptOverride.trim() || buildUgcPrompt();
  const fullPrompt =
    "Generate an image. Photorealistic, vertical 9:16 portrait. " +
    "Absolutely no text, captions, watermarks, or logos in the image. " +
    "Style constraint: this must look like a casual amateur selfie from an older iPhone " +
    "(iPhone 11 / 12) front camera, with ordinary imperfect lighting, slight grain, " +
    "mild compression, and slightly soft focus — " +
    "NOT a professional photoshoot, NOT studio lighting, NOT a ring light, NOT retouched glossy skin. " +
    "Follow the ethnicity in the prompt exactly. Do not default to mixed-race or racially ambiguous features. " +
    prompt;

  log.step("ChatGPT web: generating UGC model image via browser.");
  log.info(`Look: ${prompt.slice(0, 180)}...`);

  // A fresh conversation per run keeps prior images out of the way.
  await page.goto(cc.url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  if (await looksLoggedOut(page)) {
    throw new Error(
      "ChatGPT is not logged in inside the automation browser profile. " +
        "Run `npm run login` and sign in at chatgpt.com (Google login works), then retry.",
    );
  }

  const composer = page
    .locator('#prompt-textarea, div[contenteditable="true"][data-virtualkeyboard], form div[contenteditable="true"]')
    .first();
  try {
    await composer.waitFor({ state: "visible", timeout: 20_000 });
  } catch {
    await snapshot(page, "chatgpt-no-composer");
    throw new Error(
      "Could not find the ChatGPT message composer — the UI may have changed or a " +
        "captcha/interstitial is showing. See the artifacts/ screenshot.",
    );
  }

  await composer.click();
  await composer.fill(fullPrompt);
  await page.waitForTimeout(300);

  const sendButton = page.locator('button[data-testid="send-button"], button[aria-label*="Send" i]').first();
  if (await sendButton.isVisible().catch(() => false)) {
    await sendButton.click();
  } else {
    await composer.press("Enter");
  }
  log.info("Prompt sent; waiting for ChatGPT to render the image...");

  const src = await waitForGeneratedImage(page, cc.timeoutSec * 1000);
  const bytes = await downloadImageBytes(page, src);
  if (bytes.length < 10_000) {
    await snapshot(page, "chatgpt-tiny-image");
    throw new Error(`ChatGPT image download looks wrong (${bytes.length} bytes) — see artifacts/ screenshot.`);
  }

  const ext = sniffImageExt(bytes);
  const dir = ensureDir(IMAGE_DIR);
  const path = join(dir, `model_${timestamp()}_chatgpt.${ext}`);
  writeFileSync(path, bytes);
  log.ok(`Model image saved: ${path}`);
  return { path, prompt };
}

async function looksLoggedOut(page: Page): Promise<boolean> {
  if (/auth|login/i.test(page.url())) return true;
  const loginButton = page.locator('button:has-text("Log in"), a:has-text("Log in"), [data-testid="login-button"]').first();
  return await loginButton.isVisible({ timeout: 1500 }).catch(() => false);
}

/**
 * Poll until a generated image appears in the conversation and streaming has
 * finished. ChatGPT progressively renders images, so after the <img> shows up
 * we wait for its src to stop changing before trusting it.
 */
async function waitForGeneratedImage(page: Page, timeoutMs: number): Promise<string> {
  const startedAt = Date.now();
  let lastSrc = "";
  let stableCount = 0;

  while (Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(2000);

    const src = await page
      .evaluate(() => {
        const selectors = [
          'img[alt="Generated image" i]',
          'img[alt*="generated" i]',
          'img[src*="oaiusercontent"]',
          'img[src*="files.openai"]',
          // Newer UI serves images through the conversation backend.
          'img[src*="backend-api"]',
          'img[src*="estuary"]',
          'article img[src^="blob:"]',
          // Last resort: any large image inside an assistant turn.
          '[data-message-author-role="assistant"] img',
          'article img',
        ];
        for (const selector of selectors) {
          const imgs = Array.from(document.querySelectorAll<HTMLImageElement>(selector));
          // Skip avatars and thumbnails — a real generation is large.
          const large = imgs.filter((img) => img.naturalWidth >= 400 && img.naturalHeight >= 400);
          const last = large[large.length - 1];
          if (last) return last.src;
        }
        return "";
      })
      .catch(() => "");

    const streaming = await page
      .locator('button[data-testid="stop-button"], button[aria-label*="Stop" i]')
      .first()
      .isVisible()
      .catch(() => false);

    if (src) {
      if (src === lastSrc && !streaming) {
        stableCount += 1;
        if (stableCount >= 2) return src;
      } else {
        stableCount = 0;
      }
      lastSrc = src;
    } else if (!streaming && Date.now() - startedAt > 45_000) {
      // Response finished with no image — probably a refusal or a rate limit.
      const reply = await page
        .evaluate(() => {
          const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
          return turns[turns.length - 1]?.textContent?.slice(0, 300) ?? "";
        })
        .catch(() => "");
      await snapshot(page, "chatgpt-no-image");
      throw new Error(
        `ChatGPT replied without an image${reply ? `: "${reply.trim()}"` : ""}. ` +
          "It may have hit an image-generation limit or refused the prompt.",
      );
    }
  }

  await snapshot(page, "chatgpt-image-timeout");
  throw new Error(`ChatGPT did not produce an image within ${Math.round(timeoutMs / 1000)}s.`);
}

/** blob: URLs must be fetched in-page; https URLs go through the cookie-bearing request context. */
async function downloadImageBytes(page: Page, src: string): Promise<Buffer> {
  if (src.startsWith("blob:") || src.startsWith("data:")) {
    const base64 = await page.evaluate(async (url) => {
      const response = await fetch(url);
      const blob = await response.blob();
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result).split(",")[1] ?? "");
        reader.onerror = () => reject(new Error("FileReader failed"));
        reader.readAsDataURL(blob);
      });
    }, src);
    return Buffer.from(base64, "base64");
  }
  const response = await page.request.get(src);
  if (!response.ok()) throw new Error(`Image download failed (${response.status()}) from ${src.slice(0, 80)}`);
  return Buffer.from(await response.body());
}

function sniffImageExt(bytes: Buffer): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpg";
  if (bytes.length >= 12 && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return "png";
}
