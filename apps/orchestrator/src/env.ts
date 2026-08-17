import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

/** Repo root (three levels up from apps/orchestrator/src). */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const envPath = join(ROOT, ".env");
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    // already loaded or unsupported — env vars may come from launchd instead
  }
}

export const env = {
  metaToken: process.env.META_SYSTEM_USER_TOKEN ?? "",
  graphVersion: process.env.META_GRAPH_VERSION ?? "v23.0",
  slackBotToken: process.env.SLACK_BOT_TOKEN ?? "",
  slackChannelId: process.env.SLACK_CHANNEL_ID ?? "",
  /** 1 = no outbound Slack posts (slash commands still work). */
  slackMutePosts: process.env.SLACK_MUTE_POSTS === "1",
  studioUrl: (process.env.STUDIO_URL ?? "http://127.0.0.1:5174").replace(/\/$/, ""),
  port: Number(process.env.ORCHESTRATOR_PORT ?? 5180),
  /** Bind address for the glance + API server. 0.0.0.0 so the phone can hit this Mac. */
  bind: process.env.ORCHESTRATOR_BIND ?? "0.0.0.0",
  runHourPt: Number(process.env.RUN_HOUR_PT ?? 10),
  dryRun: process.env.DRY_RUN === "1",
  /** RedTrack API key — conversion/revenue source of truth for guardrails. */
  redtrackApiKey: process.env.REDTRACK_API_KEY ?? "",
  /** Vercel glance-portal push target, e.g. https://adfactory.vercel.app/api/push */
  portalPushUrl: (process.env.PORTAL_PUSH_URL ?? "").replace(/\/$/, ""),
  portalPushSecret: process.env.PORTAL_PUSH_SECRET ?? "",
};

export const DATA_DIR = join(ROOT, "data");
export const VENDOR_STUDIO_DIR = join(ROOT, "vendor", "l_automation");
export const PORTAL_WEB_DIR = join(ROOT, "apps", "portal", "web");
/** Glance UI lives with the Vercel app so local + hosted serve identical files. */
export const PORTAL_GLANCE_DIR = join(ROOT, "portal-vercel", "public");
export const VERTICALS_PATH = join(ROOT, "config", "verticals.yaml");
