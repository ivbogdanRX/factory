/**
 * Manual entry point: `npm run run-now` (or `npm run dry-run`) triggers the
 * full daily pipeline once and waits for it, printing run results.
 */
import { runDaily } from "./runner.js";
import { listRuns, listCreatives } from "./db.js";

const command = process.argv[2] ?? "run";
if (command !== "run") {
  console.error(`Unknown command: ${command}. Usage: tsx apps/orchestrator/src/cli.ts run`);
  process.exit(1);
}

await runDaily();

for (const run of listRuns(10)) {
  console.log(`\n${run.id} [${run.vertical_id}] → ${run.status}${run.error ? ` (${run.error})` : ""}`);
  if (run.go_live_at) console.log(`  go-live: ${run.go_live_at}`);
  for (const creative of listCreatives(run.id)) {
    console.log(`  - ${creative.output_path.split("/").pop()} → ${creative.status}${creative.ad_id ? ` ad=${creative.ad_id}` : ""}${creative.error ? ` (${creative.error})` : ""}`);
  }
}
process.exit(0);
