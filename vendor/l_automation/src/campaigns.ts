import type { AppConfig, CampaignConfig } from "./config.js";
import { DEFAULT_MAX_HOOK_SECONDS } from "./hook-duration.js";
import { IMAGE_GUARDS, NO_HANDS, NO_SCREEN_UI, NO_ZOOM } from "./prompt-guards.js";

export interface CampaignRunChoices {
  hook: string;
  creatorPrompt: string;
  scenePrompt: string;
  cameraPrompt: string;
  variantId: string;
  variantName: string;
  variantIndex: number;
  hookIndex: number;
  estimatedSpeakSeconds: number;
  /** Text burned into the top hook bubble (may differ from spoken hook). */
  bubbleText: string;
  /** Body clip chosen for this run (rotates when the campaign has several). */
  bodyVideo: string;
}

function replaceAll(input: string, replacements: Record<string, string>): string {
  let out = input;
  for (const [key, value] of Object.entries(replacements)) {
    out = out.split(`{{${key}}}`).join(value);
  }
  return out;
}

/** Old configs told the model to hold the phone, which draws a third hand. */
function stripPhoneInHand(text: string): string {
  if (!text) return text;
  return text
    .replace(
      /holding (?:her |his |the |their )?phone at arm'?s length(?: and)?/gi,
      "looking straight through the camera lens",
    )
    .replace(/at arm'?s length/gi, "")
    .replace(/\s+,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Veo swallows the opening "The" if the locked VA line was stored without it. */
function restoreLeadingThe(campaign: CampaignConfig, hook: string): string {
  const out = hook.trim();
  if (campaign.id === "va-loans-veterans" && /^VA has given out DD 214/i.test(out)) {
    return `The ${out}`;
  }
  return out;
}

function defaultCampaignPrompt(
  campaign: CampaignConfig,
  choices: CampaignRunChoices,
): string {
  const context = campaign.promptContext.trim()
    ? `Offer context: ${campaign.promptContext.trim()}`
    : "";
  const vertical = campaign.vertical.trim() || campaign.name;
  const angle = campaign.angle.trim() || "a relatable consumer angle";
  const scene = choices.scenePrompt.trim()
    ? `Creator / scene concept: ${choices.scenePrompt.trim()}`
    : "";

  // Camera framing: per-persona cameraPrompts win, then campaign-wide cameraStyle,
  // then the default front-facing selfie look.
  const framing = stripPhoneInHand(
    choices.cameraPrompt.trim() || campaign.cameraStyle.trim(),
  );
  const cameraBlock = framing
    ? [`Camera framing: ${framing}`]
    : [
        "Camera framing: chest-up talking-head shot framed as if looking straight through the lens, held fairly steady with a tiny natural shake.",
        "The recording device, its screen, any app interface, and the subject's hands or arms are NEVER visible in frame — we only ever see the face and shoulders through the lens.",
        "The person speaks directly into the lens with steady eye contact, natural pauses, and real facial expressions.",
        "Use subtle eyebrow movement and small head nods only.",
      ];

  const firstWord = choices.hook.trim().split(/\s+/).filter(Boolean)[0] ?? "";
  const firstWordLine = firstWord
    ? `Speech: take a short inhale, then clearly say the first word "${firstWord}" in full before continuing. Do not skip, swallow, clip, or mumble the opening word. Start speaking a beat after the clip begins, not on frame zero. Say every word of the Dialogue line, including the first.`
    : "Speech: take a short inhale, then start speaking a beat after the clip begins. Do not skip or swallow the opening word.";

  return [
    "Create a vertical 9:16 video that looks like candid real-life footage.",
    "It should feel real and unpolished, not an ad, not a commercial, and not cinematic.",
    `Vertical / offer: ${vertical}.`,
    `Marketing angle / audience: ${angle}.`,
    context,
    scene,
    "Scene: a realistic, slightly imperfect, lived-in everyday environment that matches the concept.",
    "Keep the main subject clearly visible, with the background present but not distracting.",
    ...cameraBlock,
    NO_HANDS,
    NO_ZOOM,
    `Dialogue: '${choices.hook}'`,
    firstWordLine,
    `Pacing: deliver the full line naturally within about ${campaign.maxHookSeconds || DEFAULT_MAX_HOOK_SECONDS} seconds — clear, tight, and complete. Do not rush or leave words hanging.`,
    "Audio: realistic phone-recorded voice. Natural room tone. Slight background ambience. No music. No robotic voice.",
    // Quality: deliberately NOT pristine. Believable older-phone footage.
    "Image quality: looks like it was captured on an older smartphone camera (around an iPhone 11):",
    "slightly soft, mild compression and sensor noise, natural exposure. NOT 4K, NOT ultra-sharp, NOT cinematic, NOT a professional camera.",
    NO_SCREEN_UI,
    "Lighting: natural available lighting. Realistic skin texture. Soft shadows. Slight imperfections.",
    "Restrictions: no extra unintended people in focus. No dramatic lighting. No perfect influencer-style setup.",
  ]
    .filter(Boolean)
    .join(" ");
}

export function findCampaign(
  cfg: AppConfig,
  campaignId: string | undefined,
): CampaignConfig | undefined {
  if (!campaignId) return undefined;
  const campaign = cfg.campaigns.find((c) => c.id === campaignId);
  if (!campaign) {
    const available = cfg.campaigns.map((c) => c.id).join(", ") || "none configured";
    throw new Error(`Unknown campaign "${campaignId}". Available campaigns: ${available}`);
  }
  return campaign;
}

export { CampaignBatchPicker, resolveVariants } from "./campaign-picker.js";
export type { PickCampaignOptions } from "./campaign-picker.js";

export function applyCampaign(
  cfg: AppConfig,
  campaign: CampaignConfig,
  choices: CampaignRunChoices,
): AppConfig {
  const hook = restoreLeadingThe(campaign, choices.hook);
  const cameraPrompt = stripPhoneInHand(choices.cameraPrompt);
  const creatorPrompt = stripPhoneInHand(choices.creatorPrompt);
  const scenePrompt = stripPhoneInHand(choices.scenePrompt);
  const replacements = {
    hook,
    vertical: campaign.vertical,
    angle: campaign.angle,
    promptContext: campaign.promptContext,
    cameraStyle: campaign.cameraStyle,
    cameraPrompt,
    creatorPrompt,
    scenePrompt,
    name: campaign.name,
  };
  const normalized: CampaignRunChoices = {
    ...choices,
    hook,
    cameraPrompt,
    creatorPrompt,
    scenePrompt,
  };
  const prompt = campaign.promptTemplate.trim()
    ? replaceAll(campaign.promptTemplate, replacements)
    : defaultCampaignPrompt(campaign, normalized);

  // The first frame is generated from the creator prompt; carry the same
  // no-screen-UI / no-hands guards so a fake phone UI or extra selfie-arm
  // never gets baked in there. Empty creatorPrompt leaves override blank so
  // the image backend's randomized UGC prompt (which includes the same guards)
  // can run.
  const imagePrompt = creatorPrompt
    ? `${creatorPrompt} ${IMAGE_GUARDS}`
    : "";

  const bodyVideo = (choices.bodyVideo?.trim() || campaign.bodyVideo || "").trim();

  return {
    ...cfg,
    imageSource: {
      ...cfg.imageSource,
      nanoBanana: {
        ...cfg.imageSource.nanoBanana,
        promptOverride:
          imagePrompt || cfg.imageSource.nanoBanana.promptOverride,
      },
      openai: {
        ...cfg.imageSource.openai,
        promptOverride: imagePrompt || cfg.imageSource.openai.promptOverride,
      },
      chatgpt: {
        ...cfg.imageSource.chatgpt,
        promptOverride: imagePrompt || cfg.imageSource.chatgpt.promptOverride,
      },
    },
    flow: {
      ...cfg.flow,
      prompt,
    },
    video: {
      ...cfg.video,
      targetVideo: bodyVideo,
      trimSeconds: campaign.trimSeconds > 0 ? campaign.trimSeconds : cfg.video.trimSeconds,
      name: campaign.outputName || campaign.name || campaign.vertical || cfg.video.name,
    },
    captions: {
      ...cfg.captions,
      dialogue: hook,
      style:
        campaign.captionStyle === "bubble" || campaign.captionStyle === "default"
          ? campaign.captionStyle
          : cfg.captions.style,
      position:
        campaign.captionPosition === "top" ||
        campaign.captionPosition === "middle" ||
        campaign.captionPosition === "bottom"
          ? campaign.captionPosition
          : cfg.captions.position,
      verticalPosition:
        campaign.captionVerticalPosition > 0
          ? campaign.captionVerticalPosition
          : cfg.captions.verticalPosition,
      hookBubble: {
        ...cfg.captions.hookBubble,
        enabled:
          campaign.hookBubbleEnabled === "true"
            ? true
            : campaign.hookBubbleEnabled === "false"
              ? false
              : cfg.captions.hookBubble.enabled,
        text: choices.bubbleText,
        style:
          campaign.hookBubbleStyle === "shadow" ||
          campaign.hookBubbleStyle === "box" ||
          campaign.hookBubbleStyle === "card"
            ? campaign.hookBubbleStyle
            : cfg.captions.hookBubble.style,
      },
    },
  };
}
