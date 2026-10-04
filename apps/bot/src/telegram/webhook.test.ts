import { createLogger } from '@medcourse/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app';
import type { Update } from './types';
import { registerWebhook, secretMatches, webhookPath } from './webhook';

const SECRET = 'webhook-secret-0123456789';
const logger = createLogger({ service: 'webhook-test', level: 'silent' });

let app: FastifyInstance | undefined;

function build(onUpdate: (update: Update) => Promise<void>): FastifyInstance {
  app = buildApp({
    logger,
    db: { ping: () => Promise.resolve() },
    webhook: { secret: SECRET, onUpdate },
  });
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const post = (
  instance: FastifyInstance,
  options: { headers?: Record<string, string>; payload?: unknown; url?: string },
) =>
  instance.inject({
    method: 'POST',
    url: options.url ?? webhookPath(SECRET),
    headers: { 'content-type': 'application/json', ...options.headers },
    payload:
      options.payload === undefined
        ? JSON.stringify({ update_id: 1 })
        : (options.payload as string),
  });

describe('webhookPath', () => {
  it('is stable for a secret, differs between secrets, and does not contain the secret', () => {
    expect(webhookPath(SECRET)).toBe(webhookPath(SECRET));
    expect(webhookPath(SECRET)).not.toBe(webhookPath(`${SECRET}x`));
    expect(webhookPath(SECRET)).toMatch(/^\/telegram\/[0-9a-f]{32}$/);
    expect(webhookPath(SECRET)).not.toContain(SECRET);
  });
});

describe('secretMatches', () => {
  it('accepts only the exact secret', () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches(SECRET, undefined)).toBe(false);
    expect(secretMatches(SECRET, '')).toBe(false);
    expect(secretMatches(SECRET, `${SECRET} `)).toBe(false);
    expect(secretMatches(SECRET, SECRET.slice(0, -1))).toBe(false);
    expect(secretMatches(SECRET, `${SECRET}extra`)).toBe(false);
    expect(secretMatches(SECRET, SECRET.toUpperCase())).toBe(false);
  });

  it('copes with values of any length', () => {
    expect(secretMatches(SECRET, 'x'.repeat(10_000))).toBe(false);
  });
});

describe('POST /telegram/<segment>', () => {
  it('hands a genuine update to the handler and answers 200', async () => {
    const onUpdate = vi.fn(() => Promise.resolve());
    const response = await post(build(onUpdate), {
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      payload: JSON.stringify({ update_id: 42, message: { text: 'hi' } }),
    });

    expect(response.statusCode).toBe(200);
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ update_id: 42, message: { text: 'hi' } });
  });

  it('refuses a missing or wrong secret with 403 and never calls the handler', async () => {
    const onUpdate = vi.fn(() => Promise.resolve());
    const instance = build(onUpdate);

    for (const headers of [
      {},
      { 'x-telegram-bot-api-secret-token': 'wrong' },
      { 'x-telegram-bot-api-secret-token': '' },
    ]) {
      const response = await post(instance, { headers });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({
        error: 'forbidden',
        requestId: expect.any(String) as unknown,
      });
    }
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('does not exist at any other path', async () => {
    const onUpdate = vi.fn(() => Promise.resolve());
    const instance = build(onUpdate);
    for (const url of [
      '/telegram',
      '/telegram/webhook',
      `/telegram/${'0'.repeat(32)}`,
      `${webhookPath(SECRET)}/`,
    ]) {
      const response = await post(instance, {
        url,
        headers: { 'x-telegram-bot-api-secret-token': SECRET },
      });
      expect(response.statusCode, url).toBe(404);
    }
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ['not JSON', '{nope'],
    ['an array', '[]'],
    ['a string', '"hello"'],
    ['null', 'null'],
    ['an object without update_id', '{"message":{}}'],
    ['a non-numeric update_id', '{"update_id":"1"}'],
    ['a fractional update_id', '{"update_id":1.5}'],
  ])('refuses a body that is %s with 400', async (_name, payload) => {
    const onUpdate = vi.fn(() => Promise.resolve());
    const response = await post(build(onUpdate), {
      headers: { 'x-telegram-bot-api-secret-token': SECRET },
      payload,
    });
    expect(response.statusCode).toBe(400);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('refuses without the right secret before it even looks at the body', async () => {
    const onUpdate = vi.fn(() => Promise.resolve());
    const response = await post(build(onUpdate), { payload: '{nope' });
    expect(response.statusCode).toBe(403);
  });

  it('is not registered at all when no webhook is configured', async () => {
    app = buildApp({ logger, db: { ping: () => Promise.resolve() } });
    const response = await post(app, { headers: { 'x-telegram-bot-api-secret-token': SECRET } });
    expect(response.statusCode).toBe(404);
  });

  it('can be registered on any Fastify instance', () => {
    expect(typeof registerWebhook).toBe('function');
  });
});
