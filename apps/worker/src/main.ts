import {
  ConfigError,
  loadConfigFromProcess,
  requireBotToken,
  type Config,
} from '@medcourse/config';
import {
  createDatabase,
  createRepositoryDeps,
  createRepositories,
  systemActor,
} from '@medcourse/db';
import { createLogger } from '@medcourse/logger';
import type { TelegramApi } from '@medcourse/telegram';
import { Api } from 'grammy';
import { completionSweepDue, runCompletionSweep } from './completion';
import { runAlerts } from './alerts';
import { createHealthServer } from './health';
import { renderMetrics } from './metrics';
import { runIncidentNotices } from './notices';
import { startLoop } from './loop';
import {
  maintenanceDue,
  runMaintenance,
  runStartWindowSweep,
  startWindowSweepDue,
} from './maintenance';
import { privacySweepDue, runPrivacySweep } from './privacy';
import { reconcileDue, runReconciliation } from './reconcile';
import { Pacer } from './pacer';
import { SEND_RATE_PER_SECOND, missedSweepDue, runMissedSweep, runOutboxBurst } from './reminders';

const SERVICE = 'worker';
const DEFAULT_HTTP_PORT = 3001;
const TICK_INTERVAL_MS = 2_000;
const MIN_HEARTBEAT_LIMIT_MS = 30_000;

async function main(): Promise<void> {
  let config: Config;
  let botToken: string;
  try {
    // The worker only sends: it needs the token, not the webhook settings.
    config = loadConfigFromProcess({ defaultHttpPort: DEFAULT_HTTP_PORT, receivesUpdates: false });
    botToken = requireBotToken(config);
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

  const repositoryDeps = createRepositoryDeps(config.encryptionKeys);
  const api: Pick<TelegramApi, 'sendMessage'> = new Api(botToken);
  const pacer = new Pacer(SEND_RATE_PER_SECOND);
  let lastMaintenanceAt: Date | null = null;
  let lastStartWindowSweepAt: Date | null = null;
  let lastMissedSweepAt: Date | null = null;
  let lastCompletionSweepAt: Date | null = null;
  let lastReconcileAt: Date | null = null;
  let lastPrivacySweepAt: Date | null = null;

  /** One job failing must not keep the others from running in the same round. */
  const attempt = async (job: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
    } catch (err) {
      logger.error({ err, job }, 'a worker job failed');
    }
  };

  const loop = startLoop({
    intervalMs: TICK_INTERVAL_MS,
    tick: async () => {
      const now = new Date();
      // Before anything is sent: how far behind the queues were when this round began. A few
      // counts once in five minutes, so the reminders do not wait for it.
      if (reconcileDue(lastReconcileAt, now)) {
        lastReconcileAt = now;
        await attempt('reconciliation', () =>
          runReconciliation({ orm: db.orm, repositoryDeps, now, logger }),
        );
      }
      // Reminders next: they are the only job here that someone is waiting for.
      await attempt('outbox', () =>
        runOutboxBurst({ orm: db.orm, repositoryDeps, api, logger, pacer }),
      );
      if (missedSweepDue(lastMissedSweepAt, now)) {
        lastMissedSweepAt = now;
        await attempt('missed doses', () =>
          runMissedSweep({ orm: db.orm, repositoryDeps, now, logger }),
        );
      }
      // The people who handle incidents are told of the ones opened by the reconciliation above.
      await attempt('incident notices', () =>
        runIncidentNotices({ orm: db.orm, repositoryDeps, api, now, logger }),
      );
      // After the reminders and the misses: what the doctors are to be told about them.
      await attempt('alerts', () => runAlerts({ orm: db.orm, repositoryDeps, api, logger }));
      // After the misses: a course is closed only once every dose in it has an outcome.
      if (completionSweepDue(lastCompletionSweepAt, now)) {
        lastCompletionSweepAt = now;
        await attempt('completion', () =>
          runCompletionSweep({ orm: db.orm, repositoryDeps, api, now, logger }),
        );
      }
      if (startWindowSweepDue(lastStartWindowSweepAt, now)) {
        lastStartWindowSweepAt = now;
        await attempt('start windows', () =>
          runStartWindowSweep({ orm: db.orm, repositoryDeps, now, logger }),
        );
      }
      if (privacySweepDue(lastPrivacySweepAt, now)) {
        lastPrivacySweepAt = now;
        await attempt('privacy', () =>
          runPrivacySweep({ orm: db.orm, repositoryDeps, now, logger }),
        );
      }
      if (maintenanceDue(lastMaintenanceAt, now)) {
        // Marked first: a failing housekeeping run must not be retried every two seconds.
        lastMaintenanceAt = now;
        await attempt('maintenance', () =>
          runMaintenance({ orm: db.orm, repositoryDeps, now, logger }),
        );
      }
    },
    onError: (err) => {
      logger.error({ err }, 'tick failed');
    },
  });

  const health = createHealthServer({
    logger,
    db,
    loop,
    maxHeartbeatAgeMs: Math.max(TICK_INTERVAL_MS * 3, MIN_HEARTBEAT_LIMIT_MS),
    ...(config.metricsToken === null
      ? {}
      : {
          metrics: {
            token: config.metricsToken,
            render: async () =>
              renderMetrics(
                await createRepositories(db.orm, repositoryDeps).metrics.snapshot(
                  systemActor('metrics page'),
                  new Date(),
                ),
                { heartbeatAgeSeconds: loop.heartbeatAgeMs() / 1000 },
              ),
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
      await loop.stop();
      await new Promise<void>((resolve, reject) => {
        health.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
      await db.close();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await new Promise<void>((resolve, reject) => {
    health.once('error', reject);
    health.listen(config.httpPort, '0.0.0.0', resolve);
  });
  logger.info({ appEnv: config.appEnv, port: config.httpPort }, 'worker started');
}

main().catch((err: unknown) => {
  createLogger({ service: SERVICE, level: 'info' }).fatal({ err }, 'worker failed to start');
  process.exit(1);
});
