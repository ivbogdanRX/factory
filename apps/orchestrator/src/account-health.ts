/**
 * Meta account health alerts, polled every ~10 minutes from the main tick:
 *  - EVERY ad on the account (manual campaigns included) that turns
 *    DISAPPROVED → auto-remediation (see remediation.ts); WITH_ISSUES → one
 *    urgent Slack alert per ad per condition;
 *  - the ad account itself (account_status / disable_reason) → urgent alert
 *    when the account stops being ACTIVE, recovery message when it clears.
 * Dedupe state lives in the alert_state table, so restarts don't re-alert and
 * a condition alerts once on appear (+ once on clear for the account).
 * Graph budget: ~2 calls per ad account per poll (status + filtered ad scan).
 */
import { env } from "./env.js";
import { loadVerticals } from "./verticals.js";
import {
  getAlertState,
  setAlertState,
  clearAlertState,
  listAlertKeys,
  listOurAdIds,
  getRemediation,
  listRemediationsByState,
} from "./db.js";
import { getAdStatuses, getAdAccountHealth, listProblemAds, type ProblemAd } from "./meta.js";
import { startRemediationForAd, progressRemediations } from "./remediation.js";
import { postSlack } from "./slack.js";

const POLL_INTERVAL_MS = 10 * 60 * 1000;

/** Every ad account to monitor: vertical-configured ones plus any extras from
 * EXTRA_META_HEALTH_ACCOUNTS (comma-separated act_… ids) — used for the spare
 * accounts running cloned campaigns that no vertical points at. */
function monitoredAccountIds(): string[] {
  const extras = (process.env.EXTRA_META_HEALTH_ACCOUNTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [
    ...new Set([
      ...loadVerticals().filter((v) => v.enabled).map((v) => v.meta.adAccountId).filter(Boolean),
      ...extras,
    ]),
  ];
}

const ACCOUNT_STATUS_NAMES: Record<number, string> = {
  1: "ACTIVE",
  2: "DISABLED",
  3: "UNSETTLED (unpaid balance — a charge probably failed)",
  7: "PENDING_RISK_REVIEW",
  8: "PENDING_SETTLEMENT",
  9: "IN_GRACE_PERIOD (payment overdue)",
  100: "PENDING_CLOSURE",
  101: "CLOSED",
};

const DISABLE_REASON_NAMES: Record<number, string> = {
  1: "ads integrity policy violation",
  2: "ads IP review",
  3: "payment risk",
  4: "gray account shutdown",
  5: "AFC review",
  6: "business integrity review",
  7: "permanently closed",
};

function accountAdvice(accountStatus: number): string {
  if (accountStatus === 3 || accountStatus === 9 || accountStatus === 8) {
    return "Fix the payment method in Ads Manager → Billing, then retry the charge.";
  }
  if (accountStatus === 2) {
    return "Open facebook.com/accountquality to review and appeal.";
  }
  return "Check the account in Ads Manager.";
}

async function checkAdAccounts(): Promise<void> {
  const accountIds = monitoredAccountIds();
  for (const accountId of accountIds) {
    const key = `account:${accountId}`;
    let health;
    try {
      health = await getAdAccountHealth(accountId);
    } catch (error) {
      console.warn(`Account health fetch failed for ${accountId}`, error);
      continue;
    }
    if (health.accountStatus === 1) {
      const previous = getAlertState(key);
      if (previous !== undefined) {
        clearAlertState(key);
        await postSlack(`:white_check_mark: *Ad account ${accountId} is ACTIVE again* — previous problem (${previous}) has cleared.`);
      }
      continue;
    }
    const statusName = ACCOUNT_STATUS_NAMES[health.accountStatus] ?? `status code ${health.accountStatus}`;
    const reason = health.disableReason
      ? ` Reason: ${DISABLE_REASON_NAMES[health.disableReason] ?? `code ${health.disableReason}`}.`
      : "";
    const detail = `${statusName}${reason}`;
    if (getAlertState(key) === detail) continue; // already alerted for this exact condition
    setAlertState(key, detail);
    await postSlack(
      `:rotating_light: *Ad account ${accountId} is ${statusName}* — ads are not delivering.${reason} ${accountAdvice(health.accountStatus)}`,
    );
  }
}

/** Above this many rejected ads, swap only a few per cycle (less bursty). */
const BACKLOG_THRESHOLD = 10;
const MAX_SWAPS_PER_POLL = 3;

async function checkAds(): Promise<void> {
  // Account-wide scan: one filtered Graph call per ad account returns every
  // DISAPPROVED / WITH_ISSUES ad — manual campaigns included.
  const accountIds = monitoredAccountIds();
  const ourAdIds = listOurAdIds();
  const allProblems: { ad: ProblemAd; accountId: string }[] = [];
  for (const accountId of accountIds) {
    try {
      for (const ad of await listProblemAds(accountId)) allProblems.push({ ad, accountId });
    } catch (error) {
      console.warn(`Problem-ad scan failed for ${accountId}`, error);
    }
  }

  // Clear WITH_ISSUES alert rows for ads that recovered (silently — recovery
  // messages are account-level only), so a relapse alerts again.
  const problemIds = new Set(allProblems.map((p) => p.ad.id));
  for (const key of listAlertKeys("ad:")) {
    if (!problemIds.has(key.slice("ad:".length))) clearAlertState(key);
  }

  // Rejected ads not yet handled → remediate, gradually when there's a backlog.
  const rejected = allProblems.filter((p) => p.ad.effectiveStatus === "DISAPPROVED" && !getRemediation(p.ad.id));
  if (rejected.length > BACKLOG_THRESHOLD && getAlertState("remediationBacklog") === undefined) {
    setAlertState("remediationBacklog", String(rejected.length));
    await postSlack(
      `:dog: Found *${rejected.length}* rejected ads on the account — working through the backlog a few per poll cycle to keep the edits low-key.`,
    );
  }
  if (rejected.length === 0 && getAlertState("remediationBacklog") !== undefined) {
    clearAlertState("remediationBacklog");
  }
  const batch = rejected.length > BACKLOG_THRESHOLD ? rejected.slice(0, MAX_SWAPS_PER_POLL) : rejected;
  for (const { ad, accountId } of batch) {
    await startRemediationForAd({
      adId: ad.id,
      adName: ad.name,
      campaignName: ad.campaignName,
      isOurs: ourAdIds.has(ad.id),
      adAccountId: accountId,
    });
  }

  // WITH_ISSUES: alert once per condition, no auto-remediation. Swapped ads
  // can pass through WITH_ISSUES during re-review — the remediation owns them.
  for (const { ad } of allProblems) {
    if (ad.effectiveStatus !== "WITH_ISSUES" || getRemediation(ad.id)) continue;
    const key = `ad:${ad.id}`;
    if (getAlertState(key) === "WITH_ISSUES") continue; // already alerted
    setAlertState(key, "WITH_ISSUES");
    const manual = ourAdIds.has(ad.id) ? "" : " — manual campaign";
    await postSlack(
      `:rotating_light: *Ad "${ad.name}"*${ad.campaignName ? ` (campaign "${ad.campaignName}"${manual})` : ""} has *delivery issues* (WITH_ISSUES) — open it in Ads Manager to see what Meta flagged.`,
    );
  }

  // Advance remediations awaiting re-review (the 30s tick watcher does this
  // too; both go through the same in-flight guard).
  const pending = listRemediationsByState("swapped");
  if (pending.length > 0) {
    const statuses = await getAdStatuses(pending.map((r) => r.ad_id));
    await progressRemediations(statuses);
  }
}

/** One full poll (accounts + ads). Exposed for on-demand testing. */
export async function pollAccountHealth(): Promise<void> {
  await checkAdAccounts();
  await checkAds();
}

let lastPollAt = 0;
let polling = false;

/** Called from the 30s scheduler tick; polls at most every 10 minutes. */
export function maybePollAccountHealth(): void {
  if (!env.metaToken) return;
  if (polling || Date.now() - lastPollAt < POLL_INTERVAL_MS) return;
  polling = true;
  lastPollAt = Date.now();
  void pollAccountHealth()
    .catch((error) => console.warn("Account health poll failed:", error))
    .finally(() => {
      polling = false;
    });
}
