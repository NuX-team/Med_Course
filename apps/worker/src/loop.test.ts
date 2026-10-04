import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startLoop } from './loop';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startLoop', () => {
  it('ticks immediately, then every interval after the previous tick ended', async () => {
    const tick = vi.fn(() => Promise.resolve());
    const loop = startLoop({ intervalMs: 1_000, tick, onError: vi.fn() });

    await vi.advanceTimersByTimeAsync(0);
    expect(tick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(tick).toHaveBeenCalledTimes(2);

    await loop.stop();
  });

  it('never runs two ticks at once, even when a tick outlasts the interval', async () => {
    let active = 0;
    let maxActive = 0;
    const tick = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      active -= 1;
    });
    const loop = startLoop({ intervalMs: 1_000, tick, onError: vi.fn() });

    await vi.advanceTimersByTimeAsync(30_000);
    const stopped = loop.stop();
    await vi.advanceTimersByTimeAsync(5_000); // let the in-flight tick finish
    await stopped;

    expect(tick.mock.calls.length).toBeGreaterThan(1);
    expect(maxActive).toBe(1);
  });

  it('reports a failing tick and keeps going', async () => {
    const boom = new Error('boom');
    const tick = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(boom)
      .mockResolvedValue(undefined);
    const onError = vi.fn();
    const loop = startLoop({ intervalMs: 1_000, tick, onError });

    await vi.advanceTimersByTimeAsync(2_500);
    await loop.stop();

    expect(onError).toHaveBeenCalledExactlyOnceWith(boom);
    expect(tick.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('waits for an in-flight tick on stop and schedules nothing afterwards', async () => {
    let finished = false;
    const tick = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      finished = true;
    });
    const loop = startLoop({ intervalMs: 1_000, tick, onError: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);

    const stopped = loop.stop();
    await vi.advanceTimersByTimeAsync(3_000);
    await stopped;
    expect(finished).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('measures heartbeat age from the last finished tick, failed or not', async () => {
    const tick = vi.fn(() => Promise.reject(new Error('always failing')));
    const loop = startLoop({ intervalMs: 10_000, tick, onError: vi.fn() });

    await vi.advanceTimersByTimeAsync(0);
    expect(loop.heartbeatAgeMs()).toBe(0);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(loop.heartbeatAgeMs()).toBe(4_000);

    await loop.stop();
  });
});
