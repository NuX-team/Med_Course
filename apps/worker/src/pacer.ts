/**
 * Spaces out calls so that, however many are waiting, they leave at an even rate. Telegram lets a
 * bot send about 30 messages a second in all; going over it is answered with 429 and a pause
 * for everyone, which is slower than never going over (ARCHITECTURE §8).
 *
 * Callers take places in line: each place is `1000 / perSecond` ms after the one before, so a
 * burst of a thousand reminders is let out at the rate, not at once and not one after another
 * waiting for each answer.
 */
export class Pacer {
  readonly #interval: number;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  #next = 0;

  constructor(
    perSecond: number,
    options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    if (!(perSecond > 0)) {
      throw new RangeError('the rate must be positive');
    }
    this.#interval = 1000 / perSecond;
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ??
      ((ms) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  /** Resolves when this caller's place comes up. */
  async take(): Promise<void> {
    const now = this.#now();
    const at = Math.max(now, this.#next);
    this.#next = at + this.#interval;
    if (at > now) {
      await this.#sleep(at - now);
    }
  }

  /** Everyone waits, for as long as Telegram said to: after a 429 the whole bot is told to stop. */
  pauseFor(ms: number): void {
    this.#next = Math.max(this.#next, this.#now() + ms);
  }
}
