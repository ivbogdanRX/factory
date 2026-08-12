import { env } from "./env.js";
import { startServer } from "./server.js";
import { maybeStartDailyRun, activateDueRuns, completeExpiredRuns } from "./runner.js";
import { maybeRunWeeklyHealthcheck } from "./healthcheck.js";
import { maybeSendMorningDigest } from "./digest.js";
import { maybePollAccountHealth } from "./account-health.js";
import { maybeWatchRemediations } from "./remediation.js";
import { maybeEvaluateGuardrails } from "./guardrails.js";
import { maybePushSnapshot } from "./push.js";
import { nowClockInTimeZone, PT } from "./schedule.js";
import { listRunsByStatus, updateRun } from "./db.js";
import { resumeHookTestWatches } from "./hook-tests.js";
import { resumeAdDraftWatches } from "./ad-drafts.js";

// Runs that were mid-flight when the process died can never finish — fail them
// visibly instead of leaving them stuck in "generating"/"uploading" forever.
// This runs only AFTER we own the port: a stray second instance dies on
// EADDRINUSE before it can wrongly mark the live instance's runs as dead.
startServer(() => {
  for (const status of ["generating", "uploading"] as const) {
    for (const run of listRunsByStatus(status)) {
      updateRun(run.id, { status: "error", error: "Interrupted by orchestrator restart" });
    }
  }
  // Hook tests / ad drafts can outlive a restart: re-attach to their studio jobs.
  resumeHookTestWatches();
  resumeAdDraftWatches();
});
console.log(
  `Ad Factory orchestrator up. Daily run at ${env.runHourPt}:00 PT (override in portal). ` +
    (env.dryRun ? "DRY RUN mode — no Meta writes." : "Live mode."),
);

setInterval(() => {
  const { hour, minute } = nowClockInTimeZone(PT);
  maybeStartDailyRun(hour, minute);
  void activateDueRuns();
  void completeExpiredRuns();
  maybeRunWeeklyHealthcheck();
  maybeSendMorningDigest();
  maybePollAccountHealth();
  maybeWatchRemediations();
  void maybeEvaluateGuardrails();
  void maybePushSnapshot();
}, 30_000);
