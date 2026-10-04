import { ScheduleError } from './errors';
import {
  addDays,
  assertTimeZone,
  localDateOf,
  parseLocalDate,
  startOfLocalDay,
  type LocalDate,
} from './local-time';

/**
 * A stretch of time during which the course is on hold. `to: null` means "still paused":
 * nothing after `from` counts, so the end of the course is not known yet.
 */
export interface Pause {
  readonly from: Date;
  readonly to: Date | null;
}

/**
 * Where a course sits on the calendar. Day 1 is the local date of the start (TZ §7.1: a start
 * at 23:50 is day 1 for ten minutes, then day 2). Days are counted in the patient's time zone,
 * and `durationDays` counts days of treatment, not days on the calendar: a day that lies
 * wholly inside a pause is not counted, so a pause pushes the end of the course out
 * (ARCHITECTURE §5.5, D-10). A day only partly paused still counts.
 */
export interface CourseTimeline {
  readonly effectiveStartDate: LocalDate;
  readonly timezone: string;
  readonly durationDays: number;
  readonly pauses?: readonly Pause[];
}

/** Guards against a runaway loop; three years is far past any course plus its pauses. */
const MAX_SPAN_DAYS = 3 * 365;

export interface CountedDay {
  readonly day: number;
  readonly date: LocalDate;
}

/** Sorted, with overlapping and touching pauses merged. Rejects empty and inverted ones. */
export function normalizePauses(pauses: readonly Pause[] = []): Pause[] {
  const sorted = pauses
    .map((pause) => {
      if (Number.isNaN(pause.from.getTime()) || (pause.to !== null && pause.to <= pause.from)) {
        throw new ScheduleError('INVALID_PAUSE', 'a pause must end after it starts');
      }
      return pause;
    })
    .sort((a, b) => a.from.getTime() - b.from.getTime());

  const merged: Pause[] = [];
  for (const pause of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && (last.to === null || pause.from <= last.to)) {
      const to =
        last.to === null || pause.to === null ? null : pause.to > last.to ? pause.to : last.to;
      merged[merged.length - 1] = { from: last.from, to };
    } else {
      merged.push(pause);
    }
  }
  return merged;
}

/** Is `instant` inside a pause? Half-open: a pause includes its start and excludes its end. */
export function isPaused(instant: Date, pauses: readonly Pause[]): boolean {
  return pauses.some((pause) => instant >= pause.from && (pause.to === null || instant < pause.to));
}

function isWhollyPaused(date: LocalDate, zone: string, pauses: readonly Pause[]): boolean {
  const start = startOfLocalDay(date, zone);
  const end = startOfLocalDay(addDays(date, 1), zone);
  return pauses.some((pause) => pause.from <= start && (pause.to === null || pause.to >= end));
}

/**
 * The counted days in order: day 1, 2, ... up to `durationDays`, each with its calendar date.
 * Stops early, without reaching `durationDays`, when an open pause begins (the rest is unknown).
 */
export function* courseDays(timeline: CourseTimeline): Generator<CountedDay> {
  assertTimeZone(timeline.timezone);
  parseLocalDate(timeline.effectiveStartDate);
  const pauses = normalizePauses(timeline.pauses);
  const openFrom = pauses.find((pause) => pause.to === null)?.from;

  let date = timeline.effectiveStartDate;
  let day = 0;
  for (let steps = 0; day < timeline.durationDays; steps += 1) {
    if (steps > MAX_SPAN_DAYS) {
      throw new ScheduleError('TIMELINE_TOO_LONG', 'the course and its pauses span too many days');
    }
    if (openFrom !== undefined && startOfLocalDay(date, timeline.timezone) >= openFrom) {
      return;
    }
    if (!isWhollyPaused(date, timeline.timezone, pauses)) {
      day += 1;
      yield { day, date };
    }
    date = addDays(date, 1);
  }
}

/** The date of the final day, or `null` while an open pause leaves the end unknown. */
export function lastCourseDay(timeline: CourseTimeline): LocalDate | null {
  let last: CountedDay | undefined;
  for (const counted of courseDays(timeline)) {
    last = counted;
  }
  return last?.day === timeline.durationDays ? last.date : null;
}

/** The calendar date of day `day` (1-based), or `null` if it is beyond what is known. */
export function dateOfCourseDay(timeline: CourseTimeline, day: number): LocalDate | null {
  for (const counted of courseDays(timeline)) {
    if (counted.day === day) {
      return counted.date;
    }
  }
  return null;
}

export type CourseDay =
  | { readonly state: 'NOT_STARTED' }
  | {
      readonly state: 'IN_PROGRESS';
      readonly day: number;
      readonly remainingDays: number;
      readonly date: LocalDate;
    }
  /** Today lies wholly inside a pause. `daysDone` is how many days were counted before it. */
  | { readonly state: 'PAUSED'; readonly daysDone: number }
  | { readonly state: 'ENDED'; readonly lastDay: LocalDate };

/** Which day of the course it is at `now`. */
export function courseDayAt(timeline: CourseTimeline, now: Date): CourseDay {
  const today = localDateOf(now, timeline.timezone);
  if (today < timeline.effectiveStartDate) {
    return { state: 'NOT_STARTED' };
  }

  let daysDone = 0;
  let lastDate: LocalDate | undefined;
  for (const { day, date } of courseDays(timeline)) {
    if (date === today) {
      return { state: 'IN_PROGRESS', day, remainingDays: timeline.durationDays - day, date };
    }
    if (date > today) {
      return { state: 'PAUSED', daysDone };
    }
    daysDone = day;
    lastDate = date;
  }

  // Past every counted day: finished, or waiting out an open pause.
  return daysDone === timeline.durationDays && lastDate !== undefined
    ? { state: 'ENDED', lastDay: lastDate }
    : { state: 'PAUSED', daysDone };
}
