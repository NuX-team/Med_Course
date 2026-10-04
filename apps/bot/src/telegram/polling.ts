import type { Logger } from '@medcourse/logger';
import { ALLOWED_UPDATES, type TelegramApi, type Update } from './types';

const LONG_POLL_SECONDS = 25;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export interface Poller {
  /** Stops asking for updates and resolves once the one in hand has been handled. */
  stop(): Promise<void>;
}

/**
 * Local development without a public address: ask Telegram for updates instead of waiting to be
 * called. Updates are handled one after another, in order, and the offset moves on even if
 * handling one fails, so a poison update cannot jam the loop.
 */
export function startPolling(options: {
  readonly api: TelegramApi;
  readonly onUpdate: (update: Update) => Promise<void>;
  readonly logger: Logger;
  /** Replaceable so tests need not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}): Poller {
  const { api, onUpdate, logger } = options;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // An object, so the loops re-read it: a plain `let` is narrowed to `false` inside them.
  const state = { stopped: false };

  const loop = (async () => {
    // Telegram refuses getUpdates while a webhook is set.
    for (let attempt = 0; !state.stopped; attempt += 1) {
      try {
        await api.deleteWebhook();
        break;
      } catch (err) {
        logger.error({ err }, 'could not remove the webhook before polling');
        await sleep(Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** attempt));
      }
    }

    let offset: number | undefined;
    let failures = 0;
    while (!state.stopped) {
      let updates: Update[];
      try {
        updates = await api.getUpdates({
          ...(offset === undefined ? {} : { offset }),
          timeout: LONG_POLL_SECONDS,
          allowed_updates: ALLOWED_UPDATES,
        });
        failures = 0;
      } catch (err) {
        failures += 1;
        logger.warn({ err }, 'getUpdates failed, retrying');
        await sleep(Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** failures));
        continue;
      }

      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await onUpdate(update);
        } catch (err) {
          logger.error({ err, updateId: update.update_id }, 'handling a polled update failed');
        }
      }
    }
  })();

  return {
    async stop() {
      state.stopped = true;
      await loop;
    },
  };
}
