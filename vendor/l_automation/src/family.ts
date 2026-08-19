import { basename, join } from "node:path";

/**
 * Product family for a studio campaign id. Loans and debt share this process
 * but must write to separate output trees so finished videos never mix.
 */
export function productFamily(campaignId: string): "loans" | "debt" | "other" {
  const s = (campaignId ?? "").toLowerCase();
  if (s === "debt" || s.startsWith("debt-")) return "debt";
  if (s.includes("loan") || s.startsWith("va-")) return "loans";
  return "other";
}

/**
 * `<outputRoot>/<family>/<campaignId>`. Idempotent if `current` is already
 * the isolated folder (batch/CLI may have set it).
 */
export function isolatedOutputDir(outputRoot: string, campaignId: string): string {
  if (!campaignId) return outputRoot;
  if (basename(outputRoot) === campaignId) return outputRoot;
  return join(outputRoot, productFamily(campaignId), campaignId);
}
