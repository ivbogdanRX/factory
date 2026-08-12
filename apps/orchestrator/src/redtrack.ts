/**
 * RedTrack reporting client. RedTrack is the conversion source of truth for
 * guardrails (the user doesn't trust Meta's attribution); Meta stays the
 * source of truth for spend.
 *
 * Ad destination links carry sub1={{ad.id}} / sub3={{campaign.id}}, so
 * GET https://api.redtrack.io/report?group=sub1|sub3 attributes RedTrack
 * clicks/conversions/revenue back to our Meta ad/campaign ids. Verified
 * against the live account 2026-08-11: rows come back as an array of
 * { sub1|sub3, clicks, conversions, revenue, cost, cpa, ... }.
 *
 * Quirks (observed on the real account):
 * - Some rows carry an empty sub or the literal unresolved macro
 *   "{{campaign.id}}" (preview/bot clicks) — callers get them keyed as-is
 *   and should look up by exact Meta id, which naturally skips those.
 * - The account timezone is US Pacific, so date_from/date_to are PT days,
 *   matching our PT-based flight windows.
 * - Back-to-back requests get HTTP 429 — hence the retry-with-delay below.
 */
import { env } from "./env.js";

const API_BASE = "https://api.redtrack.io";
const CACHE_TTL_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 20_000;

export interface RedtrackStats {
  clicks: number;
  conversions: number;
  revenue: number;
}

/** Map of sub value (Meta ad id or campaign id) → aggregated stats. */
export type RedtrackStatsBySub = Map<string, RedtrackStats>;

const cache = new Map<string, { at: number; stats: RedtrackStatsBySub }>();

export function redtrackConfigured(): boolean {
  return env.redtrackApiKey.length > 0;
}

/**
 * The RedTrack campaign id is the path segment of the tracking link we put in
 * the ad (e.g. https://visit.instfunds.com/6a7637e09275ed0cb84381e0?sub1=...).
 */
export function redtrackCampaignIdFromUrl(websiteUrl: string): string | null {
  try {
    const segment = new URL(websiteUrl).pathname.split("/").filter(Boolean)[0] ?? "";
    return /^[0-9a-f]{24}$/i.test(segment) ? segment : null;
  } catch {
    return null;
  }
}

/**
 * Clicks/conversions/revenue grouped by a sub param for one RedTrack campaign
 * and date range (inclusive, YYYY-MM-DD in the account's timezone = PT).
 *
 * Returns null when RedTrack is unreachable or misconfigured — callers must
 * treat that as "no data this cycle" and skip, never as zero conversions.
 */
export async function getStatsBySub(options: {
  rtCampaignId: string;
  group: "sub1" | "sub3";
  dateFrom: string;
  dateTo: string;
}): Promise<RedtrackStatsBySub | null> {
  if (!redtrackConfigured()) return null;
  const { rtCampaignId, group, dateFrom, dateTo } = options;

  const cacheKey = `${rtCampaignId}:${group}:${dateFrom}:${dateTo}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.stats;

  const params = new URLSearchParams({
    api_key: env.redtrackApiKey,
    group,
    date_from: dateFrom,
    date_to: dateTo,
    campaign_id: rtCampaignId,
  });
  try {
    let response: Response | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2_000 * attempt));
      response = await fetch(`${API_BASE}/report?${params}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.status !== 429) break; // rate limited — wait and retry
    }
    if (!response || !response.ok) {
      console.warn(`RedTrack report failed: HTTP ${response?.status} ${(await response?.text().catch(() => "")) ?? ""}`);
      return null;
    }
    const rows = (await response.json()) as Array<Record<string, unknown>>;
    if (!Array.isArray(rows)) {
      console.warn("RedTrack report returned an unexpected shape", rows);
      return null;
    }
    const stats: RedtrackStatsBySub = new Map();
    for (const row of rows) {
      const key = String(row[group] ?? "");
      if (!key) continue;
      const prev = stats.get(key) ?? { clicks: 0, conversions: 0, revenue: 0 };
      stats.set(key, {
        clicks: prev.clicks + Number(row.clicks ?? 0),
        conversions: prev.conversions + Number(row.conversions ?? 0),
        revenue: prev.revenue + Number(row.revenue ?? 0),
      });
    }
    cache.set(cacheKey, { at: Date.now(), stats });
    return stats;
  } catch (error) {
    console.warn("RedTrack report failed:", error instanceof Error ? error.message : error);
    return null;
  }
}

/** Quick connectivity check; returns the campaign title or null. */
export async function redtrackHealthcheck(rtCampaignId: string): Promise<string | null> {
  if (!redtrackConfigured()) return null;
  try {
    const response = await fetch(
      `${API_BASE}/campaigns/${rtCampaignId}?api_key=${encodeURIComponent(env.redtrackApiKey)}`,
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { title?: string };
    return typeof data.title === "string" ? data.title.trim() : null;
  } catch {
    return null;
  }
}
