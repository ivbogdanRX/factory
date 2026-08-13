/**
 * Glance extras: the locked VA hook, latest rendered ads, and jpeg posters
 * so the phone dashboard isn't a wall of empty $0 tiles.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { VENDOR_STUDIO_DIR } from "./env.js";
import { loadVerticals } from "./verticals.js";

const OUTPUT_DIR = join(VENDOR_STUDIO_DIR, "output");
const FFMPEG =
  existsSync("/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg")
    ? "/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg"
    : "ffmpeg";

export interface GlanceOffer {
  id: string;
  name: string;
  hook: string;
  headline: string;
  dailyCount: number;
  budgetUsd: number;
  bidCapUsd: number;
}

export interface GlanceCreative {
  name: string;
  createdAt: string;
  videoUrl: string;
  posterUrl: string | null;
}

export function loadOffer(): GlanceOffer | null {
  const vertical = loadVerticals().find((v) => v.enabled);
  if (!vertical) return null;
  let hook = "";
  let headline = "";
  try {
    const raw = JSON.parse(readFileSync(join(VENDOR_STUDIO_DIR, "config.json"), "utf8")) as {
      campaigns?: Array<{
        id?: string;
        hooks?: string[];
        hookBubbleText?: string;
        variants?: Array<{ hooks?: string[]; bubbleHooks?: string[] }>;
      }>;
    };
    const campaign = (raw.campaigns ?? []).find((c) => c.id === vertical.creativeCampaignId);
    hook = campaign?.hooks?.[0] || campaign?.variants?.[0]?.hooks?.[0] || "";
    headline =
      campaign?.hookBubbleText ||
      campaign?.variants?.[0]?.bubbleHooks?.[0] ||
      vertical.meta.adSettings.headline;
  } catch {
    // studio config unreadable
  }
  return {
    id: vertical.id,
    name: vertical.label,
    hook,
    headline,
    dailyCount: vertical.dailyCount,
    budgetUsd: (vertical.meta.cboDailyBudgetCents || vertical.meta.dailyBudgetCents) / 100,
    bidCapUsd: (vertical.meta.bidCapCents || 0) / 100,
  };
}

function mediaUrl(absPath: string): string {
  return `/media?path=${encodeURIComponent(absPath)}`;
}

function ensurePoster(videoPath: string): string | null {
  const dir = join(videoPath, "..", ".thumbs");
  const poster = join(dir, `${basename(videoPath, extname(videoPath))}.jpg`);
  try {
    if (existsSync(poster) && statSync(poster).mtimeMs >= statSync(videoPath).mtimeMs) {
      return mediaUrl(poster);
    }
    mkdirSync(dir, { recursive: true });
    execFileSync(
      FFMPEG,
      ["-y", "-ss", "0.8", "-i", videoPath, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "6", poster],
      { timeout: 12_000, stdio: "ignore" },
    );
    return existsSync(poster) ? mediaUrl(poster) : null;
  } catch {
    return null;
  }
}

export function listLatestCreatives(limit = 4): GlanceCreative[] {
  if (!existsSync(OUTPUT_DIR)) return [];
  const files: { path: string; mtime: number }[] = [];
  for (const dateDir of readdirSync(OUTPUT_DIR)) {
    const folder = join(OUTPUT_DIR, dateDir);
    if (!statSync(folder).isDirectory()) continue;
    for (const name of readdirSync(folder)) {
      if (!name.endsWith(".mp4") || name.startsWith("Test_")) continue;
      const path = join(folder, name);
      files.push({ path, mtime: statSync(path).mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, limit).map((f) => ({
    name: basename(f.path, ".mp4").replace(/^VA_Loans_(\d+)_(\d+)_v(\d+)$/, "VA Loans · $1/$2 v$3").replaceAll("_", " "),
    createdAt: new Date(f.mtime).toISOString(),
    videoUrl: mediaUrl(f.path),
    posterUrl: ensurePoster(f.path),
  }));
}

export function prettyMacName(): string {
  try {
    return execFileSync("/usr/sbin/scutil", ["--get", "ComputerName"], { encoding: "utf8" }).trim();
  } catch {
    return "Mac mini";
  }
}
