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

describe('GET /metrics', () => {
  const TOKEN = 'metrics-token-0123456789abcdef';

  async function startWithMetrics(
    render: () => Promise<string>,
    token: string | null = TOKEN,
  ): Promise<void> {
    const server = createHealthServer({
      logger,
      db: { ping: () => Promise.resolve() },
      loop: { heartbeatAgeMs: () => 0 },
      maxHeartbeatAgeMs: 10_000,
      ...(token === null ? {} : { metrics: { token, render } }),
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

  const ask = (authorization?: string) =>
    fetch(`${baseUrl}/metrics`, authorization === undefined ? {} : { headers: { authorization } });

  it('gives the numbers to whoever holds the token, as plain text that is not kept', async () => {
    await startWithMetrics(() => Promise.resolve('medcourse_up 1\n'));
    const response = await ask(`Bearer ${TOKEN}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('medcourse_up 1\n');
  });

  it('refuses anyone else, and says nothing about what is behind the door', async () => {
    let rendered = 0;
    await startWithMetrics(() => {
      rendered += 1;
      return Promise.resolve('secret numbers');
    });
    for (const header of [
      undefined,
      '',
      'Bearer',
      'Bearer ',
      `Bearer ${TOKEN.slice(0, -1)}`,
      `Bearer ${TOKEN}x`,
      `Bearer ${TOKEN.toUpperCase()}`,
      `Basic ${TOKEN}`,
      TOKEN,
    ]) {
      const response = await ask(header);
      expect(response.status, String(header)).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe('Bearer');
      expect(await response.text()).toBe('');
    }
    expect(rendered).toBe(0);
  });

  it('does not exist when no token is configured', async () => {
    await startWithMetrics(() => Promise.resolve('x'), null);
    expect((await ask('Bearer anything')).status).toBe(404);
    expect((await ask()).status).toBe(404);
  });

  it('answers 503 with no detail when the numbers cannot be read', async () => {
    await startWithMetrics(() => Promise.reject(new Error('postgres://user:pw@db/x')));
    const response = await ask(`Bearer ${TOKEN}`);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('postgres');
  });
});
