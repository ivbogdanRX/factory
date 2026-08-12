import {
  copyFileSync,
  existsSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { loadConfig, resolvePath } from "./config.js";
import { dateStamp, ensureDir } from "./utils.js";
import { log } from "./logger.js";

interface Args {
  configPath?: string;
  /** Directory to scan for loose .mp4 files (default: config video.outputDir). */
  source?: string;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") out.configPath = argv[++i];
    else if (a === "--source") out.source = argv[++i];
  }
  return out;
}

/** Add a numeric suffix if the destination already exists. */
function uniqueDest(dir: string, name: string): string {
  const ext = extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = join(dir, name);
  let n = 1;
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem}_${n}${ext}`);
    n += 1;
  }
  return candidate;
}

function moveFile(src: string, dest: string): void {
  try {
    renameSync(src, dest);
  } catch (err) {
    // Cross-device move (e.g. external drive) -> copy + delete.
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      copyFileSync(src, dest);
      unlinkSync(src);
    } else {
      throw err;
    }
  }
}

function main(): void {
  const cli = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(cli.configPath);

  const outputDir = ensureDir(cfg.video.outputDir);
  const source = cli.source ? resolvePath(cli.source) : outputDir;

  if (!existsSync(source)) {
    log.error(`Source directory not found: ${source}`);
    process.exit(1);
  }

  log.step(`Organizing .mp4 files from ${source} into ${outputDir}/<date>/`);

  const entries = readdirSync(source, { withFileTypes: true });
  let moved = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (extname(entry.name).toLowerCase() !== ".mp4") continue;

    const srcPath = join(source, entry.name);
    const stat = statSync(srcPath);
    const folder = ensureDir(join(outputDir, dateStamp(stat.mtime)));
    const destPath = uniqueDest(folder, basename(entry.name));

    if (srcPath === destPath) continue; // already in the right place
    moveFile(srcPath, destPath);
    log.ok(`${entry.name} -> ${destPath}`);
    moved += 1;
  }

  if (moved === 0) log.info("Nothing to organize (no loose .mp4 files found).");
  else log.ok(`Organized ${moved} file(s).`);
}

main();
