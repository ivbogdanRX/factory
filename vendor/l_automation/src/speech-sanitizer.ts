/**
 * Veo reads dashes literally and trips over them (awkward pauses, garbled
 * delivery), so no dash of any kind may reach a spoken hook, the caption
 * dialogue, the bubble headline, or a scene prompt. Spaced dashes used as a
 * clause break read naturally as a comma; dashes inside compounds ("DD-214",
 * "two-week") become plain spaces.
 */
const DASH_CLASS = "[-\\u2010\\u2011\\u2012\\u2013\\u2014\\u2015\\u2212]";

export function stripDashes(text: string): string {
  return (
    text
      // " — " / " - " clause breaks → comma + space (natural spoken pause).
      .replace(new RegExp(`\\s+${DASH_CLASS}+\\s+`, "g"), ", ")
      // Any remaining dash (inside words, leading/trailing) → space.
      .replace(new RegExp(DASH_CLASS, "g"), " ")
      // Tidy up: collapse doubled separators/spaces the swaps may have left.
      .replace(/\s+([,.!?;:])/g, "$1")
      .replace(/,\s*,+/g, ",")
      .replace(/ {2,}/g, " ")
      .trim()
  );
}
