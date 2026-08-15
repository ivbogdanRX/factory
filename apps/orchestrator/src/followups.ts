/**
 * Dated campaign checks that must not depend on someone remembering.
 *
 * Stored in settings.followups. Seeded defaults (e.g. X2275 after a manual
 * scale) are merged in on first load. The 30s tick:
 *   1. Announces a newly seeded watch once (current numbers + due date).
 *   2. On the due PT morning (same hour as the digest) posts a formal
 *      Meta-spend / RedTrack-conversion check with a hold-or-scale line.
 *
 * Never writes to Meta. (IB) clones that are not factory runs are allowed —
 * we look them up by campaign id, not the runs table.
 */
import { getSetting, setSetting } from "./db.js";
import { getCampaignInsights, getCampaignDailyBudgetCents, getObjectName } from "./meta.js";
import { getStatsBySub, redtrackConfigured } from "./redtrack.js";
import { nowClockInTimeZone, todayInTimeZone, PT } from "./schedule.js";
import { postSlack } from "./slack.js";

export interface FollowUp {
  id: string;
  campaignId: string;
  campaignName: string;
  rtCampaignId: string;
  /** YYYY-MM-DD in America/Los_Angeles. */
  dueDate: string;
  note: string;
  maxCpaUsd: number;
  scaleHint: string;
  status: "pending" | "posted";
  announced?: boolean;
  postedAt?: string;
}

export interface FollowUpGlance {
  id: string;
  campaignName: string;
  note: string;
  dueDate: string;
  dueLabel: string;
  due: boolean;
  status: "pending" | "posted";
}

const SETTING_KEY = "followups";

const DEFAULTS: FollowUp[] = [
  {
    id: "x2275-200-scale",
    campaignId: "120250407331800638",
    campaignName: "(IB) LNV 3 X2275",
    rtCampaignId: "6a7637e09275ed0cb84381e0",
    dueDate: "2026-08-15",
    note: "Check the $200/day scale. If RedTrack CPA stays under ~$12, next candidate is $350–$500.",
    maxCpaUsd: 12,
    scaleHint: "$350–$500",
    status: "pending",
  },
];

const money = (n: number): string => `$${n.toFixed(2)}`;

function weekdayShort(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const utc = new Date(Date.UTC(y!, m! - 1, d!, 12, 0, 0));
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(
    utc,
  );
}

function loadFollowups(): FollowUp[] {
  const raw = getSetting(SETTING_KEY);
  let stored: FollowUp[] = [];
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as FollowUp[];
      if (Array.isArray(parsed)) stored = parsed;
    } catch {
      stored = [];
    }
  }
  const byId = new Map(stored.map((f) => [f.id, f]));
  let changed = false;
  for (const seed of DEFAULTS) {
    if (!byId.has(seed.id)) {
      byId.set(seed.id, { ...seed });
      changed = true;
    }
  }
  const all = [...byId.values()];
  if (changed || !raw) saveFollowups(all);
  return all;
}

function saveFollowups(items: FollowUp[]): void {
  setSetting(SETTING_KEY, JSON.stringify(items));
}

function updateFollowup(id: string, patch: Partial<FollowUp>): FollowUp | null {
  const items = loadFollowups();
  const idx = items.findIndex((f) => f.id === id);
  if (idx < 0) return null;
  items[idx] = { ...items[idx]!, ...patch };
  saveFollowups(items);
  return items[idx]!;
}

export function listPendingFollowups(): FollowUp[] {
  return loadFollowups().filter((f) => f.status === "pending");
}

/** Compact lines for the morning digest. */
export function followupDigestLines(): string[] {
  const today = todayInTimeZone(PT);
  const pending = listPendingFollowups();
  if (pending.length === 0) return [];
  const due = pending.filter((f) => f.dueDate <= today);
  const upcoming = pending.filter((f) => f.dueDate > today);
  const lines: string[] = [];
  if (due.length > 0) {
    lines.push(
      `*Check today:* ${due.map((f) => `*${f.campaignName}* — ${f.note}`).join(" · ")}`,
    );
  }
  if (upcoming.length > 0) {
    lines.push(
      `*Watching:* ${upcoming.map((f) => `*${f.campaignName}* — ${weekdayShort(f.dueDate)} · ${f.note}`).join(" · ")}`,
    );
  }
  return lines;
}

/** Glance payload: pending watches only. */
export function glanceFollowups(): FollowUpGlance[] {
  const today = todayInTimeZone(PT);
  return listPendingFollowups().map((f) => ({
    id: f.id,
    campaignName: f.campaignName,
    note: f.note,
    dueDate: f.dueDate,
    dueLabel: weekdayShort(f.dueDate),
    due: f.dueDate <= today,
    status: f.status,
  }));
}

export function recommendScale(cpa: number | null, maxCpaUsd: number, scaleHint: string): string {
  if (cpa === null) return `Not enough RedTrack conversions yet — hold.`;
  if (cpa < maxCpaUsd) {
    return `CPA ${money(cpa)} is under ${money(maxCpaUsd)} — next scale candidate ${scaleHint}. Do not scale from this message; wait for a human.`;
  }
  return `CPA ${money(cpa)} is at/over ${money(maxCpaUsd)} — hold, do not scale.`;
}

interface CheckNumbers {
  name: string;
  budgetUsd: number | null;
  today: { spend: number; rtConv: number; rtRev: number; cpa: number | null; roas: number | null };
  yesterday: { spend: number; rtConv: number; rtRev: number; cpa: number | null; roas: number | null };
}

function packDay(
  spend: number,
  rt: { conversions: number; revenue: number } | undefined,
): CheckNumbers["today"] {
  const rtConv = rt?.conversions ?? 0;
  const rtRev = rt?.revenue ?? 0;
  return {
    spend,
    rtConv,
    rtRev,
    cpa: rtConv > 0 ? spend / rtConv : null,
    roas: spend > 0 && rtRev > 0 ? rtRev / spend : null,
  };
}

async function fetchCheckNumbers(item: FollowUp): Promise<CheckNumbers> {
  const today = todayInTimeZone(PT);
  const [year, month, day] = today.split("-").map(Number);
  const yest = new Date(Date.UTC(year!, month! - 1, day! - 1, 12, 0, 0));
  const yesterday = `${yest.getUTCFullYear()}-${String(yest.getUTCMonth() + 1).padStart(2, "0")}-${String(yest.getUTCDate()).padStart(2, "0")}`;

  const [name, budgetCents, metaToday, metaYest, rtToday, rtYest] = await Promise.all([
    getObjectName(item.campaignId),
    getCampaignDailyBudgetCents(item.campaignId),
    getCampaignInsights(item.campaignId, "today"),
    getCampaignInsights(item.campaignId, "yesterday"),
    redtrackConfigured()
      ? getStatsBySub({
          rtCampaignId: item.rtCampaignId,
          group: "sub3",
          dateFrom: today,
          dateTo: today,
        })
      : Promise.resolve(null),
    redtrackConfigured()
      ? getStatsBySub({
          rtCampaignId: item.rtCampaignId,
          group: "sub3",
          dateFrom: yesterday,
          dateTo: yesterday,
        })
      : Promise.resolve(null),
  ]);

  const rtTodayRow = rtToday?.get(item.campaignId);
  const rtYestRow = rtYest?.get(item.campaignId);
  return {
    name: name ?? item.campaignName,
    budgetUsd: budgetCents != null ? budgetCents / 100 : null,
    today: packDay(metaToday?.spend ?? 0, rtTodayRow),
    yesterday: packDay(metaYest?.spend ?? 0, rtYestRow),
  };
}

function dayLine(label: string, d: CheckNumbers["today"]): string {
  const cpa = d.cpa != null ? money(d.cpa) : "—";
  const roas = d.roas != null ? `${d.roas.toFixed(2)}x` : "—";
  return `*${label}:* Meta ${money(d.spend)} · RT ${d.rtConv} conv / ${money(d.rtRev)} · CPA *${cpa}* · ${roas}`;
}

export async function buildFollowupText(item: FollowUp, kind: "announce" | "due"): Promise<string> {
  const nums = await fetchCheckNumbers(item);
  const budget = nums.budgetUsd != null ? `${money(nums.budgetUsd)}/day` : "budget unknown";
  const rec = recommendScale(nums.today.cpa ?? nums.yesterday.cpa, item.maxCpaUsd, item.scaleHint);
  if (kind === "announce") {
    return [
      `:eyes: *Watching ${nums.name}* (${budget})`,
      item.note,
      `Formal check *${weekdayShort(item.dueDate)}* 8am PT.`,
      dayLine("Right now", nums.today),
      dayLine("Yesterday", nums.yesterday),
    ].join("\n");
  }
  return [
    `:mag: *Scale check — ${nums.name}* (${budget})`,
    item.note,
    dayLine("Today", nums.today),
    dayLine("Yesterday", nums.yesterday),
    `> ${rec}`,
  ].join("\n");
}

async function postAndMark(
  item: FollowUp,
  kind: "announce" | "due",
): Promise<string> {
  const text = await buildFollowupText(item, kind);
  await postSlack(text);
  if (kind === "announce") {
    updateFollowup(item.id, { announced: true });
  } else {
    updateFollowup(item.id, { status: "posted", postedAt: new Date().toISOString(), announced: true });
  }
  return text;
}

/** Manual `/adops check` — current numbers for every pending watch. Does not consume the Saturday post. */
export async function runManualFollowupChecks(): Promise<string[]> {
  const pending = listPendingFollowups();
  if (pending.length === 0) return [];
  const texts: string[] = [];
  for (const item of pending) {
    const text = await buildFollowupText(item, item.dueDate <= todayInTimeZone(PT) ? "due" : "announce");
    await postSlack(text);
    texts.push(text);
  }
  return texts;
}

let running = false;

/**
 * Called from the 30s tick. Announces new watches immediately; posts the
 * formal due check the first tick at/after the digest hour on the due date.
 */
export function maybeRunFollowups(): void {
  if (running) return;
  const pending = listPendingFollowups();
  if (pending.length === 0) return;

  const today = todayInTimeZone(PT);
  const hour = Number(getSetting("digestHourPt") ?? 8);
  const dueHourReached = nowClockInTimeZone(PT).hour >= hour;

  const toAnnounce = pending.filter((f) => !f.announced);
  const toDue = pending.filter((f) => f.dueDate <= today && dueHourReached && f.status === "pending");

  if (toAnnounce.length === 0 && toDue.length === 0) return;
  running = true;
  void (async () => {
    for (const item of toAnnounce) {
      try {
        await postAndMark(item, "announce");
      } catch (error) {
        console.warn(`Follow-up announce failed for ${item.id}:`, error);
      }
    }
    // Re-read: announce may have just posted a due item's "watching" message.
    const stillDue = listPendingFollowups().filter(
      (f) => f.dueDate <= today && dueHourReached && f.status === "pending" && f.announced,
    );
    for (const item of stillDue) {
      try {
        await postAndMark(item, "due");
      } catch (error) {
        console.warn(`Follow-up due check failed for ${item.id}:`, error);
      }
    }
  })().finally(() => {
    running = false;
  });
}
