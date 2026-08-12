/** Sanity check: sanitizer handles every dash type; hook pool is locked and dash-free. */
import { stripDashes } from "../src/speech-sanitizer.js";
import { CampaignBatchPicker } from "../src/campaign-picker.js";
import { loadConfig } from "../src/config.js";

const cases = [
  "DD-214 grants",
  "two-week window",
  "I made him check this — the VA is giving DD-214 stimulus grants",
  "wait - listen to me",
  "en–dash and em—dash and horizontal―bar and minus−sign",
  "trailing dash- and -leading",
  "already clean, no dashes here.",
];
for (const c of cases) console.log(JSON.stringify(c), "=>", JSON.stringify(stripDashes(c)));

const cfg = loadConfig();
const camp = cfg.campaigns.find((c) => c.id === "va-loans-veterans")!;
const DASH = /[-\u2010-\u2015\u2212]/;
const picker = new CampaignBatchPicker(camp, { random: true });
const hooks = new Set<string>();
const variants = new Set<string>();
const bubbles = new Set<string>();
for (let i = 1; i <= 100; i++) {
  const c = picker.pick(i);
  hooks.add(c.hook);
  variants.add(c.variantId);
  bubbles.add(c.bubbleText);
  if (DASH.test(c.hook) || DASH.test(c.bubbleText) || DASH.test(c.scenePrompt)) {
    throw new Error("DASH FOUND: " + JSON.stringify(c));
  }
}
console.log("100 picks OK — variants seen:", [...variants].join(", "));
console.log("distinct hooks:", hooks.size, "->", [...hooks][0]);
console.log("bubbles in rotation:", [...bubbles].join(" | "));
console.log("no dashes anywhere: PASS");
