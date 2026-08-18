/**
 * Burned-creative log. A file that Meta rejected (Spam, UBP, etc.) must never
 * be uploaded again — recycling rejects is what turned the 8-17 batch into
 * account-level Spam. Fingerprint is the lowercase basename without extension.
 */
import { basename } from "node:path";
import {
  getCreativeByAdId,
  getRejectedCreative,
  listRejectedCreatives,
  upsertRejectedCreative,
} from "./db.js";

export function creativeFingerprint(filePathOrName: string): string {
  return basename(filePathOrName)
    .toLowerCase()
    .replace(/\.(mov|mp4|m4v|jpg|jpeg|png|webp)$/i, "");
}

export function isBurnedCreative(filePathOrName: string): boolean {
  return Boolean(getRejectedCreative(creativeFingerprint(filePathOrName)));
}

export function recordRejectedCreative(input: {
  filePathOrName: string;
  reason: string;
  adId?: string;
  adName?: string;
  accountId?: string;
}): void {
  const fileName = basename(input.filePathOrName);
  upsertRejectedCreative({
    fingerprint: creativeFingerprint(input.filePathOrName),
    file_name: fileName,
    reason: input.reason,
    ad_id: input.adId ?? null,
    ad_name: input.adName ?? null,
    account_id: input.accountId ?? null,
  });
}

/** When an ad is DISAPPROVED, log its source file so later launches skip it. */
export function recordRejectionForAd(adId: string, reason: string, accountId?: string): void {
  const creative = getCreativeByAdId(adId);
  const source = creative?.output_path || creative?.ad_name || adId;
  recordRejectedCreative({
    filePathOrName: source,
    reason,
    adId,
    adName: creative?.ad_name ?? undefined,
    accountId,
  });
}

/** Known Spam / UBP files from Aug 10–18. Idempotent. */
const SEEDED = [
  ["DF_LNV_6.22_1.mov", "Spam"],
  ["DF_LNV_6.22_4.mov", "Spam"],
  ["DF_LNV_6.23_1.mov", "Spam"],
  ["DF_LNV_6.23_2.mov", "Spam"],
  ["DF_LNV_6.23_4.mov", "Spam"],
  ["DF_LNV_6.23_5.mov", "Spam"],
  ["DF_LNV_6.24_1.mov", "Spam"],
  ["VetGirl1.mov", "Unacceptable Business Practices"],
  ["VetGirls2.mov", "Unacceptable Business Practices"],
];

export function seedKnownRejectedCreatives(): void {
  for (const [file, reason] of SEEDED) {
    if (!getRejectedCreative(creativeFingerprint(file))) {
      recordRejectedCreative({ filePathOrName: file, reason });
    }
  }
}

export function burnedSummary(): string {
  const rows = listRejectedCreatives();
  if (rows.length === 0) return "none";
  return rows.map((r) => `${r.file_name}${r.reason ? ` (${r.reason})` : ""}`).join(", ");
}
