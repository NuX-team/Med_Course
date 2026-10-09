/**
 * At most `limit` calls per `windowMs` for each key, in fixed windows that start with the key's
 * first call. In memory: one API process; a restart only ever lets a few more through.
 * (Same rule as apps/panel/src/limiter.ts.)
 */
export class WindowLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #seen = new Map<string, { count: number; startedAt: number }>();

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  get size(): number {
    return this.#seen.size;
  }

  check(key: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const at = this.#now();
    if (this.#seen.size > 10_000) {
      for (const [other, entry] of this.#seen) {
        if (at - entry.startedAt >= this.#windowMs) {
          this.#seen.delete(other);
        }
      }
    }
    const entry = this.#seen.get(key);
    if (entry === undefined || at - entry.startedAt >= this.#windowMs) {
      this.#seen.set(key, { count: 1, startedAt: at });
      return { allowed: true };
    }
    entry.count += 1;
    return entry.count <= this.#limit
      ? { allowed: true }
      : { allowed: false, retryAfterMs: entry.startedAt + this.#windowMs - at };
  }
}
