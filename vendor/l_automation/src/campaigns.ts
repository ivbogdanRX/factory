import type { AppConfig, CampaignConfig } from "./config.js";
import { DEFAULT_MAX_HOOK_SECONDS } from "./hook-duration.js";

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

/**
 * Veo loves to "help" by drawing a phone/app interface on top of the scene
 * (status bar, record button, timer, thumbnail strip, social buttons) and by
 * adding zoom/punch-in moves. These two blocks explicitly forbid both. They're
 * shared by the video prompt and (the UI half) by the first-frame image prompt
 * so the look never gets baked in upstream either.
 */
const NO_SCREEN_UI =
  "CRITICAL: the frame must show ONLY the real-world filmed scene, as if looking straight through a lens. " +
  "Do NOT render any phone interface, camera app, or screen overlay of any kind: " +
  "no status bar, no clock or time display, no battery, wifi or signal icons, no search bar, " +
  "no record button, no shutter button, no REC dot, no recording timer or countdown, " +
  "no viewfinder frame, no focus brackets, no grid lines, no zoom slider, " +
  "no thumbnail strip, no gallery previews, no play/pause or scrubber/progress controls, " +
  "no app icons, no buttons, no menus, and no social-media UI (no like, comment, share, follow, profile, or username overlays). " +
  "ABSOLUTELY NO on-screen text, captions, subtitles, watermarks, logos, channel bugs, " +
  "numbers, digits, timecodes, timestamps, dates, or aspect-ratio labels anywhere in the frame.";

const NO_ZOOM =
  "Camera motion: keep the framing essentially locked and static. " +
  "NO zoom in, NO zoom out, no digital zoom, no punch-in, no snap zoom, no dolly or push, " +
  "no whip pans, no quick reframing, no cinematic or dramatic camera moves. " +
  "Allow only a tiny, slow, natural handheld drift.";

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
  const framing =
    choices.cameraPrompt.trim() || campaign.cameraStyle.trim();
  const cameraBlock = framing
    ? [`Camera framing: ${framing}`]
    : [
        "Camera framing: handheld talking-head shot at arm's length, framed as if looking straight through the lens, held fairly steady with a tiny natural shake.",
        "The recording device, its screen, and any app interface are NEVER visible in frame — we only ever see the real-world scene through the lens.",
        "The person speaks directly into the lens with steady eye contact, natural pauses, and real facial expressions.",
        "Use subtle eyebrow movement and small head nods only.",
      ];

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
    NO_ZOOM,
    `Dialogue: '${choices.hook}'`,
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
  const replacements = {
    hook: choices.hook,
    vertical: campaign.vertical,
    angle: campaign.angle,
    promptContext: campaign.promptContext,
    cameraStyle: campaign.cameraStyle,
    cameraPrompt: choices.cameraPrompt,
    creatorPrompt: choices.creatorPrompt,
    scenePrompt: choices.scenePrompt,
    name: campaign.name,
  };
  const prompt = campaign.promptTemplate.trim()
    ? replaceAll(campaign.promptTemplate, replacements)
    : defaultCampaignPrompt(campaign, choices);

  // The first frame is generated from the creator prompt; carry the same
  // no-screen-UI guard so a fake phone/app interface never gets baked in there.
  const imagePrompt = choices.creatorPrompt
    ? `${choices.creatorPrompt} ${NO_SCREEN_UI}`
    : "";

  const bodyVideo = choices.bodyVideo?.trim() || campaign.bodyVideo;

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
      dialogue: choices.hook,
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
