import { DateTime, IANAZone } from 'luxon';
import { ScheduleError } from './errors';

/** A calendar date with no zone attached: `2026-10-02`. */
export type LocalDate = string;
/** A wall-clock time: `08:00` or `08:00:30`. */
export type LocalTime = string;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;
const MS_PER_DAY = 86_400_000;

/**
 * A named IANA zone such as `Asia/Tashkent`. A bare offset (`+05:00`) is refused even though the
 * runtime would accept it: an offset knows nothing about daylight saving or about the zone's
 * history, and the schedule must not be tied to one (ARCHITECTURE §13).
 */
export function isValidTimeZone(zone: string): boolean {
  return zone.length > 0 && !/^[+-]/.test(zone) && IANAZone.isValidZone(zone);
}

export function assertTimeZone(zone: string): void {
  if (!isValidTimeZone(zone)) {
    throw new ScheduleError('INVALID_TIME_ZONE', 'not an IANA time zone');
  }
}

/** The canonical spelling (`asia/tashkent` becomes `Asia/Tashkent`), so equal zones compare equal. */
export function canonicalTimeZone(zone: string): string {
  assertTimeZone(zone);
  return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
}

export function parseLocalDate(value: string): { year: number; month: number; day: number } {
  const match = DATE_PATTERN.exec(value);
  const year = Number(match?.[1]);
  const month = Number(match?.[2]);
  const day = Number(match?.[3]);
  if (match === null || !DateTime.fromObject({ year, month, day }, { zone: 'utc' }).isValid) {
    throw new ScheduleError('INVALID_DATE', 'not a calendar date (expected YYYY-MM-DD)');
  }
  return { year, month, day };
}

export function parseLocalTime(value: string): { hour: number; minute: number; second: number } {
  const match = TIME_PATTERN.exec(value);
  if (match === null) {
    throw new ScheduleError('INVALID_TIME', 'not a time of day (expected HH:MM or HH:MM:SS)');
  }
  return { hour: Number(match[1]), minute: Number(match[2]), second: Number(match[3] ?? 0) };
}

export function isValidLocalTime(value: string): boolean {
  return TIME_PATTERN.test(value);
}

/** Seconds since local midnight, for comparing times of day. */
export function secondsOfDay(time: LocalTime): number {
  const { hour, minute, second } = parseLocalTime(time);
  return hour * 3600 + minute * 60 + second;
}

/** The calendar date it is, in `zone`, at `instant`. */
export function localDateOf(instant: Date, zone: string): LocalDate {
  assertTimeZone(zone);
  const date = DateTime.fromJSDate(instant, { zone }).toISODate();
  if (date === null) {
    throw new ScheduleError('INVALID_DATE', 'instant is not a valid date');
  }
  return date;
}

function utcDate(date: LocalDate): DateTime {
  const parts = parseLocalDate(date);
  return DateTime.fromObject(parts, { zone: 'utc' });
}

/** Pure calendar arithmetic: independent of any zone and of daylight saving. */
export function addDays(date: LocalDate, days: number): LocalDate {
  const result = utcDate(date).plus({ days }).toISODate();
  if (result === null) {
    throw new ScheduleError('INVALID_DATE', 'date arithmetic left the supported range');
  }
  return result;
}

/** `to - from` in whole calendar days (negative when `to` is earlier). */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  return Math.round((utcDate(to).toMillis() - utcDate(from).toMillis()) / MS_PER_DAY);
}

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(date: LocalDate): number {
  return utcDate(date).weekday;
}

/**
 * The instant at which the wall clock in `zone` shows `time` on `date`.
 *
 * Daylight saving makes two wall-clock times ambiguous, and the rule is fixed here because a
 * reminder must never be dropped and never fire twice:
 * - a time that does not exist (the clock jumps over it) moves forward by the length of the
 *   jump: 02:30 on a day when 02:00 becomes 03:00 is 03:30;
 * - a time that happens twice (the clock is set back) is its first occurrence.
 */
export function zonedInstant(date: LocalDate, time: LocalTime, zone: string): Date {
  assertTimeZone(zone);
  const { year, month, day } = parseLocalDate(date);
  const { hour, minute, second } = parseLocalTime(time);
  const instant = DateTime.fromObject({ year, month, day, hour, minute, second }, { zone });
  if (!instant.isValid) {
    throw new ScheduleError('INVALID_TIME', 'could not resolve the local time');
  }
  return instant.toJSDate();
}

/** Midnight at the start of `date` in `zone`. A day lasts 23 or 25 hours when the clock changes. */
export function startOfLocalDay(date: LocalDate, zone: string): Date {
  assertTimeZone(zone);
  const { year, month, day } = parseLocalDate(date);
  return DateTime.fromObject({ year, month, day }, { zone }).startOf('day').toJSDate();
}

/** Seconds since local midnight at `instant` in `zone`. */
export function localSecondsOfDay(instant: Date, zone: string): number {
  assertTimeZone(zone);
  const local = DateTime.fromJSDate(instant, { zone });
  return local.hour * 3600 + local.minute * 60 + local.second;
}

/**
 * How an instant reads on the wall clock in `zone`: `05.10.2026 14:30`. For showing a deadline
 * to a person; the zone itself is not printed, so say whose clock it is next to it.
 */
export function formatLocalDateTime(instant: Date, zone: string): string {
  assertTimeZone(zone);
  return DateTime.fromJSDate(instant, { zone }).toFormat('dd.MM.yyyy HH:mm');
}

/** A calendar date for a person to read: `2026-10-05` as `05.10.2026`. */
export function formatLocalDate(date: LocalDate): string {
  const { year, month, day } = parseLocalDate(date);
  return `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}.${String(year)}`;
}

/** The time of day an instant falls on in `zone`: `14:30`. */
export function formatLocalTime(instant: Date, zone: string): string {
  assertTimeZone(zone);
  return DateTime.fromJSDate(instant, { zone }).toFormat('HH:mm');
}
