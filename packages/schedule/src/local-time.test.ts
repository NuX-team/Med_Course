import { describe, expect, it } from 'vitest';
import {
  addDays,
  assertTimeZone,
  canonicalTimeZone,
  daysBetween,
  formatLocalDate,
  formatLocalDateTime,
  formatLocalTime,
  isValidLocalTime,
  isValidTimeZone,
  isoWeekday,
  localDateOf,
  localSecondsOfDay,
  parseLocalDate,
  parseLocalTime,
  secondsOfDay,
  startOfLocalDay,
  zonedInstant,
} from './local-time';
import { errorCode } from './test-helpers';

const TASHKENT = 'Asia/Tashkent';
const BERLIN = 'Europe/Berlin';

describe('time zones', () => {
  it.each(['Asia/Tashkent', 'UTC', 'Europe/Berlin', 'America/New_York'])('accepts %s', (zone) => {
    expect(isValidTimeZone(zone)).toBe(true);
  });

  it.each(['', 'UTC+5', '+05:00', 'Mars/Phobos', 'Tashkent'])('rejects %j', (zone) => {
    expect(isValidTimeZone(zone)).toBe(false);
    expect(
      errorCode(() => {
        assertTimeZone(zone);
      }),
    ).toBe('INVALID_TIME_ZONE');
  });

  it('writes a zone the one canonical way', () => {
    expect(canonicalTimeZone('asia/tashkent')).toBe('Asia/Tashkent');
    expect(canonicalTimeZone('Asia/Tashkent')).toBe('Asia/Tashkent');
    expect(errorCode(() => canonicalTimeZone('nope'))).toBe('INVALID_TIME_ZONE');
  });
});

describe('parsing', () => {
  it('reads real calendar dates only', () => {
    expect(parseLocalDate('2026-10-02')).toEqual({ year: 2026, month: 10, day: 2 });
    expect(parseLocalDate('2028-02-29')).toEqual({ year: 2028, month: 2, day: 29 });
    for (const bad of [
      '2026-02-29',
      '2026-02-30',
      '2026-13-01',
      '2026-00-10',
      '2026-2-3',
      '2026/10/02',
      '',
      ' 2026-10-02',
    ]) {
      expect(
        errorCode(() => parseLocalDate(bad)),
        bad,
      ).toBe('INVALID_DATE');
    }
  });

  it('reads times of day with optional seconds', () => {
    expect(parseLocalTime('08:00')).toEqual({ hour: 8, minute: 0, second: 0 });
    expect(parseLocalTime('23:59:59')).toEqual({ hour: 23, minute: 59, second: 59 });
    expect(parseLocalTime('00:00')).toEqual({ hour: 0, minute: 0, second: 0 });
    for (const bad of ['24:00', '8:00', '12:60', '12:00:60', '12', '', '12:00:', 'noon']) {
      expect(
        errorCode(() => parseLocalTime(bad)),
        bad,
      ).toBe('INVALID_TIME');
      expect(isValidLocalTime(bad), bad).toBe(false);
    }
    expect(isValidLocalTime('08:00')).toBe(true);
  });

  it('turns a time of day into seconds', () => {
    expect(secondsOfDay('00:00')).toBe(0);
    expect(secondsOfDay('08:30')).toBe(30_600);
    expect(secondsOfDay('23:59:59')).toBe(86_399);
  });
});

describe('which date it is', () => {
  it('flips at local midnight, not at UTC midnight (Tashkent is UTC+5)', () => {
    expect(localDateOf(new Date('2026-10-02T18:59:59.999Z'), TASHKENT)).toBe('2026-10-02');
    expect(localDateOf(new Date('2026-10-02T19:00:00.000Z'), TASHKENT)).toBe('2026-10-03');
    expect(localDateOf(new Date('2026-10-02T00:00:00.000Z'), TASHKENT)).toBe('2026-10-02');
    expect(localDateOf(new Date('2026-10-01T19:00:00.000Z'), TASHKENT)).toBe('2026-10-02');
  });

  it('depends on the zone: one instant, different dates', () => {
    const instant = new Date('2026-10-02T20:00:00Z');
    expect(localDateOf(instant, 'UTC')).toBe('2026-10-02');
    expect(localDateOf(instant, TASHKENT)).toBe('2026-10-03');
    expect(localDateOf(instant, 'America/Los_Angeles')).toBe('2026-10-02');
    expect(localDateOf(instant, 'Pacific/Kiritimati')).toBe('2026-10-03');
  });

  it('refuses an unknown zone and an invalid instant', () => {
    expect(errorCode(() => localDateOf(new Date(), 'nope'))).toBe('INVALID_TIME_ZONE');
    expect(errorCode(() => localDateOf(new Date(Number.NaN), TASHKENT))).toBe('INVALID_DATE');
  });
});

describe('calendar arithmetic', () => {
  it.each([
    ['2026-10-02', 1, '2026-10-03'],
    ['2026-10-31', 1, '2026-11-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2026-02-28', 1, '2026-03-01'],
    ['2026-03-01', -1, '2026-02-28'],
    ['2026-10-02', 0, '2026-10-02'],
    ['2026-10-02', 365, '2027-10-02'],
    ['2026-03-28', 2, '2026-03-30'],
  ])('addDays(%s, %i) = %s', (date, days, expected) => {
    expect(addDays(date, days)).toBe(expected);
  });

  it('counts days between dates, signed', () => {
    expect(daysBetween('2026-10-02', '2026-10-02')).toBe(0);
    expect(daysBetween('2026-10-02', '2026-10-09')).toBe(7);
    expect(daysBetween('2026-10-09', '2026-10-02')).toBe(-7);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
  });

  it('knows the ISO weekday (2026-10-02 is a Friday)', () => {
    expect(isoWeekday('2026-10-02')).toBe(5);
    expect(isoWeekday('2026-10-04')).toBe(7);
    expect(isoWeekday('2026-10-05')).toBe(1);
  });
});

describe('a wall-clock time as an instant', () => {
  it('is an ordinary offset where the zone has no daylight saving', () => {
    expect(zonedInstant('2026-10-02', '08:00', TASHKENT).toISOString()).toBe(
      '2026-10-02T03:00:00.000Z',
    );
    expect(zonedInstant('2026-10-02', '08:00:30', TASHKENT).toISOString()).toBe(
      '2026-10-02T03:00:30.000Z',
    );
    expect(zonedInstant('2026-10-02', '00:00', TASHKENT).toISOString()).toBe(
      '2026-10-01T19:00:00.000Z',
    );
    expect(zonedInstant('2026-10-02', '23:59', TASHKENT).toISOString()).toBe(
      '2026-10-02T18:59:00.000Z',
    );
  });

  it('follows the offset of the day in a zone that changes its clocks', () => {
    expect(zonedInstant('2026-01-15', '08:00', BERLIN).toISOString()).toBe(
      '2026-01-15T07:00:00.000Z',
    );
    expect(zonedInstant('2026-07-15', '08:00', BERLIN).toISOString()).toBe(
      '2026-07-15T06:00:00.000Z',
    );
  });

  it('moves a time that does not exist forward by the length of the jump (never drops it)', () => {
    // 2026-03-29 in Berlin: 02:00 becomes 03:00, so 02:30 does not exist.
    expect(zonedInstant('2026-03-29', '01:59', BERLIN).toISOString()).toBe(
      '2026-03-29T00:59:00.000Z',
    );
    expect(zonedInstant('2026-03-29', '02:30', BERLIN).toISOString()).toBe(
      '2026-03-29T01:30:00.000Z',
    );
    expect(zonedInstant('2026-03-29', '03:00', BERLIN).toISOString()).toBe(
      '2026-03-29T01:00:00.000Z',
    );
  });

  it('takes the first occurrence of a time that happens twice (never fires twice)', () => {
    // 2026-10-25 in Berlin: 03:00 becomes 02:00, so 02:30 happens twice.
    expect(zonedInstant('2026-10-25', '02:30', BERLIN).toISOString()).toBe(
      '2026-10-25T00:30:00.000Z',
    );
    expect(zonedInstant('2026-10-25', '03:00', BERLIN).toISOString()).toBe(
      '2026-10-25T02:00:00.000Z',
    );
  });

  it('rejects bad input loudly', () => {
    expect(errorCode(() => zonedInstant('2026-10-02', '08:00', 'nope'))).toBe('INVALID_TIME_ZONE');
    expect(errorCode(() => zonedInstant('2026-02-30', '08:00', TASHKENT))).toBe('INVALID_DATE');
    expect(errorCode(() => zonedInstant('2026-10-02', '8am', TASHKENT))).toBe('INVALID_TIME');
  });
});

describe('the length of a day', () => {
  it('starts at local midnight', () => {
    expect(startOfLocalDay('2026-10-02', TASHKENT).toISOString()).toBe('2026-10-01T19:00:00.000Z');
    expect(startOfLocalDay('2026-10-02', 'UTC').toISOString()).toBe('2026-10-02T00:00:00.000Z');
  });

  it('is 24 hours in Tashkent, 23 when the clocks go forward and 25 when they go back', () => {
    const hours = (from: string, zone: string) =>
      (startOfLocalDay(addDays(from, 1), zone).getTime() - startOfLocalDay(from, zone).getTime()) /
      3_600_000;

    expect(hours('2026-10-02', TASHKENT)).toBe(24);
    expect(hours('2026-03-29', BERLIN)).toBe(23);
    expect(hours('2026-10-25', BERLIN)).toBe(25);
    expect(hours('2026-06-10', BERLIN)).toBe(24);
  });

  it('reports the time of day in the zone', () => {
    expect(localSecondsOfDay(new Date('2026-10-02T03:30:15Z'), TASHKENT)).toBe(
      8 * 3600 + 30 * 60 + 15,
    );
    expect(localSecondsOfDay(new Date('2026-10-02T19:00:00Z'), TASHKENT)).toBe(0);
  });
});

describe('showing an instant on a wall clock', () => {
  it('prints the local date and time of the zone, day first', () => {
    const instant = new Date('2026-10-05T09:30:00Z');
    expect(formatLocalDateTime(instant, TASHKENT)).toBe('05.10.2026 14:30');
    expect(formatLocalDateTime(instant, 'Europe/Moscow')).toBe('05.10.2026 12:30');
    expect(formatLocalDateTime(new Date('2026-12-31T20:00:00Z'), TASHKENT)).toBe(
      '01.01.2027 01:00',
    );
  });

  it('prints a calendar date and a time of day on their own', () => {
    expect(formatLocalDate('2026-10-05')).toBe('05.10.2026');
    expect(formatLocalDate('2027-01-01')).toBe('01.01.2027');
    expect(errorCode(() => formatLocalDate('2026-02-30'))).toBe('INVALID_DATE');
    expect(formatLocalTime(new Date('2026-10-05T09:30:00Z'), TASHKENT)).toBe('14:30');
    expect(formatLocalTime(new Date('2026-10-05T19:05:00Z'), TASHKENT)).toBe('00:05');
  });

  it('refuses something that is not a zone', () => {
    expect(errorCode(() => formatLocalDateTime(new Date(), '+05:00'))).toBe('INVALID_TIME_ZONE');
  });
});
