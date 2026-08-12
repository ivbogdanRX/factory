import { runGeneration, type RunOptions } from "./pipeline.js";
import { log } from "./logger.js";

function parseArgs(argv: string[]): RunOptions {
  const out: RunOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config") out.configPath = argv[++i];
    else if (a === "--generated-video") out.generatedVideo = argv[++i];
    else if (a === "--image") out.image = argv[++i];
    else if (a === "--count") out.count = Number(argv[++i]);
    else if (a === "--loop") out.loop = true;
    else if (a === "--interval") out.interval = Number(argv[++i]);
    else if (a === "--campaign") out.campaignId = argv[++i];
    else if (a === "--variant" || a === "--variant-index") out.variantIndex = Number(argv[++i]);
    else if (a === "--hook-index") out.hookIndex = Number(argv[++i]);
    else if (a === "--no-random") out.randomSelection = false;
    else if (a === "--random") out.randomSelection = true;
  }
  return out;
}

/** Load key=value pairs from a local .env file if present (Node 20.6+). */
function loadEnvFile(): void {
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env file (or unsupported Node) — env vars may still be set directly.
  }
}

async function main(): Promise<void> {
  loadEnvFile();
  const opts = parseArgs(process.argv.slice(2));
  await runGeneration(opts);
}

main().catch((err) => {
  log.error((err as Error).stack ?? String(err));
  process.exit(1);
});
