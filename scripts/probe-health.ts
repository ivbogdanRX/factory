/** Read-only probe: what the account-health poller would see (no Slack posts). */
import { loadVerticals } from "../apps/orchestrator/src/verticals.js";
import { listRuns, listCreatives } from "../apps/orchestrator/src/db.js";
import { getAdStatuses, getAdAccountHealth } from "../apps/orchestrator/src/meta.js";

const accountIds = [...new Set(loadVerticals().filter((v) => v.enabled).map((v) => v.meta.adAccountId))];
for (const id of accountIds) {
  console.log(`account ${id}:`, await getAdAccountHealth(id));
}

const runs = listRuns(100).filter(
  (r) => ["scheduled", "live", "paused"].includes(r.status) && Date.now() - r.created_at < 14 * 86_400_000,
);
const creatives = runs.flatMap((r) => listCreatives(r.id)).filter((c) => c.ad_id && c.status !== "killed");
console.log(`polling ${creatives.length} ad(s) from ${runs.length} run(s)`);
const statuses = await getAdStatuses(creatives.map((c) => c.ad_id!));
for (const [adId, info] of statuses) {
  console.log(`  ${adId}  ${info.effectiveStatus}  ${info.name}`);
}
