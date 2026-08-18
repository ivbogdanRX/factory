import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./env.js";

export type RunStatus =
  | "generating"
  | "uploading"
  | "scheduled"
  | "live"
  | "paused"
  | "completed"
  | "cancelled"
  | "error";

export interface RunRow {
  id: string;
  vertical_id: string;
  status: RunStatus;
  created_at: number;
  go_live_at: string | null;
  mode: string;
  meta_adset_id: string | null;
  meta_campaign_id: string | null;
  error: string | null;
  note: string | null;
  /**
   * Extra token inserted after {date} in campaign/ad set/ad names, e.g. "B"
   * for a same-day second campaign ("(IB) LNV AF 8-12 B"). Null = none.
   */
  name_tag: string | null;
}

export interface CreativeRow {
  id: number;
  run_id: string;
  output_path: string;
  video_id: string | null;
  ad_id: string | null;
  ad_name: string | null;
  status: string;
  error: string | null;
  /** Creative angle id (studio variant), e.g. "ugc-selfie". */
  angle: string | null;
  /** Final lifetime metrics, filled when the run's flight ends. */
  spend: number | null;
  purchases: number | null;
  impressions: number | null;
  clicks: number | null;
}

mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(join(DATA_DIR, "ad-factory.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  vertical_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  go_live_at TEXT,
  mode TEXT NOT NULL DEFAULT 'new-adset',
  meta_adset_id TEXT,
  error TEXT,
  note TEXT
);
CREATE TABLE IF NOT EXISTS creatives (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  output_path TEXT NOT NULL,
  video_id TEXT,
  ad_id TEXT,
  ad_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS alert_state (
  key TEXT PRIMARY KEY,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ad_remediations (
  ad_id TEXT PRIMARY KEY,
  ad_name TEXT,
  original_creative_id TEXT,
  puppy_creative_id TEXT,
  state TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  campaign_name TEXT,
  is_ours INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS hook_tests (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  angle TEXT NOT NULL,
  hook TEXT NOT NULL,
  bubble TEXT NOT NULL,
  video_path TEXT,
  status TEXT NOT NULL DEFAULT 'generating',
  studio_job_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ad_drafts (
  id TEXT PRIMARY KEY,
  vertical_id TEXT NOT NULL,
  angle TEXT NOT NULL,
  video_path TEXT,
  status TEXT NOT NULL DEFAULT 'generating',
  studio_job_id TEXT,
  ad_id TEXT,
  ad_name TEXT,
  error TEXT,
  created_at INTEGER NOT NULL
);
`);

// Lightweight migrations for databases created before newer features.
const MIGRATIONS = [
  `ALTER TABLE runs ADD COLUMN meta_campaign_id TEXT`,
  `ALTER TABLE creatives ADD COLUMN angle TEXT`,
  `ALTER TABLE creatives ADD COLUMN spend REAL`,
  `ALTER TABLE creatives ADD COLUMN purchases INTEGER`,
  `ALTER TABLE creatives ADD COLUMN impressions INTEGER`,
  `ALTER TABLE creatives ADD COLUMN clicks INTEGER`,
  `ALTER TABLE hook_tests ADD COLUMN creator_prompt TEXT`,
  `ALTER TABLE hook_tests ADD COLUMN scene_prompt TEXT`,
  `ALTER TABLE ad_remediations ADD COLUMN campaign_name TEXT`,
  `ALTER TABLE ad_remediations ADD COLUMN is_ours INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE runs ADD COLUMN name_tag TEXT`,
  `ALTER TABLE ad_drafts ADD COLUMN target_run_id TEXT`,
];

db.exec(`
CREATE TABLE IF NOT EXISTS rejected_creatives (
  fingerprint TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  reason TEXT,
  ad_id TEXT,
  ad_name TEXT,
  account_id TEXT,
  created_at INTEGER NOT NULL
);
`);

export interface RejectedCreativeRow {
  fingerprint: string;
  file_name: string;
  reason: string | null;
  ad_id: string | null;
  ad_name: string | null;
  account_id: string | null;
  created_at: number;
}

export function upsertRejectedCreative(row: Omit<RejectedCreativeRow, "created_at"> & { created_at?: number }): void {
  db.prepare(
    `INSERT INTO rejected_creatives (fingerprint, file_name, reason, ad_id, ad_name, account_id, created_at)
     VALUES (@fingerprint, @file_name, @reason, @ad_id, @ad_name, @account_id, @created_at)
     ON CONFLICT(fingerprint) DO UPDATE SET
       reason = excluded.reason,
       ad_id = excluded.ad_id,
       ad_name = excluded.ad_name,
       account_id = excluded.account_id`,
  ).run({
    ...row,
    created_at: row.created_at ?? Date.now(),
  });
}

export function getRejectedCreative(fingerprint: string): RejectedCreativeRow | undefined {
  return db.prepare(`SELECT * FROM rejected_creatives WHERE fingerprint = ?`).get(fingerprint) as
    | RejectedCreativeRow
    | undefined;
}

export function listRejectedCreatives(): RejectedCreativeRow[] {
  return db.prepare(`SELECT * FROM rejected_creatives ORDER BY created_at DESC`).all() as RejectedCreativeRow[];
}
for (const migration of MIGRATIONS) {
  try {
    db.exec(migration);
  } catch {
    // column already exists
  }
}

export function createRun(verticalId: string, mode: string): RunRow {
  const id = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const row: RunRow = {
    id,
    vertical_id: verticalId,
    status: "generating",
    created_at: Date.now(),
    go_live_at: null,
    mode,
    meta_adset_id: null,
    meta_campaign_id: null,
    error: null,
    note: null,
    name_tag: null,
  };
  db.prepare(
    `INSERT INTO runs (id, vertical_id, status, created_at, go_live_at, mode, meta_adset_id, meta_campaign_id, error, note, name_tag)
     VALUES (@id, @vertical_id, @status, @created_at, @go_live_at, @mode, @meta_adset_id, @meta_campaign_id, @error, @note, @name_tag)`,
  ).run(row);
  return row;
}

export function updateRun(id: string, patch: Partial<RunRow>): void {
  const fields = Object.keys(patch).filter((k) => k !== "id");
  if (fields.length === 0) return;
  const sets = fields.map((f) => `${f} = @${f}`).join(", ");
  db.prepare(`UPDATE runs SET ${sets} WHERE id = @id`).run({ ...patch, id });
}

export function getRun(id: string): RunRow | undefined {
  return db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as RunRow | undefined;
}

export function listRuns(limit = 50): RunRow[] {
  return db.prepare(`SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`).all(limit) as RunRow[];
}

export function listRunsByStatus(status: RunStatus): RunRow[] {
  return db.prepare(`SELECT * FROM runs WHERE status = ?`).all(status) as RunRow[];
}

export function addCreative(runId: string, outputPath: string, angle?: string): number {
  const info = db
    .prepare(`INSERT INTO creatives (run_id, output_path, status, angle) VALUES (?, ?, 'pending', ?)`)
    .run(runId, outputPath, angle ?? null);
  return Number(info.lastInsertRowid);
}

export function updateCreative(id: number, patch: Partial<CreativeRow>): void {
  const fields = Object.keys(patch).filter((k) => k !== "id");
  if (fields.length === 0) return;
  const sets = fields.map((f) => `${f} = @${f}`).join(", ");
  db.prepare(`UPDATE creatives SET ${sets} WHERE id = @id`).run({ ...patch, id });
}

export function getCreativeByAdId(adId: string): CreativeRow | undefined {
  return db.prepare(`SELECT * FROM creatives WHERE ad_id = ?`).get(adId) as CreativeRow | undefined;
}

export function listCreatives(runId: string): CreativeRow[] {
  return db.prepare(`SELECT * FROM creatives WHERE run_id = ? ORDER BY id`).all(runId) as CreativeRow[];
}

/** Every creative that has an angle and final metrics (finished flights). */
export function listMeasuredCreatives(verticalId: string): CreativeRow[] {
  return db
    .prepare(
      `SELECT c.* FROM creatives c JOIN runs r ON r.id = c.run_id
       WHERE r.vertical_id = ? AND c.angle IS NOT NULL AND c.spend IS NOT NULL`,
    )
    .all(verticalId) as CreativeRow[];
}

// ---------------------------------------------------------------------------
// Hook tests: one-off test videos reviewed in Slack before a hook is promoted
// into the studio campaign's production hooks.
// ---------------------------------------------------------------------------

export type HookTestStatus =
  | "generating"
  | "pending"
  | "approved"
  | "rejected"
  | "superseded"
  | "error";

export interface HookTestRow {
  id: string;
  /** Studio campaign the hook targets, e.g. "va-loans-veterans". */
  campaign_id: string;
  /** Target angle/variant id, e.g. "ugc-selfie" (may not exist yet, e.g. "outrage"). */
  angle: string;
  hook: string;
  bubble: string;
  video_path: string | null;
  status: HookTestStatus;
  studio_job_id: string | null;
  error: string | null;
  created_at: number;
  /** Persona overrides the test was generated with (approval preserves them). */
  creator_prompt: string | null;
  scene_prompt: string | null;
}

export function createHookTest(input: {
  campaignId: string;
  angle: string;
  hook: string;
  bubble: string;
  status?: HookTestStatus;
  creatorPrompt?: string;
  scenePrompt?: string;
}): HookTestRow {
  const row: HookTestRow = {
    id: `ht_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    campaign_id: input.campaignId,
    angle: input.angle,
    hook: input.hook,
    bubble: input.bubble,
    video_path: null,
    status: input.status ?? "generating",
    studio_job_id: null,
    error: null,
    created_at: Date.now(),
    creator_prompt: input.creatorPrompt ?? null,
    scene_prompt: input.scenePrompt ?? null,
  };
  db.prepare(
    `INSERT INTO hook_tests (id, campaign_id, angle, hook, bubble, video_path, status, studio_job_id, error, created_at, creator_prompt, scene_prompt)
     VALUES (@id, @campaign_id, @angle, @hook, @bubble, @video_path, @status, @studio_job_id, @error, @created_at, @creator_prompt, @scene_prompt)`,
  ).run(row);
  return row;
}

export function updateHookTest(id: string, patch: Partial<HookTestRow>): void {
  const fields = Object.keys(patch).filter((k) => k !== "id");
  if (fields.length === 0) return;
  const sets = fields.map((f) => `${f} = @${f}`).join(", ");
  db.prepare(`UPDATE hook_tests SET ${sets} WHERE id = @id`).run({ ...patch, id });
}

export function getHookTest(id: string): HookTestRow | undefined {
  return db.prepare(`SELECT * FROM hook_tests WHERE id = ?`).get(id) as HookTestRow | undefined;
}

export function listHookTests(limit = 100): HookTestRow[] {
  return db.prepare(`SELECT * FROM hook_tests ORDER BY created_at DESC LIMIT ?`).all(limit) as HookTestRow[];
}

export function listHookTestsByStatus(status: HookTestStatus): HookTestRow[] {
  return db.prepare(`SELECT * FROM hook_tests WHERE status = ?`).all(status) as HookTestRow[];
}

export function deleteHookTest(id: string): void {
  db.prepare(`DELETE FROM hook_tests WHERE id = ?`).run(id);
}

// ---------------------------------------------------------------------------
// Alert dedupe state: one row per currently-active alert condition (e.g.
// "ad:123" → "DISAPPROVED"). Presence of a row means "already alerted"; the
// row is cleared when the condition goes away so a relapse re-alerts.
// ---------------------------------------------------------------------------

export function getAlertState(key: string): string | undefined {
  const row = db.prepare(`SELECT detail FROM alert_state WHERE key = ?`).get(key) as
    | { detail: string }
    | undefined;
  return row?.detail;
}

export function setAlertState(key: string, detail: string): void {
  db.prepare(
    `INSERT INTO alert_state (key, detail, created_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET detail = excluded.detail, created_at = excluded.created_at`,
  ).run(key, detail, Date.now());
}

export function clearAlertState(key: string): void {
  db.prepare(`DELETE FROM alert_state WHERE key = ?`).run(key);
}

export function listAlertKeys(prefix: string): string[] {
  return (db.prepare(`SELECT key FROM alert_state WHERE key LIKE ? || '%'`).all(prefix) as { key: string }[]).map(
    (r) => r.key,
  );
}

/** Every Meta ad id this system ever created (for tagging manual vs ours). */
export function listOurAdIds(): Set<string> {
  const rows = db.prepare(`SELECT DISTINCT ad_id FROM creatives WHERE ad_id IS NOT NULL`).all() as { ad_id: string }[];
  return new Set(rows.map((r) => r.ad_id));
}

// ---------------------------------------------------------------------------
// Ad remediations: a rejected ad gets its creative swapped to the compliant
// placeholder ("swapped"), then once Meta re-approves it, it's paused for good
// ("approved"). "failed" rows stop retries/alert spam and record why.
// ---------------------------------------------------------------------------

export type RemediationState = "swapped" | "approved" | "failed";

export interface RemediationRow {
  ad_id: string;
  ad_name: string | null;
  original_creative_id: string | null;
  puppy_creative_id: string | null;
  state: RemediationState;
  note: string | null;
  created_at: number;
  updated_at: number;
  campaign_name: string | null;
  /** 1 when the ad was created by this system, 0 for the user's manual ads. */
  is_ours: number;
}

export function createRemediation(input: {
  adId: string;
  adName: string | null;
  originalCreativeId: string | null;
  puppyCreativeId: string | null;
  state: RemediationState;
  note?: string;
  campaignName?: string | null;
  isOurs?: boolean;
}): RemediationRow {
  const row: RemediationRow = {
    ad_id: input.adId,
    ad_name: input.adName,
    original_creative_id: input.originalCreativeId,
    puppy_creative_id: input.puppyCreativeId,
    state: input.state,
    note: input.note ?? null,
    created_at: Date.now(),
    updated_at: Date.now(),
    campaign_name: input.campaignName ?? null,
    is_ours: input.isOurs === false ? 0 : 1,
  };
  db.prepare(
    `INSERT INTO ad_remediations (ad_id, ad_name, original_creative_id, puppy_creative_id, state, note, created_at, updated_at, campaign_name, is_ours)
     VALUES (@ad_id, @ad_name, @original_creative_id, @puppy_creative_id, @state, @note, @created_at, @updated_at, @campaign_name, @is_ours)`,
  ).run(row);
  return row;
}

export function updateRemediation(adId: string, patch: Partial<RemediationRow>): void {
  const fields = Object.keys(patch).filter((k) => k !== "ad_id");
  fields.push("updated_at");
  const sets = fields.map((f) => `${f} = @${f}`).join(", ");
  db.prepare(`UPDATE ad_remediations SET ${sets} WHERE ad_id = @ad_id`).run({
    ...patch,
    updated_at: Date.now(),
    ad_id: adId,
  });
}

export function getRemediation(adId: string): RemediationRow | undefined {
  return db.prepare(`SELECT * FROM ad_remediations WHERE ad_id = ?`).get(adId) as RemediationRow | undefined;
}

export function listRemediationsByState(state: RemediationState): RemediationRow[] {
  return db.prepare(`SELECT * FROM ad_remediations WHERE state = ?`).all(state) as RemediationRow[];
}

// ---------------------------------------------------------------------------
// Ad drafts: pre-approved creatives reviewed in Slack. Publishing one uploads
// it as a new ad into an already-scheduled campaign's ad set; until then it
// never touches Meta.
// ---------------------------------------------------------------------------

export type AdDraftStatus =
  | "generating"
  | "pending"
  | "publishing"
  | "published"
  | "rejected"
  | "error";

export interface AdDraftRow {
  id: string;
  vertical_id: string;
  /** Studio variant/angle id the draft was rendered with, e.g. "ugc-selfie". */
  angle: string;
  video_path: string | null;
  status: AdDraftStatus;
  studio_job_id: string | null;
  /** Meta ad id once published. */
  ad_id: string | null;
  ad_name: string | null;
  error: string | null;
  created_at: number;
  /**
   * Pins the draft to a specific run (manual-launch batches). Null = publish
   * into whatever run findPublishTargetRun picks at decision time.
   */
  target_run_id: string | null;
}

export function createAdDraft(input: { verticalId: string; angle: string; targetRunId?: string }): AdDraftRow {
  const row: AdDraftRow = {
    id: `draft_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    vertical_id: input.verticalId,
    angle: input.angle,
    video_path: null,
    status: "generating",
    studio_job_id: null,
    ad_id: null,
    ad_name: null,
    error: null,
    created_at: Date.now(),
    target_run_id: input.targetRunId ?? null,
  };
  db.prepare(
    `INSERT INTO ad_drafts (id, vertical_id, angle, video_path, status, studio_job_id, ad_id, ad_name, error, created_at, target_run_id)
     VALUES (@id, @vertical_id, @angle, @video_path, @status, @studio_job_id, @ad_id, @ad_name, @error, @created_at, @target_run_id)`,
  ).run(row);
  return row;
}

export function updateAdDraft(id: string, patch: Partial<AdDraftRow>): void {
  const fields = Object.keys(patch).filter((k) => k !== "id");
  if (fields.length === 0) return;
  const sets = fields.map((f) => `${f} = @${f}`).join(", ");
  db.prepare(`UPDATE ad_drafts SET ${sets} WHERE id = @id`).run({ ...patch, id });
}

export function getAdDraft(id: string): AdDraftRow | undefined {
  return db.prepare(`SELECT * FROM ad_drafts WHERE id = ?`).get(id) as AdDraftRow | undefined;
}

export function listAdDrafts(limit = 100): AdDraftRow[] {
  return db.prepare(`SELECT * FROM ad_drafts ORDER BY created_at DESC LIMIT ?`).all(limit) as AdDraftRow[];
}

export function listAdDraftsByStatus(status: AdDraftStatus): AdDraftRow[] {
  return db.prepare(`SELECT * FROM ad_drafts WHERE status = ?`).all(status) as AdDraftRow[];
}

/** All drafts pinned to one run — the "batch" for launch-trigger decisions. */
export function listAdDraftsByTargetRun(runId: string): AdDraftRow[] {
  return db.prepare(`SELECT * FROM ad_drafts WHERE target_run_id = ? ORDER BY created_at`).all(runId) as AdDraftRow[];
}

export function deleteAdDraft(id: string): void {
  db.prepare(`DELETE FROM ad_drafts WHERE id = ?`).run(id);
}

export function getSetting(key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
