/**
 * One-off: pre-stage the compliance placeholder (puppy) creative for each
 * enabled vertical's page so real remediations reuse it instantly. Other
 * pages get theirs lazily on first rejection. Creates inert account-level
 * objects only — no ad is read or modified.
 */
import { loadVerticals } from "../apps/orchestrator/src/verticals.js";
import { ensurePuppyCreative } from "../apps/orchestrator/src/remediation.js";
import { postSlack } from "../apps/orchestrator/src/slack.js";

for (const vertical of loadVerticals().filter((v) => v.enabled)) {
  const creativeId = await ensurePuppyCreative(
    vertical.meta.adAccountId,
    vertical.meta.pageId,
    vertical.meta.adSettings.websiteUrl,
  );
  console.log(`${vertical.id}: puppy creative ready on ${vertical.meta.adAccountId} page ${vertical.meta.pageId} → ${creativeId}`);
  await postSlack(
    `:dog: Rejection auto-remediation armed — compliant placeholder creative staged on \`${vertical.meta.adAccountId}\` (creative \`${creativeId}\`). ` +
      `If Meta rejects an ad, its creative is swapped to the placeholder for re-review (status untouched) and the ad is turned off the moment it's re-approved.`,
  );
}
