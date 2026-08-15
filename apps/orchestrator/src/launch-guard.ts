/**
 * Friction around manual production launches so the phone button can never
 * slam the ad accounts:
 *  - one global 10-minute cooldown (a double-tap can't start two runs);
 *  - one per-account 6-hour cooldown (an account gets at most ~2 manual
 *    launches a day on top of the scheduled one — new campaigns in quick
 *    succession look like automation abuse to Meta's risk systems).
 * Timestamps live in the settings table so restarts don't reset them.
 */
import { getSetting, setSetting } from "./db.js";

export const GLOBAL_LAUNCH_COOLDOWN_MS = 10 * 60 * 1000;
export const ACCOUNT_LAUNCH_COOLDOWN_MS = 6 * 60 * 60 * 1000;

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
  if (accountId) setSetting(`lastManualLaunch:${accountId}`, now);
}
