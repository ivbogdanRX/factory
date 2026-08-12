/** Default hook clip target after trim (~8s Veo minus trimSeconds). */
export const DEFAULT_MAX_HOOK_SECONDS = 7.8;

/** ~141 wpm urgent conversational delivery. */
const WORDS_PER_SECOND = 2.35;

/** Rough speak time for caption / pacing checks (not frame-accurate). */
export function estimateSpeakSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  return words / WORDS_PER_SECOND;
}

export function hookFitsDuration(
  text: string,
  maxSeconds = DEFAULT_MAX_HOOK_SECONDS,
): boolean {
  return estimateSpeakSeconds(text) <= maxSeconds;
}

export function formatSpeakEstimate(text: string): string {
  return `${estimateSpeakSeconds(text).toFixed(1)}s`;
}
