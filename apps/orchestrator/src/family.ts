/**
 * Product-family isolation: loans and debt share the factory process but must
 * never share a studio campaign, Meta pixel, RedTrack link, or output folder.
 *
 * Family is explicit on each vertical (`family: loans | debt`) and is also
 * inferred from studio campaign ids (`va-loans-veterans` vs `debt-seniors`)
 * so a miswired creativeCampaignId fails closed.
 */
import { redtrackCampaignIdFromUrl } from "./redtrack.js";
import type { Vertical } from "./verticals.js";

export type ProductFamily = "loans" | "debt" | "other";

export function familyFromId(id: string): ProductFamily {
  const s = (id ?? "").toLowerCase();
  if (s === "debt" || s.startsWith("debt-")) return "debt";
  if (s.includes("loan") || s.startsWith("va-")) return "loans";
  return "other";
}

export function familyOf(vertical: Pick<Vertical, "id" | "family" | "creativeCampaignId">): ProductFamily {
  if (vertical.family === "loans" || vertical.family === "debt" || vertical.family === "other") {
    return vertical.family;
  }
  const fromId = familyFromId(vertical.id);
  if (fromId !== "other") return fromId;
  return familyFromId(vertical.creativeCampaignId);
}

/**
 * Problems that would let one family bleed into another. Checked for every
 * enabled vertical (and for a specific vertical about to run, even if it
 * isn't on the daily schedule).
 */
export function familyIsolationProblems(verticals: Vertical[], running?: Vertical): string[] {
  const problems: string[] = [];
  const scope = running
    ? [...verticals.filter((v) => v.enabled && v.id !== running.id), running]
    : verticals.filter((v) => v.enabled);

  const pixelOwner = new Map<string, ProductFamily>();
  const linkOwner = new Map<string, ProductFamily>();

  for (const v of scope) {
    const family = familyOf(v);
    const studioFamily = familyFromId(v.creativeCampaignId);
    if (studioFamily !== "other" && studioFamily !== family) {
      problems.push(
        `${v.id}: creativeCampaignId "${v.creativeCampaignId}" is a ${studioFamily} studio campaign, but this vertical is family "${family}"`,
      );
    }

    const pixel = v.meta.pixelId.trim();
    if (pixel) {
      const owner = pixelOwner.get(pixel);
      if (owner && owner !== family) {
        problems.push(`${v.id}: pixel ${pixel} is already used by the ${owner} family — pixels cannot be shared across families`);
      } else {
        pixelOwner.set(pixel, family);
      }
    }

    const rtId = redtrackCampaignIdFromUrl(v.meta.adSettings.websiteUrl);
    if (rtId) {
      const owner = linkOwner.get(rtId);
      if (owner && owner !== family) {
        problems.push(
          `${v.id}: RedTrack campaign ${rtId} is already used by the ${owner} family — landing links cannot be shared across families`,
        );
      } else {
        linkOwner.set(rtId, family);
      }
    }

    const naming = `${v.meta.naming.campaign} ${v.meta.naming.adSet} ${v.meta.naming.ad}`.toUpperCase();
    if (family === "debt" && naming.includes("LNV")) {
      problems.push(`${v.id}: naming still uses LNV (loans) — debt campaigns need their own name prefix`);
    }
    if (family === "loans" && /\bDEBT\b/.test(naming)) {
      problems.push(`${v.id}: naming uses DEBT on a loans vertical`);
    }
  }

  return problems;
}
