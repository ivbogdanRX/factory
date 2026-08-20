/**
 * Add unused premade ads to the live 852621 $25 CBO. Does not reuse the
 * Spam-rejected 6.23/6.24 files already on that campaign.
 *
 * Usage: npx tsx apps/orchestrator/scripts/add-5182-fresh-premades.ts
 */
import { basename, join } from "node:path";
import { unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { env, ROOT } from "../src/env.js";
import { loadVerticals } from "../src/verticals.js";
import {
  uploadVideo,
  extractThumbnail,
  uploadImageFile,
  createAdFromVideo,
  isIbCampaignName,
} from "../src/meta.js";
import { addCreative, updateCreative } from "../src/db.js";

const ACCOUNT_ID = "act_1109111821645182";
const ADSET_ID = "52552592319309";
const RUN_ID = "run_1787077353905_l05qv1";
const READY_DIR = join(ROOT, "ready-made", "va-loans");
const FILES = ["VetGirl1.mov", "VetGirls2.mov", "VetGirls3.mov", "VetGirls4.mov", "VetGirls5.mov"];

if (env.dryRun) throw new Error("DRY_RUN is on — refusing");
const vertical = loadVerticals().find((v) => v.enabled);
if (!vertical) throw new Error("No enabled vertical");

let n = 7;
for (const file of FILES) {
  const path = join(READY_DIR, file);
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  const adName = `(IB) LNV AF 8-18 X5182 v${n} [ready-made]`;
  if (!isIbCampaignName(adName)) throw new Error(adName);
  const creativeId = addCreative(RUN_ID, path, "ready-made");
  try {
    const videoId = await uploadVideo(ACCOUNT_ID, path, file);
    let imageHash: string | undefined;
    try {
      const thumbPath = await extractThumbnail(path);
      const image = await uploadImageFile(ACCOUNT_ID, thumbPath);
      imageHash = image.hash;
      await unlink(thumbPath).catch(() => {});
    } catch (thumbError) {
      console.warn(`thumb failed ${file}`, thumbError);
    }
    const adId = await createAdFromVideo({
      adAccountId: ACCOUNT_ID,
      adSetId: ADSET_ID,
      pageId: vertical.meta.pageId,
      videoId,
      adName,
      copy: vertical.meta.adSettings,
      thumbnail: imageHash ? { imageHash } : {},
      status: "ACTIVE",
    });
    updateCreative(creativeId, { video_id: videoId, ad_id: adId, ad_name: adName, status: "live" });
    console.log(`OK ${adName} ${adId} ← ${file}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateCreative(creativeId, { status: "error", error: message });
    console.error(`FAIL ${file}: ${message}`);
  }
  n++;
}
console.log("done");
process.exit(0);
