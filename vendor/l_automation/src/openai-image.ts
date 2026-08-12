import { writeFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import type { AppConfig } from "./config.js";
import { buildUgcPrompt, type GeneratedModelImage } from "./nanobanana.js";
import { ensureDir, slugify, timestamp } from "./utils.js";
import { acquireApiSlot } from "./ratelimit.js";
import { log } from "./logger.js";

const IMAGE_DIR = "downloads/images";

function getApiKey(): string {
  const key = process.env.OPENAI_API_KEY ?? "";
  if (!key) {
    throw new Error(
      "No OpenAI API key found. Set OPENAI_API_KEY in your .env. " +
        "Get one at https://platform.openai.com/api-keys",
    );
  }
  return key;
}

/** Map a 9:16-ish aspect ratio to the closest gpt-image-1 size. */
function sizeForAspect(aspect: string): "1024x1024" | "1024x1536" | "1536x1024" {
  const [w, h] = aspect.split(":").map(Number);
  if (w && h) {
    if (h > w) return "1024x1536"; // portrait (9:16)
    if (w > h) return "1536x1024"; // landscape (16:9)
  }
  return "1024x1024";
}

/**
 * Generate a random UGC-woman reference image with OpenAI's gpt-image-1.
 * Returns the saved path. Drop-in replacement for the Nano Banana source.
 */
export async function generateModelImageOpenAI(
  cfg: AppConfig,
): Promise<GeneratedModelImage> {
  const client = new OpenAI({ apiKey: getApiKey() });
  const oi = cfg.imageSource.openai;
  const prompt = oi.promptOverride.trim() || buildUgcPrompt();
  const size = oi.size === "auto" ? sizeForAspect(cfg.imageSource.nanoBanana.aspectRatio) : oi.size;

  log.step(`OpenAI ${oi.model}: generating UGC model image (${size}, ${oi.quality}).`);

  let result;
  try {
    await acquireApiSlot("OpenAI image generation");
    result = await client.images.generate({
      model: oi.model,
      prompt,
      size,
      quality: oi.quality,
      n: 1,
    });
  } catch (err) {
    throw new Error(`OpenAI image request failed: ${(err as Error).message}`);
  }

  const b64 = result.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error("OpenAI returned no image data.");
  }

  const dir = ensureDir(IMAGE_DIR);
  const path = join(dir, `model_${timestamp()}_${slugify("ugc")}.png`);
  writeFileSync(path, Buffer.from(b64, "base64"));
  log.ok(`Model image saved: ${path}`);
  return { path, prompt };
}
