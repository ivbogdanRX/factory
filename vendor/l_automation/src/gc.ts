import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "./config.js";
import { log } from "./logger.js";

/**
 * Intermediate/helper locations the pipeline regenerates every run. These are
 * never read back on later runs, so once a finished video lands in output/ they
 * are dead weight. output/ is deliberately NOT in this list and is never touched.
 *
 * Each entry is a directory whose stale *contents* get pruned. `topLevelOnly`
 * also restricts a directory to loose files matching `match` (used for the
 * artifacts/ and downloads/ roots where subfolders are pruned separately).
 */
interface PruneTarget {
  dir: string;
  /** Only consider direct children (not recurse into kept subdirs). */
  topLevelOnly?: boolean;
  /** When set, only files whose name matches are eligible. */
  match?: RegExp;
}

const TARGETS: PruneTarget[] = [
  { dir: "artifacts/captions" },
  { dir: "artifacts/video" },
  { dir: "artifacts/frames" },
  {
    dir: "artifacts",
    topLevelOnly: true,
    match: /\.(png|jpe?g|json|log|mp4)$/i,
  },
  { dir: "downloads/veo" },
  { dir: "downloads/images" },
  { dir: "downloads", topLevelOnly: true, match: /\.mp4$/i },
  { dir: ".", topLevelOnly: true, match: /^config\.json\..*\.bak$/i },
];

function sizeOf(target: string): number {
  let stat;
  try {
    stat = lstatSync(target);
  } catch {
    return 0;
  }
  if (stat.isDirectory()) {
    let total = 0;
    for (const entry of readdirSync(target)) {
      total += sizeOf(join(target, entry));
    }
    return total;
  }
  return stat.size;
}

function human(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export interface PruneResult {
  freedBytes: number;
  removed: number;
}

/**
 * Delete intermediate files older than `maxAgeHours` across the known scratch
 * locations. With maxAgeHours <= 0, everything eligible is removed regardless
 * of age. Returns how much was freed. Never throws on individual failures and
 * never touches output/.
 */
export function pruneIntermediates(maxAgeHours: number): PruneResult {
  const cutoff =
    maxAgeHours > 0 ? Date.now() - maxAgeHours * 3_600_000 : Number.POSITIVE_INFINITY;

  let freedBytes = 0;
  let removed = 0;

  for (const target of TARGETS) {
    const dirPath = join(PROJECT_ROOT, target.dir);
    if (!existsSync(dirPath)) continue;

    let entries: string[];
    try {
      entries = readdirSync(dirPath);
    } catch {
      continue;
    }

    for (const name of entries) {
      if (name === ".DS_Store" && target.topLevelOnly) continue;
      const full = join(dirPath, name);

      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }

      // For root-level targets we only prune loose files (subdirs are handled
      // by their own dedicated target entries).
      if (target.topLevelOnly && stat.isDirectory()) continue;
      if (target.match && !target.match.test(name)) continue;
      if (stat.mtimeMs >= cutoff) continue;

      const bytes = sizeOf(full);
      try {
        rmSync(full, { recursive: true, force: true });
        freedBytes += bytes;
        removed += 1;
      } catch {
        // Best-effort: skip anything we can't remove (e.g. locked file).
      }
    }
  }

  return { freedBytes, removed };
}

/**
 * Run automatic intermediate cleanup and log a one-line summary. Safe to call
 * at the start of every run; it's a no-op when nothing is stale enough.
 */
export function autoCleanIntermediates(maxAgeHours: number): void {
  const { freedBytes, removed } = pruneIntermediates(maxAgeHours);
  if (removed > 0) {
    const window =
      maxAgeHours > 0 ? `older than ${maxAgeHours}h` : "all intermediates";
    log.info(`Cleaned ${removed} stale helper file(s) (${window}), freed ${human(freedBytes)}.`);
  }
}
