/**
 * One-off watcher: the three Luu accounts' cloned ads were force-paused by
 * Meta ("payment method invalid"). Every 15 minutes, try flipping them back
 * to ACTIVE; once the user fixes billing the flip succeeds, we Slack-ping and
 * stop watching that account. Gives up after 24h.
 *
 * Usage: npx tsx apps/orchestrator/scripts/reactivate-luu-clones.ts
 */
import { setObjectStatus } from "../src/meta.js";
import { postSlack } from "../src/slack.js";

/** Cloned ad ids per Luu account (from the 2026-08-12 clone run). */
const PENDING = new Map<string, string[]>([
  ["Luu 566693", ["120248855534580499", "120248855545340499"]],
  ["Luu 342975", ["120249020177580008", "120249020180250008"]],
  ["Luu 165671", ["120250407338020638", "120250407341420638"]],
]);

const RETRY_MS = 15 * 60 * 1000;
const DEADLINE = Date.now() + 24 * 60 * 60 * 1000;

async function tick(): Promise<void> {
  for (const [label, adIds] of [...PENDING]) {
    try {
      for (const adId of adIds) await setObjectStatus(adId, "ACTIVE");
      PENDING.delete(label);
      console.log(`${label}: reactivated`);
      await postSlack(
        `:white_check_mark: *${label} billing fixed* — both cloned "(IB) LNV 3" ads are ACTIVE again and will go live with the 5 AM PT launch.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`${label}: still blocked (${message.slice(0, 100)})`);
    }
  }
}

async function main(): Promise<void> {
  console.log(`Watching ${PENDING.size} Luu account(s), retry every 15 min, deadline in 24h`);
  while (PENDING.size > 0 && Date.now() < DEADLINE) {
    await tick();
    if (PENDING.size === 0) break;
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }
  if (PENDING.size > 0) {
    await postSlack(
      `:warning: Gave up re-activating cloned ads after 24h on: ${[...PENDING.keys()].join(", ")} — billing still broken. Fix the payment method and resume them from the portal.`,
    );
  }
  console.log("done");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
