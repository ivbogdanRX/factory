import { AsyncLocalStorage } from "node:async_hooks";

type Level = "info" | "warn" | "error" | "step" | "ok";

const COLORS: Record<Level, string> = {
  info: "\x1b[36m", // cyan
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
  step: "\x1b[35m", // magenta
  ok: "\x1b[32m", // green
};
const RESET = "\x1b[0m";

export interface LogEntry {
  level: Level;
  /** The fully-formatted message (including any ▶/✓ prefix). */
  message: string;
  /** ISO timestamp of when the line was emitted. */
  time: string;
}

type LogListener = (entry: LogEntry) => void;

const listeners = new Set<LogListener>();

/**
 * Per-async-context log sink. Each concurrent job runs inside its own scope so
 * its log lines route only to that job's sink, never bleeding into sibling jobs
 * that run in parallel.
 */
const scopeStore = new AsyncLocalStorage<{ sink: LogListener }>();

/** Run `fn` with all of its (awaited) log output routed to `sink`. */
export function runWithLogScope<T>(
  sink: LogListener,
  fn: () => Promise<T>,
): Promise<T> {
  return scopeStore.run({ sink }, fn);
}

/** Subscribe to every log line globally (in addition to any scoped sink). */
export function addLogListener(fn: LogListener): void {
  listeners.add(fn);
}

export function removeLogListener(fn: LogListener): void {
  listeners.delete(fn);
}

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function emit(level: Level, msg: string): void {
  const color = COLORS[level];
  const tag = level.toUpperCase().padEnd(5);
  // eslint-disable-next-line no-console
  console.log(`${color}[${stamp()}] ${tag}${RESET} ${msg}`);

  const scope = scopeStore.getStore();
  if (scope || listeners.size > 0) {
    const entry: LogEntry = {
      level,
      message: msg,
      time: new Date().toISOString(),
    };
    if (scope) {
      try {
        scope.sink(entry);
      } catch {
        // A broken sink must never crash the pipeline.
      }
    }
    for (const fn of listeners) {
      try {
        fn(entry);
      } catch {
        // A broken listener must never crash the pipeline.
      }
    }
  }
}

export const log = {
  info: (msg: string) => emit("info", msg),
  warn: (msg: string) => emit("warn", msg),
  error: (msg: string) => emit("error", msg),
  step: (msg: string) => emit("step", `\u25b6 ${msg}`),
  ok: (msg: string) => emit("ok", `\u2713 ${msg}`),
};
