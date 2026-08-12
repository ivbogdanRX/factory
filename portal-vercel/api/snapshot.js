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
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json(json);
}
