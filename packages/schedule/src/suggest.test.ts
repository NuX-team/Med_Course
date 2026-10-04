import { describe, expect, it } from 'vitest';
import { isValidLocalTime, secondsOfDay } from './local-time';
import { SUGGESTED_FREQUENCIES, suggestDailyTimes } from './suggest';

describe('suggestDailyTimes', () => {
  it.each(SUGGESTED_FREQUENCIES)(
    'proposes exactly %i valid, different, ascending times',
    (count) => {
      const times = suggestDailyTimes(count);
      expect(times).toHaveLength(count);
      expect(times.every(isValidLocalTime)).toBe(true);
      expect([...times].sort()).toEqual(times);
      expect(new Set(times).size).toBe(count);
    },
  );

  it('keeps every proposal inside waking hours and at least three hours apart', () => {
    for (const count of SUGGESTED_FREQUENCIES) {
      const seconds = suggestDailyTimes(count).map(secondsOfDay);
      expect(Math.min(...seconds)).toBeGreaterThanOrEqual(7 * 3600);
      expect(Math.max(...seconds)).toBeLessThanOrEqual(22 * 3600);
      for (let index = 1; index < seconds.length; index += 1) {
        expect((seconds[index] ?? 0) - (seconds[index - 1] ?? 0)).toBeGreaterThanOrEqual(3 * 3600);
      }
    }
  });

  it('hands out a fresh list each time, so a caller cannot spoil the next proposal', () => {
    const first = suggestDailyTimes(2);
    first.push('03:00');
    expect(suggestDailyTimes(2)).toEqual(['09:00', '21:00']);
  });
});
