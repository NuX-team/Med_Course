import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { Database } from '@medcourse/db';
import type { Logger } from '@medcourse/logger';

export interface HealthDeps {
  readonly logger: Logger;
  readonly db: Pick<Database, 'ping'>;
  readonly loop: { heartbeatAgeMs(): number };
  /** The loop counts as stuck once it has not finished a tick for this long. */
  readonly maxHeartbeatAgeMs: number;
  /** The metrics page, for whoever holds the token. Absent: there is no such page. */
  readonly metrics?: { readonly token: string; render(): Promise<string> };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

/**
 * Same probe contract as the bot (`/healthz`, `/readyz`), so Docker and any later
 * orchestrator treat both processes alike. Returns an unstarted server.
 */
export function createHealthServer({
  logger,
  db,
  loop,
  maxHeartbeatAgeMs,
  metrics,
}: HealthDeps): Server {
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

    if (request.method === 'GET' && path === '/metrics' && metrics !== undefined) {
      // Behind a token: the numbers say how the service is doing, and that is not for everyone.
      const given = Buffer.from(
        /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '',
      );
      const wanted = Buffer.from(metrics.token);
      if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
        response.writeHead(401, { 'www-authenticate': 'Bearer' });
        response.end();
        return;
      }
      void metrics.render().then(
        (body) => {
          response.writeHead(200, {
            'content-type': 'text/plain; version=0.0.4; charset=utf-8',
            'cache-control': 'no-store',
          });
          response.end(body);
        },
        (err: unknown) => {
          logger.warn({ err }, 'metrics could not be read');
          sendJson(response, 503, { status: 'unavailable' });
        },
      );
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  });
}
