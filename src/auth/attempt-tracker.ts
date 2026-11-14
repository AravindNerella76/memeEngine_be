/**
 * Counts wrong passwords per key inside a sliding window and locks the key for a while once the limit is
 * reached. In memory on purpose: nothing to clean up, and a restart only ever forgives. The clock is
 * injectable so tests do not need to wait.
 */
export interface TrackerOptions {
  maxFailures: number;
  windowMs: number;
  lockMs: number;
  maxKeys?: number;
}

interface Entry {
  fails: number[];
  lockedUntil: number;
}

export class AttemptTracker {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly opts: TrackerOptions, private readonly now: () => number = Date.now) {}

  /** Is this key locked right now? */
  check(key: string): { blocked: boolean; retryAfterSec: number } {
    const e = this.entries.get(key);
    const t = this.now();
    if (!e || e.lockedUntil <= t) return { blocked: false, retryAfterSec: 0 };
    return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((e.lockedUntil - t) / 1000)) };
  }

  /** Records a wrong password. Returns true when this failure locked the key. */
  fail(key: string): boolean {
    const t = this.now();
    this.prune(t);
    const e = this.entries.get(key) || { fails: [], lockedUntil: 0 };
    e.fails = e.fails.filter(f => t - f < this.opts.windowMs);
    e.fails.push(t);
    let locked = false;
    if (e.fails.length >= this.opts.maxFailures) {
      e.lockedUntil = t + this.opts.lockMs;
      e.fails = [];
      locked = true;
    }
    this.entries.set(key, e);
    return locked;
  }

  /** A correct password clears the key. */
  success(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Keeps memory bounded: drop entries that are neither locked nor recent. */
  private prune(t: number): void {
    if (this.entries.size < (this.opts.maxKeys ?? 10000)) return;
    for (const [k, e] of this.entries) {
      if (e.lockedUntil <= t && (e.fails.length === 0 || t - e.fails[e.fails.length - 1] >= this.opts.windowMs)) this.entries.delete(k);
    }
    // still full of live entries (an attack): drop the oldest so memory cannot grow without limit
    while (this.entries.size >= (this.opts.maxKeys ?? 10000)) {
      const first = this.entries.keys().next().value;
      if (first === undefined) break;
      this.entries.delete(first);
    }
  }
}
