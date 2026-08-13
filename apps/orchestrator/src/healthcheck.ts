/**
 * Weekly (and on-demand) healthcheck of the whole chain: creative studio,
 * Meta token, OpenAI credits, Gemini key, ChatGPT browser session, ffmpeg and
 * disk. Results go to Slack and are stored for the portal.
 */
import { execFile, exec } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { env, ROOT, VENDOR_STUDIO_DIR } from "./env.js";
import { getSetting, setSetting } from "./db.js";
import { loadVerticals } from "./verticals.js";
import { studioHealthy } from "./creative.js";
import { whoAmI } from "./meta.js";
import { postSlack } from "./slack.js";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

export type CheckStatus = "ok" | "warn" | "fail";

export interface HealthCheckItem {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface HealthReport {
  at: string;
  ok: boolean;
  checks: HealthCheckItem[];
}

/** Minimal .env parser for the vendored studio's keys (OPENAI/GEMINI). */
function vendorEnv(): Record<string, string> {
  const path = join(VENDOR_STUDIO_DIR, ".env");
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"#]*)"?\s*$/.exec(line);
    if (match) out[match[1]!] = match[2]!.trim();
  }
  return out;
}

async function checkStudio(): Promise<HealthCheckItem> {
  const up = await studioHealthy();
  return {
    name: "Creative studio",
    status: up ? "ok" : "fail",
    detail: up ? `reachable at ${env.studioUrl}` : `not reachable at ${env.studioUrl} — is the launchd service running?`,
  };
}

async function checkMeta(): Promise<HealthCheckItem> {
  if (!env.metaToken) {
    return { name: "Meta token", status: "warn", detail: "META_SYSTEM_USER_TOKEN not set in .env yet" };
  }
  try {
    const name = await whoAmI();
    return { name: "Meta token", status: "ok", detail: `valid, acting as "${name}"` };
  } catch (error) {
    return { name: "Meta token", status: "fail", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function checkOpenAI(): Promise<HealthCheckItem> {
  const key = vendorEnv().OPENAI_API_KEY ?? "";
  if (!key) return { name: "OpenAI credits", status: "warn", detail: "OPENAI_API_KEY not set in vendor/l_automation/.env" };
  // Only a hard failure when OpenAI is actually the active image source;
  // with ChatGPT (or nanobanana) mode it's just a fallback.
  let critical = false;
  try {
    const raw = JSON.parse(readFileSync(join(VENDOR_STUDIO_DIR, "config.json"), "utf8")) as {
      imageSource?: { mode?: string };
    };
    critical = raw.imageSource?.mode === "openai";
  } catch {
    // unreadable config — treat as non-critical
  }
  const badStatus = critical ? "fail" : "warn";
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
    });
    if (response.ok) return { name: "OpenAI credits", status: "ok", detail: "key valid, credits available" };
    const data = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    const message = data.error?.message ?? `HTTP ${response.status}`;
    const isCredits = response.status === 429 || /credit|quota|billing/i.test(message);
    return {
      name: "OpenAI credits",
      status: badStatus,
      detail: isCredits
        ? `out of credits${critical ? "" : " (not the active image source — chatgpt mode is)"} — top up at platform.openai.com (${message})`
        : message,
    };
  } catch (error) {
    return { name: "OpenAI credits", status: badStatus, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function checkGemini(): Promise<HealthCheckItem> {
  const keys = vendorEnv();
  const key = keys.GEMINI_API_KEY ?? keys.GOOGLE_API_KEY ?? "";
  if (!key) return { name: "Gemini key (Veo)", status: "warn", detail: "GEMINI_API_KEY not set in vendor/l_automation/.env" };
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1&key=${encodeURIComponent(key)}`);
    if (response.ok) return { name: "Gemini key (Veo)", status: "ok", detail: "key valid" };
    const data = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    return { name: "Gemini key (Veo)", status: "fail", detail: data.error?.message ?? `HTTP ${response.status}` };
  } catch (error) {
    return { name: "Gemini key (Veo)", status: "fail", detail: error instanceof Error ? error.message : String(error) };
  }
}

async function checkChatGPTSession(): Promise<HealthCheckItem> {
  const name = "ChatGPT session";
  try {
    const { stdout } = await execFileAsync(
      "npx",
      ["tsx", "scripts/probe-chatgpt.ts", "--json"],
      { cwd: VENDOR_STUDIO_DIR, timeout: 90_000, env: { ...process.env, PROBE_HEADLESS: "1" } },
    );
    const jsonLine = stdout.split("\n").reverse().find((l) => l.trim().startsWith("{"));
    if (!jsonLine) return { name, status: "warn", detail: "probe produced no result" };
    const probe = JSON.parse(jsonLine) as { loggedOut: boolean; composerVisible: boolean };
    if (!probe.loggedOut) return { name, status: "ok", detail: "logged in — chatgpt image source ready" };
    if (probe.composerVisible) {
      return { name, status: "fail", detail: "logged OUT — run `npm run login` in vendor/l_automation and sign in to ChatGPT" };
    }
    return { name, status: "warn", detail: "page state unclear (headless block?) — verify manually if chatgpt mode misbehaves" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/profile is already in use|existing browser session/i.test(message)) {
      return { name, status: "warn", detail: "browser profile busy (a job was running) — skipped this week" };
    }
    return { name, status: "warn", detail: `probe failed: ${message.slice(0, 160)}` };
  }
}

async function checkFfmpeg(): Promise<HealthCheckItem> {
  try {
    const { stdout } = await execFileAsync("ffmpeg", ["-hide_banner", "-filters"], { timeout: 10_000 });
    const hasAss = /(^|\s)ass(\s|$)/m.test(stdout) || stdout.includes(" ass ");
    if (!hasAss) {
      return {
        name: "ffmpeg",
        status: "warn",
        detail: "installed but missing libass — captions/headlines won't burn in. brew install ffmpeg-full",
      };
    }
    return { name: "ffmpeg", status: "ok", detail: "installed with libass (captions ready)" };
  } catch {
    return { name: "ffmpeg", status: "fail", detail: "not on PATH — brew install ffmpeg" };
  }
}

async function checkDisk(): Promise<HealthCheckItem> {
  try {
    const { stdout } = await execAsync(`df -k "${ROOT}" | tail -1 | awk '{print $4}'`);
    const freeGb = Number(stdout.trim()) / 1024 / 1024;
    if (!Number.isFinite(freeGb)) throw new Error("could not parse df output");
    const detail = `${freeGb.toFixed(0)} GB free`;
    return { name: "Disk space", status: freeGb < 20 ? "warn" : "ok", detail: freeGb < 20 ? `${detail} — getting low` : detail };
  } catch (error) {
    return { name: "Disk space", status: "warn", detail: error instanceof Error ? error.message : String(error) };
  }
}

function checkVerticalConfig(): HealthCheckItem {
  const enabled = loadVerticals().filter((v) => v.enabled);
  if (enabled.length === 0) return { name: "Vertical config", status: "warn", detail: "no verticals enabled" };
  const problems: string[] = [];
  for (const v of enabled) {
    const missing: string[] = [];
    if (!v.meta.adAccountId) missing.push("adAccountId");
    if (!v.meta.pageId) missing.push("pageId");
    if (v.meta.mode === "new-campaign" && !v.meta.pixelId) missing.push("pixelId");
    if (v.meta.mode === "new-adset" && !v.meta.parentCampaignId) missing.push("parentCampaignId");
    if (v.meta.mode === "existing-adset" && !v.meta.existingAdSetId) missing.push("existingAdSetId");
    if (missing.length) problems.push(`${v.id}: missing ${missing.join(", ")}`);
  }
  return problems.length
    ? { name: "Vertical config", status: "warn", detail: problems.join(" · ") }
    : { name: "Vertical config", status: "ok", detail: `${enabled.length} enabled vertical(s) fully configured` };
}

function checkSlackConfig(): HealthCheckItem {
  if (!env.slackBotToken || !env.slackChannelId) {
    return { name: "Slack", status: "warn", detail: "tokens not set — notifications are console-only" };
  }
  return { name: "Slack", status: "ok", detail: "configured" };
}

const icon = (s: CheckStatus): string => (s === "ok" ? ":white_check_mark:" : s === "warn" ? ":warning:" : ":x:");

export async function runHealthcheck(options?: { skipBrowserProbe?: boolean }): Promise<HealthReport> {
  const checks: HealthCheckItem[] = [];
  checks.push(await checkStudio());
  checks.push(await checkMeta());
  checks.push(await checkOpenAI());
  checks.push(await checkGemini());
  checks.push(await checkFfmpeg());
  checks.push(await checkDisk());
  checks.push(checkVerticalConfig());
  checks.push(checkSlackConfig());
  if (!options?.skipBrowserProbe) checks.push(await checkChatGPTSession());

  const report: HealthReport = {
    at: new Date().toISOString(),
    ok: checks.every((c) => c.status !== "fail"),
    checks,
  };
  setSetting("lastHealthcheck", JSON.stringify(report));
  setSetting("lastHealthcheckAt", String(Date.now()));

  const lines = checks.map((c) => `${icon(c.status)} *${c.name}* — ${c.detail}`);
  await postSlack(
    `${report.ok ? ":stethoscope: Weekly healthcheck: all clear" : ":stethoscope: Healthcheck found problems"}\n${lines.join("\n")}`,
  );
  return report;
}

export function lastHealthReport(): HealthReport | null {
  const raw = getSetting("lastHealthcheck");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as HealthReport;
  } catch {
    return null;
  }
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
let healthcheckRunning = false;

/** Called from the scheduler tick; runs at most once a week. */
export function maybeRunWeeklyHealthcheck(): void {
  if (healthcheckRunning) return;
  const last = Number(getSetting("lastHealthcheckAt") ?? 0);
  if (Date.now() - last < WEEK_MS) return;
  healthcheckRunning = true;
  void runHealthcheck()
    .catch((error) => console.error("Healthcheck failed:", error))
    .finally(() => {
      healthcheckRunning = false;
    });
}
