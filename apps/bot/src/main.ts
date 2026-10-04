import {
  ConfigError,
  loadConfigFromProcess,
  requireTelegram,
  type Config,
  type TelegramConfig,
} from '@medcourse/config';
import { createDatabase, createRepositoryDeps } from '@medcourse/db';
import { createLogger } from '@medcourse/logger';
import { Api } from 'grammy';
import { buildApp } from './app';
import { extractIncoming } from './telegram/handler';
import { startPolling, type Poller } from './telegram/polling';
import { processUpdate } from './telegram/process';
import { RateLimiter } from './telegram/rate-limit';
import { ALLOWED_UPDATES, type TelegramApi, type Update } from './telegram/types';
import { webhookPath } from './telegram/webhook';

const SERVICE = 'bot';
const DEFAULT_HTTP_PORT = 3000;
/** One person may send this many updates in this window; the rest are dropped. */
const RATE_LIMIT = { limit: 20, windowMs: 10_000 };
/** A polling loop may be inside a 25-second request; do not hold shutdown for it. */
const POLLER_STOP_GRACE_MS = 3_000;

async function main(): Promise<void> {
  let config: Config;
  let telegram: TelegramConfig;
  try {
    config = loadConfigFromProcess({ defaultHttpPort: DEFAULT_HTTP_PORT });
    telegram = requireTelegram(config);
  } catch (err) {
    const bootLogger = createLogger({ service: SERVICE, level: 'info' });
    if (err instanceof ConfigError) {
      bootLogger.fatal({ problems: err.problems }, 'invalid configuration');
    } else {
      bootLogger.fatal({ err }, 'could not load configuration');
    }
    process.exit(1);
  }

  const logger = createLogger({ service: SERVICE, level: config.logLevel });
  const db = createDatabase(config.databaseUrl);
  const api: TelegramApi = new Api(telegram.botToken);
  const repositoryDeps = createRepositoryDeps(config.encryptionKeys);
  const limiter = new RateLimiter(RATE_LIMIT);

  // Fail at start, not on the first patient: a wrong token or no route to Telegram is found here,
  // and the bot's username is needed for the invitation links doctors hand out.
  let botUsername: string;
  try {
    const me = await api.getMe();
    if (me.username === undefined) {
      throw new Error('the bot has no username');
    }
    botUsername = me.username;
  } catch (err) {
    // The message only: an error object from an HTTP client can carry the request address.
    logger.fatal(
      { reason: err instanceof Error ? err.message : 'unknown' },
      'could not ask Telegram who this bot is: check TELEGRAM_BOT_TOKEN and the network',
    );
    process.exit(1);
  }

  const onUpdate = async (update: Update): Promise<void> => {
    const incoming = extractIncoming(update);
    if (incoming !== null && !limiter.allow(incoming.telegramUserId)) {
      logger.warn({ updateId: update.update_id }, 'rate limit: update dropped');
      return;
    }
    await processUpdate(
      { orm: db.orm, repositoryDeps, api, logger, botUsername, panelBaseUrl: config.panelBaseUrl },
      update,
    );
  };

  const app = buildApp({
    logger,
    db,
    ...(telegram.mode === 'webhook'
      ? { webhook: { secret: telegram.webhookSecret, onUpdate } }
      : {}),
  });

  let poller: Poller | undefined;
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    try {
      await Promise.race([
        poller?.stop(),
        new Promise<void>((resolve) => setTimeout(resolve, POLLER_STOP_GRACE_MS)),
      ]);
      await app.close();
      await db.close();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: '0.0.0.0', port: config.httpPort });

  if (telegram.mode === 'webhook') {
    await api.setWebhook(`${telegram.publicBaseUrl}${webhookPath(telegram.webhookSecret)}`, {
      secret_token: telegram.webhookSecret,
      allowed_updates: ALLOWED_UPDATES,
    });
  } else {
    poller = startPolling({ api, onUpdate, logger });
  }
  logger.info(
    { appEnv: config.appEnv, port: config.httpPort, telegramMode: telegram.mode },
    'bot started',
  );
}

main().catch((err: unknown) => {
  createLogger({ service: SERVICE, level: 'info' }).fatal({ err }, 'bot failed to start');
  process.exit(1);
});
