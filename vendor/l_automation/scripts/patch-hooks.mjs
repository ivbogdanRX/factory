import fs from "node:fs";

/**
 * Rewrites the SPOKEN hooks for the bathroom campaign as clean, punchy ad
 * hooks: audience callout (seniors 55+) + curiosity + benefit, no dashes, and
 * short enough to speak in ~7.8s (<= ~18 words at 2.35 wps). Then strips any
 * dash from every hook / bubble line across all campaigns as a safety net.
 */

const spokenByVariant = {
  judge: [
    "I am ordering that every senior over fifty five be granted access to this bathroom remodel program.",
    "Listen carefully, seniors over fifty five may now qualify for a brand new walk in shower.",
    "This court finds seniors over fifty five have been overpaying for safe bathroom remodels far too long.",
    "Every homeowner over fifty five deserves a safe bathroom, and today I am ordering it done.",
    "Seniors over fifty five, you are about to learn why your bathroom remodel could be covered.",
  ],
  podcast: [
    "Nobody is telling seniors over fifty five their bathroom remodel might be almost completely covered.",
    "If you are over fifty five, stop paying full price for a walk in shower.",
    "They do not want seniors knowing that old tub can be replaced for way less.",
    "I cannot believe how many seniors over fifty five are missing this bathroom remodel program.",
    "Here is what the big remodel companies keep hiding from seniors over fifty five.",
  ],
  news: [
    "If you are a senior over fifty five, there is a new bathroom safety program today.",
    "Seniors are swapping dangerous tubs for walk in showers, and many are stunned how little it costs.",
    "A new alert for homeowners over fifty five could change how you pay for your bathroom.",
    "Thousands of seniors over fifty five are upgrading unsafe bathrooms right now, and you may qualify.",
    "Seniors over fifty five may be leaving bathroom remodel help on the table without knowing it.",
  ],
  contractor: [
    "I have pulled too many seniors out of dangerous tubs, and over fifty five yours is risky.",
    "If you are over fifty five, that slippery tub is an accident waiting to happen.",
    "As a contractor, I tell seniors over fifty five to check this before they pay.",
    "I install walk in showers every week, and most seniors had no idea they could afford it.",
    "That old bathtub is dangerous, and seniors over fifty five deserve a safer remodel within reach.",
  ],
  insider: [
    "After years on the inside, most seniors over fifty five miss this bathroom remodel program.",
    "If you are over fifty five, there is a simple way to check if yours is covered.",
    "Most seniors over fifty five never hear about this until after they have already overpaid.",
    "I helped run these programs, and seniors over fifty five qualify far more than they think.",
    "Here is the shortcut seniors over fifty five use to find a safer bathroom within reach.",
  ],
};

const campaignLevelHooks = [
  "If you are over fifty five, your bathroom remodel might be covered more than you expect.",
  "Seniors are replacing dangerous old tubs with walk in showers for far less than they think.",
  "A lot of seniors over fifty five never find out this bathroom program even exists.",
];

/** Remove every dash variant and tidy spacing/punctuation. */
function stripDashes(line) {
  return String(line)
    .replace(/[-\u2010\u2011\u2012\u2013\u2014\u2015]/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const cfg = JSON.parse(fs.readFileSync("config.json", "utf8"));

const bath = cfg.campaigns.find((c) => c.id === "bathroom-remodel-seniors");
if (!bath) throw new Error("bathroom campaign not found");

bath.hooks = campaignLevelHooks.slice();
for (const variant of bath.variants ?? []) {
  if (spokenByVariant[variant.id]) variant.hooks = spokenByVariant[variant.id].slice();
}

// Safety net: no dashes anywhere in any spoken hook or bubble line.
let cleaned = 0;
for (const c of cfg.campaigns) {
  const scrub = (arr) =>
    Array.isArray(arr)
      ? arr.map((l) => {
          const out = stripDashes(l);
          if (out !== l) cleaned++;
          return out;
        })
      : arr;
  c.hooks = scrub(c.hooks);
  for (const v of c.variants ?? []) {
    v.hooks = scrub(v.hooks);
    v.bubbleHooks = scrub(v.bubbleHooks);
  }
}

fs.writeFileSync("config.json", JSON.stringify(cfg, null, 2) + "\n");
console.log(`Rewrote bathroom hooks; stripped dashes from ${cleaned} other line(s).`);
