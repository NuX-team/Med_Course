/**
 * At most `limit` calls per `windowMs` for each key, counted in fixed windows that start with the
 * key's first call. Kept in memory: the panel is one process, and a restart forgetting who was
 * counted only ever lets a few more through, never fewer.
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

  /** How many keys are being counted; for the test that says the table does not grow without end. */
  get size(): number {
    return this.#seen.size;
  }

  /** Counts a call and says whether it is within the limit; `retryAfterMs` is how long to wait if not. */
  check(key: string): { allowed: true } | { allowed: false; retryAfterMs: number } {
    const at = this.#now();
    if (this.#seen.size > 10_000) {
      // Forget the keys whose window is over: nothing here may grow without end.
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
