import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { GoogleGenAI } from "@google/genai";
import type { AppConfig } from "./config.js";
import { getApiKey } from "./veo-api.js";
import { ensureDir, slugify, timestamp } from "./utils.js";
import { acquireApiSlot } from "./ratelimit.js";
import { log } from "./logger.js";
import { IMAGE_GUARDS } from "./prompt-guards.js";

const IMAGE_DIR = "downloads/images";

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

interface LookPack {
  id: "white" | "asian" | "black" | "mixed";
  /** Unmistakable ethnicity line for the image model. */
  ethnicity: string;
  skin: string[];
  hair: string[];
  eyes: string[];
}

const WHITE: LookPack = {
  id: "white",
  ethnicity:
    "White American / European (clearly Caucasian — fair to light skin, NOT mixed-race, NOT racially ambiguous)",
  skin: [
    "fair porcelain skin with a natural flush in the cheeks",
    "light skin with a few faint freckles across the nose",
    "fair-to-light skin with a healthy natural glow",
  ],
  hair: [
    "long loose wavy blonde",
    "sleek straight dirty-blonde",
    "shoulder-length soft auburn waves",
    "long glossy light brown with face-framing layers",
    "an effortless messy bun with blonde face-framing strands",
  ],
  eyes: ["blue", "green", "hazel", "light brown"],
};

const ASIAN: LookPack = {
  id: "asian",
  ethnicity:
    "East Asian (clearly Korean, Chinese, or Japanese — NOT mixed-race, NOT racially ambiguous, NOT White-passing)",
  skin: [
    "light warm East Asian skin with a natural glow",
    "fair East Asian skin with a soft peach undertone",
    "light-medium East Asian complexion",
  ],
  hair: [
    "long glossy straight black",
    "sleek shoulder-length straight dark brown",
    "long soft black waves with face-framing pieces",
    "an effortless low bun with dark face-framing strands",
  ],
  eyes: ["dark brown", "warm brown", "dark hazel"],
};

const BLACK: LookPack = {
  id: "black",
  ethnicity:
    "Black American (clearly African American — medium to deep brown skin, NOT mixed-race, NOT light-skinned racially ambiguous)",
  skin: [
    "rich medium-brown skin with a natural glow",
    "deep brown skin with warm undertones",
    "medium-deep brown skin with a healthy sheen",
  ],
  hair: [
    "voluminous natural curly black",
    "long sleek straight black",
    "shoulder-length defined dark curls",
    "a chic short curly cut",
    "long glossy dark twists pulled half-up",
  ],
  eyes: ["dark brown", "warm brown", "deep hazel"],
};

const MIXED: LookPack = {
  id: "mixed",
  ethnicity:
    "mixed-race (clearly biracial — either Black-and-White or East-Asian-and-White, light-to-medium brown or warm olive skin, mixed features that still look like a real pretty woman)",
  skin: [
    "light-medium tan skin with mixed features",
    "warm olive-brown skin",
    "light brown skin with a golden undertone",
  ],
  hair: [
    "long loose wavy dark brown",
    "voluminous curly dark brown",
    "long glossy dark waves",
    "shoulder-length soft coils",
  ],
  eyes: ["hazel", "brown", "green", "dark brown"],
};

// White / Asian / Black are the default mix. Mixed is included but less often
// so the model doesn't collapse everything to racially ambiguous.
const LOOK_POOL: LookPack[] = [
  WHITE,
  WHITE,
  WHITE,
  ASIAN,
  ASIAN,
  ASIAN,
  BLACK,
  BLACK,
  BLACK,
  MIXED,
];

// Variety pools so every run produces a different attractive UGC creator.
// Skewed young (but clearly adult, 21+) and conventionally attractive.
const AGES = ["early 20s", "mid 20s", "21-year-old", "23-year-old", "25-year-old"];
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
  const look = pick(LOOK_POOL);
  const age = pick(AGES);
  const ethnicity = look.ethnicity;
  const skin = pick(look.skin);
  const hair = pick(look.hair);
  const eyes = pick(look.eyes);
  const setting = pick(SETTINGS);
  const timeOfDay = pick(TIMES_OF_DAY);
  const lighting = pick(LIGHTING);
  const clothing = pick(CLOTHING);
  const expression = pick(EXPRESSIONS);

  const ethnicityLock =
    look.id === "mixed"
      ? "Her mixed heritage should be readable in her features, but she still looks like one specific pretty real woman — not a generic AI blend."
      : `Her ethnicity must be unmistakable: she is ${ethnicity}. Do NOT make her mixed-race. Do NOT make her racially ambiguous. Do NOT default to a mixed or ethnically vague face.`;

  return [
    `A vertical 9:16 casual iPhone selfie of a very pretty young ${age} woman who is ${ethnicity},`,
    `with ${skin}, ${hair} hair, and ${eyes} eyes, ${expression}.`,
    ethnicityLock,
    `She is conventionally attractive in a real-life way — even features, full lips, defined brows,`,
    `the kind of pretty girl you'd actually see on a friend's Instagram Story —`,
    `NOT a beauty-pageant glam look, NOT plastic-surgery features, NOT a fashion-campaign model.`,
    `Light natural makeup or clean skin, slightly imperfect hair, real skin with visible texture and pores.`,
    `Chest-up / head-and-shoulders talking-head, looking straight through the front camera lens.`,
    `She is NOT holding a phone. No hands, fingers, wrists, or arms in frame — the camera is invisible.`,
    `Setting: ${setting} during ${timeOfDay}, with ${lighting}. She is wearing ${clothing}.`,
    // Amateur capture quality — this must NOT look like a photoshoot.
    `Amateur older-iPhone front-camera quality (around iPhone 11 / 12): candid uneven framing,`,
    `ordinary imperfect lighting (no studio light, no ring light, no beauty dish),`,
    `slightly soft focus with a touch of sensor grain and mild compression, mildly washed-out colors,`,
    `a plain lived-in everyday background (a bit cluttered is fine, nothing styled or aspirational).`,
    `It should look like a random pretty girl's front-camera video call screenshot,`,
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
  const prompt = (nb.promptOverride.trim() || buildUgcPrompt()) + " " + IMAGE_GUARDS;

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
