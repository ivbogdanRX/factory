import { mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let timestampCounter = 0;

/**
 * A filesystem-safe, unique-per-call token. The ISO timestamp is only
 * millisecond-resolution, so concurrent jobs can collide on it; we append a
 * monotonic counter (unique within this process) plus a little randomness
 * (guards against a second process in the same millisecond) so intermediate and
 * output filenames never clobber each other.
 */
export function timestamp(): string {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const seq = (timestampCounter++).toString(36);
  const rand = Math.random().toString(36).slice(2, 5);
  return `${iso}-${seq}${rand}`;
}

/** Human-friendly elapsed time, e.g. "1h 02m 05s" or "12.3s". */
export function formatDuration(ms: number): string {
  const totalSec = ms / 1000;
  if (totalSec < 60) return `${totalSec.toFixed(1)}s`;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}h ${pad(m)}m ${pad(s)}s` : `${m}m ${pad(s)}s`;
}

/** Local date as YYYY-MM-DD (used for per-day output folders). */
export function dateStamp(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Local wall-clock time as HHMMSS. */
export function timeStampHMS(d = new Date()): string {
  const h = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}${mi}${s}`;
}

/** Turn arbitrary text into a filesystem-safe slug. */
export function slugify(input: string, max = 40): string {
  const slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "video";
}

/**
 * Build a dated, descriptively-named output path:
 *   <baseDir>/<YYYY-MM-DD>/<YYYY-MM-DD>_<HHMMSS>_<slug>.mp4
 * Creates the per-day folder if needed.
 */
export function buildDatedOutputPath(
  baseDir: string,
  slug: string,
  ext = ".mp4",
): string {
  const date = dateStamp();
  const dir = ensureDir(join(baseDir, date));
  const name = `${date}_${timeStampHMS()}_${slugify(slug)}${ext}`;
  return join(dir, name);
}

/**
 * Turn a label into a readable Title_Case_Word string, preserving tokens that
 * are already all-uppercase (e.g. "VA"). "va loans" -> "VA_Loans".
 */
export function titleSlug(input: string, maxWords = 4): string {
  const words = input
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, maxWords)
    .map((w) =>
      w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(),
    );
  return words.join("_") || "Video";
}

/**
 * Names this process has already handed out but not necessarily written yet.
 * Concurrent jobs finish around the same time, so reading the directory alone
 * would let two jobs pick the same `_vN` and clobber each other. We reserve the
 * name in-memory the instant it's chosen. This runs synchronously, so parallel
 * callers can never interleave and grab the same number.
 */
const reservedOutputPaths = new Set<string>();

/**
 * Build a readable, versioned output path:
 *   <baseDir>/<YYYY-MM-DD>/<Label>_<M>_<D>_v<N>.mp4   e.g. VA_Loans_6_15_v1.mp4
 * N auto-increments per (label, day) so repeated/concurrent runs don't collide.
 * Files still live in a per-day folder for easy retrieval.
 */
export function buildNamedOutputPath(
  baseDir: string,
  label: string,
  ext = ".mp4",
): string {
  const now = new Date();
  const dir = ensureDir(join(baseDir, dateStamp(now)));
  const base = `${titleSlug(label)}_${now.getMonth() + 1}_${now.getDate()}`;

  let existing: string[] = [];
  try {
    existing = readdirSync(dir);
  } catch {
    existing = [];
  }
  const re = new RegExp(`^${base}_v(\\d+)${ext.replace(".", "\\.")}$`, "i");
  let maxV = 0;
  for (const name of existing) {
    const m = name.match(re);
    if (m) maxV = Math.max(maxV, Number(m[1]));
  }

  let version = maxV + 1;
  let candidate = join(dir, `${base}_v${version}${ext}`);
  while (reservedOutputPaths.has(candidate) || existsSync(candidate)) {
    version += 1;
    candidate = join(dir, `${base}_v${version}${ext}`);
  }
  reservedOutputPaths.add(candidate);
  return candidate;
}

/** Release a reserved output name (e.g. if a run failed before writing it). */
export function releaseOutputPath(path: string): void {
  reservedOutputPaths.delete(path);
}

/**
 * Pause for manual intervention (login, CAPTCHA, manual download).
 * Resolves when the user presses Enter.
 */
export async function waitForEnter(message: string): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    await rl.question(`\n\u23f8  ${message}\n   Press Enter to continue... `);
  } finally {
    rl.close();
  }
}

/** Newest file in a directory matching an optional extension filter. */
export function newestFile(dir: string, exts?: string[]): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let best: { path: string; mtime: number } | null = null;
  for (const name of entries) {
    if (exts && !exts.some((e) => name.toLowerCase().endsWith(e))) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (!best || st.mtimeMs > best.mtime) {
      best = { path: full, mtime: st.mtimeMs };
    }
  }
  return best?.path ?? null;
}

/**
 * Poll until a new file (mtime newer than `since`) appears in `dir`,
 * is stable (size unchanged across two checks) and not a partial download.
 */
export async function waitForNewDownload(
  dir: string,
  since: number,
  opts: { timeoutMs?: number; pollMs?: number; exts?: string[] } = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const pollMs = opts.pollMs ?? 1000;
  const deadline = Date.now() + timeoutMs;
  let lastSize = -1;
  let stableHits = 0;

  while (Date.now() < deadline) {
    const candidates = readdirSync(dir)
      .filter((n) => !n.endsWith(".crdownload") && !n.endsWith(".part"))
      .filter((n) => !opts.exts || opts.exts.some((e) => n.toLowerCase().endsWith(e)))
      .map((n) => join(dir, n))
      .filter((p) => {
        try {
          const st = statSync(p);
          return st.isFile() && st.mtimeMs >= since;
        } catch {
          return false;
        }
      })
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

    const newest = candidates[0];
    if (newest) {
      const size = statSync(newest).size;
      if (size > 0 && size === lastSize) {
        stableHits += 1;
        if (stableHits >= 2) return newest;
      } else {
        stableHits = 0;
        lastSize = size;
      }
    }
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for a new download in ${dir}`);
}
