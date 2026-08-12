/**
 * One-off: clone the proven "(IB) LNV 3" campaign (52641822897713, RedTrack
 * CPA ~$8.50) onto every available spare ad account.
 *
 * Per account: new CBO campaign at the $100/day ladder rung (guardrail Rule D
 * scales it on ROAS evidence), same ad set shape ($25 bid cap, purchase
 * optimization on the loans pixel, US 18-65 Advantage audience), the two
 * currently-ACTIVE winning videos re-uploaded, and a `runs` row registered so
 * flights, guardrails, digest and per-ad Slack buttons all apply.
 *
 * Idempotent per account: skips any account that already has a campaign with
 * the same clone name.
 *
 * Usage: npx tsx apps/orchestrator/scripts/clone-winner.ts
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
  type VideoAdCopy,
} from "../src/meta.js";
import { createRun, updateRun, addCreative, updateCreative, listCreatives } from "../src/db.js";
import { nextDayStartIso } from "../src/schedule.js";
import { postSlack } from "../src/slack.js";

const SOURCE_CAMPAIGN_NAME = "(IB) LNV 3";
const PAGE_ID = "1268897542969382"; // Amanda Slay — same page as the source ads
const PIXEL_ID = "1033187746256419"; // Fresh BM - Loans
const LAUNCH_BUDGET_CENTS = 10_000; // $100/day ladder start (Rule D scales it)
const BID_CAP_CENTS = 2_500;

/** ACTIVE ads of the source campaign, verified via Graph on 2026-08-12. */
const SOURCE_ADS = [
  { name: "(IB) DF_LNV_6.15_3", videoId: "1069438078866335" },
  { name: "(IB) DF_LNV_6.15_7", videoId: "1364000998597891" },
];

/** ACTIVE + funded accounts from the 2026-08-12 sweep, minus the main account
 * (already runs the source campaign) and act_4570617276549207 (occupied by
 * third-party "(IS)" campaigns — excluded pending the user's say-so). */
const TARGET_ACCOUNTS = [
  { id: "act_1109111821645182", label: "Linh 852621" },
  { id: "act_1043436118643857", label: "Linh 726718" },
  { id: "act_2418227075367073", label: "Linh 712634" },
  { id: "act_1580820796744259", label: "Linh 351366" },
  { id: "act_2641896642874778", label: "Luu 566693" },
  { id: "act_1046718361084665", label: "Luu 342975" },
  { id: "act_2503613803492275", label: "Luu 165671" },
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

/** Source ad set targeting (read from ad set 52641822900113), minus
 * read-only fields (age_range) that Graph rejects on create. */
const TARGETING: Record<string, unknown> = {
  age_min: 18,
  age_max: 65,
  geo_locations: { countries: ["US"], location_types: ["home", "recent"] },
  targeting_automation: { advantage_audience: 1 },
  publisher_platforms: ["facebook", "instagram"],
  facebook_positions: ["feed", "right_hand_column", "instream_video", "marketplace", "story", "search", "facebook_reels"],
  instagram_positions: ["stream", "story", "reels", "profile_feed", "ig_search"],
};

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

async function main(): Promise<void> {
  const goLiveAt = nextDayStartIso(5); // tomorrow 5:00 AM PT
  const goLiveText = new Date(goLiveAt).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  console.log(`Cloning "${SOURCE_CAMPAIGN_NAME}" to ${TARGET_ACCOUNTS.length} accounts, go-live ${goLiveText} PT`);
  const videoPaths = new Map<string, string>();
  for (const ad of SOURCE_ADS) {
    videoPaths.set(ad.videoId, await downloadSourceVideo(ad.videoId));
    console.log(`downloaded ${ad.name} (${ad.videoId})`);
  }

  const results: { label: string; ok: boolean; detail: string }[] = [];

  for (const account of TARGET_ACCOUNTS) {
    const tail = account.id.replace("act_", "").slice(-4);
    const campaignName = `${SOURCE_CAMPAIGN_NAME} X${tail}`;
    try {
      const existing = await listCampaignNames(account.id);
      if (existing.includes(campaignName)) {
        results.push({ label: account.label, ok: false, detail: `skipped — "${campaignName}" already exists` });
        continue;
      }

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
        startTime: goLiveAt,
      });

      const run = createRun("va-loans", "new-campaign");
      updateRun(run.id, {
        status: "scheduled",
        go_live_at: goLiveAt,
        meta_campaign_id: campaignId,
        meta_adset_id: adSetId,
        note: `Clone of ${SOURCE_CAMPAIGN_NAME} on ${account.label} (${account.id})`,
      });

      const adLines: string[] = [];
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
          updateCreative(creativeDbId, { video_id: videoId, ad_id: adId, ad_name: sourceAd.name, status: "scheduled" });
          adLines.push(sourceAd.name);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          updateCreative(creativeDbId, { status: "error", error: message });
        }
      }

      const created = listCreatives(run.id).filter((c) => c.ad_id).length;
      if (created === 0) {
        updateRun(run.id, { status: "error", error: "Every ad creation failed" });
        results.push({ label: account.label, ok: false, detail: "campaign created but every ad failed" });
      } else {
        results.push({ label: account.label, ok: true, detail: `"${campaignName}" · ${created} ad(s) · run ${run.id}` });
      }
      console.log(`${account.label}: done (${created} ads)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ label: account.label, ok: false, detail: message });
      console.error(`${account.label}: FAILED — ${message}`);
    }
  }

  const good = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  const lines = [
    `:factory: *Winner cloned to spare accounts* — "${SOURCE_CAMPAIGN_NAME}" (RedTrack CPA ~$8.50, 140 conversions) duplicated.`,
    `> Go-live: *${goLiveText} PT* · $100/day CBO start (ladder scales to $250/$500 on ROAS) · $25 bid cap · both winning ads.`,
    ...good.map((r) => `> :white_check_mark: ${r.label}: ${r.detail}`),
    ...bad.map((r) => `> :x: ${r.label}: ${r.detail}`),
    `> Skipped on purpose: act_4570617276549207 (has live third-party "(IS)" campaigns — say the word and I'll add it) and the UNSETTLED/DISABLED accounts.`,
    `> Guardrails, 3-day flight, per-ad controls and the digest cover all of these. Pause any from the portal before 5 AM if you want out.`,
  ];
  await postSlack(lines.join("\n"));
  console.log(`\n${good.length} succeeded, ${bad.length} failed/skipped`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
