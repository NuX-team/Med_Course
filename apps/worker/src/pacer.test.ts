import { describe, expect, it } from 'vitest';
import { Pacer } from './pacer';

/**
 * A clock the test moves by hand: the pacer is tested without waiting. `sleep` only records how
 * long it was asked to wait; callers that ask at the same instant therefore see the same time,
 * as they do in life, and `later` moves the clock on to where a waiting caller would be.
 */
function virtual(options: { movesOnSleep?: boolean } = {}) {
  let at = 1_000_000;
  const slept: number[] = [];
  return {
    now: () => at,
    sleep: (ms: number): Promise<void> => {
      slept.push(ms);
      if (options.movesOnSleep === true) {
        at += ms;
      }
      return Promise.resolve();
    },
    slept,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

describe('Pacer', () => {
  it('lets the first caller through at once and spaces the next ones evenly', async () => {
    const clock = virtual({ movesOnSleep: true });
    const pacer = new Pacer(25, clock);
    const left: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      await pacer.take();
      left.push(clock.now());
    }
    expect(left.map((at, index) => (index === 0 ? 0 : at - (left[index - 1] ?? 0)))).toEqual([
      0, 40, 40, 40, 40,
    ]);
  });

  it('gives callers that ask together successive places, not all the same one', () => {
    const clock = virtual();
    const pacer = new Pacer(10, clock);
    const asked = Array.from({ length: 4 }, () => pacer.take());
    // Four callers at the same instant: they wait 0, 100, 200 and 300 ms.
    expect(clock.slept).toEqual([100, 200, 300]);
    return Promise.all(asked).then(() => undefined);
  });

  it('does not save up the time nobody asked: after a quiet spell there is no burst', async () => {
    const clock = virtual();
    const pacer = new Pacer(10, clock);
    await pacer.take();
    clock.advance(60_000);
    const asked = [pacer.take(), pacer.take(), pacer.take()];
    expect(clock.slept).toEqual([100, 200]);
    await Promise.all(asked);
  });

  it('holds everybody back for as long as Telegram said, and then goes on at the rate', async () => {
    const clock = virtual();
    const pacer = new Pacer(10, clock);
    await pacer.take();
    pacer.pauseFor(5_000);
    await pacer.take();
    expect(clock.slept.at(-1)).toBe(5_000);
    // A shorter pause does not shorten one already in force: the place after a pause of five
    // seconds is five seconds away, however many shorter ones are asked for in the meantime.
    const other = virtual();
    const held = new Pacer(10, other);
    held.pauseFor(5_000);
    held.pauseFor(100);
    held.pauseFor(1);
    await held.take();
    expect(other.slept).toEqual([5_000]);
  });

  it('refuses a rate that is not a positive number', () => {
    for (const rate of [0, -5, Number.NaN]) {
      expect(() => new Pacer(rate)).toThrow(RangeError);
    }
  });
});
