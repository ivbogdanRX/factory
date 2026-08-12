/**
 * Receives status snapshots from the Mac orchestrator (PORTAL_PUSH_URL points
 * here). Auth: x-adf-secret header must match the PUSH_SECRET env var.
 * The snapshot is stored in Vercel Blob under a fixed name.
 */
import { put } from "@vercel/blob";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  const secret = process.env.PUSH_SECRET;
  if (!secret || req.headers["x-adf-secret"] !== secret) {
    res.status(401).json({ error: "Bad or missing x-adf-secret" });
    return;
  }
  const body = req.body;
  if (!body || typeof body !== "object" || !body.generatedAt) {
    res.status(400).json({ error: "Body must be a snapshot JSON" });
    return;
  }
  await put("adfactory/snapshot.json", JSON.stringify(body), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 60,
  });
  res.status(200).json({ ok: true });
}
