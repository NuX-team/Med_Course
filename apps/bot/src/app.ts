import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Database } from '@medcourse/db';
import { registerWebhook, type WebhookOptions } from './telegram/webhook';

export interface AppDeps {
  /** A pino logger from @medcourse/logger satisfies this. */
  readonly logger: FastifyBaseLogger;
  readonly db: Pick<Database, 'ping'>;
  /** Present only when Telegram is to call us (webhook mode). */
  readonly webhook?: WebhookOptions;
}

const PROBE_PATHS = new Set(['/healthz', '/readyz']);

/**
 * Probe traffic is frequent and uninteresting, so the per-request "incoming/completed" lines
 * are skipped for it. A failing probe is still logged explicitly (see /readyz).
 */
const logController = new LogController({
  disableRequestLogging: (request) => PROBE_PATHS.has(request.url.split('?')[0] ?? ''),
});

/** Anything Fastify throws that carries a 4xx `statusCode` is the client's fault; the rest is ours. */
function clientErrorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) {
    return undefined;
  }
  const { statusCode } = error;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500
    ? statusCode
    : undefined;
}

export function buildApp({ logger, db, webhook }: AppDeps): FastifyInstance {
  const app = Fastify({
    loggerInstance: logger,
    logController,
    genReqId: () => randomUUID(),
  });

  // Clients get a machine-readable code and the request id, never internal details (TZ §10).
  app.setErrorHandler((error, request, reply) => {
    const clientStatus = clientErrorStatus(error);
    if (clientStatus === undefined) {
      request.log.error({ err: error }, 'unhandled error');
      return reply.code(500).send({ error: 'internal_error', requestId: request.id });
    }
    return reply.code(clientStatus).send({ error: 'bad_request', requestId: request.id });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: 'not_found', requestId: request.id }),
  );

  // Liveness: the process is up and its event loop turns.
  app.get('/healthz', () => ({ status: 'ok' }));

  // Readiness: the process can do useful work, i.e. the database answers.
  app.get('/readyz', async (request, reply) => {
    try {
      await db.ping();
      return { status: 'ok', checks: { db: 'up' } };
    } catch (err) {
      request.log.warn({ err }, 'readiness check failed');
      return reply.code(503).send({ status: 'unavailable', checks: { db: 'down' } });
    }
  });

  if (webhook !== undefined) {
    registerWebhook(app, webhook);
  }

  return app;
}
