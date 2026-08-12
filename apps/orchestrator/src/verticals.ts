import { readFileSync, writeFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { VERTICALS_PATH } from "./env.js";

export interface AdSettings {
  headline: string;
  primaryText: string;
  description: string;
  callToAction: string;
  websiteUrl: string;
  displayUrl: string;
}

export interface VerticalNaming {
  campaign: string;
  adSet: string;
  ad: string;
}

export interface VerticalMeta {
  adAccountId: string;
  pageId: string;
  mode: "new-campaign" | "new-adset" | "existing-adset";
  parentCampaignId: string;
  existingAdSetId: string;
  templateAdSetId: string;
  /** Campaign objective for new-campaign mode (e.g. OUTCOME_SALES). */
  objective: string;
  /** CBO campaign daily budget in cents (new-campaign mode). */
  cboDailyBudgetCents: number;
  /** LOWEST_COST_WITHOUT_CAP (highest volume) or LOWEST_COST_WITH_BID_CAP. */
  bidStrategy: string;
  /** Ad set bid cap in cents; only used with LOWEST_COST_WITH_BID_CAP. */
  bidCapCents: number;
  /** Conversion pixel + event for the ad set promoted_object. */
  pixelId: string;
  pixelEvent: string;
  /** ABO ad set budget in cents (new-adset mode without a template). */
  dailyBudgetCents: number;
  optimizationGoal: string;
  specialAdCategories: string[];
  adSettings: AdSettings;
  naming: VerticalNaming;
}

export interface GuardrailConfig {
  enabled: boolean;
  /** Rule A: pause an ad at this Meta spend with zero RedTrack conversions. */
  adKillSpendUsd: number;
  /** Rule B: campaign Meta spend needed before the CPA guard applies. */
  campaignGuardMinSpendUsd: number;
  /** Rule B: pause the campaign when RedTrack CPA exceeds this. */
  maxCpaUsd: number;
  /** Rule C: extend the flight while RedTrack CPA is under this. */
  extendUnderCpaUsd: number;
  /** Rule C: total extra days a flight can be extended. */
  maxExtensionDays: number;
  /** Rule D: flight-to-date Meta spend needed before a scale-up is considered. */
  scaleMinSpendUsd: number;
  /** Rule D: minimum RedTrack revenue / Meta spend to justify a scale-up. */
  scaleAtRoas: number;
  /** Rule D: budget ladder in USD/day, ascending (e.g. [100, 250, 500]). */
  scaleSteps: number[];
}

export interface AngleMixConfig {
  /** Share of the daily creatives drawn from the UGC angle group (0..1). */
  ugcShare: number;
  /** Studio variant ids that count as UGC-style; empty = no grouping. */
  ugcAngleIds: string[];
}

export interface Vertical {
  id: string;
  label: string;
  enabled: boolean;
  creativeCampaignId: string;
  dailyCount: number;
  angles: AngleMixConfig;
  meta: VerticalMeta;
  schedule: { startHourPt: number; flightDays: number };
  guardrails: GuardrailConfig;
}

interface VerticalsFile {
  verticals: Vertical[];
}

export function loadVerticals(): Vertical[] {
  const raw = parse(readFileSync(VERTICALS_PATH, "utf8")) as VerticalsFile;
  return (raw?.verticals ?? []).map(normalize);
}

function normalize(v: Partial<Vertical> & { id: string }): Vertical {
  return {
    id: v.id,
    label: v.label ?? v.id,
    enabled: Boolean(v.enabled),
    creativeCampaignId: v.creativeCampaignId ?? "",
    dailyCount: Math.max(1, Number(v.dailyCount ?? 1)),
    angles: {
      ugcShare: Math.min(1, Math.max(0, Number(v.angles?.ugcShare ?? 0.8))),
      ugcAngleIds: Array.isArray(v.angles?.ugcAngleIds) ? v.angles.ugcAngleIds.map(String) : [],
    },
    meta: {
      adAccountId: v.meta?.adAccountId ?? "",
      pageId: v.meta?.pageId ?? "",
      mode:
        v.meta?.mode === "existing-adset" || v.meta?.mode === "new-adset"
          ? v.meta.mode
          : "new-campaign",
      parentCampaignId: v.meta?.parentCampaignId ?? "",
      existingAdSetId: v.meta?.existingAdSetId ?? "",
      templateAdSetId: v.meta?.templateAdSetId ?? "",
      objective: v.meta?.objective ?? "OUTCOME_SALES",
      cboDailyBudgetCents: Number(v.meta?.cboDailyBudgetCents ?? 25000),
      bidStrategy: v.meta?.bidStrategy ?? "LOWEST_COST_WITHOUT_CAP",
      bidCapCents: Number(v.meta?.bidCapCents ?? 0),
      pixelId: v.meta?.pixelId ?? "",
      pixelEvent: v.meta?.pixelEvent ?? "PURCHASE",
      dailyBudgetCents: Number(v.meta?.dailyBudgetCents ?? 5000),
      optimizationGoal: v.meta?.optimizationGoal ?? "OFFSITE_CONVERSIONS",
      specialAdCategories: v.meta?.specialAdCategories ?? [],
      adSettings: {
        headline: v.meta?.adSettings?.headline ?? "",
        primaryText: v.meta?.adSettings?.primaryText ?? "",
        description: v.meta?.adSettings?.description ?? "",
        callToAction: v.meta?.adSettings?.callToAction ?? "LEARN_MORE",
        websiteUrl: v.meta?.adSettings?.websiteUrl ?? "",
        displayUrl: v.meta?.adSettings?.displayUrl ?? "",
      },
      naming: {
        campaign: (v.meta?.naming as Partial<VerticalNaming>)?.campaign ?? "(IB) {vertical} {date}",
        adSet: (v.meta?.naming as Partial<VerticalNaming>)?.adSet ?? "(IB) {vertical} {date}",
        ad: (v.meta?.naming as Partial<VerticalNaming>)?.ad ?? "(IB) {vertical} {date} v{n}",
      },
    },
    schedule: {
      startHourPt: Number(v.schedule?.startHourPt ?? 5),
      flightDays: Math.max(1, Number(v.schedule?.flightDays ?? 3)),
    },
    guardrails: {
      enabled: v.guardrails?.enabled ?? true,
      adKillSpendUsd: Number(v.guardrails?.adKillSpendUsd ?? 50),
      campaignGuardMinSpendUsd: Number(v.guardrails?.campaignGuardMinSpendUsd ?? 100),
      maxCpaUsd: Number(v.guardrails?.maxCpaUsd ?? 120),
      extendUnderCpaUsd: Number(v.guardrails?.extendUnderCpaUsd ?? 80),
      maxExtensionDays: Math.max(0, Number(v.guardrails?.maxExtensionDays ?? 2)),
      scaleMinSpendUsd: Number(v.guardrails?.scaleMinSpendUsd ?? 75),
      scaleAtRoas: Number(v.guardrails?.scaleAtRoas ?? 1.0),
      scaleSteps: (Array.isArray(v.guardrails?.scaleSteps) && v.guardrails.scaleSteps.length > 0
        ? v.guardrails.scaleSteps.map(Number).filter((n) => Number.isFinite(n) && n > 0)
        : [100, 250, 500]
      ).sort((a, b) => a - b),
    },
  };
}

export function saveVerticals(verticals: Vertical[]): void {
  writeFileSync(VERTICALS_PATH, stringify({ verticals }), "utf8");
}

export function getVertical(id: string): Vertical | undefined {
  return loadVerticals().find((v) => v.id === id);
}

/** Shallow-merge a patch into one vertical and persist the file. */
export function patchVertical(id: string, patch: Record<string, unknown>): Vertical {
  const all = loadVerticals();
  const idx = all.findIndex((v) => v.id === id);
  if (idx === -1) throw new Error(`Unknown vertical: ${id}`);
  const current = all[idx]!;
  const merged: Vertical = {
    ...current,
    ...(patch as Partial<Vertical>),
    meta: {
      ...current.meta,
      ...((patch.meta as Partial<VerticalMeta>) ?? {}),
      adSettings: {
        ...current.meta.adSettings,
        ...(((patch.meta as Partial<VerticalMeta>) ?? {}).adSettings ?? {}),
      },
      naming: {
        ...current.meta.naming,
        ...(((patch.meta as Partial<VerticalMeta>) ?? {}).naming ?? {}),
      },
    },
    schedule: { ...current.schedule, ...((patch.schedule as Partial<Vertical["schedule"]>) ?? {}) },
    guardrails: { ...current.guardrails, ...((patch.guardrails as Partial<GuardrailConfig>) ?? {}) },
    id: current.id,
  };
  all[idx] = merged;
  saveVerticals(all);
  return merged;
}
