/**
 * One-shot migration (2026-08-12): lock every active va-loans-veterans variant
 * to the single user-approved script, repurpose ugc-selfie to a pretty-woman
 * avatar, and park everything removed (variants, hooks, old persona prompts)
 * in vendor/l_automation/config.parked.json so nothing is lost.
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";

const CONFIG = new URL("../vendor/l_automation/config.json", import.meta.url).pathname;
const PARKED = new URL("../vendor/l_automation/config.parked.json", import.meta.url).pathname;

const LOCKED_SCRIPT =
  "The VA has given out DD 214 stimulus grants for the next two weeks, and most veterans are getting $70,000 paychecks in just a few minutes.";

// Same serialization the studio + hook approvals use → minimal diffs.
const stableStringify = (value) =>
  JSON.stringify(value, null, 2).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

const stripDashes = (text) =>
  text
    .replace(/\s+[-\u2010-\u2015\u2212]+\s+/g, ", ")
    .replace(/[-\u2010-\u2015\u2212]/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .replace(/,\s*,+/g, ",")
    .replace(/ {2,}/g, " ")
    .trim();

const raw = JSON.parse(readFileSync(CONFIG, "utf8"));
const campaign = raw.campaigns.find((c) => c.id === "va-loans-veterans");
if (!campaign) throw new Error("va-loans-veterans not found");

const KEEP = ["ugc-selfie", "rent-vet", "debt-vet"];
const parkedVariants = campaign.variants.filter((v) => !KEEP.includes(v.id));
const keptVariants = campaign.variants.filter((v) => KEEP.includes(v.id));

const parked = {
  note:
    "Hooks/variants parked 2026-08-12 while production runs a single locked script " +
    "(user request: one script, pretty-women + male-veteran avatars only). " +
    "Restore by copying entries back into config.json campaigns[va-loans-veterans].",
  lockedScript: LOCKED_SCRIPT,
  "va-loans-veterans": {
    parkedVariants,
    parkedHooksByVariant: Object.fromEntries(
      keptVariants.map((v) => [v.id, v.hooks.filter((h) => h !== LOCKED_SCRIPT)]),
    ),
    originalUgcSelfiePersona: {
      name: keptVariants.find((v) => v.id === "ugc-selfie")?.name,
      creatorPrompt: keptVariants.find((v) => v.id === "ugc-selfie")?.creatorPrompt,
      scenePrompt: keptVariants.find((v) => v.id === "ugc-selfie")?.scenePrompt,
    },
  },
};
writeFileSync(PARKED, JSON.stringify(parked, null, 2) + "\n");

for (const v of keptVariants) {
  v.hooks = [LOCKED_SCRIPT];
  v.bubbleHooks = v.bubbleHooks.map(stripDashes);
  v.scenePrompt = stripDashes(v.scenePrompt);
}
const ugc = keptVariants.find((v) => v.id === "ugc-selfie");
ugc.name = "UGC Selfie (Pretty Woman)";
ugc.creatorPrompt =
  "Candid selfie-style photo of a very pretty young woman in her mid 20s, long natural hair, light everyday makeup, wearing a casual hoodie or sweater, sitting in the driver's seat of a parked car in daylight, looking straight through the camera lens, chest-up with no hands or phone in frame, excited genuine expression, shot on an older smartphone front camera, slightly soft, natural light.";
ugc.scenePrompt =
  "A very pretty young woman sitting in her parked car, just found out the news about veteran grants, excitedly sharing it selfie style like a TikTok story time, girl next door energy, real and personal, not a commercial voice.";

campaign.variants = keptVariants;
campaign.hooks = [LOCKED_SCRIPT];

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
copyFileSync(CONFIG, `${CONFIG}.${stamp}.bak`);
writeFileSync(CONFIG, stableStringify(raw));
console.log(`Locked. Kept variants: ${keptVariants.map((v) => v.id).join(", ")}. Parked ${parkedVariants.length} variant(s) → config.parked.json. Backup: config.json.${stamp}.bak`);
