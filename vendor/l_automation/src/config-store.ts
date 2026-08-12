import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROJECT_ROOT, loadConfig, resolvePath } from "./config.js";

/**
 * Raw (un-normalized) config.json access for the web UI. Unlike `loadConfig`,
 * this preserves the on-disk shape (relative paths, comments-free JSON) so edits
 * round-trip cleanly instead of getting rewritten with absolute paths.
 */

function configPath(): string {
  return process.env.CONFIG
    ? resolvePath(process.env.CONFIG)
    : resolve(PROJECT_ROOT, "config.json");
}

export function readRawConfig(): Record<string, unknown> {
  const path = configPath();
  if (!existsSync(path)) {
    throw new Error(`No config found at ${path}.`);
  }
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

/**
 * Persist a new campaigns array into config.json. The write is validated by
 * re-running `loadConfig`; if validation fails the original file is restored and
 * the error is rethrown so the UI can surface it.
 */
export function writeCampaigns(campaigns: unknown[]): void {
  const path = configPath();
  const raw = readRawConfig();
  const backup = JSON.stringify(raw, null, 2);

  raw.campaigns = campaigns;
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");

  try {
    loadConfig(path);
  } catch (err) {
    // Roll back to the previous valid contents.
    writeFileSync(path, backup + "\n");
    throw new Error(`Rejected config update: ${(err as Error).message}`);
  }
}

/** One-time timestamped backup of config.json (best effort). */
export function backupConfig(): void {
  const path = configPath();
  if (!existsSync(path)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  try {
    copyFileSync(path, `${path}.${stamp}.bak`);
  } catch {
    // Backups are best-effort; never block a save on them.
  }
}
