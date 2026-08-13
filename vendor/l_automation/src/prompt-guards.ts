/**
 * Shared prompt guards so the first-frame image and the Veo clip never
 * disagree about what's in frame. Used by campaign video prompts and every
 * image backend (ChatGPT / OpenAI / Nano Banana).
 */

/**
 * Veo loves to "help" by drawing a phone/app interface on top of the scene
 * (status bar, record button, timer, thumbnail strip, social buttons).
 */
export const NO_SCREEN_UI =
  "CRITICAL: the frame must show ONLY the real-world filmed scene, as if looking straight through a lens. " +
  "Do NOT render any phone interface, camera app, or screen overlay of any kind: " +
  "no status bar, no clock or time display, no battery, wifi or signal icons, no search bar, " +
  "no record button, no shutter button, no REC dot, no recording timer or countdown, " +
  "no viewfinder frame, no focus brackets, no grid lines, no zoom slider, " +
  "no thumbnail strip, no gallery previews, no play/pause or scrubber/progress controls, " +
  "no app icons, no buttons, no menus, and no social-media UI (no like, comment, share, follow, profile, or username overlays). " +
  "ABSOLUTELY NO on-screen text, captions, subtitles, watermarks, logos, channel bugs, " +
  "numbers, digits, timecodes, timestamps, dates, or aspect-ratio labels anywhere in the frame.";

export const NO_ZOOM =
  "Camera motion: keep the framing essentially locked and static. " +
  "NO zoom in, NO zoom out, no digital zoom, no punch-in, no snap zoom, no dolly or push, " +
  "no whip pans, no quick reframing, no cinematic or dramatic camera moves. " +
  "Allow only a tiny, slow, natural handheld drift.";

/**
 * "Holding the phone at arm's length" makes the model draw the selfie arm
 * in-frame on top of a through-the-lens talking head → a third hand.
 */
export const NO_HANDS =
  "CRITICAL — ZERO HANDS: do not show any hands, fingers, palms, wrists, forearms, or a phone in frame. " +
  "Chest-up / head-and-shoulders only. The subject is looking through the lens — the camera and phone are invisible. " +
  "She is NOT holding anything. If a hand, arm, or phone would appear, crop it out.";

export const IMAGE_GUARDS = `${NO_SCREEN_UI} ${NO_HANDS}`;
