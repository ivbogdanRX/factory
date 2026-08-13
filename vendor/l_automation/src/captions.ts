import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import type { AppConfig, CaptionsConfig } from "./config.js";
import { probe } from "./video.js";
import { ensureDir, timestamp } from "./utils.js";
import {
  bubbleFontSizeForText,
  bubbleMarginLR,
  bubblePaddingForFont,
  formatBubbleHeadline,
} from "./hook-bubble.js";
import { log } from "./logger.js";

export interface TimedWord {
  text: string;
  start: number; // seconds
  end: number; // seconds
}

interface CaptionWord {
  text: string;
  start: number;
  end: number;
}

type CaptionGroup = CaptionWord[];

function run(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

async function ffmpegBinary(): Promise<string> {
  const candidates = [
    process.env.FFMPEG_PATH,
    "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg",
    "/usr/local/opt/ffmpeg-full/bin/ffmpeg",
    "ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
  ].filter((v): v is string => Boolean(v));

  for (const bin of candidates) {
    try {
      const { code, stdout } = await run(bin, ["-hide_banner", "-filters"]);
      if (code === 0 && /\bass\b/.test(stdout)) return bin;
    } catch {
      // try next
    }
  }
  return "ffmpeg";
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    const { code } = await run("which", [cmd]);
    return code === 0;
  } catch {
    return false;
  }
}

/** Pull the quoted text after "Dialogue:" out of the prompt. */
export function extractDialogue(prompt: string): string {
  const m = prompt.match(/Dialogue:\s*[‘'"“]([\s\S]*?)[’'"”]/i);
  if (m && m[1]) return m[1].trim();
  return "";
}

/** Split caption text into display tokens (words, punctuation attached). */
function tokenize(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

function normalizeWord(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Transcribe with faster-whisper (Python) for accurate cross-attention word
 * timestamps. Returns null if the venv/script isn't available.
 */
async function fasterWhisperWordTimes(
  audioPath: string,
  cfg: CaptionsConfig,
): Promise<TimedWord[] | null> {
  const py = cfg.fasterWhisperPython;
  if (!existsSync(py)) {
    return null;
  }
  const script = join("scripts", "transcribe_fw.py");
  if (!existsSync(script)) return null;

  const { code, stdout, stderr } = await run(py, [
    script,
    audioPath,
    cfg.fasterWhisperModel,
  ]);
  if (code !== 0) {
    log.warn(`faster-whisper failed (${code}); trying fallback.\n${stderr}`);
    return null;
  }
  try {
    const parsed = JSON.parse(stdout.trim()) as Array<{
      text: string;
      start: number;
      end: number;
    }>;
    return parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Transcribe audio with whisper.cpp to get per-word timestamps. Returns null if
 * Whisper isn't available so the caller can fall back to even timing.
 */
async function whisperWordTimes(
  audioPath: string,
  cfg: CaptionsConfig,
): Promise<TimedWord[] | null> {
  if (!cfg.whisperModel || !existsSync(cfg.whisperModel)) {
    log.warn(
      "No whisper model configured (captions.whisperModel) — falling back to " +
        "even caption timing.",
    );
    return null;
  }
  if (!(await commandExists(cfg.whisperBinary))) {
    log.warn(
      `whisper binary "${cfg.whisperBinary}" not found on PATH — falling back ` +
        "to even caption timing.",
    );
    return null;
  }

  const outPrefix = audioPath.replace(/\.[^.]+$/, "");
  // -ml 1 + -sow yields one segment per word (with timestamps); -oj writes JSON.
  const { code, stderr } = await run(cfg.whisperBinary, [
    "-m",
    cfg.whisperModel,
    "-f",
    audioPath,
    "-oj",
    "-of",
    outPrefix,
    "-ml",
    "1",
    "-sow",
    "-nt",
  ]);
  const jsonPath = `${outPrefix}.json`;
  if (code !== 0 || !existsSync(jsonPath)) {
    log.warn(`Whisper failed (${code}); falling back to even timing.\n${stderr}`);
    return null;
  }

  try {
    const data = JSON.parse(readFileSync(jsonPath, "utf8")) as {
      transcription?: Array<{
        offsets?: { from?: number; to?: number };
        text?: string;
      }>;
    };
    const words: TimedWord[] = [];
    for (const seg of data.transcription ?? []) {
      const text = (seg.text ?? "").trim();
      if (!text) continue;
      words.push({
        text,
        start: (seg.offsets?.from ?? 0) / 1000,
        end: (seg.offsets?.to ?? 0) / 1000,
      });
    }
    return words.length > 0 ? words : null;
  } catch (err) {
    log.warn(`Could not parse Whisper JSON: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Get per-word timings from the best available engine, honoring the configured
 * preference ("auto" tries faster-whisper then whisper.cpp). Returns null when
 * no engine is available.
 */
async function transcribeWords(
  audioPath: string,
  cfg: CaptionsConfig,
): Promise<{ words: TimedWord[] | null; used: string }> {
  const engine = cfg.timingEngine;
  let whisper: TimedWord[] | null = null;
  let used = "even";
  if (engine === "auto" || engine === "faster-whisper") {
    whisper = await fasterWhisperWordTimes(audioPath, cfg);
    if (whisper) used = "faster-whisper";
  }
  if (!whisper && (engine === "auto" || engine === "whisper.cpp")) {
    whisper = await whisperWordTimes(audioPath, cfg);
    if (whisper) used = "whisper.cpp";
  }
  return { words: whisper, used };
}

/**
 * Transcribe a finished video to per-word timestamps (preferring the most
 * accurate engine available). Used by the overlay planner to place B-roll on the
 * exact words it relates to. Returns null when no transcription engine is
 * available.
 */
export async function getWordTimings(
  videoPath: string,
  cfg: AppConfig,
): Promise<TimedWord[] | null> {
  const work = ensureDir("artifacts/captions");
  const audioPath = join(work, `words_${timestamp()}.wav`);
  await run("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    audioPath,
  ]);
  const { words } = await transcribeWords(audioPath, cfg.captions);
  return words;
}

/** Find leading/trailing speech bounds via ffmpeg silencedetect (fallback). */
async function silenceBounds(
  clipPath: string,
  durationSec: number,
  noiseDb = -30,
  minSilenceSec = 0.3,
): Promise<{ start: number; end: number } | null> {
  let stderr = "";
  try {
    ({ stderr } = await run("ffmpeg", [
      "-hide_banner",
      "-i",
      clipPath,
      "-af",
      `silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`,
      "-f",
      "null",
      "-",
    ]));
  } catch {
    return null;
  }
  const intervals: Array<{ s: number; e: number }> = [];
  let pendingStart: number | null = null;
  for (const line of stderr.split("\n")) {
    const ms = line.match(/silence_start:\s*([\d.]+)/);
    if (ms) {
      pendingStart = Number(ms[1]);
      continue;
    }
    const me = line.match(/silence_end:\s*([\d.]+)/);
    if (me) {
      const e = Number(me[1]);
      intervals.push({ s: pendingStart ?? 0, e });
      pendingStart = null;
    }
  }
  // A silence that runs to EOF prints only silence_start.
  if (pendingStart !== null) intervals.push({ s: pendingStart, e: durationSec });
  if (intervals.length === 0) return null;

  let start = 0;
  let end = durationSec;
  const first = intervals[0]!;
  if (first.s <= 0.1) start = first.e;
  const last = intervals[intervals.length - 1]!;
  if (last.e >= durationSec - 0.1) end = last.s;
  return { start, end };
}

/** Re-encode a [start, start+len] slice of a clip to its own file. */
async function cutSlice(
  input: string,
  start: number,
  len: number,
  out: string,
): Promise<boolean> {
  const { code, stderr } = await run("ffmpeg", [
    "-y",
    "-i",
    input,
    "-ss",
    start.toFixed(3),
    "-t",
    len.toFixed(3),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
    "-ac",
    "2",
    out,
  ]);
  if (code !== 0) {
    log.warn(`Slice failed (${start.toFixed(2)}s +${len.toFixed(2)}s):\n${stderr}`);
    return false;
  }
  return true;
}

/**
 * Remove dead air from a clip so short/paused spoken lines don't leave seconds
 * of silence. Trims leading/trailing silence AND compresses long mid-line pauses
 * (jump-cut style, natural for UGC). Uses whisper word timings when available
 * (robust against background ambience), falling back to leading/trailing trim
 * via silence detection. Returns the original path when there's nothing to cut.
 */
export async function tightenSilence(
  clipPath: string,
  cfg: AppConfig,
  opts: { leadPad?: number; tailPad?: number; maxGap?: number } = {},
): Promise<string> {
  // Leave breathing room so word edges aren't clipped. The tail is padded
  // generously because whisper often ends words early and clips trailing
  // consonants (e.g. the "s" in "fees"/"penalties"); we're cutting into known
  // dead air anyway, so a longer tail is nearly free.
  const leadPad = opts.leadPad ?? 0.15;
  const tailPad = opts.tailPad ?? 0.4;
  // Pauses longer than this (seconds) between words get compressed away.
  const maxGap = opts.maxGap ?? 0.34;
  const info = await probe(clipPath);
  if (!info.hasAudio || info.durationSec <= 0.5) return clipPath;

  const work = ensureDir("artifacts/captions");
  const audioPath = join(work, `tighten_${timestamp()}.wav`);
  await run("ffmpeg", [
    "-y",
    "-i",
    clipPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    audioPath,
  ]);

  const ext = extname(clipPath) || ".mp4";
  const dur = info.durationSec;

  // Build keep windows ("phrases"). Adjacent words with a small gap stay in one
  // window; a gap over maxGap closes the window and opens a new one — the dead
  // air in between is dropped.
  let windows: Array<{ start: number; end: number }> = [];
  const { words } = await transcribeWords(audioPath, cfg.captions);
  if (words && words.length > 0) {
    const sorted = [...words].sort((a, b) => a.start - b.start);
    let segStart = sorted[0]!.start;
    let prevEnd = sorted[0]!.end;
    for (let i = 1; i < sorted.length; i++) {
      const w = sorted[i]!;
      if (w.start - prevEnd > maxGap) {
        windows.push({ start: segStart, end: prevEnd });
        segStart = w.start;
      }
      prevEnd = Math.max(prevEnd, w.end);
    }
    windows.push({ start: segStart, end: prevEnd });
    // Pad each window and clamp to the clip.
    windows = windows.map((w) => ({
      start: Math.max(0, w.start - leadPad),
      end: Math.min(dur, w.end + tailPad),
    }));
  } else {
    const b = await silenceBounds(clipPath, dur);
    if (!b) return clipPath;
    windows = [
      { start: Math.max(0, b.start - leadPad), end: Math.min(dur, b.end + tailPad) },
    ];
  }

  // Merge windows that now overlap or nearly touch after padding.
  windows.sort((a, b) => a.start - b.start);
  const merged: Array<{ start: number; end: number }> = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.start - last.end <= 0.05) last.end = Math.max(last.end, w.end);
    else if (w.end - w.start > 0.05) merged.push({ ...w });
  }
  if (merged.length === 0) return clipPath;

  const kept = merged.reduce((s, w) => s + (w.end - w.start), 0);
  // Nothing meaningful to remove — leave the clip untouched.
  if (dur - kept < 0.25) return clipPath;

  const stamp = timestamp();
  const parts: string[] = [];
  for (let i = 0; i < merged.length; i++) {
    const w = merged[i]!;
    const len = w.end - w.start;
    if (len < 0.1) continue;
    const part = join(work, `phrase_${stamp}_${i}${ext}`);
    if (await cutSlice(clipPath, w.start, len, part)) parts.push(part);
  }
  if (parts.length === 0) return clipPath;

  const out = join(dirname(clipPath), `${basename(clipPath, ext)}_tight${ext}`);
  if (parts.length === 1) {
    // Single phrase: just move/copy it to the output name via a stream copy.
    const { code } = await run("ffmpeg", ["-y", "-i", parts[0]!, "-c", "copy", out]);
    if (code !== 0) return parts[0]!;
  } else {
    const inputs: string[] = [];
    for (const p of parts) inputs.push("-i", p);
    const streams = parts.map((_, i) => `[${i}:v][${i}:a]`).join("");
    const filter = `${streams}concat=n=${parts.length}:v=1:a=1[v][a]`;
    const { code, stderr } = await run("ffmpeg", [
      "-y",
      ...inputs,
      "-filter_complex",
      filter,
      "-map",
      "[v]",
      "-map",
      "[a]",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      out,
    ]);
    if (code !== 0) {
      log.warn(`Silence compaction failed; using untrimmed clip.\n${stderr}`);
      return clipPath;
    }
  }

  log.ok(
    `Tightened clip: cut ${(dur - kept).toFixed(2)}s of dead air across ` +
      `${merged.length} phrase(s) (${dur.toFixed(2)}s -> ~${kept.toFixed(2)}s).`,
  );
  return out;
}

/**
 * Needleman-Wunsch alignment of script tokens to whisper words, transferring
 * timestamps onto each script token (null where unmatched). This keeps the
 * EXACT script words while borrowing Whisper's timing.
 */
function alignTimes(
  scriptTokens: string[],
  whisper: TimedWord[],
): (TimedWord | null)[] {
  const a = scriptTokens.map(normalizeWord);
  const b = whisper.map((w) => normalizeWord(w.text));
  const n = a.length;
  const m = b.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  const bt: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = 1; i <= n; i++) {
    dp[i]![0] = i;
    bt[i]![0] = 1; // up = consume script token
  }
  for (let j = 1; j <= m; j++) {
    dp[0]![j] = j;
    bt[0]![j] = 2; // left = consume whisper word
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const diag = dp[i - 1]![j - 1]! + cost;
      const up = dp[i - 1]![j]! + 1;
      const left = dp[i]![j - 1]! + 1;
      let best = diag;
      let dir = 0;
      if (up < best) {
        best = up;
        dir = 1;
      }
      if (left < best) {
        best = left;
        dir = 2;
      }
      dp[i]![j] = best;
      bt[i]![j] = dir;
    }
  }

  const times: (TimedWord | null)[] = new Array(n).fill(null);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const dir = i === 0 ? 2 : j === 0 ? 1 : bt[i]![j]!;
    if (dir === 0) {
      times[i - 1] = whisper[j - 1] ?? null;
      i--;
      j--;
    } else if (dir === 1) {
      i--;
    } else {
      j--;
    }
  }
  return times;
}

/**
 * Drop degenerate word timings before alignment. whisper.cpp's word heuristic
 * fails on fast speech: it stacks every word it can't place as a zero-length
 * event at the end of the audio window (and the final word can "end" at the
 * 30s window edge, far past the clip). Those poisoned anchors used to freeze
 * the captions and then dump the rest of the line in one flash — filtering
 * them lets alignment interpolate over trustworthy anchors instead.
 */
function sanitizeWordTimes(
  words: TimedWord[] | null,
  durationSec: number,
): TimedWord[] | null {
  if (!words) return null;
  const cleaned = words
    .filter((w) => w.end - w.start > 0.02 && w.start < durationSec - 0.05)
    .map((w) => ({ ...w, end: Math.min(w.end, durationSec) }));
  if (cleaned.length === 0) return null;
  if (cleaned.length < words.length) {
    log.warn(
      `Dropped ${words.length - cleaned.length} unreliable word timestamp(s) ` +
        "(zero-length or past the clip); interpolating those words instead.",
    );
  }
  return cleaned;
}

/** Fill null timings by interpolating between known neighbors. */
function fillGaps(
  times: (TimedWord | null)[],
  totalDuration: number,
): { start: number; end: number }[] {
  const n = times.length;
  const out: { start: number; end: number }[] = new Array(n);

  // Indices that have a known time.
  const known = times
    .map((t, idx) => (t ? idx : -1))
    .filter((idx) => idx >= 0);

  if (known.length === 0) {
    // No alignment at all: distribute evenly across the whole clip.
    const slice = totalDuration / Math.max(n, 1);
    for (let k = 0; k < n; k++) {
      out[k] = { start: k * slice, end: (k + 1) * slice };
    }
    return out;
  }

  for (let k = 0; k < n; k++) {
    const t = times[k];
    if (t) {
      out[k] = { start: t.start, end: t.end };
      continue;
    }
    // Find previous and next known indices.
    let prev = -1;
    let next = -1;
    for (let p = k - 1; p >= 0; p--) {
      if (times[p]) {
        prev = p;
        break;
      }
    }
    for (let q = k + 1; q < n; q++) {
      if (times[q]) {
        next = q;
        break;
      }
    }
    if (prev >= 0 && next >= 0) {
      const a = times[prev]!.end;
      const b = times[next]!.start;
      const span = (b - a) / (next - prev);
      const off = k - prev;
      out[k] = { start: a + span * (off - 1), end: a + span * off };
    } else if (prev >= 0) {
      // Trailing run with no anchor after it: spread the remaining words
      // evenly to the end of the clip instead of stacking them on the anchor.
      const a = times[prev]!.end;
      const span = Math.max(0.05, (totalDuration - a) / (n - 1 - prev));
      const off = k - prev;
      out[k] = {
        start: Math.min(a + span * (off - 1), totalDuration - 0.05),
        end: Math.min(a + span * off, totalDuration),
      };
    } else {
      // Leading run with no anchor before it: spread evenly from the start.
      const b = times[next]!.start;
      const span = Math.max(0.05, b / next);
      out[k] = { start: span * k, end: Math.min(span * (k + 1), b) };
    }
  }
  return out;
}

function groupWords(words: CaptionWord[], perGroup: number): CaptionGroup[] {
  const groups: CaptionGroup[] = [];
  for (let i = 0; i < words.length; i += perGroup) {
    groups.push(words.slice(i, i + perGroup));
  }
  return groups;
}

/** Full ASS color with alpha, e.g. for the style line: &HAABBGGRR. */
function hexToAss(hex: string): string {
  const h = hex.replace("#", "").trim();
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

/** Inline color override value, e.g. for {\1c&HBBGGRR&}. */
function hexToAssInline(hex: string): string {
  const h = hex.replace("#", "").trim();
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return `&H${b}${g}${r}&`.toUpperCase();
}

/**
 * Rough advance-width of a char as a fraction of font size. Calibrated against
 * actual ASS renders of the configured heavy sans (measured, not font metrics).
 */
function estCharWidth(ch: string): number {
  if (ch === " ") return 0.2;
  if (/[.,!'’\-|:;]/.test(ch)) return 0.21;
  if (/[iIjl]/.test(ch)) return 0.24;
  if (/[1frt]/.test(ch)) return 0.32;
  if (/[MWmw@]/.test(ch)) return 0.63;
  if (/[a-z]/.test(ch)) return 0.41;
  return 0.48;
}

/**
 * One rounded rectangle behind the whole (possibly multi-line) hook headline,
 * as an ASS vector-drawing event plus a \pos override for the text so it stays
 * centered inside the card. Avoids BorderStyle 3's per-line stair-step boxes.
 */
function buildHookCard(
  formatted: string,
  fontSize: number,
  width: number,
  topY: number,
  fillColor: string,
): { rectEvent: string; textOverride: string } {
  const lines = formatted.split("\\N");
  const lineH = Math.round(fontSize * 1.2);
  const padX = Math.round(fontSize * 0.8);
  const padY = Math.round(fontSize * 0.5);
  const textW = Math.max(
    ...lines.map((line) => [...line].reduce((sum, ch) => sum + estCharWidth(ch), 0) * fontSize),
  );
  const w = Math.round(textW + padX * 2);
  const h = Math.round(lines.length * lineH + padY * 2);
  const r = Math.round(fontSize * 0.4);
  const x0 = Math.round((width - w) / 2);
  const fill = hexToAssInline(fillColor);
  const path =
    `m ${r} 0 l ${w - r} 0 b ${w} 0 ${w} 0 ${w} ${r} ` +
    `l ${w} ${h - r} b ${w} ${h} ${w} ${h} ${w - r} ${h} ` +
    `l ${r} ${h} b 0 ${h} 0 ${h} 0 ${h - r} ` +
    `l 0 ${r} b 0 0 0 0 ${r} 0`;
  // 50% translucent fill: keep the shadow small and mostly transparent so it
  // doesn't muddy the card where it shows through the fill.
  const shad = Math.max(2, Math.round(fontSize * 0.05));
  return {
    rectEvent:
      `{\\an7\\pos(${x0},${topY})\\p1\\bord0\\blur2` +
      `\\c${fill}\\1a&H80&\\shad${shad}\\4c&H000000&\\4a&HC8&}${path}{\\p0}`,
    // an5 = middle-center: the text block is vertically centered in the card.
    // q2 = never auto-wrap; the headline is already broken into balanced lines.
    textOverride: `{\\an5\\q2\\pos(${Math.round(width / 2)},${topY + Math.round(h / 2)})}`,
  };
}

function assTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const cs = Math.floor((secs - Math.floor(secs)) * 100);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${h}:${pad(m)}:${pad(Math.floor(secs))}.${pad(cs)}`;
}

interface Layout3x4 {
  contentHeight: number;
  padTop: number;
  padBottom: number;
}

/** Centered 3:4 safe rectangle inside a taller 9:16 canvas (video stays full frame). */
function compute3x4Zone(width: number, height: number): Layout3x4 {
  const contentHeight = Math.min(height, Math.round((width * 4) / 3));
  const padTop = Math.max(0, Math.round((height - contentHeight) / 2));
  return { contentHeight, padTop, padBottom: height - contentHeight - padTop };
}

function resolveHookBubblePlacement(
  width: number,
  height: number,
  cfg: CaptionsConfig,
): { alignment: number; marginV: number; marginLR: number } {
  const marginLR = bubbleMarginLR(width);
  if (cfg.layout === "3:4") {
    const { contentHeight, padTop } = compute3x4Zone(width, height);
    // Top inside the 3:4 zone — not in the extra 9:16 headroom above it.
    // Enough clearance that the bubble's padded box survives a 4:5 feed crop.
    return {
      alignment: 8,
      marginV: Math.round(padTop + contentHeight * 0.07),
      marginLR,
    };
  }
  return {
    alignment: 8,
    marginV:
      cfg.verticalPosition > 0
        ? Math.round(height * cfg.verticalPosition)
        : Math.round(height * 0.05),
    marginLR,
  };
}

function resolveCaptionPlacement(
  width: number,
  height: number,
  cfg: CaptionsConfig,
): { alignment: number; marginV: number; marginLR: number } {
  const marginLR = Math.round(width * 0.08);

  if (cfg.layout === "3:4") {
    const { contentHeight, padBottom } = compute3x4Zone(width, height);
    // Raised placement: caption block sits in the ~60-75% vertical band of the
    // full frame, clear of feed-crop player chrome (progress bar/volume live in
    // the bottom ~15-20%) and below the speaker's face in the center.
    return {
      alignment: 2,
      marginV: Math.round(padBottom + contentHeight * 0.19),
      marginLR,
    };
  }

  if (cfg.position === "top") {
    return {
      alignment: 8,
      marginV:
        cfg.verticalPosition > 0
          ? Math.round(height * cfg.verticalPosition)
          : Math.round(height * 0.06),
      marginLR,
    };
  }

  if (cfg.verticalPosition > 0) {
    // Clamp so explicit placements never drop into the bottom ~25% where
    // FB/IG player chrome overlaps the video.
    return {
      alignment: 2,
      marginV: Math.round(height * Math.max(1 - cfg.verticalPosition, 0.25)),
      marginLR,
    };
  }

  if (cfg.position === "bottom") {
    return { alignment: 2, marginV: Math.round(height * 0.25), marginLR };
  }

  return { alignment: 5, marginV: 0, marginLR };
}

function buildAss(
  groups: CaptionGroup[],
  width: number,
  height: number,
  cfg: CaptionsConfig,
  durationSec: number,
  hookText: string,
): string {
  const hook = cfg.hookBubble;
  const useHookBubble = hook.enabled && hookText.trim().length > 0;

  // Timed captions: outlined text (never bubble when hook bubble is on).
  const captionFontSize =
    cfg.fontSize > 0 ? cfg.fontSize : Math.round(height * 0.04);
  const captionIsBubble = cfg.style === "bubble" && !useHookBubble;
  const captionPrimary = hexToAss(
    captionIsBubble ? cfg.bubbleTextColor : cfg.primaryColor,
  );
  const captionOutline = hexToAss(
    captionIsBubble ? cfg.bubbleColor : cfg.outlineColor,
  );
  // For outlined captions BackColour is the drop-shadow color — a
  // semi-transparent black keeps the shadow soft (it used to inherit the white
  // bubble color, which made the shadow invisible).
  const captionBack = captionIsBubble ? hexToAss(cfg.bubbleColor) : "&H60000000";
  const hlInline = hexToAssInline(cfg.highlightColor);
  const primaryInline = hexToAssInline(
    captionIsBubble ? cfg.bubbleTextColor : cfg.primaryColor,
  );
  const captionPlace = resolveCaptionPlacement(width, height, cfg);
  const captionBorderStyle = captionIsBubble ? 3 : 1;
  // Outline scales with the font so bigger text keeps the heavy short-form
  // look; a real shadow underneath adds separation from busy footage.
  const captionOutlineWidth = captionIsBubble
    ? cfg.bubblePadding > 0
      ? cfg.bubblePadding
      : Math.max(8, Math.round(captionFontSize * 0.4))
    : Math.max(cfg.outlineWidth, Math.round(captionFontSize * 0.11));
  const captionShadow = captionIsBubble
    ? 0
    : Math.max(2, Math.round(captionFontSize * 0.07));

  const hookIsShadow = hook.style === "shadow";
  const hookIsCard = hook.style === "card";
  const hookFontSize = bubbleFontSizeForText(
    height,
    formatBubbleHeadline(hookText),
  );
  // Shadow style keeps the author's original casing; box style follows upperCase.
  const hookSource = hookIsShadow
    ? hookText
    : cfg.upperCase
      ? hookText.toUpperCase()
      : hookText;
  const formattedHook = formatBubbleHeadline(hookSource);
  const hookPlace = resolveHookBubblePlacement(width, height, cfg);
  const hookBold = hook.bold ? -1 : 0;
  const hookMarginLR = bubbleMarginLR(width);

  // Box style (default): dark text on an opaque colored box (BorderStyle 3).
  // Card style: dark text over ONE rounded rectangle drawn behind the whole
  // headline (avoids the per-line stair-step boxes of BorderStyle 3).
  // Shadow style: white text with a soft blurred dark shadow, no box
  // (BorderStyle 1 + a `\blur` applied to the event for soft edges).
  const hookPrimary = hexToAss(hookIsShadow ? "#FFFFFF" : hook.textColor);
  const hookOutline = hexToAss(hookIsShadow ? "#000000" : hook.bubbleColor);
  // Box style: BackColour is the drop-shadow color — a soft transparent black
  // lifts the bubble off the footage without losing the native UGC look.
  const hookBack = hookIsShadow ? hexToAss("#000000") : "&H78000000";
  const hookBorderStyle = hookIsShadow || hookIsCard ? 1 : 3;
  const hookOutlineWidth = hookIsShadow
    ? Math.max(2, Math.round(hookFontSize * 0.07))
    : hookIsCard
      ? 0
      : bubblePaddingForFont(hookFontSize, hook.bubblePadding);
  const hookShadow = hookIsShadow
    ? Math.max(2, Math.round(hookFontSize * 0.08))
    : hookIsCard
      ? 0
      : Math.max(2, Math.round(hookFontSize * 0.07));
  const hookBlur = hookIsShadow ? Math.max(3, Math.round(hookFontSize * 0.12)) : 0;

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Captions,${cfg.fontName},${captionFontSize},${captionPrimary},&H000000FF,${captionOutline},${captionBack},-1,0,0,0,100,100,0,0,${captionBorderStyle},${captionOutlineWidth},${captionShadow},${captionPlace.alignment},${captionPlace.marginLR},${captionPlace.marginLR},${captionPlace.marginV},1`,
  ];

  if (useHookBubble) {
    header.push(
      `Style: HookBubble,${cfg.fontName},${hookFontSize},${hookPrimary},&H000000FF,${hookOutline},${hookBack},${hookBold},0,0,0,100,100,0,0,${hookBorderStyle},${hookOutlineWidth},${hookShadow},${hookPlace.alignment},${hookMarginLR},${hookMarginLR},${hookPlace.marginV},1`,
    );
  }

  header.push(
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  );

  const disp = (w: string) =>
    (cfg.upperCase ? w.toUpperCase() : w).replace(/\n/g, " ");

  const events: string[] = [];

  if (useHookBubble) {
    if (hookIsCard) {
      const card = buildHookCard(formattedHook, hookFontSize, width, hookPlace.marginV, hook.bubbleColor);
      events.push(
        `Dialogue: 0,${assTime(0)},${assTime(durationSec)},HookBubble,,0,0,0,,${card.rectEvent}`,
        `Dialogue: 1,${assTime(0)},${assTime(durationSec)},HookBubble,,0,0,0,,${card.textOverride}${formattedHook}`,
      );
    } else {
      const hookPrefix = hookBlur > 0 ? `{\\blur${hookBlur}}` : "";
      events.push(
        `Dialogue: 0,${assTime(0)},${assTime(durationSec)},HookBubble,,0,0,0,,${hookPrefix}${formattedHook}`,
      );
    }
  }

  for (const group of groups) {
    if (group.length === 0) continue;
    const groupEnd = group[group.length - 1]!.end;

    if (!cfg.highlightCurrentWord) {
      const text = group.map((w) => disp(w.text)).join(" ");
      events.push(
        `Dialogue: 0,${assTime(group[0]!.start)},${assTime(groupEnd)},Captions,,0,0,0,,${text}`,
      );
      continue;
    }

    for (let j = 0; j < group.length; j++) {
      const start = group[j]!.start;
      const end = j < group.length - 1 ? group[j + 1]!.start : groupEnd;
      const safeEnd = Math.max(end, start + 0.05);
      const text = group
        .map((w, idx) =>
          idx === j
            ? `{\\1c${hlInline}}${disp(w.text)}{\\1c${primaryInline}}`
            : disp(w.text),
        )
        .join(" ");
      events.push(
        `Dialogue: 0,${assTime(start)},${assTime(safeEnd)},Captions,,0,0,0,,${text}`,
      );
    }
  }

  return `${header.join("\n")}\n${events.join("\n")}\n`;
}

/**
 * Burn UGC-style captions onto a clip. The displayed words are the exact known
 * dialogue; Whisper (if available) supplies the timing, otherwise timing is
 * evenly distributed. Returns the path to the captioned clip.
 */
export async function addCaptions(
  clipPath: string,
  cfg: AppConfig,
): Promise<string> {
  const text = (cfg.captions.dialogue || extractDialogue(cfg.flow.prompt)).trim();
  if (!text) {
    log.warn(
      "Captions enabled but no dialogue found (no captions.dialogue and no " +
        "Dialogue: '...' in the prompt). Skipping captions.",
    );
    return clipPath;
  }

  const info = await probe(clipPath);
  const tokens = tokenize(text);
  const work = ensureDir("artifacts/captions");

  // 1) Extract audio for transcription.
  const audioPath = join(work, `audio_${timestamp()}.wav`);
  await run("ffmpeg", [
    "-y",
    "-i",
    clipPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    audioPath,
  ]);

  // 2) Get word timings, preferring the most accurate available engine, then
  //    align them onto the EXACT script tokens.
  const { words: rawWhisper, used } = await transcribeWords(audioPath, cfg.captions);
  const whisper = sanitizeWordTimes(rawWhisper, info.durationSec);

  const perToken = whisper
    ? fillGaps(alignTimes(tokens, whisper), info.durationSec)
    : fillGaps(new Array(tokens.length).fill(null), info.durationSec);

  // Apply optional global nudge, then clamp everything inside the clip.
  const off = cfg.captions.timingOffsetSec;
  for (const p of perToken) {
    p.start = Math.max(0, Math.min(p.start + off, info.durationSec - 0.05));
    p.end = Math.max(p.start + 0.05, Math.min(p.end + off, info.durationSec));
  }

  log.ok(
    whisper
      ? `Timing via ${used}: ${whisper.length} words.`
      : "Timing: even distribution (no transcription engine available).",
  );

  // 3) Build per-word groups carrying timing.
  const words: CaptionWord[] = tokens.map((t, idx) => ({
    text: t,
    start: perToken[idx]?.start ?? 0,
    end: perToken[idx]?.end ?? info.durationSec,
  }));
  const groups = groupWords(words, Math.max(1, cfg.captions.wordsPerGroup));

  const hookText = (
    cfg.captions.hookBubble.text.trim() || text
  ).trim();

  // 4) Write ASS and burn it in (optionally letterbox to 3:4 first).
  const assPath = join(work, `subs_${timestamp()}.ass`);
  writeFileSync(
    assPath,
    buildAss(groups, info.width, info.height, cfg.captions, info.durationSec, hookText),
  );

  const ext = extname(clipPath) || ".mp4";
  const outPath = join(
    dirname(clipPath),
    `${basename(clipPath, ext)}_captioned${ext}`,
  );

  log.step("Burning captions onto the generated clip...");
  // ffmpeg 8 requires named filter options (filename= / fontsdir=). Quote
  // paths so colons in timestamps don't split the option list.
  const assArg = assPath.replace(/\\/g, "/").replace(/'/g, "\\'");
  const fontsDir = "fonts";
  const assFilter = existsSync(fontsDir)
    ? `ass=filename='${assArg}':fontsdir='${fontsDir}'`
    : `ass=filename='${assArg}'`;
  if (cfg.captions.layout === "3:4") {
    log.info(
      "Text placement: 3:4 safe zone on full 9:16 frame (hook top / captions bottom inside zone).",
    );
  }
  const ffmpeg = await ffmpegBinary();
  const { code, stderr } = await run(ffmpeg, [
    "-y",
    "-i",
    clipPath,
    "-vf",
    assFilter,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-c:a",
    "copy",
    outPath,
  ]);
  if (code !== 0) {
    throw new Error(`Caption burn-in failed:\n${stderr}`);
  }

  log.ok(`Captioned clip: ${outPath}`);
  return outPath;
}
