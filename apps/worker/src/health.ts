import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Database } from '@medcourse/db';
import type { Logger } from '@medcourse/logger';

export interface HealthDeps {
  readonly logger: Logger;
  readonly db: Pick<Database, 'ping'>;
  readonly loop: { heartbeatAgeMs(): number };
  /** The loop counts as stuck once it has not finished a tick for this long. */
  readonly maxHeartbeatAgeMs: number;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

/**
 * Same probe contract as the bot (`/healthz`, `/readyz`), so Docker and any later
 * orchestrator treat both processes alike. Returns an unstarted server.
 */
export function createHealthServer({ logger, db, loop, maxHeartbeatAgeMs }: HealthDeps): Server {
  return createServer((request, response) => {
    const path = (request.url ?? '').split('?')[0];

    if (request.method === 'GET' && path === '/healthz') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (request.method === 'GET' && path === '/readyz') {
      void (async () => {
        const loopAlive = loop.heartbeatAgeMs() <= maxHeartbeatAgeMs;
        let dbUp = true;
        try {
          await db.ping();
        } catch (err) {
          dbUp = false;
          logger.warn({ err }, 'readiness check failed');
        }

        const checks = { db: dbUp ? 'up' : 'down', loop: loopAlive ? 'alive' : 'stuck' };
        sendJson(response, dbUp && loopAlive ? 200 : 503, {
          status: dbUp && loopAlive ? 'ok' : 'unavailable',
          checks,
        });
      })();
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  });
}
