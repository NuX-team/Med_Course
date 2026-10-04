import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogger } from '@medcourse/logger';
import { createHealthServer } from './health';

const logger = createLogger({ service: 'worker-test', level: 'silent' });

let baseUrl = '';
let close: (() => Promise<void>) | undefined;

async function start(options: { dbUp: boolean; heartbeatAgeMs: number }): Promise<void> {
  const server = createHealthServer({
    logger,
    db: {
      ping: () => {
        return options.dbUp ? Promise.resolve() : Promise.reject(new Error('db down'));
      },
    },
    loop: { heartbeatAgeMs: () => options.heartbeatAgeMs },
    maxHeartbeatAgeMs: 10_000,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  close = () =>
    new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
    });
}

afterEach(async () => {
  await close?.();
  close = undefined;
});

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.json() };
}

describe('worker health server', () => {
  it('answers /healthz even when the database is down and the loop is stuck', async () => {
    await start({ dbUp: false, heartbeatAgeMs: 999_999 });
    expect(await get('/healthz')).toEqual({ status: 200, body: { status: 'ok' } });
  });

  it('is ready when the database answers and the loop is fresh', async () => {
    await start({ dbUp: true, heartbeatAgeMs: 500 });
    expect(await get('/readyz')).toEqual({
      status: 200,
      body: { status: 'ok', checks: { db: 'up', loop: 'alive' } },
    });
  });

  it('is not ready when the database is down', async () => {
    await start({ dbUp: false, heartbeatAgeMs: 500 });
    expect(await get('/readyz')).toEqual({
      status: 503,
      body: { status: 'unavailable', checks: { db: 'down', loop: 'alive' } },
    });
  });

  it('is not ready when the loop has not ticked for too long', async () => {
    await start({ dbUp: true, heartbeatAgeMs: 10_001 });
    expect(await get('/readyz')).toEqual({
      status: 503,
      body: { status: 'unavailable', checks: { db: 'up', loop: 'stuck' } },
    });
  });

  it('returns 404 for anything else', async () => {
    await start({ dbUp: true, heartbeatAgeMs: 0 });
    expect(await get('/metrics')).toEqual({ status: 404, body: { error: 'not_found' } });
  });
});
