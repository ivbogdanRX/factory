import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import OpenAI, { toFile } from "openai";
import { loadConfig, resolvePath, type AppConfig } from "./config.js";
import {
  buildNamedOutputPath,
  ensureDir,
  releaseOutputPath,
  titleSlug,
  formatDuration,
} from "./utils.js";
import { acquireApiSlot } from "./ratelimit.js";
import { runWithLogScope, log, type LogEntry } from "./logger.js";
import type { RunResult, ProgressUpdate } from "./pipeline.js";

export interface ImageAdOptions {
  /** Uploaded winner image paths (relative to project, e.g. downloads/image-winners/x.png). */
  winners: string[];
  /** Target vertical. Blank = use what the study infers from each winner. */
  vertical?: string;
  /** Target marketing angle / audience. Blank = use the study's inference. */
  angle?: string;
  /** How many variations to generate per winner. Defaults to config.imageAds.variationsPerWinner. */
  count?: number;
  /** Variation strategy. Defaults to config.imageAds.mode. */
  mode?: "edit" | "fresh" | "both";
  configPath?: string;
  onLog?: (entry: LogEntry) => void;
  onProgress?: (update: ProgressUpdate) => void;
  shouldStop?: () => boolean;
}

/** What the vision model extracts from an uploaded winner. */
interface AdStudy {
  vertical: string;
  angle: string;
  headline: string;
  subhead: string;
  layout: string;
  palette: string;
  visualElements: string[];
  whyItWorks: string;
}

/** A single planned variation: rewritten copy + a visual direction. */
interface VariationSpec {
  headline: string;
  subhead: string;
  visualDirection: string;
}

function getClient(): OpenAI {
  const key = process.env.OPENAI_API_KEY ?? "";
  if (!key) {
    throw new Error(
      "No OpenAI API key found. Set OPENAI_API_KEY in your .env to generate image ads.",
    );
  }
  return new OpenAI({ apiKey: key });
}

function mimeForExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    default:
      return "image/png";
  }
}

const VERTICAL_STOPWORDS = new Set([
  "and", "the", "for", "with", "from", "free", "new", "program", "programs",
  "ad", "ads", "offer", "offers", "loan", "loans", "a", "an", "of", "to", "your",
]);

/** Reduce a vertical label to its meaningful lowercase tokens. */
function verticalTokens(label: string): Set<string> {
  return new Set(
    label
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !VERTICAL_STOPWORDS.has(t)),
  );
}

/**
 * True when two vertical labels describe roughly the same thing (share at least
 * one meaningful token). Used to decide whether a winner can be safely edited in
 * place or must be regenerated from scratch for a different vertical.
 */
function sameVertical(a: string, b: string): boolean {
  const ta = verticalTokens(a);
  const tb = verticalTokens(b);
  if (ta.size === 0 || tb.size === 0) return true; // not enough signal — assume same
  for (const t of ta) if (tb.has(t)) return true;
  return false;
}

function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    const m = raw.match(/[[{][\s\S]*[\]}]/);
    if (m) {
      try {
        return JSON.parse(m[0]) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Study an uploaded winning static ad with a vision model: infer its vertical
 * and angle, read its on-image copy, and describe what makes it convert.
 */
async function studyImageAd(
  client: OpenAI,
  imagePath: string,
  cfg: AppConfig,
): Promise<AdStudy> {
  const buffer = readFileSync(imagePath);
  const dataUrl = `data:${mimeForExt(extname(imagePath))};base64,${buffer.toString("base64")}`;

  const system =
    "You are a direct-response creative strategist. Study the provided static ad " +
    "image and return a structured breakdown. Read any on-image text exactly. " +
    'Respond ONLY with JSON: {"vertical":"...","angle":"...","headline":"...",' +
    '"subhead":"...","layout":"...","palette":"...","visualElements":["..."],' +
    '"whyItWorks":"..."}.';

  await acquireApiSlot("image-ads: study winner");
  const resp = await client.chat.completions.create({
    model: cfg.imageAds.analysisModel,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: "Study this winning ad." },
          { type: "image_url", image_url: { url: dataUrl } },
        ],
      },
    ],
  });

  const content = resp.choices[0]?.message?.content ?? "";
  const parsed = safeJson<Partial<AdStudy>>(content);
  if (!parsed) throw new Error("Could not study the image (no JSON returned).");
  return {
    vertical: (parsed.vertical ?? "").trim(),
    angle: (parsed.angle ?? "").trim(),
    headline: (parsed.headline ?? "").trim(),
    subhead: (parsed.subhead ?? "").trim(),
    layout: (parsed.layout ?? "").trim(),
    palette: (parsed.palette ?? "").trim(),
    visualElements: Array.isArray(parsed.visualElements)
      ? parsed.visualElements.map((v) => String(v).trim()).filter(Boolean)
      : [],
    whyItWorks: (parsed.whyItWorks ?? "").trim(),
  };
}

/**
 * From a study, draft `count` distinct variation specs (rewritten headline +
 * subhead + a visual direction) for the target vertical/angle. The copy keeps
 * the proven psychology but is original, not a copy of the winner's wording.
 */
async function draftVariations(
  client: OpenAI,
  study: AdStudy,
  vertical: string,
  angle: string,
  count: number,
  cfg: AppConfig,
): Promise<VariationSpec[]> {
  // When retargeting to a different vertical than the winner, the study's copy
  // (headlines, subheads) is about the WRONG subject. Tell the model in no
  // uncertain terms to borrow only the persuasive structure, not the topic.
  const crossVertical = !sameVertical(study.vertical, vertical);
  const retargetRule = crossVertical
    ? `IMPORTANT: The winning ad is about "${study.vertical}", but you are writing ` +
      `for a DIFFERENT product: "${vertical}". Borrow ONLY the persuasive structure ` +
      `and emotional pattern. Every headline, subhead, and visual direction MUST be ` +
      `about ${vertical} for ${angle}. Never mention, imply, or reuse anything from ` +
      `"${study.vertical}" (no bathrooms, showers, renovations, or its wording). `
    : "";

  const system =
    "You write high-converting static ad concepts. Given a study of a winning " +
    "ad, produce DISTINCT variations for the TARGET vertical and angle provided " +
    "(which may differ from the winning ad's original topic). Keep the persuasive " +
    "pattern that works, but rewrite the headline and subhead so they are original " +
    "(not a copy), punchy, compliant, and entirely about the TARGET vertical. Vary " +
    "the visual direction across variations. " +
    retargetRule +
    `Return exactly ${count} variations. ` +
    'Respond ONLY with JSON: {"variations":[{"headline":"...","subhead":"...","visualDirection":"..."}]}.';

  const user = JSON.stringify({
    targetVertical: vertical,
    targetAngle: angle,
    count,
    winningAdStudy: study,
  });

  await acquireApiSlot("image-ads: draft variations");
  const resp = await client.chat.completions.create({
    model: cfg.imageAds.analysisModel,
    temperature: 0.85,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const content = resp.choices[0]?.message?.content ?? "";
  const parsed = safeJson<{ variations?: VariationSpec[] }>(content);
  const specs = (parsed?.variations ?? [])
    .map((v) => ({
      headline: String(v.headline ?? "").trim(),
      subhead: String(v.subhead ?? "").trim(),
      visualDirection: String(v.visualDirection ?? "").trim(),
    }))
    .filter((v) => v.headline || v.visualDirection)
    .slice(0, count);

  if (specs.length === 0) {
    throw new Error("Could not draft any variations from the study.");
  }
  // Backfill by cycling through what we got if the model returned too few.
  const base = specs.length;
  for (let i = base; i < count; i++) specs.push(specs[i % base]!);
  return specs;
}

/**
 * Phrase describing the source ad's subject matter that must NOT bleed into a
 * cross-vertical remix (e.g. "bathroom / walk-in shower" imagery when retargeting
 * to windows). Built from the winner's inferred vertical so it isn't hardcoded.
 */
function forbiddenSubjectClause(study: AdStudy, targetVertical: string): string {
  const source = study.vertical.trim();
  if (!source || sameVertical(source, targetVertical)) return "";
  return (
    `The reference ad is for "${source}". Do NOT include any imagery, props, ` +
    `rooms, or subjects from "${source}" — every visual element must depict ` +
    `${targetVertical} instead.`
  );
}

/** Build the image-generation prompt for one variation. */
function buildPrompt(
  study: AdStudy,
  spec: VariationSpec,
  vertical: string,
  angle: string,
  isEdit: boolean,
): string {
  const parts: string[] = [];
  const forbid = forbiddenSubjectClause(study, vertical);
  if (isEdit) {
    parts.push(
      `Recreate this static ad as a fresh ${vertical} advertisement targeting ` +
        `${angle}. Keep the overall composition, layout, design style, color ` +
        `palette, and graphic structure of the reference, but REPLACE the subject, ` +
        `photo, and scene with imagery relevant to ${vertical} for ${angle}.`,
      forbid,
    );
  } else {
    parts.push(
      `A high-converting static advertisement for ${vertical}, targeting ${angle}.`,
      study.layout ? `Use a similar layout structure: ${study.layout}.` : "",
      study.palette ? `Color palette: ${study.palette}.` : "",
      `All imagery must be relevant to ${vertical} for ${angle}.`,
      forbid,
    );
  }
  parts.push(`Visual direction: ${spec.visualDirection}.`);
  parts.push(
    `Render this headline text prominently and legibly: "${spec.headline}".`,
  );
  if (spec.subhead) {
    parts.push(`Render this supporting subhead text: "${spec.subhead}".`);
  }
  parts.push(
    "Professional ad design, sharp, clean typography, realistic, no spelling errors.",
  );
  return parts.filter(Boolean).join(" ");
}

/** Decode a b64 image and write it to a versioned per-vertical output path. */
function saveImage(b64: string, baseDir: string, label: string): string {
  const outPath = buildNamedOutputPath(baseDir, label, ".png");
  try {
    writeFileSync(outPath, Buffer.from(b64, "base64"));
  } catch (err) {
    releaseOutputPath(outPath);
    throw err;
  }
  return outPath;
}

/**
 * Study uploaded winning static ads and generate fresh image-ad variations for
 * a chosen vertical/angle. Returns the list of generated image paths.
 */
export async function runImageAds(opts: ImageAdOptions): Promise<RunResult> {
  if (opts.onLog) {
    return runWithLogScope(opts.onLog, () => runImageAdsInner(opts));
  }
  return runImageAdsInner(opts);
}

async function runImageAdsInner(opts: ImageAdOptions): Promise<RunResult> {
  const startedAt = Date.now();
  const cfg = loadConfig(opts.configPath);
  const client = getClient();

  const winners = (opts.winners ?? [])
    .map((w) => resolvePath(w.trim()))
    .filter(Boolean);
  if (winners.length === 0) {
    throw new Error("No winner images provided. Upload at least one image.");
  }
  for (const w of winners) {
    if (!existsSync(w)) throw new Error(`Winner image not found: ${w}`);
  }

  const count = Math.max(1, opts.count ?? cfg.imageAds.variationsPerWinner);
  const mode = opts.mode ?? cfg.imageAds.mode;
  const size = cfg.imageAds.size;
  const total = winners.length * count;

  const outputs: string[] = [];
  let done = 0;

  const report = (
    phase: ProgressUpdate["phase"],
    extra: Partial<ProgressUpdate> = {},
  ): void => {
    opts.onProgress?.({
      phase,
      runIndex: done,
      runTotal: total,
      persona: "Image ads",
      ...extra,
    });
  };

  report("image");

  for (let wi = 0; wi < winners.length; wi++) {
    if (opts.shouldStop?.()) {
      log.warn("Stop requested; ending image-ad generation.");
      break;
    }
    const winner = winners[wi]!;
    log.step(`=== Winner ${wi + 1}/${winners.length}: studying ${winner} ===`);

    const study = await studyImageAd(client, winner, cfg);
    const vertical = (opts.vertical?.trim() || study.vertical || "image ad").trim();
    const angle = (opts.angle?.trim() || study.angle || "a relatable consumer angle").trim();
    log.ok(`Studied: vertical "${vertical}", angle "${angle}".`);
    if (study.whyItWorks) log.info(`Why it works: ${study.whyItWorks}`);

    // If the target vertical differs from the winner's inferred vertical, an
    // in-place image edit clones the original subject (e.g. a bathroom) instead
    // of the requested one. Force fresh text-to-image so the subject is rebuilt
    // for the target vertical, while layout/palette from the study still guide it.
    const crossVertical = !sameVertical(study.vertical, vertical);
    if (crossVertical && mode !== "fresh") {
      log.warn(
        `Target vertical "${vertical}" differs from the winner's "${study.vertical}". ` +
          `Generating fresh images (no edit/remix) so the subject matches the target.`,
      );
    }

    const specs = await draftVariations(client, study, vertical, angle, count, cfg);
    log.ok(`Drafted ${specs.length} variation concept(s).`);

    const baseDir = join(cfg.video.outputDir, titleSlug(vertical), "images");

    // Generate one variation. Runs concurrently with others; the shared API
    // rate limiter still paces how fast requests actually start.
    const generateVariation = async (i: number): Promise<void> => {
      if (opts.shouldStop?.()) return;
      const spec = specs[i]!;
      // "both" alternates edit/fresh; otherwise honor the chosen mode. A
      // cross-vertical remix always falls back to fresh so the edit endpoint
      // can't clone the winner's original (off-target) subject matter.
      const isEdit = crossVertical
        ? false
        : mode === "edit"
          ? true
          : mode === "fresh"
            ? false
            : i % 2 === 0;
      const prompt = buildPrompt(study, spec, vertical, angle, isEdit);
      log.step(
        `Variation ${i + 1}/${specs.length} (${isEdit ? "edit/remix" : "fresh"}): ` +
          `"${spec.headline}"`,
      );

      try {
        let b64: string | undefined;
        if (isEdit) {
          await acquireApiSlot("image-ads: edit variation");
          const file = await toFile(readFileSync(winner), `winner${extname(winner)}`, {
            type: mimeForExt(extname(winner)),
          });
          const res = await client.images.edit({
            model: cfg.imageAds.model,
            image: file,
            prompt,
            size,
            n: 1,
          });
          b64 = res.data?.[0]?.b64_json;
        } else {
          await acquireApiSlot("image-ads: generate variation");
          const res = await client.images.generate({
            model: cfg.imageAds.model,
            prompt,
            size,
            quality: cfg.imageAds.quality,
            n: 1,
          });
          b64 = res.data?.[0]?.b64_json;
        }

        if (!b64) {
          log.warn(`Variation ${i + 1} returned no image; skipping.`);
          return;
        }
        const outPath = saveImage(b64, baseDir, vertical);
        outputs.push(outPath);
        done += 1;
        log.ok(`Saved: ${outPath}`);
        report("image", { imagePath: outPath, hook: spec.headline });
      } catch (err) {
        log.warn(`Variation ${i + 1} failed: ${(err as Error).message}`);
      }
    };

    // Bounded worker pool: up to `imageAds.concurrency` variations in flight.
    const poolSize = Math.max(1, Math.min(cfg.imageAds.concurrency, specs.length));
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (opts.shouldStop?.()) {
          log.warn("Stop requested; ending image-ad generation.");
          return;
        }
        const i = next++;
        if (i >= specs.length) return;
        await generateVariation(i);
      }
    };
    await Promise.all(Array.from({ length: poolSize }, () => worker()));
  }

  if (outputs.length === 0) {
    throw new Error("No image ads were generated.");
  }

  report("run-done", { output: outputs[outputs.length - 1], imagePath: outputs[outputs.length - 1] });
  log.ok(
    `Image ads done in ${formatDuration(Date.now() - startedAt)}: ` +
      `${outputs.length}/${total} image(s).`,
  );
  return { outputs, elapsedMs: Date.now() - startedAt };
}
