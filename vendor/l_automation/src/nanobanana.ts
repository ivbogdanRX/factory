import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import type { AppConfig } from "./config.js";
import { getApiKey } from "./veo-api.js";
import { ensureDir, slugify, timestamp } from "./utils.js";
import { acquireApiSlot } from "./ratelimit.js";
import { log } from "./logger.js";

const IMAGE_DIR = "downloads/images";

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

// Variety pools so every run produces a different attractive UGC creator.
// Skewed young (but clearly adult, 21+) and conventionally attractive.
const AGES = ["early 20s", "mid 20s", "21-year-old", "23-year-old", "25-year-old"];
const ETHNICITIES = [
  "white American",
  "Latina",
  "Black American",
  "East Asian",
  "South Asian",
  "Middle Eastern",
  "mixed-race",
];
const HAIR = [
  "long loose wavy brown",
  "sleek straight blonde",
  "voluminous curly black",
  "shoulder-length auburn with soft waves",
  "an effortless messy bun with face-framing strands",
  "a chic short bob",
  "long glossy straight black",
  "ginger with loose beachy curls",
];
const EYES = ["brown", "hazel", "green", "blue", "dark brown"];
const SETTINGS = [
  "a cozy, beautifully decorated living room",
  "a bright aesthetic kitchen with plants",
  "the driver's seat of a clean car",
  "a stylish sunlit bedroom with neutral decor",
  "a tidy aesthetic home office",
  "a trendy coffee shop",
  "a chic bathroom with great lighting",
  "a sunny street with a soft city backdrop",
  "a cozy reading nook by a window",
  "a modern apartment beside a large bright window",
];
const TIMES_OF_DAY = [
  "morning",
  "late morning",
  "a golden-hour afternoon",
  "the afternoon",
  "early evening at sunset",
];
const LIGHTING = [
  "soft flattering natural window light",
  "a warm golden-hour glow",
  "bright airy daylight",
  "soft natural light that gives her a healthy glow",
  "gentle warm light with a soft catchlight in her eyes",
];
const CLOTHING = [
  "a cute cozy oversized knit sweater",
  "a fitted ribbed top",
  "a casual matching athleisure set",
  "a stylish casual t-shirt",
  "a denim jacket over a simple top",
  "a soft neutral-toned cardigan",
];
const EXPRESSIONS = [
  "a warm genuine smile",
  "talking energetically mid-sentence",
  "a friendly, engaging expression",
  "a soft confident smile",
  "an approachable relatable look",
];

/** Build a randomized, attractive-but-authentic UGC-creator selfie prompt. */
export function buildUgcPrompt(): string {
  const age = pick(AGES);
  const ethnicity = pick(ETHNICITIES);
  const hair = pick(HAIR);
  const eyes = pick(EYES);
  const setting = pick(SETTINGS);
  const timeOfDay = pick(TIMES_OF_DAY);
  const lighting = pick(LIGHTING);
  const clothing = pick(CLOTHING);
  const expression = pick(EXPRESSIONS);

  return [
    // Pleasant-looking but ordinary — real person, not a model.
    `A vertical 9:16 casual selfie of a pleasant, girl-next-door young ${age} ${ethnicity} woman`,
    `with ${hair} hair and ${eyes} eyes, ${expression}.`,
    `She looks like a normal, likeable everyday person — attractive in a real-life way,`,
    `NOT a model, NOT an influencer with styled hair and makeup. Minimal or no makeup,`,
    `slightly imperfect hair, real skin with visible texture and pores.`,
    `She is holding her phone at arm's length taking a front-facing selfie`,
    `in ${setting} during ${timeOfDay}, with ${lighting}. She is wearing ${clothing}.`,
    // Amateur capture quality — this must NOT look like a photoshoot.
    `Amateur iPhone front-camera quality: candid uneven framing, ordinary imperfect`,
    `lighting (no studio light, no golden-hour glow, no flattering key light),`,
    `slightly soft focus with a touch of sensor grain, mildly washed-out colors,`,
    `a plain lived-in everyday background (a bit cluttered is fine, nothing styled or aspirational).`,
    `It should look like a random person's front-camera video call screenshot,`,
    `NOT a professional photo, NOT retouched, NOT AI-looking, NOT CGI, NOT a stock photo.`,
    `Single person only, head and shoulders, face clearly visible and centered`,
    `for a talking-head video.`,
  ].join(" ");
}

export interface GeneratedModelImage {
  path: string;
  prompt: string;
}

/**
 * Generate a random UGC-woman reference image with Nano Banana Pro
 * (gemini-3-pro-image-preview) via the Gemini API. Returns the saved path.
 */
export async function generateModelImage(
  cfg: AppConfig,
): Promise<GeneratedModelImage> {
  const ai = new GoogleGenAI({ apiKey: getApiKey() });
  const nb = cfg.imageSource.nanoBanana;
  const prompt = nb.promptOverride.trim() || buildUgcPrompt();

  log.step(`Nano Banana Pro: generating UGC model image (${nb.aspectRatio}, ${nb.imageSize}).`);

  let response;
  try {
    await acquireApiSlot("Nano Banana image generation");
    response = await ai.models.generateContent({
      model: nb.model,
      contents: prompt,
      config: {
        responseModalities: ["IMAGE"],
        imageConfig: {
          aspectRatio: nb.aspectRatio,
          imageSize: nb.imageSize,
        },
      },
    });
  } catch (err) {
    throw new Error(
      `Nano Banana Pro request failed: ${(err as Error).message}`,
    );
  }

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const inline = part.inlineData;
    if (inline?.data) {
      const mime = inline.mimeType ?? "image/png";
      const ext = mime.includes("jpeg") ? ".jpg" : mime.includes("webp") ? ".webp" : ".png";
      const dir = ensureDir(IMAGE_DIR);
      const path = join(dir, `model_${timestamp()}_${slugify("ugc")}${ext}`);
      writeFileSync(path, Buffer.from(inline.data, "base64"));
      log.ok(`Model image saved: ${path}`);
      return { path, prompt };
    }
  }

  throw new Error(
    "Nano Banana Pro returned no image (it may have refused the prompt).",
  );
}
