/**
 * One-off smoke test for new-campaign mode: creates a PAUSED CBO campaign +
 * ad set exactly as the daily runner would, prints them, then deletes both.
 * No ads are created and nothing can spend.
 *
 * Usage: npx tsx scripts/test-campaign-create.ts
 */
import { getVertical } from "../apps/orchestrator/src/verticals.js";
import { createCampaign, createAdSet, setObjectStatus, defaultUsTargeting } from "../apps/orchestrator/src/meta.js";
import { nextDayStartIso } from "../apps/orchestrator/src/schedule.js";

const vertical = getVertical("va-loans");
if (!vertical) throw new Error("va-loans vertical not found");
const m = vertical.meta;
console.log("Account:", m.adAccountId, "| page:", m.pageId, "| pixel:", m.pixelId);

const goLiveAt = nextDayStartIso(vertical.schedule.startHourPt);
console.log("Would go live:", goLiveAt);

const campaignId = await createCampaign(m.adAccountId, {
  name: "(IB) AF smoke test — delete me",
  objective: m.objective,
  specialAdCategories: m.specialAdCategories,
  dailyBudget: m.cboDailyBudgetCents,
  bidStrategy: m.bidStrategy,
  status: "PAUSED",
});
console.log("Created campaign:", campaignId);

try {
  const adSetId = await createAdSet(m.adAccountId, {
    name: "(IB) AF smoke test ad set",
    campaignId,
    billingEvent: "IMPRESSIONS",
    optimizationGoal: m.optimizationGoal,
    targeting: defaultUsTargeting(),
    promotedObject: { pixel_id: m.pixelId, custom_event_type: m.pixelEvent },
    status: "PAUSED",
    startTime: goLiveAt,
  });
  console.log("Created ad set:", adSetId);
  await setObjectStatus(adSetId, "DELETED");
  console.log("Deleted ad set.");
} finally {
  await setObjectStatus(campaignId, "DELETED");
  console.log("Deleted campaign.");
}
console.log("SMOKE TEST PASSED — new-campaign mode works against Meta.");
