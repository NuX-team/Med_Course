import { describe, expect, it } from 'vitest';
import { isInQuietHours, quietHoursConflicts } from './quiet-hours';
import { at } from './test-helpers';

const TASHKENT = 'Asia/Tashkent';
/** Tashkent is UTC+5: 22:00 local is 17:00Z, 07:00 local is 02:00Z. */
const night = { from: '22:00', to: '07:00' };
const afternoon = { from: '13:00', to: '15:00' };

describe('isInQuietHours', () => {
  it('handles a window that runs past midnight, start included and end excluded', () => {
    expect(isInQuietHours(at('2026-10-02T16:59:59Z'), night, TASHKENT)).toBe(false); // 21:59:59
    expect(isInQuietHours(at('2026-10-02T17:00:00Z'), night, TASHKENT)).toBe(true); // 22:00
    expect(isInQuietHours(at('2026-10-02T19:00:00Z'), night, TASHKENT)).toBe(true); // 00:00
    expect(isInQuietHours(at('2026-10-03T01:59:59Z'), night, TASHKENT)).toBe(true); // 06:59:59
    expect(isInQuietHours(at('2026-10-03T02:00:00Z'), night, TASHKENT)).toBe(false); // 07:00
    expect(isInQuietHours(at('2026-10-03T07:00:00Z'), night, TASHKENT)).toBe(false); // noon
  });

  it('handles a window inside one day', () => {
    expect(isInQuietHours(at('2026-10-02T07:59:59Z'), afternoon, TASHKENT)).toBe(false); // 12:59:59
    expect(isInQuietHours(at('2026-10-02T08:00:00Z'), afternoon, TASHKENT)).toBe(true); // 13:00
    expect(isInQuietHours(at('2026-10-02T09:59:59Z'), afternoon, TASHKENT)).toBe(true); // 14:59:59
    expect(isInQuietHours(at('2026-10-02T10:00:00Z'), afternoon, TASHKENT)).toBe(false); // 15:00
  });

  it('treats equal ends as an empty window, not as all day', () => {
    const empty = { from: '08:00', to: '08:00' };
    for (const hour of [0, 5, 8, 13, 23]) {
      expect(isInQuietHours(new Date(Date.UTC(2026, 9, 2, hour)), empty, TASHKENT)).toBe(false);
    }
  });

  it('is read in the patient’s own zone', () => {
    const instant = at('2026-10-02T18:00:00Z'); // 23:00 in Tashkent, 18:00 in UTC
    expect(isInQuietHours(instant, night, TASHKENT)).toBe(true);
    expect(isInQuietHours(instant, night, 'UTC')).toBe(false);
  });
});

describe('quietHoursConflicts', () => {
  const slots = [
    { id: 'morning', scheduledAt: at('2026-10-02T03:00:00Z') }, // 08:00
    { id: 'late', scheduledAt: at('2026-10-02T18:30:00Z') }, // 23:30
    { id: 'small-hours', scheduledAt: at('2026-10-03T00:00:00Z') }, // 05:00
    { id: 'evening', scheduledAt: at('2026-10-02T15:00:00Z') }, // 20:00
  ];

  it('returns the prescribed doses that the quiet hours would swallow, in the order given', () => {
    expect(quietHoursConflicts(slots, night, TASHKENT).map((slot) => slot.id)).toEqual([
      'late',
      'small-hours',
    ]);
  });

  it('returns none when the window is empty or misses every dose', () => {
    expect(quietHoursConflicts(slots, { from: '08:00', to: '08:00' }, TASHKENT)).toEqual([]);
    expect(quietHoursConflicts(slots, { from: '10:00', to: '12:00' }, TASHKENT)).toEqual([]);
    expect(quietHoursConflicts([], night, TASHKENT)).toEqual([]);
  });
});
