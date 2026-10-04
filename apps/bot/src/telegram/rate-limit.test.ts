import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limit';

function limiter(limit: number, windowMs: number) {
  let now = 1_000_000;
  const instance = new RateLimiter({ limit, windowMs, now: () => now });
  return {
    instance,
    advance: (ms: number): void => {
      now += ms;
    },
  };
}

describe('RateLimiter', () => {
  it('lets a person through up to the limit, then drops the rest', () => {
    const { instance } = limiter(3, 10_000);
    expect([1, 2, 3, 4, 5].map(() => instance.allow(7))).toEqual([true, true, true, false, false]);
  });

  it('forgets events as the window slides', () => {
    const { instance, advance } = limiter(2, 10_000);
    expect(instance.allow(7)).toBe(true);
    advance(6_000);
    expect(instance.allow(7)).toBe(true);
    expect(instance.allow(7)).toBe(false);

    advance(4_000); // the first event is now exactly one window old
    expect(instance.allow(7)).toBe(true);
    expect(instance.allow(7)).toBe(false);
  });

  it('does not count a dropped event against the person', () => {
    const { instance, advance } = limiter(1, 1_000);
    expect(instance.allow(7)).toBe(true);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      advance(10);
      expect(instance.allow(7)).toBe(false);
    }
    advance(1_000);
    expect(instance.allow(7)).toBe(true);
  });

  it('keeps people apart', () => {
    const { instance } = limiter(1, 10_000);
    expect(instance.allow(1)).toBe(true);
    expect(instance.allow(1)).toBe(false);
    expect(instance.allow(2)).toBe(true);
  });

  it('does not grow without bound as people come and go', () => {
    const { instance, advance } = limiter(1, 1_000);
    for (let id = 1; id <= 12_000; id += 1) {
      expect(instance.allow(id)).toBe(true);
      advance(5);
    }
    // Long idle: the sweep on the next event removes everyone, so ids can be reused at once.
    advance(60_000);
    expect(instance.allow(1)).toBe(true);
  });
});
