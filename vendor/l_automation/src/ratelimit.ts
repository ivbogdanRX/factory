import { sleep } from "./utils.js";
import { log } from "./logger.js";

/**
 * A process-wide, sliding-window rate limiter shared by every concurrent job.
 * It caps how many rate-limited API requests (image + video generation) may be
 * started per rolling 60s window, so running multiple jobs in parallel never
 * exceeds the configured provider limits.
 */

let requestsPerMinute = 0; // 0 = disabled (unlimited)
let windowHits: number[] = [];

const WINDOW_MS = 60_000;

export function configureRateLimit(rpm: number): void {
  requestsPerMinute = Math.max(0, Math.floor(rpm));
}

export interface RateLimitStatus {
  /** Configured cap per 60s window. 0 = unlimited (limiter disabled). */
  perMinute: number;
  /** Requests started in the current rolling window. */
  used: number;
  /** Slots free right now (null when unlimited). */
  remaining: number | null;
  /** Length of the rolling window in ms. */
  windowMs: number;
  /** ms until the oldest in-window request ages out (a slot frees up). */
  resetInMs: number;
}

/** A live snapshot of the shared API rate limiter for the UI. */
export function getRateLimitStatus(): RateLimitStatus {
  const now = Date.now();
  const hits = windowHits.filter((t) => now - t < WINDOW_MS);
  const used = hits.length;
  const unlimited = requestsPerMinute <= 0;
  const resetInMs = hits.length ? Math.max(0, WINDOW_MS - (now - hits[0]!)) : 0;
  return {
    perMinute: requestsPerMinute,
    used,
    remaining: unlimited ? null : Math.max(0, requestsPerMinute - used),
    windowMs: WINDOW_MS,
    resetInMs,
  };
}

/**
 * Block until it is safe to start one more rate-limited request. Resolves
 * immediately when the limiter is disabled or the window has room. The
 * check-then-record step is synchronous, so concurrent callers can't slip
 * extra requests past the cap.
 */
export async function acquireApiSlot(labelForLog?: string): Promise<void> {
  if (requestsPerMinute <= 0) return;

  for (;;) {
    const now = Date.now();
    windowHits = windowHits.filter((t) => now - t < WINDOW_MS);
    if (windowHits.length < requestsPerMinute) {
      windowHits.push(now);
      return;
    }
    const oldest = windowHits[0]!;
    const waitMs = WINDOW_MS - (now - oldest) + 25;
    if (labelForLog) {
      log.info(
        `Rate limit reached (${requestsPerMinute}/min). ` +
          `Waiting ${(waitMs / 1000).toFixed(1)}s before ${labelForLog}.`,
      );
    }
    await sleep(waitMs);
  }
}
