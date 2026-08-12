/**
 * Hook bubble headlines: short, 1–2 lines, audience + benefit + intrigue.
 * Formatted for ASS burn-in inside the 3:4 top safe zone on 9:16.
 */

const MAX_LINES = 2;
const TARGET_CHARS_PER_LINE = 24;
const HARD_MAX_CHARS_PER_LINE = 30;

/** Split a headline into balanced ASS lines (`\N` = hard break). */
export function formatBubbleHeadline(text: string): string {
  const normalized = text.replace(/\\N/g, "\n").replace(/\s+/g, " ").trim();
  if (!normalized) return "";

  if (normalized.includes("\n")) {
    return normalized
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, MAX_LINES)
      .join("\\N");
  }

  if (normalized.length <= TARGET_CHARS_PER_LINE) {
    return normalized;
  }

  const words = normalized.split(" ");
  if (words.length <= 1) {
    return normalized.slice(0, HARD_MAX_CHARS_PER_LINE);
  }

  let bestSplit = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 1; i < words.length; i++) {
    const line1 = words.slice(0, i).join(" ");
    const line2 = words.slice(i).join(" ");
    if (line1.length > HARD_MAX_CHARS_PER_LINE || line2.length > HARD_MAX_CHARS_PER_LINE) {
      continue;
    }
    const score = Math.abs(line1.length - line2.length) + line1.length * 0.1;
    if (score < bestScore) {
      bestScore = score;
      bestSplit = i;
    }
  }

  // No split fits the hard cap (very long headline): fall back to the most
  // balanced split so we never render a one-word orphan line.
  if (bestSplit < 0) {
    for (let i = 1; i < words.length; i++) {
      const line1 = words.slice(0, i).join(" ");
      const line2 = words.slice(i).join(" ");
      const score = Math.abs(line1.length - line2.length);
      if (score < bestScore) {
        bestScore = score;
        bestSplit = i;
      }
    }
  }

  const line1 = words.slice(0, bestSplit).join(" ");
  const line2 = words.slice(bestSplit).join(" ");
  if (!line2) return line1;
  return `${line1}\\N${line2}`;
}

/** Scale bubble font down as lines get longer so text stays inside the safe zone. */
export function bubbleFontSizeForText(height: number, formatted: string): number {
  const lines = formatted.split("\\N");
  const longest = Math.max(...lines.map((l) => l.length), 1);
  let ratio = 0.046;
  if (longest > 20) ratio = 0.0415;
  if (longest > 26) ratio = 0.0365;
  if (longest > 32) ratio = 0.033;
  if (lines.length > 2) ratio = 0.031;
  return Math.round(Math.max(height * 0.03, height * ratio));
}

export function bubblePaddingForFont(fontSize: number, configured = 0): number {
  if (configured > 0) return configured;
  return Math.max(12, Math.round(fontSize * 0.5));
}

/** Side margins as fraction of width — wider for bubbles so text wraps cleanly. */
export function bubbleMarginLR(width: number): number {
  return Math.round(width * 0.11);
}
