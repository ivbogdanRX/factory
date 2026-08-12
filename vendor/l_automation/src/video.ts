import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, timestamp } from "./utils.js";
import { log } from "./logger.js";

const WORK_DIR = "artifacts/video";

interface ProbeInfo {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

interface CropSpec {
  width: number;
  height: number;
  x: number;
  y: number;
}

function run(
  cmd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with ${code}:\n${stderr}`));
    });
  });
}

function parseFps(rate: string | undefined): number {
  if (!rate) return 30;
  const [n, d] = rate.split("/").map(Number);
  if (!n || !d) return 30;
  return n / d;
}

export async function probe(file: string): Promise<ProbeInfo> {
  if (!existsSync(file)) throw new Error(`Video not found: ${file}`);
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    file,
  ]);
  const data = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
    }>;
  };
  const streams = data.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const hasAudio = streams.some((s) => s.codec_type === "audio");
  if (!v) throw new Error(`No video stream in ${file}`);
  return {
    durationSec: Number(data.format?.duration ?? 0),
    width: v.width ?? 1280,
    height: v.height ?? 720,
    fps: parseFps(v.r_frame_rate),
    hasAudio,
  };
}

function parseCropSpec(crop: string): CropSpec | null {
  const m = crop.match(/^(\d+):(\d+):(\d+):(\d+)$/);
  if (!m) return null;
  const [, width, height, x, y] = m.map(Number);
  if (!width || !height || x === undefined || y === undefined) return null;
  return { width, height, x, y };
}

async function detectLetterboxCrop(input: string, info: ProbeInfo): Promise<CropSpec | null> {
  const sampleSec = Math.min(3, Math.max(0.5, info.durationSec));
  const { stderr } = await run("ffmpeg", [
    "-hide_banner",
    "-ss",
    "0.5",
    "-t",
    sampleSec.toFixed(3),
    "-i",
    input,
    "-vf",
    "cropdetect=limit=0.08:round=2:reset=0",
    "-an",
    "-f",
    "null",
    "-",
  ]);

  const counts = new Map<string, number>();
  for (const match of stderr.matchAll(/crop=(\d+:\d+:\d+:\d+)/g)) {
    const key = match[1]!;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  let best: CropSpec | null = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    const crop = parseCropSpec(key);
    if (!crop) continue;
    if (count > bestCount) {
      best = crop;
      bestCount = count;
    }
  }

  if (!best) return null;

  const fullWidth = best.width >= info.width * 0.95;
  const meaningfulVerticalCrop = best.height <= info.height * 0.97 && best.y > 0;
  const notTooAggressive = best.height >= info.height * 0.6;
  if (!fullWidth || !meaningfulVerticalCrop || !notTooAggressive) {
    return null;
  }

  return best;
}

/**
 * Re-encode an input to a normalized intermediate: fixed resolution (scaled
 * to cover + cropped to fill), fixed fps, with an audio track guaranteed to exist
 * (silent if the source had none). This makes the later concat lossless and
 * resolution/codec-safe.
 */
async function normalize(
  input: string,
  output: string,
  opts: {
    width: number;
    height: number;
    fps: number;
    trimToSec?: number;
    hasAudio: boolean;
    sourceInfo: ProbeInfo;
    removeLetterbox?: boolean;
  },
): Promise<void> {
  const { width, height, fps, trimToSec, hasAudio, sourceInfo, removeLetterbox } = opts;
  const letterboxCrop = removeLetterbox
    ? await detectLetterboxCrop(input, sourceInfo)
    : null;
  if (letterboxCrop) {
    log.info(
      `Removing generated clip letterbox: crop=${letterboxCrop.width}:${letterboxCrop.height}:` +
        `${letterboxCrop.x}:${letterboxCrop.y}`,
    );
  }
  const cropPrefix = letterboxCrop
    ? `crop=${letterboxCrop.width}:${letterboxCrop.height}:${letterboxCrop.x}:${letterboxCrop.y},`
    : "";
  const vf =
    cropPrefix +
    `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
    `crop=${width}:${height},fps=${fps},setsar=1,format=yuv420p`;

  const args: string[] = ["-y"];

  // Trim the END by limiting duration with -t (applied to the main input).
  if (trimToSec !== undefined && trimToSec > 0) {
    args.push("-t", trimToSec.toFixed(3));
  }
  args.push("-i", input);

  if (!hasAudio) {
    // Synthesize silent stereo audio for a uniform stream layout.
    args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  }

  args.push(
    "-vf",
    vf,
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
  );

  if (!hasAudio) {
    // anullsrc is infinite; bound it to the video length.
    args.push("-shortest");
  }

  args.push(output);
  await run("ffmpeg", args);
}

/**
 * Concatenate N clips into one continuous video. The FIRST clip's geometry/fps
 * is the canonical output format; every clip is normalized (scaled+cropped to
 * fill, fps-matched, audio guaranteed) and optionally end-trimmed before the
 * join. Used to stitch a full multi-segment remake into a single ad.
 */
export async function concatSegments(args: {
  clips: string[];
  outputVideo: string;
  /** Seconds to trim off the END of each clip (e.g. Veo's tail glitch). */
  trimSeconds?: number;
}): Promise<{ output: string; segments: number }> {
  const { clips, outputVideo, trimSeconds = 0 } = args;
  if (clips.length === 0) throw new Error("concatSegments: no clips provided.");
  const work = ensureDir(WORK_DIR);

  if (clips.length === 1 && trimSeconds <= 0) {
    // Nothing to join; still normalize so the output is uniform/streamable.
  }

  const first = await probe(clips[0]!);
  const outW = first.width;
  const outH = first.height;
  const outFps = Math.round(first.fps) || 30;

  const stamp = timestamp();
  const normalized: string[] = [];
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!;
    const info = await probe(clip);
    const trimTo =
      trimSeconds > 0 ? Math.max(0.1, info.durationSec - trimSeconds) : undefined;
    const out = join(work, `seg_${stamp}_${i}.mp4`);
    log.step(`Normalizing segment ${i + 1}/${clips.length}...`);
    await normalize(clip, out, {
      width: outW,
      height: outH,
      fps: outFps,
      trimToSec: trimTo,
      hasAudio: info.hasAudio,
      sourceInfo: info,
      removeLetterbox: true,
    });
    normalized.push(out);
  }

  ensureDir(join(outputVideo, ".."));
  log.step(`Concatenating ${normalized.length} segment(s) into the full video...`);
  const inputs: string[] = [];
  for (const n of normalized) inputs.push("-i", n);
  const streams = normalized.map((_, i) => `[${i}:v][${i}:a]`).join("");
  const filter = `${streams}concat=n=${normalized.length}:v=1:a=1[v][a]`;
  await run("ffmpeg", [
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
    "-movflags",
    "+faststart",
    outputVideo,
  ]);
  log.ok(`Full video written: ${outputVideo}`);
  return { output: outputVideo, segments: normalized.length };
}

/**
 * Speed up (or slow down) a finished video by `factor` (e.g. 1.1 = 10% faster).
 * Video is retimed with setpts and audio is time-stretched with atempo, which
 * preserves pitch so voices don't sound chipmunky. Burned-in captions speed up
 * with the frames, so they stay in sync.
 */
export async function changeSpeed(
  input: string,
  output: string,
  factor: number,
): Promise<string> {
  if (!factor || Math.abs(factor - 1) < 0.001) {
    // No-op: just normalize-copy so the caller still gets `output`.
    await run("ffmpeg", ["-y", "-i", input, "-c", "copy", output]);
    return output;
  }
  // atempo handles 0.5–2.0 in one pass; chain for anything outside that.
  const tempos: number[] = [];
  let remaining = factor;
  while (remaining > 2.0) {
    tempos.push(2.0);
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    tempos.push(0.5);
    remaining /= 0.5;
  }
  tempos.push(remaining);
  const atempo = tempos.map((t) => `atempo=${t.toFixed(6)}`).join(",");
  const setpts = `setpts=${(1 / factor).toFixed(6)}*PTS`;

  ensureDir(join(output, ".."));
  await run("ffmpeg", [
    "-y",
    "-i",
    input,
    "-filter_complex",
    `[0:v]${setpts}[v];[0:a]${atempo}[a]`,
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
    "-movflags",
    "+faststart",
    output,
  ]);
  return output;
}

/**
 * Crop a fixed fraction off the top and bottom of a clip, then re-scale back to
 * the original geometry. Used as a deterministic guard against Veo occasionally
 * painting a fake phone/browser chrome (status bar, back chevron, nav bar) in
 * the outer margins despite the no-UI prompt. The center subject is preserved;
 * the edges (where the chrome always lives) are zoomed out of frame.
 */
export async function cropSafeMargins(
  input: string,
  output: string,
  topFrac: number,
  bottomFrac: number,
): Promise<string> {
  const info = await probe(input);
  const yTop = Math.max(0, Math.round(info.height * Math.max(0, topFrac)));
  const yBot = Math.max(0, Math.round(info.height * Math.max(0, bottomFrac)));
  ensureDir(join(output, ".."));

  if ((yTop === 0 && yBot === 0) || info.height - yTop - yBot < info.height * 0.5) {
    await run("ffmpeg", ["-y", "-i", input, "-c", "copy", output]);
    return output;
  }

  let newH = info.height - yTop - yBot;
  if (newH % 2) newH -= 1;
  // Keep the original aspect ratio by cropping the width to match, centered.
  let newW = Math.round((newH * info.width) / info.height);
  if (newW % 2) newW -= 1;
  const xOff = Math.round((info.width - newW) / 2);

  const vf =
    `crop=${newW}:${newH}:${xOff}:${yTop},` +
    `scale=${info.width}:${info.height},setsar=1,format=yuv420p`;

  await run("ffmpeg", [
    "-y",
    "-i",
    input,
    "-vf",
    vf,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-c:a",
    "copy",
    output,
  ]);
  return output;
}

export interface SpliceResult {
  output: string;
  generatedTrimmedDuration: number;
}

/**
 * Trim the last `trimSeconds` off `generatedVideo`, then concatenate it
 * BEFORE `targetVideo`, writing to `outputVideo`. The target video's
 * resolution and fps are used as the canonical output format.
 */
export async function trimAndSplice(args: {
  generatedVideo: string;
  targetVideo: string;
  outputVideo: string;
  trimSeconds: number;
}): Promise<SpliceResult> {
  const { generatedVideo, targetVideo, outputVideo, trimSeconds } = args;
  const work = ensureDir(WORK_DIR);

  log.step("Probing input videos...");
  const gen = await probe(generatedVideo);
  const target = await probe(targetVideo);
  log.info(
    `Generated: ${gen.width}x${gen.height} @${gen.fps.toFixed(2)}fps, ` +
      `${gen.durationSec.toFixed(2)}s, audio=${gen.hasAudio}`,
  );
  log.info(
    `Target:    ${target.width}x${target.height} @${target.fps.toFixed(2)}fps, ` +
      `${target.durationSec.toFixed(2)}s, audio=${target.hasAudio}`,
  );

  const trimmedDuration = gen.durationSec - trimSeconds;
  if (trimmedDuration <= 0) {
    throw new Error(
      `trimSeconds (${trimSeconds}s) >= generated clip duration ` +
        `(${gen.durationSec.toFixed(2)}s). Nothing would remain.`,
    );
  }

  // Use the target's geometry as the output canon, with a sane fps.
  const outW = target.width;
  const outH = target.height;
  const outFps = Math.round(target.fps) || 30;

  const stamp = timestamp();
  const normGen = join(work, `norm_gen_${stamp}.mp4`);
  const normTarget = join(work, `norm_target_${stamp}.mp4`);

  log.step(`Trimming last ${trimSeconds}s off the generated clip and normalizing...`);
  await normalize(generatedVideo, normGen, {
    width: outW,
    height: outH,
    fps: outFps,
    trimToSec: trimmedDuration,
    hasAudio: gen.hasAudio,
    sourceInfo: gen,
    removeLetterbox: true,
  });
  log.ok(`Normalized generated clip -> ${normGen}`);

  log.step("Normalizing the target video...");
  await normalize(targetVideo, normTarget, {
    width: outW,
    height: outH,
    fps: outFps,
    hasAudio: target.hasAudio,
    sourceInfo: target,
  });
  log.ok(`Normalized target -> ${normTarget}`);

  log.step("Concatenating (generated first, then target)...");
  ensureDir(join(outputVideo, ".."));
  // Use the concat FILTER with a single re-encode (not the demuxer + stream
  // copy). Both intermediates already share codec/res/fps, but re-encoding into
  // one continuous stream avoids edit-list/timestamp quirks that make some
  // players (QuickTime/Preview, embedded previews) skip the first segment.
  // +faststart moves the moov atom up front for smooth playback/streaming.
  await run("ffmpeg", [
    "-y",
    "-i",
    normGen,
    "-i",
    normTarget,
    "-filter_complex",
    "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]",
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
    "-movflags",
    "+faststart",
    outputVideo,
  ]);
  log.ok(`Final video written: ${outputVideo}`);

  return { output: outputVideo, generatedTrimmedDuration: trimmedDuration };
}
