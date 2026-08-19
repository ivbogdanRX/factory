/**
 * Live "(IB) LNV 3" clones on USD 1 / USD 2 / USD 3 at $250/day.
 *
 * Same two winning videos as the Linh clones, loans pixel, $25 bid cap,
 * spend starts immediately. Does not touch existing (SG) campaigns.
 *
 * USD accounts live in BM5 and cannot advertise as Amanda Slay, so ads
 * run from Veterans Support Page (already assigned). The loans pixel was
 * shared onto these accounts before launch.
 *
 * Usage: npx tsx apps/orchestrator/scripts/launch-usd-lnv3.ts
 */
import { mkdirSync, existsSync, createWriteStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env, DATA_DIR } from "../src/env.js";
import {
  createCampaign,
  createAdSet,
  createAdFromVideo,
  uploadVideo,
  listCampaignNames,
  getAdAccountHealth,
  isIbCampaignName,
  type VideoAdCopy,
} from "../src/meta.js";
import { createRun, updateRun, addCreative, updateCreative, listCreatives } from "../src/db.js";
import { recordLaunch } from "../src/launch-guard.js";

const SOURCE_CAMPAIGN_NAME = "(IB) LNV 3";
const PAGE_ID = "1317581624764447"; // Veterans Support Page — assigned on USD 1/2/3
const PIXEL_ID = "1033187746256419"; // Fresh BM - Loans
const LAUNCH_BUDGET_CENTS = 25_000;
const BID_CAP_CENTS = 2_500;
const GAP_MS = 90_000;

const SOURCE_ADS = [
  { name: "(IB) DF_LNV_6.15_3", videoId: "1069438078866335" },
  { name: "(IB) DF_LNV_6.15_7", videoId: "1364000998597891" },
];

const TARGET_ACCOUNTS = [
  { id: "act_1346720040781283", label: "USD 1 ·1283" },
  { id: "act_897039680145135", label: "USD 2 ·5135" },
  { id: "act_1073520861891344", label: "USD 3 ·1344" },
];

const COPY: VideoAdCopy = {
  headline: "vets need to see this!",
  primaryText: "i tried this myself and it worked! sharing this to help a few friends!",
  description: "2.3M Views",
  callToAction: "LEARN_MORE",
  websiteUrl:
    "https://visit.instfunds.com/6a7637e09275ed0cb84381e0?sub1={{ad.id}}&sub2={{adset.id}}&sub3={{campaign.id}}&sub4={{ad.name}}&sub5={{adset.name}}&sub6={{campaign.name}}&sub7={{placement}}&sub8={{site_source_name}}&utm_source=facebook&utm_medium=paid",
  displayUrl: "",
};

const TARGETING: Record<string, unknown> = {
  age_min: 18,
  age_max: 65,
  geo_locations: { countries: ["US"], location_types: ["home", "recent"] },
  targeting_automation: { advantage_audience: 1 },
  publisher_platforms: ["facebook", "instagram"],
  facebook_positions: ["feed", "right_hand_column", "instream_video", "marketplace", "story", "search", "facebook_reels"],
  instagram_positions: ["stream", "story", "reels", "profile_feed", "ig_search"],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tail = (id: string) => id.replace(/^act_/, "").slice(-4);

async function graphGet(path: string, params: string): Promise<Record<string, unknown>> {
  const url = `https://graph.facebook.com/${env.graphVersion}/${path}?access_token=${encodeURIComponent(env.metaToken)}${params}`;
  const response = await fetch(url);
  const data = (await response.json()) as Record<string, unknown>;
  if (!response.ok || data.error) throw new Error(JSON.stringify(data.error ?? data));
  return data;
}

async function downloadSourceVideo(videoId: string): Promise<string> {
  const dir = join(DATA_DIR, "clones");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${videoId}.mp4`);
  if (existsSync(dest)) return dest;
  const meta = await graphGet(videoId, "&fields=source");
  const source = String(meta.source ?? "");
  if (!source) throw new Error(`Video ${videoId} has no downloadable source`);
  const response = await fetch(source);
  if (!response.ok || !response.body) throw new Error(`Video download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(dest));
  return dest;
}

async function publishAccount(
  account: { id: string; label: string },
  videoPaths: Map<string, string>,
): Promise<string> {
  const health = await getAdAccountHealth(account.id);
  if (health.accountStatus !== 1) {
    throw new Error(`account status ${health.accountStatus} — not ACTIVE`);
  }

  const campaignName = `${SOURCE_CAMPAIGN_NAME} X${tail(account.id)}`;
  if (!isIbCampaignName(campaignName)) {
    throw new Error(`Refusing to create "${campaignName}" — not (IB)`);
  }
  const existing = await listCampaignNames(account.id);
  if (existing.includes(campaignName)) {
    throw new Error(`skipped — "${campaignName}" already exists`);
  }

  const nowIso = new Date().toISOString();
  const campaignId = await createCampaign(account.id, {
    name: campaignName,
    objective: "OUTCOME_SALES",
    specialAdCategories: ["FINANCIAL_PRODUCTS_SERVICES"],
    dailyBudget: LAUNCH_BUDGET_CENTS,
    bidStrategy: "LOWEST_COST_WITH_BID_CAP",
    status: "ACTIVE",
  });

  const adSetId = await createAdSet(account.id, {
    name: "(IB) Vids",
    campaignId,
    bidAmount: BID_CAP_CENTS,
    billingEvent: "IMPRESSIONS",
    optimizationGoal: "OFFSITE_CONVERSIONS",
    status: "ACTIVE",
    targeting: TARGETING,
    promotedObject: { pixel_id: PIXEL_ID, custom_event_type: "PURCHASE" },
  });

  const run = createRun("va-loans", "new-campaign");
  updateRun(run.id, {
    status: "uploading",
    go_live_at: nowIso,
    meta_campaign_id: campaignId,
    meta_adset_id: adSetId,
    note: `USD LNV 3 $250 live on ${account.label} (${account.id})`,
  });

  for (const sourceAd of SOURCE_ADS) {
    const localPath = videoPaths.get(sourceAd.videoId)!;
    const creativeDbId = addCreative(run.id, localPath);
    try {
      const videoId = await uploadVideo(account.id, localPath, sourceAd.name);
      const adId = await createAdFromVideo({
        adAccountId: account.id,
        adSetId,
        pageId: PAGE_ID,
        videoId,
        adName: sourceAd.name,
        copy: COPY,
        thumbnail: {},
        status: "ACTIVE",
      });
      updateCreative(creativeDbId, { video_id: videoId, ad_id: adId, ad_name: sourceAd.name, status: "live" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateCreative(creativeDbId, { status: "error", error: message });
    }
  }

  const created = listCreatives(run.id).filter((c) => c.ad_id).length;
  if (created === 0) {
    updateRun(run.id, { status: "error", error: "Every ad creation failed" });
    throw new Error(`campaign ${campaignId} created but every ad failed`);
  }

  updateRun(run.id, { status: "live", error: null });
  recordLaunch(account.id);
  return `${campaignName} ${campaignId} · ${created} ad(s) · run ${run.id}`;
}

if (env.dryRun) throw new Error("DRY_RUN is on — refusing");

const videoPaths = new Map<string, string>();
for (const ad of SOURCE_ADS) {
  videoPaths.set(ad.videoId, await downloadSourceVideo(ad.videoId));
  console.log(`downloaded ${ad.name}`);
}

const results: { label: string; ok: boolean; detail: string }[] = [];
for (let i = 0; i < TARGET_ACCOUNTS.length; i++) {
  const account = TARGET_ACCOUNTS[i]!;
  if (i > 0) {
    console.log(`Waiting ${GAP_MS / 1000}s before ${account.label}…`);
    await sleep(GAP_MS);
  }
  try {
    const detail = await publishAccount(account, videoPaths);
    results.push({ label: account.label, ok: true, detail });
    console.log(`${account.label}: ${detail}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    results.push({ label: account.label, ok: false, detail: message });
    console.error(`${account.label}: FAILED — ${message}`);
  }
}

const good = results.filter((r) => r.ok);
const bad = results.filter((r) => !r.ok);
console.log(`\n${good.length} succeeded, ${bad.length} failed/skipped`);
for (const r of results) console.log(`${r.ok ? "OK" : "FAIL"} ${r.label}: ${r.detail}`);
process.exit(bad.length && !good.length ? 1 : 0);
