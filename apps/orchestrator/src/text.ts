/**
 * Dash-free rule for anything Veo will speak or burn on screen (mirrors
 * vendor/l_automation/src/speech-sanitizer.ts — the packages don't share
 * code, so the tiny rule lives in both). Veo trips over dashes, so spaced
 * dashes become a comma pause and in-word hyphens ("DD-214") become spaces.
 */
const DASH_CLASS = "[-\\u2010\\u2011\\u2012\\u2013\\u2014\\u2015\\u2212]";

export function stripDashes(text: string): string {
  return text
    .replace(new RegExp(`\\s+${DASH_CLASS}+\\s+`, "g"), ", ")
    .replace(new RegExp(DASH_CLASS, "g"), " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/,\s*,+/g, ",")
    .replace(/ {2,}/g, " ")
    .trim();
}
