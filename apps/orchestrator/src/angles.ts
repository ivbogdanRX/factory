/**
 * Creative angles: each studio campaign variant (persona/scene concept) is an
 * "angle" (UGC selfie vet, older veteran, military spouse, ...). The daily mix
 * is sampled with weights derived from finished flights, so angles that buy
 * purchases cheaply get more slots while losers still get occasional retests.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VENDOR_STUDIO_DIR } from "./env.js";
import { listMeasuredCreatives } from "./db.js";
import { familyFromId } from "./family.js";
import type { AngleMixConfig } from "./verticals.js";

export interface Angle {
  index: number;
  id: string;
  name: string;
}

export interface AngleStats {
  id: string;
  name: string;
  verticalId: string;
  family: string;
  creatives: number;
  spend: number;
  purchases: number;
  impressions: number;
  clicks: number;
  costPerPurchase: number | null;
  weight: number;
}

/** Variants of a studio campaign, read straight from vendor config.json. */
export function loadAngles(creativeCampaignId: string): Angle[] {
  const raw = JSON.parse(readFileSync(join(VENDOR_STUDIO_DIR, "config.json"), "utf8")) as {
    campaigns?: Array<{ id?: string; variants?: Array<{ id?: string; name?: string }> }>;
  };
  const campaign = (raw.campaigns ?? []).find((c) => c.id === creativeCampaignId);
  return (campaign?.variants ?? []).map((v, index) => ({
    index,
    id: v.id ?? `variant-${index + 1}`,
    name: v.name ?? v.id ?? `Variant ${index + 1}`,
  }));
}

/**
 * Smoothed purchase-efficiency weight: (purchases + 1) / (spend$ + 25).
 * With no data every angle is equal; an angle that spent $250 with no
 * purchases drops to ~1/10 the weight of an untested one, while a winner
 * with cheap purchases dominates without ever fully starving the rest.
 */
export function angleStats(verticalId: string, creativeCampaignId: string): AngleStats[] {
  const angles = loadAngles(creativeCampaignId);
  const measured = listMeasuredCreatives(verticalId);
  return angles.map((angle) => {
    const rows = measured.filter((c) => c.angle === angle.id);
    const spend = rows.reduce((sum, c) => sum + (c.spend ?? 0), 0);
    const purchases = rows.reduce((sum, c) => sum + (c.purchases ?? 0), 0);
    return {
      id: angle.id,
      name: angle.name,
      verticalId,
      family: familyFromId(verticalId) === "other" ? familyFromId(creativeCampaignId) : familyFromId(verticalId),
      creatives: rows.length,
      spend,
      purchases,
      impressions: rows.reduce((sum, c) => sum + (c.impressions ?? 0), 0),
      clicks: rows.reduce((sum, c) => sum + (c.clicks ?? 0), 0),
      costPerPurchase: purchases > 0 ? spend / purchases : null,
      weight: (purchases + 1) / (spend + 25),
    };
  });
}

/** Weighted sample (with replacement) of `count` angles from one pool. */
function sampleWeighted(pool: Angle[], weightOf: (a: Angle) => number, count: number): Angle[] {
  const weights = pool.map(weightOf);
  const total = weights.reduce((sum, w) => sum + w, 0);
  const picked: Angle[] = [];
  for (let i = 0; i < count; i++) {
    let roll = Math.random() * total;
    let chosen = pool[pool.length - 1]!;
    for (let j = 0; j < pool.length; j++) {
      roll -= weights[j]!;
      if (roll <= 0) {
        chosen = pool[j]!;
        break;
      }
    }
    picked.push(chosen);
  }
  return picked;
}

/**
 * Pick today's `count` angles. When `mix.ugcAngleIds` is set, the count is
 * first split between the UGC group and the rest using the configured
 * `ugcShare` with deterministic largest-remainder rounding (e.g. 6 ads at
 * 0.8 → always 5 UGC / 1 other). Performance weighting still applies within
 * each group. Without a mix config every angle competes in one pool.
 */
export function pickAngles(
  verticalId: string,
  creativeCampaignId: string,
  count: number,
  mix?: AngleMixConfig,
): Angle[] {
  const angles = loadAngles(creativeCampaignId);
  if (angles.length === 0) return [];
  const stats = angleStats(verticalId, creativeCampaignId);
  const weightOf = (a: Angle): number => stats.find((s) => s.id === a.id)?.weight ?? 1;

  const ugcIds = new Set(mix?.ugcAngleIds ?? []);
  const ugcPool = angles.filter((a) => ugcIds.has(a.id));
  const restPool = angles.filter((a) => !ugcIds.has(a.id));
  // No grouping configured (or one side is empty): single weighted pool.
  if (!mix || ugcPool.length === 0 || restPool.length === 0) {
    return sampleWeighted(angles, weightOf, count);
  }

  // Largest-remainder split of `count` between the two groups.
  const exactUgc = count * mix.ugcShare;
  let ugcCount = Math.floor(exactUgc);
  const exactRest = count - exactUgc;
  let restCount = Math.floor(exactRest);
  let leftover = count - ugcCount - restCount;
  if (leftover > 0) {
    if (exactUgc - ugcCount >= exactRest - restCount) ugcCount += leftover;
    else restCount += leftover;
  }

  return [
    ...sampleWeighted(ugcPool, weightOf, ugcCount),
    ...sampleWeighted(restPool, weightOf, restCount),
  ];
}
