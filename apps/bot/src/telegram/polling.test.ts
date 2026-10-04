import { createLogger } from '@medcourse/logger';
import { describe, expect, it, vi } from 'vitest';
import { startPolling } from './polling';
import type { TelegramApi, Update } from './types';

const logger = createLogger({ service: 'polling-test', level: 'silent' });
const update = (id: number): Update => ({ update_id: id });

/** An API whose getUpdates answers from a script and then keeps returning nothing. */
function fakeApi(script: (Update[] | Error)[]) {
  const calls: { method: string; offset?: number }[] = [];
  const queue = [...script];
  const api = {
    deleteWebhook: vi.fn(() => {
      calls.push({ method: 'deleteWebhook' });
      return Promise.resolve(true);
    }),
    getUpdates: vi.fn((other?: { offset?: number }) => {
      calls.push({
        method: 'getUpdates',
        ...(other?.offset === undefined ? {} : { offset: other.offset }),
      });
      const next = queue.shift();
      if (next instanceof Error) return Promise.reject(next);
      // Like the real thing, never answer within the same microtask turn: a loop of instantly
      // resolved promises would starve the event loop.
      return new Promise((resolve) =>
        setImmediate(() => {
          resolve(next ?? []);
        }),
      );
    }),
  } as unknown as TelegramApi;
  return { api, calls, remaining: () => queue.length };
}

/** Lets the loop run until `done()` or a safety limit, with real timers but no real waiting. */
async function until(done: () => boolean): Promise<void> {
  for (let spin = 0; spin < 500 && !done(); spin += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(done()).toBe(true);
}

describe('startPolling', () => {
  it('removes the webhook before it asks for anything', async () => {
    const { api, calls } = fakeApi([]);
    const poller = startPolling({
      api,
      onUpdate: () => Promise.resolve(),
      logger,
      sleep: () => Promise.resolve(),
    });
    await until(() => calls.length >= 3);
    await poller.stop();

    expect(calls[0]).toEqual({ method: 'deleteWebhook' });
    expect(calls.slice(1).every((call) => call.method === 'getUpdates')).toBe(true);
  });

  it('hands over updates in order and moves the offset past the last one', async () => {
    const handled: number[] = [];
    const { api, calls, remaining } = fakeApi([[update(10), update(11)], [update(12)]]);
    const poller = startPolling({
      api,
      onUpdate: (u) => {
        handled.push(u.update_id);
        return Promise.resolve();
      },
      logger,
      sleep: () => Promise.resolve(),
    });
    await until(() => remaining() === 0 && handled.length === 3);
    await poller.stop();

    expect(handled).toEqual([10, 11, 12]);
    const offsets = calls.filter((call) => call.method === 'getUpdates').map((call) => call.offset);
    expect(offsets.slice(0, 3)).toEqual([undefined, 12, 13]);
  });

  it('is not stopped by an update that cannot be handled, and still moves on', async () => {
    const handled: number[] = [];
    const { api, remaining } = fakeApi([[update(1), update(2), update(3)]]);
    const poller = startPolling({
      api,
      onUpdate: (u) => {
        handled.push(u.update_id);
        return u.update_id === 2 ? Promise.reject(new Error('poison')) : Promise.resolve();
      },
      logger,
      sleep: () => Promise.resolve(),
    });
    await until(() => remaining() === 0 && handled.length === 3);
    await poller.stop();

    expect(handled).toEqual([1, 2, 3]);
  });

  it('backs off after a failed request and then carries on from the same place', async () => {
    const sleeps: number[] = [];
    const handled: number[] = [];
    const { api, remaining } = fakeApi([
      [update(5)],
      new Error('network'),
      new Error('network'),
      [update(6)],
    ]);
    const poller = startPolling({
      api,
      onUpdate: (u) => {
        handled.push(u.update_id);
        return Promise.resolve();
      },
      logger,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    await until(() => remaining() === 0 && handled.length === 2);
    await poller.stop();

    expect(handled).toEqual([5, 6]);
    expect(sleeps.length).toBeGreaterThanOrEqual(2);
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] ?? Infinity);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(30_000);
  });

  it('keeps trying to remove the webhook until it works', async () => {
    const { api, calls } = fakeApi([]);
    let attempts = 0;
    (api as unknown as { deleteWebhook: () => Promise<boolean> }).deleteWebhook = () => {
      attempts += 1;
      return attempts < 3 ? Promise.reject(new Error('down')) : Promise.resolve(true);
    };
    const poller = startPolling({
      api,
      onUpdate: () => Promise.resolve(),
      logger,
      sleep: () => Promise.resolve(),
    });
    await until(() => calls.some((call) => call.method === 'getUpdates'));
    await poller.stop();

    expect(attempts).toBe(3);
  });

  it('stops when asked, and asks for nothing afterwards', async () => {
    const { api, calls } = fakeApi([]);
    const poller = startPolling({
      api,
      onUpdate: () => Promise.resolve(),
      logger,
      sleep: () => Promise.resolve(),
    });
    await until(() => calls.length >= 2);
    await poller.stop();

    const afterStop = calls.length;
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls.length).toBe(afterStop);
  });
});
