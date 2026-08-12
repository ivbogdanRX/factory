import type { CampaignConfig, CampaignVariant } from "./config.js";
import type { CampaignRunChoices } from "./campaigns.js";
import {
  DEFAULT_MAX_HOOK_SECONDS,
  estimateSpeakSeconds,
  hookFitsDuration,
} from "./hook-duration.js";
import { log } from "./logger.js";
import { stripDashes } from "./speech-sanitizer.js";

export interface PickCampaignOptions {
  runIndex: number;
  /** Lock a persona/variant (0-based). Omit for random persona each run. */
  variantIndex?: number;
  /** Lock hook line within the variant (0-based). Omit to shuffle without repeat. */
  hookIndex?: number;
  /** Use this exact spoken hook line, bypassing the variant's hooks entirely. */
  hookOverride?: string;
  /** Override top bubble text for this batch. Empty = campaign / variant defaults. */
  hookBubbleText?: string;
  /** When true (default), persona + hook are picked randomly / shuffled. */
  random?: boolean;
}

/** Resolve persona variants from `variants[]` or legacy parallel prompt arrays. */
export function resolveVariants(campaign: CampaignConfig): CampaignVariant[] {
  if (campaign.variants.length > 0) return campaign.variants;

  const n = Math.max(
    campaign.creatorPrompts.length,
    campaign.scenePrompts.length,
    campaign.cameraPrompts.length,
    1,
  );
  const out: CampaignVariant[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `variant-${i + 1}`,
      name: `Variant ${i + 1}`,
      creatorPrompt: campaign.creatorPrompts[i] ?? "",
      scenePrompt: campaign.scenePrompts[i] ?? "",
      cameraPrompt: campaign.cameraPrompts[i] ?? "",
      hooks:
        campaign.hooks.length > 0
          ? campaign.hooks
          : [`Hook line for variant ${i + 1}`],
      bubbleHooks: [],
    });
  }
  return out;
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

function pickRandomInt(max: number): number {
  return Math.floor(Math.random() * (max + 1));
}

function maxHookSeconds(campaign: CampaignConfig): number {
  return campaign.maxHookSeconds > 0
    ? campaign.maxHookSeconds
    : DEFAULT_MAX_HOOK_SECONDS;
}

function eligibleHooks(
  variant: CampaignVariant,
  maxSeconds: number,
): { hook: string; index: number }[] {
  const eligible = variant.hooks
    .map((hook, index) => ({ hook, index }))
    .filter(({ hook }) => hookFitsDuration(hook, maxSeconds));
  if (eligible.length > 0) return eligible;
  return variant.hooks.map((hook, index) => ({ hook, index }));
}

/**
 * Picks persona + hook for one run. When generating a batch:
 * - random mode + no locked persona → random persona + shuffled hooks per persona
 * - locked persona → only that persona, hooks shuffled without repeat until exhausted
 */
export class CampaignBatchPicker {
  private readonly variants: CampaignVariant[];
  private readonly maxSeconds: number;
  private readonly bodyVideos: string[];
  private bodyQueue: number[] = [];
  private readonly hookQueues = new Map<number, number[]>();
  private readonly bubbleQueues = new Map<number, number[]>();

  constructor(
    private readonly campaign: CampaignConfig,
    private readonly opts: Omit<PickCampaignOptions, "runIndex">,
  ) {
    this.variants = resolveVariants(campaign);
    if (this.variants.length === 0) {
      throw new Error(`Campaign "${campaign.id}" has no variants or prompts configured.`);
    }
    this.maxSeconds = maxHookSeconds(campaign);
    // Pool = primary body clip plus any extras, de-duplicated, order preserved.
    this.bodyVideos = [campaign.bodyVideo, ...campaign.bodyVideos].filter(
      (v, i, arr) => v && v.trim().length > 0 && arr.indexOf(v) === i,
    );
  }

  pick(runIndex: number): CampaignRunChoices {
    const variantIdx = this.pickVariantIndex(runIndex);
    const variant = this.variants[variantIdx]!;
    // Dash-free guarantee: every path a spoken/burned line can take (config
    // hooks, hookIndex, hookOverride, bubble override) funnels through here.
    const { hook: rawHook, hookIdx } = this.pickHook(variantIdx, variant);
    const hook = stripDashes(rawHook);
    const bubbleText = stripDashes(this.pickBubbleText(variantIdx, variant, hook));
    const bodyVideo = this.pickBodyVideo(runIndex);

    const seconds = estimateSpeakSeconds(hook);
    if (!hookFitsDuration(hook, this.maxSeconds)) {
      log.warn(
        `Hook may run long (~${seconds.toFixed(1)}s > ${this.maxSeconds}s target): "${hook.slice(0, 60)}..."`,
      );
    }

    return {
      hook,
      creatorPrompt: variant.creatorPrompt,
      scenePrompt: stripDashes(variant.scenePrompt),
      cameraPrompt: variant.cameraPrompt,
      variantId: variant.id,
      variantName: variant.name,
      variantIndex: variantIdx,
      hookIndex: hookIdx,
      estimatedSpeakSeconds: seconds,
      bubbleText,
      bodyVideo,
    };
  }

  /** Rotate body clips: sequential when --no-random, otherwise shuffled without repeat. */
  private pickBodyVideo(runIndex: number): string {
    if (this.bodyVideos.length <= 1) return this.bodyVideos[0] ?? this.campaign.bodyVideo;
    if (this.opts.random === false) {
      return this.bodyVideos[(runIndex - 1) % this.bodyVideos.length]!;
    }
    if (this.bodyQueue.length === 0) {
      this.bodyQueue = shuffle(this.bodyVideos.map((_, index) => index));
    }
    return this.bodyVideos[this.bodyQueue.shift()!]!;
  }

  private pickBubbleText(
    variantIdx: number,
    variant: CampaignVariant,
    spokenHook: string,
  ): string {
    if (this.opts.hookBubbleText?.trim()) {
      return this.opts.hookBubbleText.trim();
    }
    if (this.campaign.hookBubbleText.trim()) {
      return this.campaign.hookBubbleText.trim();
    }
    const pool = variant.bubbleHooks.filter((line) => line.trim().length > 0);
    if (pool.length === 0) {
      return spokenHook;
    }
    if (!this.bubbleQueues.has(variantIdx)) {
      this.bubbleQueues.set(
        variantIdx,
        shuffle(pool.map((_, index) => index)),
      );
    }
    let queue = this.bubbleQueues.get(variantIdx)!;
    if (queue.length === 0) {
      queue = shuffle(pool.map((_, index) => index));
      this.bubbleQueues.set(variantIdx, queue);
    }
    return pool[queue.shift()!]!;
  }

  private pickVariantIndex(runIndex: number): number {
    if (this.opts.variantIndex !== undefined) {
      if (this.opts.variantIndex < 0 || this.opts.variantIndex >= this.variants.length) {
        throw new Error(
          `Variant index ${this.opts.variantIndex} is out of range for campaign "${this.campaign.id}" ` +
            `(0-${this.variants.length - 1}).`,
        );
      }
      return this.opts.variantIndex;
    }
    if (this.opts.random === false) {
      return (runIndex - 1) % this.variants.length;
    }
    return pickRandomInt(this.variants.length - 1);
  }

  private pickHook(
    variantIdx: number,
    variant: CampaignVariant,
  ): { hook: string; hookIdx: number } {
    if (this.opts.hookOverride?.trim()) {
      return { hook: this.opts.hookOverride.trim(), hookIdx: -1 };
    }
    const pool = eligibleHooks(variant, this.maxSeconds);
    if (pool.length === 0) {
      throw new Error(`Variant "${variant.id}" in campaign "${this.campaign.id}" has no hooks.`);
    }

    if (this.opts.hookIndex !== undefined) {
      if (this.opts.hookIndex < 0 || this.opts.hookIndex >= variant.hooks.length) {
        throw new Error(
          `Hook index ${this.opts.hookIndex} is out of range for variant "${variant.id}" ` +
            `(0-${variant.hooks.length - 1}).`,
        );
      }
      return { hook: variant.hooks[this.opts.hookIndex]!, hookIdx: this.opts.hookIndex };
    }

    if (!this.hookQueues.has(variantIdx)) {
      this.hookQueues.set(
        variantIdx,
        shuffle(pool.map((p) => p.index)),
      );
    }
    let queue = this.hookQueues.get(variantIdx)!;
    if (queue.length === 0) {
      queue = shuffle(pool.map((p) => p.index));
      this.hookQueues.set(variantIdx, queue);
    }
    const hookIdx = queue.shift()!;
    return { hook: variant.hooks[hookIdx]!, hookIdx };
  }
}
