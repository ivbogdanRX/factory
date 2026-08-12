/**
 * Re-run ONLY the caption + hook-bubble burn-in on an existing clip so text
 * placement/styling can be checked without a full generation run.
 *
 * Usage:
 *   npx tsx scripts/preview-captions.ts <clip.mp4> "<dialogue>" "<bubble headline>" [box|shadow|card]
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { loadConfig } from "../src/config.js";
import { addCaptions } from "../src/captions.js";

const [clip, dialogue, bubble, style] = process.argv.slice(2);
if (!clip) {
  console.error(
    'usage: tsx scripts/preview-captions.ts <clip.mp4> "<dialogue>" "<bubble headline>"',
  );
  process.exit(1);
}

const cfg = loadConfig();
cfg.captions.enabled = true;
if (dialogue) cfg.captions.dialogue = dialogue;
cfg.captions.hookBubble.enabled = true;
if (bubble) cfg.captions.hookBubble.text = bubble;
if (style === "box" || style === "shadow" || style === "card") {
  cfg.captions.hookBubble.style = style;
}

// Work on a copy so we never clobber a real pipeline artifact next to the input.
const workDir = "artifacts/preview";
mkdirSync(workDir, { recursive: true });
const workClip = join(workDir, `preview_input${extname(clip) || ".mp4"}`);
copyFileSync(clip, workClip);

const out = await addCaptions(workClip, cfg);
console.log(`\nPreview written: ${out}`);
