import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import type { AppConfig } from "./config.js";
import { ensureDir, timestamp } from "./utils.js";
import { acquireApiSlot } from "./ratelimit.js";
import { log } from "./logger.js";

function getClient(): OpenAI {
  const key = process.env.OPENAI_API_KEY ?? "";
  if (!key) {
    throw new Error(
      "No OpenAI API key found. Set OPENAI_API_KEY in your .env to use the spy " +
        "classifier/transcriber.",
    );
  }
  return new OpenAI({ apiKey: key });
}

export interface AdClassification {
  vertical: string;
  confidence: number;
  angle: string;
}

/** Light input shape for classification (just what the model needs). */
export interface ClassifiableAd {
  key: string;
  text: string;
}

function safeJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Models sometimes wrap JSON in prose/fences — grab the first {...} or [...].
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
 * Classify a batch of ads into a normalized vertical + marketing angle. One
 * chat call handles the whole batch to keep it cheap. Returns a map keyed by
 * ad key; unknown/failed ads simply won't appear in the map.
 */
export async function classifyAds(
  ads: ClassifiableAd[],
  cfg: AppConfig,
): Promise<Map<string, AdClassification>> {
  const result = new Map<string, AdClassification>();
  const usable = ads.filter((a) => a.text.trim().length > 0);
  if (usable.length === 0) return result;

  const client = getClient();
  const batchSize = 20;

  for (let i = 0; i < usable.length; i += batchSize) {
    const batch = usable.slice(i, i + batchSize);
    const payload = batch.map((a) => ({
      key: a.key,
      text: a.text.slice(0, 800),
    }));

    const system =
      "You are a performance-marketing analyst. For each ad, infer the product " +
      "vertical it is selling and the marketing angle/target audience. " +
      "Use short, normalized, lowercase vertical labels that group similar ads " +
      "(e.g. 'bathroom remodel', 'va loans', 'medicare', 'solar', 'weight loss', " +
      "'debt relief', 'auto insurance', 'roofing'). " +
      "Respond ONLY with JSON: " +
      '{"items":[{"key":"...","vertical":"...","angle":"...","confidence":0-1}]}.';

    try {
      await acquireApiSlot("spy: classify ads");
      const resp = await client.chat.completions.create({
        model: cfg.spy.classifierModel,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify({ ads: payload }) },
        ],
      });
      const content = resp.choices[0]?.message?.content ?? "";
      const parsed = safeJson<{
        items?: Array<{
          key: string;
          vertical?: string;
          angle?: string;
          confidence?: number;
        }>;
      }>(content);
      for (const item of parsed?.items ?? []) {
        if (!item.key || !item.vertical) continue;
        result.set(item.key, {
          vertical: item.vertical.trim().toLowerCase(),
          angle: (item.angle ?? "").trim(),
          confidence:
            typeof item.confidence === "number"
              ? Math.min(1, Math.max(0, item.confidence))
              : 0.5,
        });
      }
    } catch (err) {
      log.warn(`Classification batch failed: ${(err as Error).message}`);
    }
  }

  log.ok(`Classified ${result.size}/${usable.length} ad(s) into verticals.`);
  return result;
}

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });
}

/** Extract audio and transcribe it via the OpenAI transcription API. */
export async function transcribeVideo(
  videoPath: string,
  cfg: AppConfig,
): Promise<string> {
  const work = ensureDir("artifacts/spy");
  const audioPath = join(work, `spy_audio_${timestamp()}.mp3`);
  const code = await run("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-b:a",
    "64k",
    audioPath,
  ]);
  if (code !== 0) {
    throw new Error("ffmpeg failed to extract audio for transcription.");
  }

  const client = getClient();
  await acquireApiSlot("spy: transcribe winner");
  const resp = await client.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: cfg.spy.transcribeModel,
  });
  const text = (resp as { text?: string }).text ?? "";
  log.ok(`Transcribed winner (${text.split(/\s+/).length} words).`);
  return text.trim();
}

/**
 * Split a winning ad's transcript into ordered ~7-second spoken segments for a
 * full end-to-end remake. Keeps the same persuasive structure and flow as the
 * original, but rewrites the wording so it's original (not a copy). Returns at
 * most `maxSegments` lines, each one Veo clip.
 */
export async function splitTranscriptIntoSegments(
  transcript: string,
  vertical: string,
  angle: string,
  maxSegments: number,
  cfg: AppConfig,
): Promise<string[]> {
  const client = getClient();
  const system =
    "You restructure a competitor's winning short-form video ad into a sequence " +
    "of spoken segments for a UGC remake. Keep the SAME order, flow, and " +
    "persuasive beats (hook → problem → solution/benefit → proof → CTA), but " +
    "REWRITE the wording so it's original, natural, and spoken. Each segment must " +
    "be deliverable in about 7 seconds (~16-20 words), self-contained, and read " +
    "naturally when played back-to-back. Same vertical and angle. " +
    `Return at most ${maxSegments} segments. ` +
    'Respond ONLY with JSON: {"segments":["...","..."]}.';
  const user = JSON.stringify({
    vertical,
    angle,
    maxSegments,
    transcript: transcript.slice(0, 3000),
  });

  try {
    await acquireApiSlot("spy: split segments");
    const resp = await client.chat.completions.create({
      model: cfg.spy.classifierModel,
      temperature: 0.7,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const content = resp.choices[0]?.message?.content ?? "";
    const parsed = safeJson<{ segments?: string[] }>(content);
    const segments = (parsed?.segments ?? [])
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, maxSegments);
    if (segments.length === 0) throw new Error("model returned no segments");
    return segments;
  } catch (err) {
    log.warn(`Segment split failed (${(err as Error).message}); using sentences.`);
    // Fallback: chunk the transcript into sentence groups.
    const sentences = transcript
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const out: string[] = [];
    let buf = "";
    for (const s of sentences) {
      const next = buf ? `${buf} ${s}` : s;
      if (next.split(/\s+/).length > 20 && buf) {
        out.push(buf);
        buf = s;
      } else {
        buf = next;
      }
      if (out.length >= maxSegments) break;
    }
    if (buf && out.length < maxSegments) out.push(buf);
    return out.length > 0 ? out : [transcript.slice(0, 160)];
  }
}

export interface DraftedHooks {
  /** Spoken hook lines (≈ one Veo clip each). */
  hooks: string[];
  /** Short top-bubble headlines. */
  bubbleHooks: string[];
}

/**
 * From a winning ad's transcript, draft fresh spoken hooks + bubble headlines
 * for the SAME vertical/angle — variations that keep what worked but are not a
 * copy. Returns `count` spoken hooks.
 */
export async function draftHookVariations(
  transcript: string,
  vertical: string,
  angle: string,
  count: number,
  cfg: AppConfig,
): Promise<DraftedHooks> {
  const client = getClient();
  const system =
    "You write high-converting short-form UGC ad hooks (spoken, first 8 seconds). " +
    "Given a competitor's winning ad transcript, write NEW hook variations for the " +
    "same vertical and angle. Keep the psychological pattern that works, but make " +
    "them original (not a copy), natural, and spoken in ~7 seconds each. " +
    "Also write matching short on-screen bubble headlines (max ~8 words, punchy). " +
    'Respond ONLY with JSON: {"hooks":["..."],"bubbleHooks":["..."]}.';

  const user = JSON.stringify({
    vertical,
    angle,
    count,
    winningTranscript: transcript.slice(0, 2000),
  });

  try {
    await acquireApiSlot("spy: draft hooks");
    const resp = await client.chat.completions.create({
      model: cfg.spy.classifierModel,
      temperature: 0.8,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    const content = resp.choices[0]?.message?.content ?? "";
    const parsed = safeJson<DraftedHooks>(content);
    const hooks = (parsed?.hooks ?? [])
      .map((h) => h.trim())
      .filter(Boolean)
      .slice(0, count);
    const bubbleHooks = (parsed?.bubbleHooks ?? [])
      .map((h) => h.trim())
      .filter(Boolean);
    if (hooks.length === 0) throw new Error("model returned no hooks");
    return { hooks, bubbleHooks };
  } catch (err) {
    log.warn(`Hook drafting failed (${(err as Error).message}); using transcript.`);
    // Fallback: use the first sentence of the transcript as a single hook.
    const first = transcript.split(/(?<=[.!?])\s+/)[0]?.trim() || transcript.slice(0, 120);
    return { hooks: [first], bubbleHooks: [] };
  }
}
