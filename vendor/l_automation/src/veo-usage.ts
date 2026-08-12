import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT } from "./config.js";

/**
 * Tracks how many Veo generation requests this tool has made, per model.
 *
 * - Per-minute counts (RPM) are kept in memory (transient sliding window).
 * - Per-day counts (RPD) are persisted to disk so they survive server
 *   restarts, and reset at midnight Pacific to match Google's quota window.
 *
 * Note: this only counts requests made *through this tool*; the Gemini API has
 * no endpoint to read your real remaining quota, so treat it as a close
 * estimate, not gospel.
 */

const USAGE_FILE = join(PROJECT_ROOT, ".veo-usage.json");
const RPM_WINDOW_MS = 60_000;

interface DailyUsage {
  /** Pacific calendar day, e.g. "2026-06-16". */
  day: string;
  /** Per-model request count for `day`. */
  rpd: Record<string, number>;
}

/** Per-model timestamps of recent requests, for the rolling RPM window. */
const recent: Record<string, number[]> = {};

/** Pacific-time calendar day as YYYY-MM-DD (matches Gemini quota reset). */
function pacificDay(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function load(): DailyUsage {
  try {
    if (existsSync(USAGE_FILE)) {
      const parsed = JSON.parse(readFileSync(USAGE_FILE, "utf8"));
      if (parsed && typeof parsed.day === "string") {
        return { day: parsed.day, rpd: parsed.rpd ?? {} };
      }
    }
  } catch {
    // corrupt/missing — start fresh
  }
  return { day: pacificDay(), rpd: {} };
}

let daily: DailyUsage = load();

function save(): void {
  try {
    writeFileSync(USAGE_FILE, JSON.stringify(daily));
  } catch {
    // best-effort; usage tracking is non-critical
  }
}

/** Reset the daily counters when the Pacific day rolls over. */
function rollDay(): void {
  const today = pacificDay();
  if (daily.day !== today) {
    daily = { day: today, rpd: {} };
    save();
  }
}

/** Record one Veo API request against a model. */
export function recordVeoRequest(model: string): void {
  rollDay();
  daily.rpd[model] = (daily.rpd[model] ?? 0) + 1;
  save();
  (recent[model] ??= []).push(Date.now());
}

export interface VeoModelUsage {
  rpmUsed: number;
  rpdUsed: number;
}

/** Current per-minute and per-day usage for a model. */
export function getVeoUsage(model: string): VeoModelUsage {
  rollDay();
  const now = Date.now();
  const arr = (recent[model] ??= []).filter((t) => now - t < RPM_WINDOW_MS);
  recent[model] = arr;
  return { rpmUsed: arr.length, rpdUsed: daily.rpd[model] ?? 0 };
}

/** The Pacific day the current daily counts belong to. */
export function getVeoUsageDay(): string {
  rollDay();
  return daily.day;
}
