/**
 * Allows at most `limit` events per person in any `windowMs`. In memory and per process: it
 * exists to stop one chat from flooding the bot, not to be an exact quota, so a restart
 * forgetting the counts is fine.
 */
export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #seen = new Map<number, number[]>();

  constructor(options: { limit: number; windowMs: number; now?: () => number }) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? Date.now;
  }

  /** True if this event is within the limit (and counts it); false if it should be dropped. */
  allow(telegramUserId: number): boolean {
    const now = this.#now();
    const recent = (this.#seen.get(telegramUserId) ?? []).filter((at) => now - at < this.#windowMs);
    if (recent.length >= this.#limit) {
      this.#seen.set(telegramUserId, recent);
      return false;
    }
    recent.push(now);
    this.#seen.set(telegramUserId, recent);
    if (this.#seen.size > 10_000) {
      this.#sweep(now);
    }
    return true;
  }

  /** Drops people with nothing recent, so the map cannot grow without bound. */
  #sweep(now: number): void {
    for (const [id, times] of this.#seen) {
      if (times.every((at) => now - at >= this.#windowMs)) {
        this.#seen.delete(id);
      }
    }
  }
}
