/**
 * Orchestrator HTTP API + portal static hosting.
 * Glance is reachable on the LAN / Tailscale; write APIs stay loopback-only
 * (Slack bot talks to 127.0.0.1).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { hostname } from "node:os";
import { env, PORTAL_WEB_DIR, PORTAL_GLANCE_DIR, VENDOR_STUDIO_DIR } from "./env.js";
import { loadVerticals, patchVertical } from "./verticals.js";
import { listRuns, listCreatives, getSetting, setSetting } from "./db.js";
import { nextRunAtIso } from "./schedule.js";
import {
  runDaily,
  runVertical,
  pauseRun,
  resumeRun,
  killRun,
  pauseCreative,
  resumeCreative,
  killCreative,
  findControllableRun,
} from "./runner.js";
import { getPerformanceReport, formatPerformanceReport } from "./perf.js";
import { startHookTest, approveHookTest, rejectHookTest } from "./hook-tests.js";
import { startAdDrafts, publishAdDraft, rejectAdDraft, startManualLaunchBatch, launchRun } from "./ad-drafts.js";
import { listHookTests, listAdDrafts } from "./db.js";
import { runHealthcheck, lastHealthReport } from "./healthcheck.js";
import { sendDigest } from "./digest.js";
import { studioHealthy } from "./creative.js";
import { angleStats } from "./angles.js";
import { buildSnapshot } from "./push.js";

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function isLoopback(req: IncomingMessage): boolean {
  const ip = req.socket.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  return JSON.parse(text) as Record<string, unknown>;
}

/** Only media inside the vendored studio's output tree is served. */
function isAllowedMediaPath(path: string): boolean {
  const resolved = resolve(path);
  return resolved.startsWith(resolve(join(VENDOR_STUDIO_DIR, "output")) + "/")
    || resolved.startsWith(resolve(join(VENDOR_STUDIO_DIR, "downloads")) + "/");
}

function serveMedia(req: IncomingMessage, res: ServerResponse, path: string): void {
  if (!isAllowedMediaPath(path) || !existsSync(path)) {
    sendJson(res, 404, { error: "Media not found" });
    return;
  }
  const stat = statSync(path);
  const type = VIDEO_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Number(match[2]) : stat.size - 1;
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
    });
    createReadStream(path, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Accept-Ranges": "bytes" });
  createReadStream(path).pipe(res);
}

/**
 * Static hosting: the glance UI (shared with the Vercel app) is the root;
 * the full management tool lives at /manage from apps/portal/web.
 */
function serveStatic(res: ServerResponse, pathname: string): void {
  let rel = pathname === "/" ? "index.html" : pathname.slice(1);
  if (rel === "manage") rel = "manage.html";
  for (const dir of [PORTAL_GLANCE_DIR, PORTAL_WEB_DIR]) {
    const path = resolve(join(dir, rel));
    if (path.startsWith(resolve(dir)) && existsSync(path) && statSync(path).isFile()) {
      res.writeHead(200, { "Content-Type": STATIC_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream" });
      createReadStream(path).pipe(res);
      return;
    }
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
}

async function buildState(): Promise<Record<string, unknown>> {
  const runs = listRuns(50).map((run) => ({ ...run, creatives: listCreatives(run.id) }));
  return {
    now: new Date().toISOString(),
    settings: {
      runHourPt: Number(getSetting("runHourPt") ?? env.runHourPt),
      globalPause: getSetting("globalPause") === "1",
      skipNext: getSetting("skipNext") === "1",
      dryRun: env.dryRun,
    },
    nextRunAt: nextRunAtIso(Number(getSetting("runHourPt") ?? env.runHourPt)),
    studioUrl: env.studioUrl,
    studioHealthy: await studioHealthy(),
    lastHealthcheck: lastHealthReport(),
    mac: { hostname: hostname(), online: true, lastSeen: new Date().toISOString() },
    verticals: loadVerticals(),
    runs,
  };
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${env.port}`);
  const { pathname } = url;
  const mutating =
    req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";

  try {
    // The one deliberate exception to loopback-only writes: the phone's
    // "launch production run" button. It has its own friction (exact confirm
    // phrase + cooldown) so it can't fire by accident.
    if (mutating && !isLoopback(req) && pathname !== "/api/launch") {
      sendJson(res, 403, { error: "Write APIs are localhost-only" });
      return;
    }

    if (pathname === "/api/launch" && req.method === "POST") {
      const body = await readBody(req);
      if (String(body.confirm ?? "") !== "LAUNCH") {
        sendJson(res, 400, { error: 'Confirmation phrase missing — type LAUNCH exactly.' });
        return;
      }
      if (getSetting("globalPause") === "1") {
        sendJson(res, 409, { error: "Factory is paused — resume it first (Slack /adops)." });
        return;
      }
      const lastLaunch = Number(getSetting("lastManualLaunchAt") ?? 0);
      const coolMs = 10 * 60 * 1000 - (Date.now() - lastLaunch);
      if (coolMs > 0) {
        sendJson(res, 429, { error: `A run was just launched. Try again in ${Math.ceil(coolMs / 60000)} min.` });
        return;
      }
      const verticalId = body.verticalId ? String(body.verticalId) : undefined;
      if (verticalId) {
        const vertical = loadVerticals().find((v) => v.id === verticalId);
        if (!vertical) {
          sendJson(res, 404, { error: `Unknown vertical: ${verticalId}` });
          return;
        }
        void runVertical(vertical);
      } else {
        void runDaily();
      }
      setSetting("lastManualLaunchAt", String(Date.now()));
      console.log(`Manual production launch from ${req.socket.remoteAddress} (vertical: ${verticalId ?? "all"})`);
      sendJson(res, 202, { ok: true, message: "Production run started — ads will generate now and go live after review." });
      return;
    }
    if (pathname === "/api/state" && req.method === "GET") {
      sendJson(res, 200, await buildState());
      return;
    }

    // Same JSON the Vercel glance app receives — the glance UI fetches this.
    if (pathname === "/api/snapshot" && req.method === "GET") {
      sendJson(res, 200, await buildSnapshot());
      return;
    }

    if (pathname === "/api/run" && req.method === "POST") {
      const body = await readBody(req);
      const verticalId = body.verticalId ? String(body.verticalId) : undefined;
      if (verticalId) {
        const vertical = loadVerticals().find((v) => v.id === verticalId);
        if (!vertical) {
          sendJson(res, 404, { error: `Unknown vertical: ${verticalId}` });
          return;
        }
        void runVertical(vertical);
      } else {
        void runDaily();
      }
      sendJson(res, 202, { ok: true, message: "Run started" });
      return;
    }

    const runAction = /^\/api\/runs\/([^/]+)\/(pause|resume|kill)$/.exec(pathname);
    if (runAction && req.method === "POST") {
      const [, id, action] = runAction;
      const run = action === "pause" ? await pauseRun(id!) : action === "resume" ? await resumeRun(id!) : await killRun(id!);
      sendJson(res, 200, { ok: true, run });
      return;
    }

    // Single-ad controls (Slack per-video buttons). :id is the Meta ad id.
    const creativeAction = /^\/api\/creatives\/([^/]+)\/(pause|resume|kill)$/.exec(pathname);
    if (creativeAction && req.method === "POST") {
      const [, adId, action] = creativeAction;
      const creative =
        action === "pause" ? await pauseCreative(adId!) : action === "resume" ? await resumeCreative(adId!) : await killCreative(adId!);
      sendJson(res, 200, { ok: true, creative });
      return;
    }

    // Used by the Slack bot: act on the latest controllable run for a vertical (or any).
    if (pathname === "/api/control" && req.method === "POST") {
      const body = await readBody(req);
      const action = String(body.action ?? "");
      const verticalId = body.verticalId ? String(body.verticalId) : undefined;
      const target = body.runId ? String(body.runId) : findControllableRun(verticalId)?.id;
      if (!target) {
        sendJson(res, 404, { error: "No controllable run found" });
        return;
      }
      const run = action === "pause" ? await pauseRun(target) : action === "resume" ? await resumeRun(target) : action === "kill" ? await killRun(target) : null;
      if (!run) {
        sendJson(res, 400, { error: `Unknown action: ${action}` });
        return;
      }
      sendJson(res, 200, { ok: true, run });
      return;
    }

    // Hook testing: generate a one-off test video (Slack review only, no Meta).
    if (pathname === "/api/hook-tests" && req.method === "GET") {
      sendJson(res, 200, { ok: true, hookTests: listHookTests() });
      return;
    }

    if (pathname === "/api/hook-tests" && req.method === "POST") {
      const body = await readBody(req);
      const campaignId = String(body.campaignId ?? "").trim();
      const angle = String(body.angle ?? "").trim();
      const hook = String(body.hook ?? "").trim();
      const bubble = String(body.bubble ?? "").trim();
      if (!campaignId || !angle || !hook || !bubble) {
        sendJson(res, 400, { error: "campaignId, angle, hook and bubble are required" });
        return;
      }
      const hookTest = await startHookTest({
        campaignId,
        angle,
        hook,
        bubble,
        creatorPrompt: body.creatorPrompt ? String(body.creatorPrompt).trim() : undefined,
        scenePrompt: body.scenePrompt ? String(body.scenePrompt).trim() : undefined,
      });
      sendJson(res, 201, { ok: true, hookTest });
      return;
    }

    // Approve / reject a hook test (Slack buttons land here via the bot).
    const hookTestAction = /^\/api\/hook-tests\/([^/]+)\/(approve|reject)$/.exec(pathname);
    if (hookTestAction && req.method === "POST") {
      const [, id, action] = hookTestAction;
      const body = await readBody(req);
      const userId = body.userId ? String(body.userId) : undefined;
      const hookTest =
        action === "approve" ? await approveHookTest(id!, userId) : await rejectHookTest(id!, userId);
      sendJson(res, 200, { ok: true, hookTest });
      return;
    }

    // Draft creatives: generate now, review in Slack, publish only on approval.
    if (pathname === "/api/ad-drafts" && req.method === "GET") {
      sendJson(res, 200, { ok: true, adDrafts: listAdDrafts() });
      return;
    }

    if (pathname === "/api/ad-drafts" && req.method === "POST") {
      const body = await readBody(req);
      const verticalId = String(body.verticalId ?? "").trim();
      const angles = Array.isArray(body.angles) ? body.angles.map(String) : [];
      if (!verticalId || angles.length === 0) {
        sendJson(res, 400, { error: "verticalId and a non-empty angles array are required" });
        return;
      }
      const adDrafts = await startAdDrafts(verticalId, angles);
      sendJson(res, 201, { ok: true, adDrafts });
      return;
    }

    // Manual-launch batch: paused campaign now, drafts gate every ad, and the
    // campaign activates when the batch is decided (or via Launch now).
    if (pathname === "/api/ad-drafts/batch" && req.method === "POST") {
      const body = await readBody(req);
      const verticalId = String(body.verticalId ?? "").trim();
      const angles = Array.isArray(body.angles) ? body.angles.map(String) : [];
      if (!verticalId || angles.length === 0) {
        sendJson(res, 400, { error: "verticalId and a non-empty angles array are required" });
        return;
      }
      const batch = await startManualLaunchBatch(verticalId, angles);
      sendJson(res, 201, { ok: true, ...batch });
      return;
    }

    const runLaunch = /^\/api\/runs\/([^/]+)\/launch$/.exec(pathname);
    if (runLaunch && req.method === "POST") {
      const body = await readBody(req);
      const userId = body.userId ? String(body.userId) : undefined;
      const run = await launchRun(runLaunch[1]!, userId);
      sendJson(res, 200, { ok: true, run });
      return;
    }

    // Publish / reject a draft (Slack buttons land here via the bot).
    const adDraftAction = /^\/api\/ad-drafts\/([^/]+)\/(publish|reject)$/.exec(pathname);
    if (adDraftAction && req.method === "POST") {
      const [, id, action] = adDraftAction;
      const body = await readBody(req);
      const userId = body.userId ? String(body.userId) : undefined;
      const adDraft = action === "publish" ? await publishAdDraft(id!, userId) : await rejectAdDraft(id!, userId);
      sendJson(res, 200, { ok: true, adDraft });
      return;
    }

    const verticalPatch = /^\/api\/verticals\/([^/]+)$/.exec(pathname);
    if (verticalPatch && req.method === "PATCH") {
      const body = await readBody(req);
      const vertical = patchVertical(verticalPatch[1]!, body);
      sendJson(res, 200, { ok: true, vertical });
      return;
    }

    if (pathname === "/api/angles" && req.method === "GET") {
      const byVertical = loadVerticals().map((v) => {
        let stats: unknown[] = [];
        try {
          stats = angleStats(v.id, v.creativeCampaignId);
        } catch {
          // studio config unreadable — return empty stats for this vertical
        }
        return { verticalId: v.id, label: v.label, angles: stats };
      });
      sendJson(res, 200, { ok: true, verticals: byVertical });
      return;
    }

    if (pathname === "/api/perf" && req.method === "GET") {
      const entries = await getPerformanceReport();
      sendJson(res, 200, { ok: true, entries, text: entries.length > 0 ? formatPerformanceReport(entries) : "No automated campaigns in the last 7 days." });
      return;
    }

    // Build the morning digest now and post it to the Slack channel.
    if (pathname === "/api/digest" && req.method === "POST") {
      const text = await sendDigest();
      sendJson(res, 200, { ok: true, text });
      return;
    }

    if (pathname === "/api/healthcheck" && req.method === "POST") {
      const report = await runHealthcheck();
      sendJson(res, 200, { ok: true, report });
      return;
    }

    if (pathname === "/api/settings" && req.method === "POST") {
      const body = await readBody(req);
      if (body.runHourPt !== undefined) setSetting("runHourPt", String(Number(body.runHourPt)));
      if (body.digestHourPt !== undefined) setSetting("digestHourPt", String(Number(body.digestHourPt)));
      if (body.globalPause !== undefined) setSetting("globalPause", body.globalPause ? "1" : "0");
      if (body.skipNext !== undefined) setSetting("skipNext", body.skipNext ? "1" : "0");
      sendJson(res, 200, { ok: true });
      return;
    }

    if (pathname === "/media" && req.method === "GET") {
      serveMedia(req, res, url.searchParams.get("path") ?? "");
      return;
    }

    if (req.method === "GET") {
      serveStatic(res, pathname);
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}

export function startServer(onReady?: () => void): void {
  const server = createServer((req, res) => void handle(req, res));
  server.on("error", (error) => {
    // Most likely EADDRINUSE from a second instance — die before touching
    // anything so the instance that owns the port keeps sole control.
    console.error(`Server failed to bind port ${env.port}:`, error.message);
    process.exit(1);
  });
  server.listen(env.port, env.bind, () => {
    console.log(`Portal + API listening on http://${env.bind}:${env.port}`);
    onReady?.();
  });
}
