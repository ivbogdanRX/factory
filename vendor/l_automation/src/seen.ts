import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir } from "./utils.js";

const STATE_DIR = ".state";

/**
 * Persistent set of identifiers we've already used, so the bot never reuses the
 * same Pinterest image across runs. Backed by a small JSON file.
 */
export class SeenStore {
  private file: string;
  private set: Set<string>;

  constructor(name = "seen-pins.json") {
    ensureDir(STATE_DIR);
    this.file = join(STATE_DIR, name);
    this.set = new Set<string>();
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, "utf8"));
        if (Array.isArray(parsed)) this.set = new Set(parsed as string[]);
      } catch {
        // Corrupt/empty state file — start fresh.
      }
    }
  }

  has(key: string): boolean {
    return this.set.has(key);
  }

  add(key: string): void {
    this.set.add(key);
    this.save();
  }

  get size(): number {
    return this.set.size;
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify([...this.set]));
  }
}

/**
 * Stable identifier for a Pinterest image, independent of the size variant
 * (e.g. /236x/, /736x/, /originals/). The trailing filename is a unique hash.
 */
export function pinKey(url: string): string {
  try {
    const u = new URL(url);
    const base = u.pathname.split("/").pop();
    return (base || u.pathname).toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}
