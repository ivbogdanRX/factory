#!/usr/bin/env node
/**
 * Garbage-collect intermediate run artifacts while preserving final outputs.
 *
 * The pipeline writes uniquely-timestamped intermediates (debug screenshots,
 * normalized clips, extracted audio, raw Veo/image downloads) that are never
 * read back on later runs — once a finished video lands in output/, they're
 * dead weight. This removes that dead weight; it NEVER touches output/.
 *
 * Usage:
 *   npm run clean            # preview what would be freed (dry run)
 *   npm run clean -- --yes   # actually delete
 *   npm run clean -- --all   # also drop top-level downloads/*.mp4 + .bak configs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--yes") || args.has("-y");
const ALL = args.has("--all");

/** Sum the size of a file or directory tree, in bytes. */
function sizeOf(target) {
  let total = 0;
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return 0;
  }
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) {
      total += sizeOf(path.join(target, entry));
    }
  } else {
    total = stat.size;
  }
  return total;
}

function human(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Targets to clean. Each is a directory whose *contents* we wipe (keeping the
 * directory itself), or an explicit list of glob-free file matches.
 */
const targets = [
  { label: "artifacts/captions (extracted audio + subtitle files)", dir: "artifacts/captions" },
  { label: "artifacts/video (normalized intermediate clips)", dir: "artifacts/video" },
  { label: "artifacts/frames (preview frames)", dir: "artifacts/frames" },
  {
    label: "artifacts/* (debug screenshots, logs, scratch files)",
    files: () => {
      const dir = path.join(ROOT, "artifacts");
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .filter((n) => /\.(png|jpg|jpeg|json|log|mp4)$/i.test(n))
        .filter((n) => n !== ".DS_Store")
        .map((n) => path.join("artifacts", n));
    },
  },
  { label: "downloads/veo (raw generated clips)", dir: "downloads/veo" },
  { label: "downloads/images (source/generated images)", dir: "downloads/images" },
];

if (ALL) {
  targets.push({
    label: "downloads/*.mp4 (loose raw clips)",
    files: () => {
      const dir = path.join(ROOT, "downloads");
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .filter((n) => n.toLowerCase().endsWith(".mp4"))
        .map((n) => path.join("downloads", n));
    },
  });
  targets.push({
    label: "config.json.*.bak (old config backups)",
    files: () => {
      if (!fs.existsSync(ROOT)) return [];
      return fs
        .readdirSync(ROOT)
        .filter((n) => /^config\.json\..*\.bak$/.test(n))
        .map((n) => n);
    },
  });
}

/** Resolve a target into the list of absolute paths it would remove. */
function resolveEntries(target) {
  if (target.files) {
    return target.files().map((rel) => path.join(ROOT, rel));
  }
  const dir = path.join(ROOT, target.dir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n !== ".DS_Store")
    .map((n) => path.join(dir, n));
}

let grandTotal = 0;
let removedTotal = 0;
const rows = [];

for (const target of targets) {
  const entries = resolveEntries(target);
  if (entries.length === 0) continue;
  let bytes = 0;
  for (const entry of entries) bytes += sizeOf(entry);
  grandTotal += bytes;
  rows.push({ label: target.label, count: entries.length, bytes });

  if (APPLY) {
    for (const entry of entries) {
      fs.rmSync(entry, { recursive: true, force: true });
    }
    removedTotal += bytes;
  }
}

if (rows.length === 0) {
  console.log("Nothing to clean — already tidy. ✨");
  process.exit(0);
}

const verb = APPLY ? "Removed" : "Would free";
console.log(`${APPLY ? "Cleaning" : "Dry run — nothing deleted yet"}\n`);
for (const row of rows) {
  console.log(
    `  ${human(row.bytes).padStart(8)}  (${String(row.count).padStart(3)} items)  ${row.label}`,
  );
}
console.log("\n  " + "-".repeat(50));
console.log(`  ${verb}: ${human(APPLY ? removedTotal : grandTotal)}  (output/ left untouched)`);

if (!APPLY) {
  console.log("\nRe-run with `npm run clean -- --yes` to delete.");
  console.log("Add `--all` to also drop loose downloads/*.mp4 and config .bak files.");
}
