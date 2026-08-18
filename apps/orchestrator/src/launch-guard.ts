/**
 * Friction around production launches so we never look like a fan-out bot:
 *  - one global 10-minute cooldown (a double-tap can't start two runs);
 *  - one per-account 6-hour cooldown;
 *  - one ad account per PT calendar day (same videos on two accounts in
 *    minutes is what triggered Spam on 8-17);
 *  - cold accounts (lifetime spend under $75) get a 3-ad / $25 CBO cap.
 * Timestamps live in the settings table so restarts don't reset them.
 */
import { getSetting, setSetting } from "./db.js";
import { PT, todayInTimeZone } from "./schedule.js";

export const GLOBAL_LAUNCH_COOLDOWN_MS = 10 * 60 * 1000;
export const ACCOUNT_LAUNCH_COOLDOWN_MS = 6 * 60 * 60 * 1000;
export const WARMUP_SPEND_USD = 75;
export const WARMUP_MAX_ADS = 3;
export const WARMUP_BUDGET_CENTS = 2_500;

const LAUNCH_ACCOUNT_KEY = "lastLaunchAccountId";
const LAUNCH_DAY_KEY = "lastLaunchPtDate";

export function globalCooldownMsLeft(): number {
  const last = Number(getSetting("lastManualLaunchAt") ?? 0);
  return Math.max(0, GLOBAL_LAUNCH_COOLDOWN_MS - (Date.now() - last));
}

export function accountCooldownMsLeft(accountId: string): number {
  const last = Number(getSetting(`lastManualLaunch:${accountId}`) ?? 0);
  return Math.max(0, ACCOUNT_LAUNCH_COOLDOWN_MS - (Date.now() - last));
}

export function recordLaunch(accountId: string | undefined): void {
  const now = String(Date.now());
  setSetting("lastManualLaunchAt", now);
  if (accountId) {
    setSetting(`lastManualLaunch:${accountId}`, now);
    setSetting(LAUNCH_ACCOUNT_KEY, accountId);
    setSetting(LAUNCH_DAY_KEY, todayInTimeZone(PT));
  }
}

/**
 * Refuse a second account on the same PT day. Same-account retries after the
 * 6h cooldown are allowed (drafts / replacements), but not a fan-out.
 */
export function assertOneAccountPerDay(accountId: string): void {
  const day = todayInTimeZone(PT);
  const lastDay = getSetting(LAUNCH_DAY_KEY);
  const lastAccount = getSetting(LAUNCH_ACCOUNT_KEY);
  if (lastDay === day && lastAccount && lastAccount !== accountId) {
    throw new Error(
      `Already launched on ${lastAccount} today (${day} PT). One account per day — wait until tomorrow or reuse that account.`,
    );
  }
}

export function warmupLimits(lifetimeSpendUsd: number): { maxAds: number; budgetCents: number; warmup: boolean } {
  if (lifetimeSpendUsd < WARMUP_SPEND_USD) {
    return { maxAds: WARMUP_MAX_ADS, budgetCents: WARMUP_BUDGET_CENTS, warmup: true };
  }
  return { maxAds: Number.POSITIVE_INFINITY, budgetCents: Number.POSITIVE_INFINITY, warmup: false };
}
