import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { runGeneration } from "./pipeline.js";
import { titleSlug, formatDuration } from "./utils.js";
import { log } from "./logger.js";

/**
 * Batch runner: produce N randomized videos for EVERY campaign (vertical) and
 * file them under output/<Vertical>/<YYYY-MM-DD>/.
 *
 *   npm run batch                 # 10 of each vertical
 *   npm run batch -- --count 5    # 5 of each
 *   npm run batch -- --only debt-nurses,debt-veterans
 *   npm run batch -- --interval 30   # wait 30s between runs
 */

interface BatchArgs {
  configPath?: string;
  count: number;
  interval: number;
  only?: string[];
  random: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): BatchArgs {
  const out: BatchArgs = { count: 10, interval: 0, random: true, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") out.configPath = argv[++i];
    else if (a === "--count") out.count = Number(argv[++i]);
    else if (a === "--interval") out.interval = Number(argv[++i]);
    else if (a === "--only")
      out.only = (argv[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === "--no-random") out.random = false;
    else if (a === "--random") out.random = true;
    else if (a === "--dry-run") out.dryRun = true;
  }
  return out;
}

/** Load key=value pairs from a local .env file if present (Node 20.6+). */
function loadEnvFile(): void {
  try {
    process.loadEnvFile(".env");
  } catch {
    /* No .env file (or unsupported Node) — env vars may still be set directly. */
  }
}

/** Folder name for a campaign, e.g. "Debt Nurses" -> "Debt_Nurses". */
function verticalFolder(label: string): string {
  return titleSlug(label);
}

async function main(): Promise<void> {
  loadEnvFile();
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig(args.configPath);

  if (!Number.isFinite(args.count) || args.count <= 0) {
    log.error(`--count must be a positive number (got ${args.count}).`);
    process.exit(1);
  }

  let campaigns = cfg.campaigns;
  if (args.only && args.only.length > 0) {
    const known = new Set(cfg.campaigns.map((c) => c.id));
    const unknown = args.only.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      log.error(
        `Unknown campaign id(s): ${unknown.join(", ")}. ` +
          `Available: ${cfg.campaigns.map((c) => c.id).join(", ")}`,
      );
      process.exit(1);
    }
    campaigns = cfg.campaigns.filter((c) => args.only!.includes(c.id));
  }

  // Skip campaigns whose body clip is missing, rather than failing every run.
  const runnable = campaigns.filter((c) => {
    if (existsSync(c.bodyVideo)) return true;
    log.warn(`Skipping "${c.id}": body video not found (${c.bodyVideo}).`);
    return false;
  });

  if (runnable.length === 0) {
    log.error("No runnable campaigns (all skipped or filtered out).");
    process.exit(1);
  }

  const startedAt = Date.now();
  log.step(
    `Batch: ${args.count} ${args.random ? "randomized " : ""}video(s) each for ` +
      `${runnable.length} vertical(s) via the Flow browser backend: ` +
      `${runnable.map((c) => c.id).join(", ")}`,
  );

  if (args.dryRun) {
    log.info(`Plan (dry run — nothing will be generated):`);
    for (const c of runnable) {
      const label = c.outputName || c.name || c.vertical;
      const folder = join(cfg.video.outputDir, verticalFolder(label));
      log.info(`  ${c.id}: ${args.count} -> ${folder}/<date>/`);
    }
    log.info(
      `Total: ${args.count * runnable.length} video(s) across ${runnable.length} vertical(s).`,
    );
    return;
  }

  const summary: { id: string; produced: number; expected: number }[] = [];

  for (const campaign of runnable) {
    const label = campaign.outputName || campaign.name || campaign.vertical;
    const folder = join(cfg.video.outputDir, verticalFolder(label));
    log.step(
      `=== Vertical "${campaign.id}" -> ${folder}/<date>/ (${args.count} run(s)) ===`,
    );
    try {
      const result = await runGeneration({
        configPath: args.configPath,
        campaignId: campaign.id,
        count: args.count,
        interval: args.interval,
        randomSelection: args.random,
        outputDir: folder,
        // Always drive the Flow web UI for batch runs (never the Veo API).
        backend: "browser",
        // Never block the batch on a manual download prompt; skip & continue.
        interactive: false,
      });
      summary.push({
        id: campaign.id,
        produced: result.outputs.length,
        expected: args.count,
      });
    } catch (err) {
      log.error(`Vertical "${campaign.id}" aborted: ${(err as Error).message}`);
      summary.push({ id: campaign.id, produced: 0, expected: args.count });
    }
  }

  const total = summary.reduce((n, s) => n + s.produced, 0);
  const expected = summary.reduce((n, s) => n + s.expected, 0);
  log.ok(
    `Batch finished in ${formatDuration(Date.now() - startedAt)}. ` +
      `Produced ${total}/${expected} video(s).`,
  );
  for (const s of summary) {
    const line = `  ${s.id}: ${s.produced}/${s.expected}`;
    if (s.produced < s.expected) log.warn(line);
    else log.info(line);
  }
}

main().catch((err) => {
  log.error((err as Error).stack ?? String(err));
  process.exit(1);
});
