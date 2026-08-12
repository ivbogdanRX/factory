import { runGeneration, type ProgressUpdate } from "./pipeline.js";
import { runFullRemake } from "./full-remake.js";
import { runFullAd, type FullAdOptions } from "./full-ad.js";
import { runImageAds, type ImageAdOptions } from "./image-ads.js";
import type { LogEntry } from "./logger.js";

export type JobStatus = "queued" | "running" | "done" | "error";

export interface JobLogLine {
  level: LogEntry["level"];
  message: string;
  time: string;
}

export interface Job {
  id: string;
  status: JobStatus;
  campaignId?: string;
  count?: number;
  variantIndex?: number;
  hookIndex?: number;
  hookOverride?: string;
  hookBubbleText?: string;
  randomSelection?: boolean;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  outputs: string[];
  error?: string;
  logs: JobLogLine[];
  progress?: ProgressUpdate;
  /** When set, this job is a full ad remake from a spy suggestion. */
  fullRemake?: boolean;
  /** When set, this job is a brand-new full ad from the New Ad tab. */
  fullAd?: boolean;
  /** When set, this job generates static image-ad variations. */
  imageAd?: boolean;
  /** Friendly label for the job (e.g. the new ad topic). */
  label?: string;
}

export interface StartJobInput {
  campaignId?: string;
  count?: number;
  variantIndex?: number;
  hookIndex?: number;
  /** Use this exact spoken hook line instead of the variant's hooks. */
  hookOverride?: string;
  /** Override the persona's reference-image prompt (ChatGPT/Nano image). */
  creatorPromptOverride?: string;
  /** Override the persona's scene/delivery concept (Veo video prompt). */
  scenePromptOverride?: string;
  hookBubbleText?: string;
  randomSelection?: boolean;
  image?: string;
  /** Remake an entire competitor ad from this spy suggestion id. */
  fullRemakeSuggestionId?: string;
  /** Generate a brand-new full ad from a user-provided script. */
  fullAd?: FullAdOptions;
  /** Generate static image-ad variations from uploaded winners. */
  imageAd?: ImageAdOptions;
}

const MAX_LOG_LINES = 5000;

/**
 * Runs generation jobs as a concurrent worker pool. Up to `maxConcurrent` jobs
 * run in parallel; the rest queue and start automatically as slots free up.
 * Per-job logs are isolated by the pipeline's async log scope.
 */
class JobManager {
  private jobs = new Map<string, Job>();
  private order: string[] = [];
  private queue: string[] = [];
  private active = new Set<string>();
  private maxConcurrent = 2;

  configure(maxConcurrent: number): void {
    this.maxConcurrent = Math.max(1, Math.floor(maxConcurrent));
  }

  capacity(): { maxConcurrent: number; active: number; queued: number } {
    return {
      maxConcurrent: this.maxConcurrent,
      active: this.active.size,
      queued: this.queue.length,
    };
  }

  list(): Job[] {
    return this.order
      .map((id) => this.jobs.get(id)!)
      .filter(Boolean)
      .slice()
      .reverse();
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  start(input: StartJobInput): Job {
    const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job: Job = {
      id,
      status: "queued",
      campaignId: input.campaignId,
      count: input.count,
      variantIndex: input.variantIndex,
      hookIndex: input.hookIndex,
      hookOverride: input.hookOverride,
      hookBubbleText: input.hookBubbleText,
      randomSelection: input.randomSelection,
      createdAt: Date.now(),
      outputs: [],
      logs: [],
      fullRemake: !!input.fullRemakeSuggestionId,
      fullAd: !!input.fullAd,
      imageAd: !!input.imageAd,
      label:
        input.fullAd?.name?.trim() ||
        input.imageAd?.vertical?.trim() ||
        undefined,
    };
    this.jobs.set(id, job);
    this.order.push(id);
    this.queue.push(id);
    // Stash the run inputs on the job for the pump to consume.
    jobInputs.set(id, input);
    this.pump();
    return job;
  }

  /** Launch queued jobs until the concurrency cap is reached. */
  private pump(): void {
    while (this.active.size < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const job = this.jobs.get(id);
      const input = jobInputs.get(id);
      if (!job || !input) continue;
      this.active.add(id);
      job.status = "running";
      job.startedAt = Date.now();
      this.run(job, input);
    }
  }

  private run(job: Job, input: StartJobInput): void {
    const onLog = (entry: LogEntry): void => {
      job.logs.push({
        level: entry.level,
        message: entry.message,
        time: entry.time,
      });
      if (job.logs.length > MAX_LOG_LINES) {
        job.logs.splice(0, job.logs.length - MAX_LOG_LINES);
      }
    };
    const onProgress = (update: ProgressUpdate): void => {
      job.progress = update;
    };

    const work = input.imageAd
      ? runImageAds({
          ...input.imageAd,
          onLog,
          onProgress,
        })
      : input.fullAd
      ? runFullAd({
          ...input.fullAd,
          onLog,
          onProgress,
        })
      : input.fullRemakeSuggestionId
      ? runFullRemake({
          suggestionId: input.fullRemakeSuggestionId,
          onLog,
          onProgress,
        })
      : runGeneration({
          campaignId: input.campaignId,
          count: input.count,
          variantIndex: input.variantIndex,
          hookIndex: input.hookIndex,
          hookOverride: input.hookOverride,
          creatorPromptOverride: input.creatorPromptOverride,
          scenePromptOverride: input.scenePromptOverride,
          hookBubbleText: input.hookBubbleText,
          randomSelection: input.randomSelection,
          image: input.image,
          onLog,
          onProgress,
        });

    void work
      .then((result) => {
        job.outputs = result.outputs;
        job.status = "done";
      })
      .catch((err: unknown) => {
        job.status = "error";
        job.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        job.finishedAt = Date.now();
        this.active.delete(job.id);
        jobInputs.delete(job.id);
        this.pump();
      });
  }
}

/** Run inputs kept out of the serialized Job so they aren't sent to clients. */
const jobInputs = new Map<string, StartJobInput>();

export const jobManager = new JobManager();
