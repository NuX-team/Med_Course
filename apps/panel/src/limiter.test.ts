import { describe, expect, it } from 'vitest';
import { WindowLimiter } from './limiter';

describe('WindowLimiter', () => {
  it('lets a key make its quota in a window and refuses the rest, saying how long to wait', () => {
    let at = 1_000;
    const limiter = new WindowLimiter(3, 10_000, () => at);

    expect([1, 2, 3].map(() => limiter.check('a'))).toEqual([
      { allowed: true },
      { allowed: true },
      { allowed: true },
    ]);
    at += 4_000;
    expect(limiter.check('a')).toEqual({ allowed: false, retryAfterMs: 6_000 });
    expect(limiter.check('a')).toEqual({ allowed: false, retryAfterMs: 6_000 });
  });

  it('counts each key on its own', () => {
    const limiter = new WindowLimiter(1, 10_000, () => 0);
    expect(limiter.check('a')).toEqual({ allowed: true });
    expect(limiter.check('b')).toEqual({ allowed: true });
    expect(limiter.check('a').allowed).toBe(false);
    expect(limiter.check('b').allowed).toBe(false);
  });

  it('starts a new window when the old one is over, to the millisecond', () => {
    let at = 0;
    const limiter = new WindowLimiter(1, 10_000, () => at);
    limiter.check('a');
    at = 9_999;
    expect(limiter.check('a').allowed).toBe(false);
    at = 10_000;
    expect(limiter.check('a')).toEqual({ allowed: true });
    expect(limiter.check('a').allowed).toBe(false);
  });

  it('does not grow without end: keys whose window is over are forgotten', () => {
    let at = 0;
    const limiter = new WindowLimiter(1, 1_000, () => at);
    for (let index = 0; index < 10_001; index += 1) {
      limiter.check(`address-${String(index)}`);
    }
    at = 5_000;
    expect(limiter.size).toBe(10_001);
    // The next call finds the table too big and sweeps it: every key whose window is over goes.
    expect(limiter.check('address-0')).toEqual({ allowed: true });
    expect(limiter.size).toBe(1);
    expect(limiter.check('address-0').allowed).toBe(false);
  });
});
