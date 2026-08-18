/**
 * Local premade MP4/MOV files for a vertical. Skips anything in the reject
 * log so a Spam/UBP file cannot be re-queued.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./env.js";
import { isBurnedCreative } from "./reject-log.js";

export const READY_MADE_ANGLE_ID = "stock";

export function listReadyMade(dirRel: string): string[] {
  const dir = join(ROOT, dirRel);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((f) => /\.(mov|mp4|m4v)$/i.test(f) && !f.startsWith("."))
    .filter((f) => !isBurnedCreative(f))
    .map((f) => join(dir, f))
    .sort();
}

/** First `count` unused premades. Empty if the folder is missing or all burned. */
export function pickReadyMade(dirRel: string, count: number): string[] {
  if (count <= 0) return [];
  return listReadyMade(dirRel).slice(0, count);
}
