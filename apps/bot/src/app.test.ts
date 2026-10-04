import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createLogger } from '@medcourse/logger';
import { buildApp } from './app';

const logger = createLogger({ service: 'bot-test', level: 'silent' });

// `expect.any` is typed `any`; naming it as `unknown` keeps the assertions below lint-clean.
const anyRequestId: unknown = expect.any(String);

let app: FastifyInstance | undefined;

function createApp(ping: () => Promise<void>): FastifyInstance {
  app = buildApp({ logger, db: { ping } });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /healthz', () => {
  it('is up even when the database is down', async () => {
    const response = await createApp(() => Promise.reject(new Error('db down'))).inject({
      method: 'GET',
      url: '/healthz',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /readyz', () => {
  it('is ready when the database answers', async () => {
    const response = await createApp(() => Promise.resolve()).inject({
      method: 'GET',
      url: '/readyz',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: { db: 'up' } });
  });

  it('is 503 without leaking the failure reason when the database is down', async () => {
    const response = await createApp(() =>
      Promise.reject(new Error('connect ECONNREFUSED 10.0.0.7:5432')),
    ).inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'unavailable', checks: { db: 'down' } });
    expect(response.body).not.toContain('10.0.0.7');
  });
});

describe('error handling', () => {
  it('answers unknown routes with a code and request id', async () => {
    const response = await createApp(() => Promise.resolve()).inject({
      method: 'GET',
      url: '/nope',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found', requestId: anyRequestId });
  });

  it('hides internal error details behind a request id', async () => {
    const instance = createApp(() => Promise.resolve());
    instance.get('/boom', () => {
      throw new Error('relation "patients" does not exist');
    });

    const response = await instance.inject({ method: 'GET', url: '/boom' });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'internal_error', requestId: anyRequestId });
    expect(response.body).not.toContain('patients');
  });

  it('keeps client errors as 4xx', async () => {
    const instance = createApp(() => Promise.resolve());
    instance.post('/echo', () => 'ok');

    const response = await instance.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'bad_request', requestId: anyRequestId });
  });
});
