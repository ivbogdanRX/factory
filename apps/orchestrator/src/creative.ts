/**
 * Client for the vendored creative studio (vendor/l_automation `npm run web`).
 * Queues generation jobs over its local HTTP API and polls until they finish.
 */
import { env } from "./env.js";

export interface StudioJob {
  id: string;
  status: "queued" | "running" | "done" | "error";
  outputs: string[];
  error?: string;
  progress?: { phase?: string };
}

async function studioFetch(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${env.studioUrl}${path}`, init);
  } catch {
    throw new Error(
      `Creative studio is not reachable at ${env.studioUrl}. Start it with \`npm run studio\` (vendor/l_automation web server).`,
    );
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(String((data as { error?: string }).error ?? `Studio request failed (${response.status})`));
  }
  return data;
}

export async function queueCreativeJob(
  campaignId: string,
  count: number,
  variantIndex?: number,
): Promise<StudioJob> {
  const data = await studioFetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      campaignId,
      count,
      randomSelection: true,
      ...(variantIndex !== undefined ? { variantIndex } : {}),
    }),
  });
  return data.job as unknown as StudioJob;
}

/**
 * Queue a one-off hook-test video: locked persona variant, exact spoken hook
 * and bubble text. Generation only — never uploaded to Meta.
 */
export async function queueHookTestJob(
  campaignId: string,
  variantIndex: number,
  hook: string,
  bubble: string,
  persona?: { creatorPrompt?: string; scenePrompt?: string },
): Promise<StudioJob> {
  const data = await studioFetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      campaignId,
      count: 1,
      variantIndex,
      hookOverride: hook,
      hookBubbleText: bubble,
      randomSelection: false,
      ...(persona?.creatorPrompt ? { creatorPromptOverride: persona.creatorPrompt } : {}),
      ...(persona?.scenePrompt ? { scenePromptOverride: persona.scenePrompt } : {}),
    }),
  });
  return data.job as unknown as StudioJob;
}

export async function getStudioJob(id: string): Promise<StudioJob> {
  const data = await studioFetch(`/api/jobs/${id}`);
  return data.job as unknown as StudioJob;
}

/**
 * Poll a studio job until it completes. Veo generation + captions + splice can
 * take a while per video, so the default budget is generous.
 */
export async function waitForStudioJob(
  id: string,
  options?: { timeoutMs?: number; onTick?: (job: StudioJob) => void },
): Promise<StudioJob> {
  const timeoutMs = options?.timeoutMs ?? 120 * 60 * 1000;
  const startedAt = Date.now();
  for (;;) {
    const job = await getStudioJob(id);
    options?.onTick?.(job);
    if (job.status === "done") return job;
    if (job.status === "error") throw new Error(job.error ?? "Creative job failed");
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Creative job ${id} timed out after ${Math.round(timeoutMs / 60000)} minutes`);
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

export async function studioHealthy(): Promise<boolean> {
  try {
    await studioFetch("/api/status");
    return true;
  } catch {
    return false;
  }
}
