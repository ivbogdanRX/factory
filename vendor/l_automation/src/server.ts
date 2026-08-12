import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  createReadStream,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { extname, join, resolve, relative, isAbsolute, sep } from "node:path";
import { PROJECT_ROOT, loadConfig } from "./config.js";
import { ensureDir, slugify, timestamp } from "./utils.js";
import { readRawConfig, writeCampaigns, backupConfig } from "./config-store.js";
import { jobManager } from "./jobs.js";
import {
  spyManager,
  approveSuggestion,
  buildSuggestions,
} from "./spy.js";
import { spyStore, type Suggestion } from "./spy-store.js";
import { configureRateLimit, getRateLimitStatus } from "./ratelimit.js";
import { getVeoModelStatuses } from "./veo-api.js";
import { getVeoUsage, getVeoUsageDay } from "./veo-usage.js";
import { log } from "./logger.js";

const WEB_DIR = join(PROJECT_ROOT, "web");
const ASSETS_DIR = join(PROJECT_ROOT, "assets");
const OUTPUT_DIR = join(PROJECT_ROOT, "output");
const DOWNLOADS_DIR = join(PROJECT_ROOT, "downloads");
const IMAGE_WINNERS_DIR = join(DOWNLOADS_DIR, "image-winners");
const PORT = Number(process.env.PORT ?? 5174);

const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".m4v"]);
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const VIDEO_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

function loadEnvFile(): void {
  try {
    process.loadEnvFile(".env");
  } catch {
    // optional
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** True only when `target` lives inside `root` (blocks path traversal). */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

function listFiles(
  dir: string,
  baseLabel: string,
  exts: Set<string> = VIDEO_EXTS,
  filter?: (full: string) => boolean,
): Array<{ name: string; path: string; size: number; modified: number }> {
  const out: Array<{ name: string; path: string; size: number; modified: number }> = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const full = join(d, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (exts.has(extname(entry).toLowerCase()) && (!filter || filter(full))) {
        out.push({
          name: relative(join(PROJECT_ROOT, baseLabel), full),
          path: full,
          size: st.size,
          modified: st.mtimeMs,
        });
      }
    }
  };
  walk(dir);
  return out.sort((a, b) => b.modified - a.modified);
}

function listVideos(dir: string, baseLabel: string): Array<{
  name: string;
  path: string;
  size: number;
  modified: number;
}> {
  return listFiles(dir, baseLabel, VIDEO_EXTS);
}

function serveStatic(res: ServerResponse, pathname: string): void {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = resolve(WEB_DIR, rel);
  if (!isInside(WEB_DIR, filePath) && filePath !== join(WEB_DIR, "index.html")) {
    sendJson(res, 403, { error: "Forbidden" });
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  const type = STATIC_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  const data = readFileSync(filePath);
  res.writeHead(200, { "Content-Type": type, "Content-Length": data.length });
  res.end(data);
}

/** Serve a video file with HTTP range support so the browser can scrub. */
function serveMedia(req: IncomingMessage, res: ServerResponse, target: string): void {
  const filePath = isAbsolute(target) ? resolve(target) : resolve(PROJECT_ROOT, target);
  const allowed =
    isInside(ASSETS_DIR, filePath) ||
    isInside(OUTPUT_DIR, filePath) ||
    isInside(DOWNLOADS_DIR, filePath);
  if (!allowed || !existsSync(filePath) || !statSync(filePath).isFile()) {
    sendJson(res, 404, { error: "Media not found" });
    return;
  }
  const ext = extname(filePath).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) {
    sendJson(res, 415, { error: "Unsupported media type" });
    return;
  }
  const size = statSync(filePath).size;
  const type = VIDEO_TYPES[ext] ?? "application/octet-stream";
  const range = req.headers.range;

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    const start = match && match[1] ? Number(match[1]) : 0;
    const end = match && match[2] ? Number(match[2]) : size - 1;
    if (start >= size || end >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": type,
    });
    createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    "Content-Length": size,
    "Content-Type": type,
    "Accept-Ranges": "bytes",
  });
  createReadStream(filePath).pipe(res);
}

/** Serve a generated reference image (from downloads/) for progress previews. */
function serveImage(res: ServerResponse, target: string): void {
  if (!target) {
    sendJson(res, 400, { error: "Missing image path" });
    return;
  }
  const filePath = isAbsolute(target) ? resolve(target) : resolve(PROJECT_ROOT, target);
  const ext = extname(filePath).toLowerCase();
  const allowed =
    (isInside(DOWNLOADS_DIR, filePath) || isInside(OUTPUT_DIR, filePath)) &&
    IMAGE_EXTS.has(ext);
  if (!allowed || !existsSync(filePath) || !statSync(filePath).isFile()) {
    sendJson(res, 404, { error: "Image not found" });
    return;
  }
  const data = readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": IMAGE_TYPES[ext] ?? "application/octet-stream",
    "Content-Length": data.length,
    "Cache-Control": "public, max-age=86400",
  });
  res.end(data);
}

/** Server-Sent Events stream of a job's logs + status. */
function streamJob(res: ServerResponse, id: string): void {
  const job = jobManager.get(id);
  if (!job) {
    sendJson(res, 404, { error: "Job not found" });
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let sent = 0;
  const push = (): void => {
    const current = jobManager.get(id);
    if (!current) return;
    while (sent < current.logs.length) {
      const line = current.logs[sent++]!;
      res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
    }
    res.write(
      `event: progress\ndata: ${JSON.stringify(current.progress ?? null)}\n\n`,
    );
    res.write(
      `event: status\ndata: ${JSON.stringify({
        status: current.status,
        outputs: current.outputs,
        error: current.error,
      })}\n\n`,
    );
    if (current.status !== "running") {
      clearInterval(timer);
      res.write("event: end\ndata: {}\n\n");
      res.end();
    }
  };
  const timer = setInterval(push, 600);
  push();
  res.on("close", () => clearInterval(timer));
}

/** Server-Sent Events stream of the current spy crawl's logs + status. */
function streamCrawl(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  let sent = 0;
  const push = (): void => {
    const state = spyManager.get();
    while (sent < state.logs.length) {
      const line = state.logs[sent++]!;
      res.write(`event: log\ndata: ${JSON.stringify(line)}\n\n`);
    }
    res.write(
      `event: status\ndata: ${JSON.stringify({
        running: state.running,
        error: state.error,
        summary: state.summary,
      })}\n\n`,
    );
    if (!state.running) {
      clearInterval(timer);
      res.write("event: end\ndata: {}\n\n");
      res.end();
    }
  };
  const timer = setInterval(push, 600);
  push();
  res.on("close", () => clearInterval(timer));
}

/** Attach the ad's media + links to a suggestion for the UI. */
function enrichSuggestion(s: Suggestion): unknown {
  const ad = spyStore.getAd(s.adKey);
  return {
    ...s,
    ad: ad
      ? {
          archiveId: ad.archiveId,
          snapshotUrl: ad.snapshotUrl,
          mediaType: ad.mediaType,
          imageUrl: ad.imageUrl,
          localVideo: ad.localVideo,
          runDays: ad.runDays,
          copyCount: ad.copyCount,
          active: ad.active,
        }
      : null,
  };
}

/** Friendly quality tier inferred from a Veo model id. */
function veoTier(id: string): string {
  if (/lite/i.test(id)) return "Lite";
  if (/fast/i.test(id)) return "Fast";
  return "Standard";
}

/** Compose the live capacity/model status payload for the UI. */
function buildStatus(): unknown {
  let backend = "api";
  let chain: string[] = [];
  let maxConcurrent = 0;
  let rpmLimit = 2;
  let rpdLimit = 10;
  try {
    const cfg = loadConfig();
    backend = cfg.flow.backend;
    maxConcurrent = cfg.concurrency.maxConcurrentJobs;
    rpmLimit = cfg.flow.veoRequestsPerMinute;
    rpdLimit = cfg.flow.veoRequestsPerDay;
    chain = [cfg.flow.apiModel, ...cfg.flow.apiModelFallbacks].filter(
      (m, i, arr) => m && arr.indexOf(m) === i,
    );
  } catch (err) {
    log.warn(`Status: could not load config: ${(err as Error).message}`);
  }

  const statuses = getVeoModelStatuses();
  let dailyUsed = 0;
  const models = chain.map((id, idx) => {
    const s = statuses[id];
    const usage = getVeoUsage(id);
    dailyUsed += Math.min(usage.rpdUsed, rpdLimit);
    return {
      id,
      tier: veoTier(id),
      role: idx === 0 ? "primary" : "fallback",
      state: s?.state ?? "available",
      detail: s?.detail,
      updatedAt: s?.updatedAt,
      rpmLimit,
      rpdLimit,
      rpmUsed: usage.rpmUsed,
      rpdUsed: usage.rpdUsed,
    };
  });

  const dailyLimit = rpdLimit * models.length;
  return {
    backend,
    maxConcurrent,
    rateLimit: getRateLimitStatus(),
    capacity: jobManager.capacity(),
    veoDaily: {
      day: getVeoUsageDay(),
      used: dailyUsed,
      limit: dailyLimit,
      left: Math.max(0, dailyLimit - dailyUsed),
      perModelRpm: rpmLimit,
      perModelRpd: rpdLimit,
    },
    models,
  };
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  // GET /api/config
  if (pathname === "/api/config" && req.method === "GET") {
    const raw = readRawConfig();
    sendJson(res, 200, {
      campaigns: raw.campaigns ?? [],
      video: raw.video ?? {},
      imageSource: raw.imageSource ?? {},
    });
    return;
  }

  // POST /api/config  { campaigns: [...] }
  if (pathname === "/api/config" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    if (!Array.isArray(body.campaigns)) {
      sendJson(res, 400, { error: "Expected { campaigns: [...] }" });
      return;
    }
    backupConfig();
    writeCampaigns(body.campaigns);
    sendJson(res, 200, { ok: true, campaigns: body.campaigns });
    return;
  }

  // GET /api/assets
  if (pathname === "/api/assets" && req.method === "GET") {
    sendJson(res, 200, { assets: listVideos(ASSETS_DIR, "assets") });
    return;
  }

  // GET /api/status — live rate limit + Veo model availability
  if (pathname === "/api/status" && req.method === "GET") {
    sendJson(res, 200, buildStatus());
    return;
  }

  // GET /api/outputs
  if (pathname === "/api/outputs" && req.method === "GET") {
    sendJson(res, 200, { outputs: listVideos(OUTPUT_DIR, "output").slice(0, 60) });
    return;
  }

  // POST /api/jobs
  if (pathname === "/api/jobs" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const job = jobManager.start({
      campaignId: body.campaignId || undefined,
      count: body.count ? Number(body.count) : undefined,
      variantIndex:
        body.variantIndex === undefined || body.variantIndex === null || body.variantIndex === ""
          ? undefined
          : Number(body.variantIndex),
      hookIndex:
        body.hookIndex === undefined || body.hookIndex === null || body.hookIndex === ""
          ? undefined
          : Number(body.hookIndex),
      hookOverride: body.hookOverride?.trim() || undefined,
      creatorPromptOverride: body.creatorPromptOverride?.trim() || undefined,
      scenePromptOverride: body.scenePromptOverride?.trim() || undefined,
      hookBubbleText: body.hookBubbleText?.trim() || undefined,
      randomSelection:
        body.randomSelection === undefined || body.randomSelection === null || body.randomSelection === ""
          ? undefined
          : Boolean(body.randomSelection),
      image: body.image || undefined,
    });
    sendJson(res, 201, { job, capacity: jobManager.capacity() });
    return;
  }

  // POST /api/full-ad — generate a brand-new full ad from a script
  if (pathname === "/api/full-ad" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const name = String(body.name ?? "").trim();
    const script = String(body.script ?? "").trim();
    if (!name) {
      sendJson(res, 400, { error: "A topic / name is required." });
      return;
    }
    if (!script) {
      sendJson(res, 400, { error: "A script is required." });
      return;
    }
    const job = jobManager.start({
      fullAd: {
        name,
        script,
        angle: body.angle ? String(body.angle).trim() : undefined,
        promptContext: body.promptContext
          ? String(body.promptContext).trim()
          : undefined,
        personaPrompt: body.personaPrompt
          ? String(body.personaPrompt).trim()
          : undefined,
        autoSplit: Boolean(body.autoSplit),
        maxSegments:
          body.maxSegments === undefined ||
          body.maxSegments === null ||
          body.maxSegments === ""
            ? undefined
            : Number(body.maxSegments),
        captionsEnabled:
          body.captionsEnabled === undefined ||
          body.captionsEnabled === null ||
          body.captionsEnabled === ""
            ? undefined
            : Boolean(body.captionsEnabled),
        hookBubbleText: body.hookBubbleText
          ? String(body.hookBubbleText).trim()
          : undefined,
        bodyVideo: body.bodyVideo ? String(body.bodyVideo).trim() : undefined,
        speed:
          body.speed === undefined || body.speed === null || body.speed === ""
            ? undefined
            : Number(body.speed),
        overlays: Boolean(body.overlays),
        overlayStyle:
          body.overlayStyle === "fullframe" || body.overlayStyle === "pip"
            ? body.overlayStyle
            : "both",
        overlaySource: body.overlaySource === "video" ? "video" : "image",
        maxOverlays:
          body.maxOverlays === undefined ||
          body.maxOverlays === null ||
          body.maxOverlays === ""
            ? undefined
            : Number(body.maxOverlays),
        backend: body.backend === "api" ? "api" : "browser",
      },
    });
    sendJson(res, 201, { job, capacity: jobManager.capacity() });
    return;
  }

  // POST /api/image-ads/upload — save a winner image (base64) for studying
  if (pathname === "/api/image-ads/upload" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const dataBase64 = String(body.dataBase64 ?? "").replace(
      /^data:[^;]+;base64,/,
      "",
    );
    if (!dataBase64) {
      sendJson(res, 400, { error: "Missing image data." });
      return;
    }
    const ext = (() => {
      const raw = extname(String(body.filename ?? "")).toLowerCase();
      return IMAGE_EXTS.has(raw) ? raw : ".png";
    })();
    const base = slugify(String(body.filename ?? "winner").replace(/\.[^.]+$/, ""));
    const dir = ensureDir(IMAGE_WINNERS_DIR);
    const filePath = join(dir, `${base}_${timestamp()}${ext}`);
    try {
      writeFileSync(filePath, Buffer.from(dataBase64, "base64"));
    } catch (err) {
      sendJson(res, 500, { error: `Could not save image: ${(err as Error).message}` });
      return;
    }
    sendJson(res, 201, { path: relative(PROJECT_ROOT, filePath) });
    return;
  }

  // GET /api/image-ads/results — generated image ads on disk (output/*/images/)
  if (pathname === "/api/image-ads/results" && req.method === "GET") {
    const imagesDirSegment = `${sep}images${sep}`;
    const results = listFiles(
      OUTPUT_DIR,
      "output",
      IMAGE_EXTS,
      (full) => full.includes(imagesDirSegment),
    ).slice(0, 120);
    sendJson(res, 200, { results });
    return;
  }

  // POST /api/image-ads/generate — study winners + queue variation generation
  if (pathname === "/api/image-ads/generate" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const winners = Array.isArray(body.winners)
      ? body.winners.map((w: unknown) => String(w)).filter(Boolean)
      : [];
    if (winners.length === 0) {
      sendJson(res, 400, { error: "Upload at least one winner image." });
      return;
    }
    const job = jobManager.start({
      imageAd: {
        winners,
        vertical: body.vertical ? String(body.vertical).trim() : undefined,
        angle: body.angle ? String(body.angle).trim() : undefined,
        count:
          body.count === undefined || body.count === null || body.count === ""
            ? undefined
            : Number(body.count),
        mode:
          body.mode === "edit" || body.mode === "fresh" || body.mode === "both"
            ? body.mode
            : undefined,
      },
    });
    sendJson(res, 201, { job, capacity: jobManager.capacity() });
    return;
  }

  // GET /api/jobs
  if (pathname === "/api/jobs" && req.method === "GET") {
    sendJson(res, 200, {
      capacity: jobManager.capacity(),
      jobs: jobManager.list(),
    });
    return;
  }

  // GET /api/jobs/:id  and  /api/jobs/:id/stream
  const jobMatch = /^\/api\/jobs\/([^/]+)(\/stream)?$/.exec(pathname);
  if (jobMatch && req.method === "GET") {
    const id = jobMatch[1]!;
    if (jobMatch[2]) {
      streamJob(res, id);
      return;
    }
    const job = jobManager.get(id);
    if (!job) {
      sendJson(res, 404, { error: "Job not found" });
      return;
    }
    sendJson(res, 200, { job });
    return;
  }

  // ---- Spy / ad-library research ------------------------------------------

  // GET /api/spy/state — pages, counts, crawl status
  if (pathname === "/api/spy/state" && req.method === "GET") {
    const crawl = spyManager.get();
    let autoCrawlMinutes = 0;
    try {
      autoCrawlMinutes = loadConfig().spy.autoCrawlMinutes;
    } catch {
      /* ignore */
    }
    sendJson(res, 200, {
      autoCrawlMinutes,
      pages: spyStore.listPages(),
      counts: {
        ads: spyStore.listAds().length,
        suggestions: spyStore
          .listSuggestions()
          .filter((s) => s.status === "pending").length,
      },
      crawl: {
        running: crawl.running,
        startedAt: crawl.startedAt,
        finishedAt: crawl.finishedAt,
        error: crawl.error,
        summary: crawl.summary,
      },
    });
    return;
  }

  // GET/POST /api/spy/pages
  if (pathname === "/api/spy/pages" && req.method === "GET") {
    sendJson(res, 200, { pages: spyStore.listPages() });
    return;
  }
  if (pathname === "/api/spy/pages" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    if (!body.input || !String(body.input).trim()) {
      sendJson(res, 400, {
        error: "Provide a page name, numeric page id, or Ad Library URL.",
      });
      return;
    }
    const page = spyStore.addPage({
      input: String(body.input),
      label: body.label ? String(body.label) : undefined,
      verticalHint: body.verticalHint ? String(body.verticalHint) : undefined,
    });
    sendJson(res, 201, { page });
    return;
  }

  // DELETE /api/spy/pages/:id
  const pageMatch = /^\/api\/spy\/pages\/([^/]+)$/.exec(pathname);
  if (pageMatch && req.method === "DELETE") {
    spyStore.removePage(pageMatch[1]!);
    sendJson(res, 200, { ok: true });
    return;
  }

  // POST /api/spy/crawl — start a crawl
  if (pathname === "/api/spy/crawl" && req.method === "POST") {
    const { started } = spyManager.startCrawl();
    sendJson(res, started ? 202 : 409, {
      started,
      error: started ? undefined : "A crawl is already running.",
    });
    return;
  }

  // GET /api/spy/crawl/stream — live crawl logs
  if (pathname === "/api/spy/crawl/stream" && req.method === "GET") {
    streamCrawl(res);
    return;
  }

  // GET /api/spy/suggestions — ranked, grouped by vertical
  if (pathname === "/api/spy/suggestions" && req.method === "GET") {
    const list = spyStore
      .listSuggestions()
      .filter((s) => s.status !== "dismissed")
      .map(enrichSuggestion);
    sendJson(res, 200, { suggestions: list });
    return;
  }

  // POST /api/spy/suggestions/rebuild — recompute from current ads
  if (pathname === "/api/spy/suggestions/rebuild" && req.method === "POST") {
    try {
      const n = buildSuggestions(loadConfig());
      sendJson(res, 200, { ok: true, pending: n });
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
    return;
  }

  // POST /api/spy/suggestions/:id/approve
  const approveMatch = /^\/api\/spy\/suggestions\/([^/]+)\/approve$/.exec(pathname);
  if (approveMatch && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    try {
      const result = await approveSuggestion(approveMatch[1]!, {
        bodyVideo: String(body.bodyVideo ?? ""),
        count: body.count ? Number(body.count) : undefined,
      });
      // Queue the regeneration jobs through the normal worker pool.
      const job = jobManager.start({
        campaignId: result.campaignId,
        count: result.count,
        randomSelection: true,
      });
      spyStore.patchSuggestion(approveMatch[1]!, { jobIds: [job.id] });
      sendJson(res, 200, {
        ok: true,
        campaignId: result.campaignId,
        hooks: result.hooks,
        job,
      });
    } catch (err) {
      sendJson(res, 400, { error: (err as Error).message });
    }
    return;
  }

  // POST /api/spy/suggestions/:id/remake — recreate the FULL ad end-to-end
  const remakeMatch = /^\/api\/spy\/suggestions\/([^/]+)\/remake$/.exec(pathname);
  if (remakeMatch && req.method === "POST") {
    const id = remakeMatch[1]!;
    const suggestion = spyStore.getSuggestion(id);
    if (!suggestion) {
      sendJson(res, 404, { error: "Suggestion not found" });
      return;
    }
    const job = jobManager.start({ fullRemakeSuggestionId: id });
    spyStore.patchSuggestion(id, {
      status: "approved",
      jobIds: [...(suggestion.jobIds ?? []), job.id],
    });
    sendJson(res, 200, { ok: true, job });
    return;
  }

  // POST /api/spy/suggestions/:id/dismiss
  const dismissMatch = /^\/api\/spy\/suggestions\/([^/]+)\/dismiss$/.exec(pathname);
  if (dismissMatch && req.method === "POST") {
    spyStore.patchSuggestion(dismissMatch[1]!, { status: "dismissed" });
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: "Unknown API route" });
}

function main(): void {
  loadEnvFile();

  // Configure the worker pool + shared rate limiter from config.
  try {
    const cfg = loadConfig();
    jobManager.configure(cfg.concurrency.maxConcurrentJobs);
    configureRateLimit(cfg.concurrency.apiRequestsPerMinute);
    log.info(
      `Concurrency: up to ${cfg.concurrency.maxConcurrentJobs} parallel job(s), ` +
        `${cfg.concurrency.apiRequestsPerMinute || "unlimited"} API req/min.`,
    );
  } catch (err) {
    log.warn(`Could not preload config for concurrency: ${(err as Error).message}`);
  }

  // Continuous tracking: periodically re-crawl whitelisted pages so suggestions
  // stay fresh without you clicking "Crawl now". A crawl is skipped if one is
  // already running, or if there are no tracked pages.
  try {
    const cfg = loadConfig();
    const mins = cfg.spy.enabled ? cfg.spy.autoCrawlMinutes : 0;
    if (mins > 0) {
      log.info(`Spy auto-tracking: re-crawling every ${mins} min.`);
      const tick = (): void => {
        if (spyStore.listPages().length === 0) return;
        const { started } = spyManager.startCrawl();
        if (started) log.info("Spy auto-crawl started.");
      };
      // First pass shortly after boot, then on the configured interval.
      setTimeout(tick, 60_000);
      setInterval(tick, mins * 60_000);
    }
  } catch {
    /* scheduler is best-effort */
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const pathname = url.pathname;

    const done = (p: Promise<void>): void => {
      p.catch((err) => {
        log.error(`Request error: ${(err as Error).message}`);
        if (!res.headersSent) sendJson(res, 500, { error: (err as Error).message });
      });
    };

    if (pathname.startsWith("/api/")) {
      done(handleApi(req, res, pathname));
      return;
    }
    if (pathname === "/media") {
      const target = url.searchParams.get("path") ?? "";
      serveMedia(req, res, target);
      return;
    }
    if (pathname === "/image") {
      const target = url.searchParams.get("path") ?? "";
      serveImage(res, target);
      return;
    }
    serveStatic(res, pathname);
  });

  server.listen(PORT, () => {
    log.ok(`Control panel running at http://localhost:${PORT}`);
    log.info(`Serving UI from ${relative(PROJECT_ROOT, WEB_DIR) || "."}${sep}`);
  });
}

main();
