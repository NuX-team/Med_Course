import {
  ConfigError,
  loadConfigFromProcess,
  requirePanelBaseUrl,
  type Config,
} from '@medcourse/config';
import { createDatabase, createRepositoryDeps } from '@medcourse/db';
import { createLogger } from '@medcourse/logger';
import { Api } from 'grammy';
import { buildPanel } from './app';

const SERVICE = 'panel';
const DEFAULT_HTTP_PORT = 3002;

async function main(): Promise<void> {
  let config: Config;
  let baseUrl: string;
  try {
    // The panel receives no Telegram updates; the token, if present, is only used to tell a
    // doctor that they were verified.
    config = loadConfigFromProcess({ defaultHttpPort: DEFAULT_HTTP_PORT, receivesUpdates: false });
    baseUrl = requirePanelBaseUrl(config);
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
  const db = createDatabase(config.databaseUrl, { maxConnections: 5 });
  const api = config.telegram === null ? null : new Api(config.telegram.botToken);

  const app = buildPanel({
    logger,
    db,
    orm: db.orm,
    repositoryDeps: createRepositoryDeps(config.encryptionKeys),
    baseUrl,
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
    'panel started',
  );
}

main().catch((err: unknown) => {
  createLogger({ service: SERVICE, level: 'info' }).fatal({ err }, 'panel failed to start');
  process.exit(1);
});
