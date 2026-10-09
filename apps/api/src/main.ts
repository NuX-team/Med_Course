import { ConfigError, loadConfigFromProcess, type Config } from '@medcourse/config';
import { createDatabase, createRepositoryDeps } from '@medcourse/db';
import { createLogger } from '@medcourse/logger';
import { Api } from 'grammy';
import { buildApi } from './app';

const SERVICE = 'api';
const DEFAULT_HTTP_PORT = 3003;

async function main(): Promise<void> {
  let config: Config;
  let botUsername: string;
  try {
    // The API receives no Telegram updates; the token, if present, only tells doctors things.
    config = loadConfigFromProcess({ defaultHttpPort: DEFAULT_HTTP_PORT, receivesUpdates: false });
    if (config.telegramBotUsername === null) {
      throw new ConfigError([
        'TELEGRAM_BOT_USERNAME: required for the API (sign-in goes through the bot)',
      ]);
    }
    botUsername = config.telegramBotUsername;
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
  const db = createDatabase(config.databaseUrl, { maxConnections: 10 });
  const api = config.telegram === null ? null : new Api(config.telegram.botToken);

  const app = buildApi({
    logger,
    db,
    orm: db.orm,
    repositoryDeps: createRepositoryDeps(config.encryptionKeys),
    botUsername,
    trustProxy: config.panelTrustProxy,
    ...(api === null
      ? {}
      : {
          notify: async (telegramUserId: number, text: string) => {
            await api.sendMessage(telegramUserId, text);
          },
        }),
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    try {
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
  logger.info(
    { appEnv: config.appEnv, port: config.httpPort, tellsDoctors: api !== null },
    'api started',
  );
}

main().catch((err: unknown) => {
  createLogger({ service: SERVICE, level: 'info' }).fatal({ err }, 'api failed to start');
  process.exit(1);
});
