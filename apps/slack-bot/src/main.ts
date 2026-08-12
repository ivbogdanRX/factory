/**
 * Slack control surface: Socket Mode bot (no public URL needed on the Mac).
 * Handles /adops slash commands and the Pause/Kill buttons on run
 * notifications by calling the orchestrator's local HTTP API.
 */
import bolt from "@slack/bolt";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const envPath = join(ROOT, ".env");
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch {
    // env may come from launchd
  }
}

const ORCHESTRATOR_URL = (process.env.ORCHESTRATOR_URL ?? "http://127.0.0.1:5180").replace(/\/$/, "");
const ALLOWED_USERS = new Set(
  (process.env.SLACK_ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN) {
  console.error("SLACK_BOT_TOKEN and SLACK_APP_TOKEN are required. Fill them in .env and restart.");
  process.exit(1);
}

function isAllowed(userId: string): boolean {
  return ALLOWED_USERS.size === 0 || ALLOWED_USERS.has(userId);
}

interface RunRow {
  id: string;
  vertical_id: string;
  status: string;
  go_live_at: string | null;
  error: string | null;
}

interface OrchestratorState {
  nextRunAt: string;
  studioHealthy: boolean;
  settings: { runHourPt: number; globalPause: boolean; skipNext: boolean; dryRun: boolean };
  verticals: { id: string; label: string; enabled: boolean; dailyCount: number }[];
  runs: (RunRow & { creatives: { status: string }[] })[];
}

async function api(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(`${ORCHESTRATOR_URL}${path}`, init);
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(String((data as { error?: string }).error ?? `Orchestrator error (${response.status})`));
  return data;
}

function fmtPt(iso: string | null): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

function countdown(iso: string | null): string {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return " (past)";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return ` (in ${hours}h ${minutes}m)`;
}

async function statusText(): Promise<string> {
  const state = (await api("/api/state")) as unknown as OrchestratorState;
  const lines: string[] = [];
  lines.push(`*Next daily run:* ${fmtPt(state.nextRunAt)}${countdown(state.nextRunAt)}`);
  lines.push(
    `*Studio:* ${state.studioHealthy ? "up" : ":warning: down"} · *Global pause:* ${state.settings.globalPause ? "ON" : "off"} · *Skip next:* ${state.settings.skipNext ? "yes" : "no"}${state.settings.dryRun ? " · *DRY RUN*" : ""}`,
  );
  const active = state.runs.filter((r) => ["generating", "uploading", "scheduled", "paused", "live"].includes(r.status)).slice(0, 8);
  if (active.length === 0) {
    lines.push("_No active runs._");
  } else {
    for (const run of active) {
      const ads = run.creatives.filter((c) => c.status === "scheduled").length;
      lines.push(`• \`${run.id}\` ${run.vertical_id} — *${run.status}*${ads ? `, ${ads} ad(s)` : ""}${run.go_live_at ? `, go-live ${fmtPt(run.go_live_at)}${countdown(run.go_live_at)}` : ""}`);
    }
  }
  return lines.join("\n");
}

const app = new bolt.App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

app.command("/adops", async ({ command, ack, respond }) => {
  await ack();
  if (!isAllowed(command.user_id)) {
    await respond({ response_type: "ephemeral", text: "You're not on the allowed user list for ad ops." });
    return;
  }

  const [sub = "status", arg] = command.text.trim().split(/\s+/);
  try {
    switch (sub.toLowerCase()) {
      case "status": {
        await respond({ response_type: "ephemeral", text: await statusText() });
        break;
      }
      case "pause":
      case "resume":
      case "kill": {
        const body: Record<string, string> = { action: sub.toLowerCase() };
        if (arg && arg !== "all") {
          if (arg.startsWith("run_")) body.runId = arg;
          else body.verticalId = arg;
        }
        const data = await api("/api/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const run = data.run as RunRow;
        await respond({ response_type: "in_channel", text: `:ok_hand: \`${run.id}\` (${run.vertical_id}) → *${run.status}*` });
        break;
      }
      case "health": {
        await respond({ response_type: "ephemeral", text: ":stethoscope: Running healthcheck (takes ~30-60s)..." });
        const data = await api("/api/healthcheck", { method: "POST" });
        const report = data.report as { ok: boolean; checks: { name: string; status: string; detail: string }[] };
        const iconFor = (s: string): string => (s === "ok" ? ":white_check_mark:" : s === "warn" ? ":warning:" : ":x:");
        await respond({
          response_type: "ephemeral",
          text: report.checks.map((c) => `${iconFor(c.status)} *${c.name}* — ${c.detail}`).join("\n"),
        });
        break;
      }
      case "perf": {
        const data = await api("/api/perf");
        await respond({ response_type: "ephemeral", text: String(data.text ?? "No data.") });
        break;
      }
      case "angles": {
        const data = await api("/api/angles");
        const verticals = data.verticals as {
          label: string;
          angles: { id: string; name: string; creatives: number; spend: number; purchases: number; costPerPurchase: number | null; weight: number }[];
        }[];
        const lines: string[] = [];
        for (const v of verticals) {
          if (!v.angles.length) continue;
          lines.push(`*${v.label}* (ranked by weight — tomorrow's mix leans toward the top):`);
          for (const a of [...v.angles].sort((x, y) => y.weight - x.weight)) {
            const cpa = a.costPerPurchase !== null ? `$${a.costPerPurchase.toFixed(2)}` : "—";
            lines.push(`> *${a.name}* \`[${a.id}]\` — ${a.creatives} ad(s), $${a.spend.toFixed(2)}, ${a.purchases} purchase(s), CPA ${cpa}`);
          }
        }
        await respond({ response_type: "ephemeral", text: lines.length ? lines.join("\n") : "No angles configured or no finished flights yet." });
        break;
      }
      case "digest": {
        await respond({ response_type: "ephemeral", text: ":newspaper: Building the digest (a few seconds)..." });
        await api("/api/digest", { method: "POST" });
        break;
      }
      case "skip": {
        await api("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ skipNext: true }),
        });
        await respond({ response_type: "in_channel", text: ":fast_forward: Tomorrow's daily run will be skipped once." });
        break;
      }
      case "run": {
        const body = arg ? { verticalId: arg } : {};
        await api("/api/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        await respond({ response_type: "in_channel", text: `:factory: Run started${arg ? ` for *${arg}*` : ""}. Ads still go live next day 5am PT.` });
        break;
      }
      default: {
        await respond({
          response_type: "ephemeral",
          text: [
            "*`/adops` commands:*",
            "`/adops status` — active runs + go-live countdown",
            "`/adops pause [vertical|runId|all]` — pause scheduled ads",
            "`/adops resume [vertical|runId|all]` — resume paused ads",
            "`/adops kill [vertical|runId|all]` — pause + cancel (never goes live)",
            "`/adops skip` — skip tomorrow's daily run once",
            "`/adops run [vertical]` — generate + schedule right now",
            "`/adops digest` — post the morning digest to the channel now",
            "`/adops perf` — spend / purchases / CPA for automated campaigns",
            "`/adops angles` — creative angle leaderboard + tomorrow's mix bias",
            "`/adops health` — run the full healthcheck now",
          ].join("\n"),
        });
      }
    }
  } catch (error) {
    await respond({
      response_type: "ephemeral",
      text: `:x: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
});

for (const actionId of ["run_pause", "run_kill"] as const) {
  app.action(actionId, async ({ body, ack, respond }) => {
    await ack();
    const userId = (body as { user?: { id?: string } }).user?.id ?? "";
    if (!isAllowed(userId)) {
      await respond({ response_type: "ephemeral", replace_original: false, text: "You're not on the allowed user list." });
      return;
    }
    const actions = (body as { actions?: { value?: string }[] }).actions ?? [];
    const runId = actions[0]?.value;
    if (!runId) return;
    try {
      const data = await api("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: actionId === "run_pause" ? "pause" : "kill", runId }),
      });
      const run = data.run as RunRow;
      await respond({
        response_type: "in_channel",
        replace_original: false,
        text: `:ok_hand: <@${userId}> set \`${run.id}\` → *${run.status}*`,
      });
    } catch (error) {
      await respond({
        response_type: "ephemeral",
        replace_original: false,
        text: `:x: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}

// Per-video buttons: act on one Meta ad, not the whole run.
for (const [actionId, verb] of [
  ["ad_pause", "pause"],
  ["ad_resume", "resume"],
  ["ad_kill", "kill"],
] as const) {
  app.action(actionId, async ({ body, ack, respond }) => {
    await ack();
    const userId = (body as { user?: { id?: string } }).user?.id ?? "";
    if (!isAllowed(userId)) {
      await respond({ response_type: "ephemeral", replace_original: false, text: "You're not on the allowed user list." });
      return;
    }
    const actions = (body as { actions?: { value?: string }[] }).actions ?? [];
    const adId = actions[0]?.value;
    if (!adId) return;
    try {
      const data = await api(`/api/creatives/${adId}/${verb}`, { method: "POST" });
      const creative = data.creative as { ad_name: string | null; status: string };
      const icon = verb === "kill" ? ":skull:" : verb === "pause" ? ":double_vertical_bar:" : ":arrow_forward:";
      await respond({
        response_type: "in_channel",
        replace_original: false,
        text: `${icon} <@${userId}> set ad *${creative.ad_name ?? adId}* → *${creative.status}*`,
      });
    } catch (error) {
      await respond({
        response_type: "ephemeral",
        replace_original: false,
        text: `:x: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}

// Hook-test buttons: promote a tested hook into production config, or reject.
// The orchestrator posts the channel confirmation, so the click response stays
// ephemeral to avoid double messages.
for (const [actionId, verb] of [
  ["hook_approve", "approve"],
  ["hook_reject", "reject"],
] as const) {
  app.action(actionId, async ({ body, ack, respond }) => {
    await ack();
    const userId = (body as { user?: { id?: string } }).user?.id ?? "";
    if (!isAllowed(userId)) {
      await respond({ response_type: "ephemeral", replace_original: false, text: "You're not on the allowed user list." });
      return;
    }
    const actions = (body as { actions?: { value?: string }[] }).actions ?? [];
    const hookTestId = actions[0]?.value;
    if (!hookTestId) return;
    try {
      await api(`/api/hook-tests/${hookTestId}/${verb}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
    } catch (error) {
      await respond({
        response_type: "ephemeral",
        replace_original: false,
        text: `:x: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}

// Draft-creative buttons: publish uploads the video to Meta as a new ad in
// the already-scheduled campaign; reject discards it (Meta never touched).
// The orchestrator posts the channel confirmation, so success stays silent.
// Launch now: activate a manual-launch batch campaign early, with however
// many ads are published so far. The orchestrator posts the announcement.
app.action("batch_launch", async ({ body, ack, respond }) => {
  await ack();
  const userId = (body as { user?: { id?: string } }).user?.id ?? "";
  if (!isAllowed(userId)) {
    await respond({ response_type: "ephemeral", replace_original: false, text: "You're not on the allowed user list." });
    return;
  }
  const actions = (body as { actions?: { value?: string }[] }).actions ?? [];
  const runId = actions[0]?.value;
  if (!runId) return;
  try {
    await api(`/api/runs/${runId}/launch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId }),
    });
  } catch (error) {
    await respond({
      response_type: "ephemeral",
      replace_original: false,
      text: `:x: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
});

for (const [actionId, verb] of [
  ["draft_publish", "publish"],
  ["draft_reject", "reject"],
] as const) {
  app.action(actionId, async ({ body, ack, respond }) => {
    await ack();
    const userId = (body as { user?: { id?: string } }).user?.id ?? "";
    if (!isAllowed(userId)) {
      await respond({ response_type: "ephemeral", replace_original: false, text: "You're not on the allowed user list." });
      return;
    }
    const actions = (body as { actions?: { value?: string }[] }).actions ?? [];
    const draftId = actions[0]?.value;
    if (!draftId) return;
    try {
      if (verb === "publish") {
        // Uploading ~60MB to Meta takes a minute; let the clicker know.
        await respond({
          response_type: "ephemeral",
          replace_original: false,
          text: ":hourglass_flowing_sand: Publishing — uploading the video to Meta (about a minute)...",
        });
      }
      await api(`/api/ad-drafts/${draftId}/${verb}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId }),
      });
    } catch (error) {
      await respond({
        response_type: "ephemeral",
        replace_original: false,
        text: `:x: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}

await app.start();
console.log(`Slack bot connected (Socket Mode). Orchestrator: ${ORCHESTRATOR_URL}`);
