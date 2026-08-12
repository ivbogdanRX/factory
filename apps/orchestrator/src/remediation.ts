/**
 * Rejection auto-remediation for EVERY ad on the account (manual campaigns
 * included). A DISAPPROVED ad sitting in the account hurts account standing,
 * so:
 *
 *  1. On rejection the ad's creative is swapped to a benign placeholder (the
 *     puppy image) which triggers Meta re-review. The ad's status is NOT
 *     touched — a rejected ad can't deliver anyway, and fewer status changes
 *     means fewer signals for Meta to analyze.
 *  2. While a swap is awaiting re-review, the ad's status is checked every
 *     30s tick (a single targeted Graph call; zero calls when nothing is
 *     pending) so the pause lands within seconds of approval.
 *  3. On approval the ad is paused — the one and only status action — so a
 *     puppy ad never spends, and the rejection is off the account record.
 *
 * The placeholder creative must promote the SAME Facebook page as the ad it
 * replaces, so one is created lazily per page (cached in settings). If the
 * user swaps the creative themselves mid-re-review, we stand down. State
 * lives in the ad_remediations table so restarts never double-swap.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./env.js";
import { loadVerticals } from "./verticals.js";
import {
  getCreativeByAdId,
  updateCreative,
  getSetting,
  setSetting,
  clearAlertState,
  createRemediation,
  updateRemediation,
  getRemediation,
  listRemediationsByState,
  type RemediationRow,
} from "./db.js";
import {
  uploadImageFile,
  createImageCreative,
  updateAdCreative,
  getAdCreativeId,
  getAdCreativeDetails,
  getAdStatuses,
  setObjectStatus,
  type AdStatusInfo,
} from "./meta.js";
import { postSlack } from "./slack.js";

export const PUPPY_IMAGE_PATH = join(ROOT, "apps", "orchestrator", "assets", "puppy.jpg");

/** Statuses meaning "Meta hasn't finished re-review yet" — keep waiting. */
const IN_REVIEW_STATUSES = new Set(["PENDING_REVIEW", "IN_PROCESS", "PENDING_BILLING_INFO", "WITH_ISSUES"]);
/** The ad no longer exists as a reviewable object — close the remediation. */
const GONE_STATUSES = new Set(["DELETED", "ARCHIVED"]);

const DAY_MS = 24 * 60 * 60 * 1000;

/** "(campaign "LNV 8-11" — manual campaign)" style suffix for Slack copy. */
function campaignTag(campaignName: string | null, isOurs: boolean): string {
  const manual = isOurs ? "" : " — manual campaign";
  if (campaignName) return ` (campaign "${campaignName}"${manual})`;
  return isOurs ? "" : " (manual campaign)";
}

/**
 * The compliance placeholder creative for a page on an ad account, created
 * once per page (a creative can only be attached to ads promoting the same
 * page) and cached in settings. Inert account-level object.
 */
export async function ensurePuppyCreative(adAccountId: string, pageId: string, link: string): Promise<string> {
  const key = `puppyCreativeId:${adAccountId}:${pageId}`;
  const existing = getSetting(key);
  if (existing) return existing;
  if (!existsSync(PUPPY_IMAGE_PATH)) {
    throw new Error(`Compliance image missing at ${PUPPY_IMAGE_PATH}`);
  }
  // The image hash is account-level and reusable across pages.
  const hashKey = `puppyImageHash:${adAccountId}`;
  let imageHash = getSetting(hashKey);
  if (!imageHash) {
    const image = await uploadImageFile(adAccountId, PUPPY_IMAGE_PATH);
    imageHash = image.hash;
    setSetting(hashKey, imageHash);
  }
  const creativeId = await createImageCreative(adAccountId, {
    name: "Compliance placeholder (puppy) — do not enable",
    pageId,
    imageHash,
    message: "Have a great day!",
    link,
  });
  setSetting(key, creativeId);
  return creativeId;
}

export interface RemediationTarget {
  adId: string;
  adName: string;
  campaignName: string | null;
  isOurs: boolean;
  adAccountId: string;
}

/**
 * A DISAPPROVED ad was found (any campaign on the account): swap its creative
 * to the placeholder and record the remediation. Does NOT change the ad's
 * status. Failures leave the ad completely untouched and alert instead.
 */
export async function startRemediationForAd(target: RemediationTarget): Promise<void> {
  const { adId, adName, campaignName, isOurs, adAccountId } = target;
  if (getRemediation(adId)) return; // already handled (any state)
  clearAlertState(`ad:${adId}`); // remediation owns this ad's messaging now
  const tag = campaignTag(campaignName, isOurs);

  try {
    const details = await getAdCreativeDetails(adId);
    if (!details.pageId) {
      throw new Error("could not determine the ad's Facebook page — not guessing");
    }
    // Landing link for the placeholder: prefer the vertical's known-approved
    // lander when the page is ours, else the link the ad itself was using.
    const vertical = loadVerticals().find((v) => v.enabled && v.meta.pageId === details.pageId);
    const link = vertical?.meta.adSettings.websiteUrl || details.link;
    if (!link) {
      throw new Error("could not determine a landing link for the placeholder — not guessing");
    }
    const puppyCreativeId = await ensurePuppyCreative(adAccountId, details.pageId, link);
    await updateAdCreative(adId, puppyCreativeId);
    createRemediation({
      adId,
      adName,
      campaignName,
      isOurs,
      originalCreativeId: details.creativeId,
      puppyCreativeId,
      state: "swapped",
    });
    await postSlack(
      `:dog: *${adName}*${tag} was rejected by Meta — swapped to the compliant placeholder creative for re-review, status untouched. It will be turned off the moment it's re-approved.`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    createRemediation({
      adId,
      adName,
      campaignName,
      isOurs,
      originalCreativeId: null,
      puppyCreativeId: null,
      state: "failed",
      note: `creative swap failed: ${message}`,
    });
    await postSlack(
      `:rotating_light: *${adName}*${tag} was *DISAPPROVED* and the automatic creative swap failed (${message}). Ad untouched — handle it in Ads Manager.`,
    );
  }
}

const inFlight = new Set<string>();

/** Advance one awaiting-re-review remediation based on the ad's current status. */
async function progressRemediation(rem: RemediationRow, info: AdStatusInfo): Promise<void> {
  if (inFlight.has(rem.ad_id)) return;
  inFlight.add(rem.ad_id);
  try {
    const status = info.effectiveStatus;
    const name = rem.ad_name ?? info.name;
    const tag = campaignTag(rem.campaign_name, rem.is_ours === 1);

    if (status === "DISAPPROVED") {
      // Still rejected. Right after the swap that just means "not re-reviewed
      // yet"; a day later it means the placeholder was rejected too.
      if (Date.now() - rem.updated_at > DAY_MS) {
        updateRemediation(rem.ad_id, { state: "failed", note: "still disapproved 24h after placeholder swap" });
        await postSlack(
          `:rotating_light: *${name}*${tag} is still DISAPPROVED 24h after the compliant-creative swap — Meta likely flagged the landing page. Needs a manual appeal in Ads Manager.`,
        );
      }
      return;
    }
    if (IN_REVIEW_STATUSES.has(status)) return; // re-review in progress — keep waiting
    if (GONE_STATUSES.has(status)) {
      updateRemediation(rem.ad_id, { state: "failed", note: `ad ${status.toLowerCase()} during remediation` });
      return;
    }

    // If the user already replaced the creative themselves, this ad is theirs
    // again — stand down instead of pausing their fix.
    if (rem.puppy_creative_id) {
      const currentCreative = await getAdCreativeId(rem.ad_id);
      if (currentCreative && currentCreative !== rem.puppy_creative_id) {
        updateRemediation(rem.ad_id, { state: "failed", note: "creative changed manually during re-review — stood down" });
        await postSlack(
          `:information_source: *${name}*${tag} — its creative was changed manually during re-review, so auto-remediation stood down (status untouched).`,
        );
        return;
      }
    }

    // Anything else (ACTIVE, PAUSED, ADSET_PAUSED, CAMPAIGN_PAUSED, ...) means
    // the placeholder passed review. Now — and only now — turn the ad off.
    await setObjectStatus(rem.ad_id, "PAUSED");
    updateRemediation(rem.ad_id, { state: "approved" });
    // If it's one of ours, mark it killed so no scheduler ever re-activates it.
    const creative = getCreativeByAdId(rem.ad_id);
    if (creative) updateCreative(creative.id, { status: "killed" });
    await postSlack(`:white_check_mark: *${name}*${tag} re-approved → turned off. Account record clean.`);
  } catch (error) {
    console.warn(`Remediation progress failed for ad ${rem.ad_id}:`, error);
  } finally {
    inFlight.delete(rem.ad_id);
  }
}

/** Advance every pending remediation present in a pre-fetched status map. */
export async function progressRemediations(statuses: Map<string, AdStatusInfo>): Promise<void> {
  for (const rem of listRemediationsByState("swapped")) {
    const info = statuses.get(rem.ad_id);
    if (info) await progressRemediation(rem, info);
  }
}

let watching = false;

/**
 * Fast approval watcher, called on every 30s tick: while any remediation is
 * awaiting re-review, check just those ads (one small batched Graph call) so
 * the pause lands within seconds of approval. Zero API calls when idle.
 */
export function maybeWatchRemediations(): void {
  if (watching) return;
  const pending = listRemediationsByState("swapped");
  if (pending.length === 0) return;
  watching = true;
  void (async () => {
    const statuses = await getAdStatuses(pending.map((r) => r.ad_id));
    await progressRemediations(statuses);
  })()
    .catch((error) => console.warn("Remediation watch failed:", error))
    .finally(() => {
      watching = false;
    });
}
