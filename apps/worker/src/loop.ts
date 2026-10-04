export interface LoopOptions {
  /** Pause between the end of one tick and the start of the next. */
  readonly intervalMs: number;
  readonly tick: () => Promise<void>;
  /** A failing tick must not kill the loop; it is reported here and the loop continues. */
  readonly onError: (error: unknown) => void;
}

export interface Loop {
  /** Milliseconds since a tick last finished (failed or not); since start before the first. */
  heartbeatAgeMs(): number;
  /** Prevents further ticks and resolves once an in-flight tick has finished. */
  stop(): Promise<void>;
}

/**
 * Runs `tick` forever with `intervalMs` between runs. Ticks never overlap, because the next
 * one is scheduled only after the previous finished. That is what lets later stages take
 * batches from the outbox without two workers-in-one-process stepping on each other.
 */
export function startLoop(options: LoopOptions): Loop {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let lastActivityAt = Date.now();

  const schedule = (delayMs: number): void => {
    timer = setTimeout(() => {
      inFlight = run();
    }, delayMs);
  };

  const run = async (): Promise<void> => {
    try {
      await options.tick();
    } catch (error) {
      options.onError(error);
    } finally {
      lastActivityAt = Date.now();
      inFlight = undefined;
      if (!stopped) {
        schedule(options.intervalMs);
      }
    }
  };

  schedule(0);

  return {
    heartbeatAgeMs: () => Date.now() - lastActivityAt,

    async stop() {
      stopped = true;
      clearTimeout(timer);
      await inFlight;
    },
  };
}
