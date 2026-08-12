import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { runFullAd } from "../src/full-ad.js";

/**
 * One-off generator for a reusable "body" clip for the new-roofs vertical.
 *
 * The body is the main sales pitch that campaign hooks get spliced in front of.
 * It is generated as a standalone full ad (no body video of its own), then
 * copied to ./assets/roofs-body.mp4 — the path both roof campaigns point at.
 */

function loadEnvFile(): void {
  try {
    (process as unknown as { loadEnvFile: (p: string) => void }).loadEnvFile(".env");
  } catch {
    /* no .env or unsupported Node — env vars may still be set directly */
  }
}

const DEST = "./assets/roofs-body.mp4";

// One compliant spoken line per clip (~7s each). Kept to "may qualify" /
// "could" language — no guaranteed approvals or dollar promises.
const SCRIPT = [
  "If you're a senior and your roof is aging, leaking, or missing shingles, you may not have to cover a replacement on your own.",
  "There are roof replacement programs and assistance options that a lot of older homeowners qualify for and never even hear about.",
  "A quick, no-pressure check takes about a minute and shows you what help you may be eligible for.",
  "You could end up with a brand new roof protecting your home for decades, often for far less than you'd expect.",
  "Tap below to see if you qualify before this round of funding fills up.",
].join("\n");

const PERSONA =
  "A candid, real-life UGC shot of a warm, trustworthy middle-aged person in a casual shirt, " +
  "standing outside in front of an ordinary suburban house, talking directly to camera like a " +
  "helpful neighbor. Natural daylight, older-phone footage look, slightly soft and not polished. " +
  "The frame shows only the real-world scene through the lens — no phone, no screen, no app interface, " +
  "no status bar, no buttons, and no on-screen UI of any kind.";

async function main(): Promise<void> {
  loadEnvFile();

  // Deterministic guard: even with the no-UI prompt, Veo intermittently paints
  // a fake phone status bar in the top margin. Crop the outer margins off every
  // raw clip (before captions) so the chrome is physically removed, not just
  // discouraged. Scoped to this run via env vars, so other campaigns are untouched.
  process.env.VEO_SAFE_CROP_TOP = process.env.VEO_SAFE_CROP_TOP ?? "0.12";
  process.env.VEO_SAFE_CROP_BOTTOM = process.env.VEO_SAFE_CROP_BOTTOM ?? "0.06";

  console.log("Generating new-roofs body clip via the API backend…");
  const result = await runFullAd({
    name: "New Roofs Seniors Body",
    angle:
      "seniors and older homeowners over 55 with aging or storm-damaged roofs who may qualify for a roof replacement program",
    promptContext:
      "Reusable body pitch for the new-roofs senior vertical. Speak to older homeowners about aging, " +
      "leaking, or storm-damaged roofs and checking whether they qualify for roof replacement programs " +
      "or assistance. Do not promise guaranteed approval, exact amounts, or guaranteed insurance payouts. " +
      "Believable real UGC footage, not a polished ad. No on-screen text, captions, numbers, or overlays in the generated frame.",
    personaPrompt: PERSONA,
    script: SCRIPT,
    autoSplit: false,
    backend: "api",
  });

  const out = result.outputs[0];
  if (!out || !existsSync(out)) {
    throw new Error("Generation finished but no output file was produced.");
  }

  mkdirSync(dirname(DEST), { recursive: true });
  copyFileSync(out, DEST);
  console.log(`\nBody clip ready: ${out}`);
  console.log(`Copied to: ${DEST}`);
}

main().catch((err) => {
  console.error("Failed to generate roofs body:", err);
  process.exit(1);
});
