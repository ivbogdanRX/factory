/**
 * Serves the latest pushed snapshot to the glance page. If a VIEW_SECRET env
 * var is set, requests must include ?key=<VIEW_SECRET> (the page asks once
 * and remembers it) — recommended, since snapshots include spend numbers.
 */
import { list } from "@vercel/blob";

export default async function handler(req, res) {
  const viewSecret = process.env.VIEW_SECRET;
  if (viewSecret && req.query.key !== viewSecret) {
    res.status(401).json({ error: "Missing or wrong access key" });
    return;
  }
  const { blobs } = await list({ prefix: "adfactory/snapshot.json", limit: 1 });
  const blob = blobs[0];
  if (!blob) {
    res.status(404).json({ error: "No snapshot pushed yet — is the Mac orchestrator running with PORTAL_PUSH_URL set?" });
    return;
  }
  const data = await fetch(`${blob.url}?v=${Date.now()}`, { cache: "no-store" });
  const json = await data.json();

  // Heartbeat: if the Mac stops pushing, this snapshot goes stale. Surface that
  // as an Always-on Mac health check so glance can tell you the box is asleep.
  const lastSeen = json.mac?.lastSeen || json.generatedAt;
  const ageMs = Math.max(0, Date.now() - new Date(lastSeen).getTime());
  const macStatus = ageMs < 90_000 ? "ok" : ageMs < 180_000 ? "warn" : "fail";
  const macCheck = {
    name: "Always-on Mac",
    status: macStatus,
    detail:
      macStatus === "ok"
        ? `on · heartbeat ${Math.round(ageMs / 1000)}s ago${json.mac?.hostname ? ` · ${json.mac.hostname}` : ""}`
        : macStatus === "warn"
          ? `heartbeat ${Math.round(ageMs / 1000)}s ago — Mac may be stalling`
          : `offline · last seen ${Math.round(ageMs / 60000)}m ago — is the Mac asleep or off?`,
  };
  json.mac = {
    ...(json.mac || {}),
    lastSeen,
    online: macStatus === "ok",
    ageMs,
  };
  json.health = json.health || { at: lastSeen, ok: true, checks: [] };
  json.health.checks = [macCheck, ...(json.health.checks || []).filter((c) => c.name !== "Always-on Mac")];
  json.health.ok = json.health.ok && macStatus !== "fail";
  json.health.at = json.health.at || lastSeen;
  if (macStatus === "fail") {
    json.problems = ["always-on Mac is offline", ...((json.problems || []).filter((p) => p !== "always-on Mac is offline"))];
    json.ok = false;
  }

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(json);
}
