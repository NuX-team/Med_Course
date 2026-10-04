import { describe, expect, it } from 'vitest';
import { addDays, localDateOf, startOfLocalDay } from './local-time';
import {
  courseDayAt,
  courseDays,
  dateOfCourseDay,
  isPaused,
  lastCourseDay,
  normalizePauses,
  type CourseTimeline,
  type Pause,
} from './timeline';
import { at, errorCode, seeded } from './test-helpers';

const TASHKENT = 'Asia/Tashkent';
const BERLIN = 'Europe/Berlin';

/** Seven days from Friday 2 October 2026, in Tashkent (local midnight = 19:00Z the day before). */
const week: CourseTimeline = {
  effectiveStartDate: '2026-10-02',
  timezone: TASHKENT,
  durationDays: 7,
};

describe('the day of the course', () => {
  it('has day 1 start at local midnight and day 2 at the next one (TZ §7.1)', () => {
    expect(courseDayAt(week, at('2026-10-01T18:59:59.999Z'))).toEqual({ state: 'NOT_STARTED' });
    expect(courseDayAt(week, at('2026-10-01T19:00:00.000Z'))).toEqual({
      state: 'IN_PROGRESS',
      day: 1,
      remainingDays: 6,
      date: '2026-10-02',
    });
    expect(courseDayAt(week, at('2026-10-02T18:59:59.999Z'))).toMatchObject({
      state: 'IN_PROGRESS',
      day: 1,
    });
    expect(courseDayAt(week, at('2026-10-02T19:00:00.000Z'))).toMatchObject({
      state: 'IN_PROGRESS',
      day: 2,
      remainingDays: 5,
    });
  });

  it('makes a tap at 23:50 day 1 for ten minutes, then day 2', () => {
    const tap = at('2026-10-02T18:50:00Z'); // 23:50 in Tashkent
    const timeline = { ...week, effectiveStartDate: localDateOf(tap, TASHKENT) };

    expect(timeline.effectiveStartDate).toBe('2026-10-02');
    expect(courseDayAt(timeline, tap)).toMatchObject({ state: 'IN_PROGRESS', day: 1 });
    expect(courseDayAt(timeline, at('2026-10-02T18:59:59Z'))).toMatchObject({ day: 1 });
    expect(courseDayAt(timeline, at('2026-10-02T19:00:00Z'))).toMatchObject({ day: 2 });
  });

  it('ends after the last day and says which it was', () => {
    expect(courseDayAt(week, at('2026-10-08T18:59:59.999Z'))).toMatchObject({
      state: 'IN_PROGRESS',
      day: 7,
      remainingDays: 0,
    });
    expect(courseDayAt(week, at('2026-10-08T19:00:00.000Z'))).toEqual({
      state: 'ENDED',
      lastDay: '2026-10-08',
    });
    expect(courseDayAt(week, at('2027-01-01T00:00:00Z'))).toEqual({
      state: 'ENDED',
      lastDay: '2026-10-08',
    });
  });

  it('is counted in the patient’s zone: the same instant is a different day elsewhere', () => {
    const instant = at('2026-10-02T20:00:00Z');
    expect(courseDayAt(week, instant)).toMatchObject({ day: 2 });
    expect(courseDayAt({ ...week, timezone: 'UTC' }, instant)).toMatchObject({ day: 1 });
  });

  it('knows the first and last dates', () => {
    expect(dateOfCourseDay(week, 1)).toBe('2026-10-02');
    expect(dateOfCourseDay(week, 7)).toBe('2026-10-08');
    expect(dateOfCourseDay(week, 8)).toBeNull();
    expect(lastCourseDay(week)).toBe('2026-10-08');
    expect(lastCourseDay({ ...week, durationDays: 1 })).toBe('2026-10-02');
    expect(lastCourseDay({ ...week, durationDays: 365 })).toBe('2027-10-01');
  });

  it('rejects an unknown zone or a malformed start date', () => {
    expect(errorCode(() => courseDayAt({ ...week, timezone: 'nope' }, new Date()))).toBe(
      'INVALID_TIME_ZONE',
    );
    expect(errorCode(() => lastCourseDay({ ...week, effectiveStartDate: '2026-02-30' }))).toBe(
      'INVALID_DATE',
    );
  });
});

describe('pauses', () => {
  it('normalises: sorts, merges overlapping and touching pauses, keeps open ones open', () => {
    const merged = normalizePauses([
      { from: at('2026-10-10T00:00Z'), to: at('2026-10-11T00:00Z') },
      { from: at('2026-10-03T00:00Z'), to: at('2026-10-04T00:00Z') },
      { from: at('2026-10-04T00:00Z'), to: at('2026-10-05T00:00Z') },
      { from: at('2026-10-04T12:00Z'), to: at('2026-10-04T18:00Z') },
    ]);
    expect(merged).toEqual([
      { from: at('2026-10-03T00:00Z'), to: at('2026-10-05T00:00Z') },
      { from: at('2026-10-10T00:00Z'), to: at('2026-10-11T00:00Z') },
    ]);

    expect(
      normalizePauses([
        { from: at('2026-10-03T00:00Z'), to: at('2026-10-04T00:00Z') },
        { from: at('2026-10-03T12:00Z'), to: null },
      ]),
    ).toEqual([{ from: at('2026-10-03T00:00Z'), to: null }]);
    expect(normalizePauses()).toEqual([]);
  });

  it('refuses an empty, inverted or invalid pause', () => {
    const t = at('2026-10-03T00:00Z');
    expect(errorCode(() => normalizePauses([{ from: t, to: t }]))).toBe('INVALID_PAUSE');
    expect(errorCode(() => normalizePauses([{ from: t, to: at('2026-10-02T00:00Z') }]))).toBe(
      'INVALID_PAUSE',
    );
    expect(errorCode(() => normalizePauses([{ from: new Date(Number.NaN), to: null }]))).toBe(
      'INVALID_PAUSE',
    );
  });

  it('includes the start of a pause and excludes its end', () => {
    const pauses: Pause[] = [{ from: at('2026-10-03T00:00Z'), to: at('2026-10-04T00:00Z') }];
    expect(isPaused(at('2026-10-02T23:59:59.999Z'), pauses)).toBe(false);
    expect(isPaused(at('2026-10-03T00:00:00.000Z'), pauses)).toBe(true);
    expect(isPaused(at('2026-10-03T23:59:59.999Z'), pauses)).toBe(true);
    expect(isPaused(at('2026-10-04T00:00:00.000Z'), pauses)).toBe(false);
    expect(isPaused(at('2030-01-01T00:00Z'), [{ from: at('2026-10-03T00:00Z'), to: null }])).toBe(
      true,
    );
  });

  it('pushes the end of the course out by every day wholly inside a pause', () => {
    // 10:00 on 4 Oct to 10:00 on 6 Oct, Tashkent: the whole of the 5th is paused, the 4th and 6th only partly.
    const paused: CourseTimeline = {
      ...week,
      pauses: [{ from: at('2026-10-04T05:00Z'), to: at('2026-10-06T05:00Z') }],
    };

    expect([...courseDays(paused)].map((counted) => counted.date)).toEqual([
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
    ]);
    expect(lastCourseDay(paused)).toBe('2026-10-09');
    expect(dateOfCourseDay(paused, 4)).toBe('2026-10-06');
  });

  it('numbers the days around a pause without a gap', () => {
    const paused: CourseTimeline = {
      ...week,
      pauses: [{ from: at('2026-10-04T05:00Z'), to: at('2026-10-06T05:00Z') }],
    };

    expect(courseDayAt(paused, at('2026-10-04T12:00Z'))).toMatchObject({
      state: 'IN_PROGRESS',
      day: 3,
    });
    expect(courseDayAt(paused, at('2026-10-05T10:00Z'))).toEqual({ state: 'PAUSED', daysDone: 3 });
    expect(courseDayAt(paused, at('2026-10-06T12:00Z'))).toMatchObject({
      state: 'IN_PROGRESS',
      day: 4,
    });
    expect(courseDayAt(paused, at('2026-10-09T03:00Z'))).toMatchObject({
      state: 'IN_PROGRESS',
      day: 7,
      remainingDays: 0,
    });
    expect(courseDayAt(paused, at('2026-10-09T19:00Z'))).toEqual({
      state: 'ENDED',
      lastDay: '2026-10-09',
    });
  });

  it('counts a day that is only partly paused', () => {
    // 23 hours 59 minutes: one minute short of covering the 5th.
    const shortOfADay: CourseTimeline = {
      ...week,
      pauses: [{ from: at('2026-10-04T19:00Z'), to: at('2026-10-05T18:59Z') }],
    };
    expect(lastCourseDay(shortOfADay)).toBe('2026-10-08');
  });

  it('skips a day exactly covered from local midnight to local midnight', () => {
    const exactDay: CourseTimeline = {
      ...week,
      pauses: [{ from: at('2026-10-04T19:00Z'), to: at('2026-10-05T19:00Z') }],
    };
    expect([...courseDays(exactDay)].map((counted) => counted.date)).not.toContain('2026-10-05');
    expect(lastCourseDay(exactDay)).toBe('2026-10-09');
  });

  it('treats touching pauses as one, so a day they cover together is skipped', () => {
    const together: CourseTimeline = {
      ...week,
      pauses: [
        { from: at('2026-10-04T19:00Z'), to: at('2026-10-05T07:00Z') },
        { from: at('2026-10-05T07:00Z'), to: at('2026-10-05T19:00Z') },
      ],
    };
    expect(lastCourseDay(together)).toBe('2026-10-09');
  });

  it('leaves the end unknown while the course is still paused', () => {
    const open: CourseTimeline = { ...week, pauses: [{ from: at('2026-10-04T05:00Z'), to: null }] };

    expect([...courseDays(open)].map((counted) => counted.date)).toEqual([
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
    ]);
    expect(lastCourseDay(open)).toBeNull();
    expect(dateOfCourseDay(open, 5)).toBeNull();
    expect(courseDayAt(open, at('2026-10-07T10:00Z'))).toEqual({ state: 'PAUSED', daysDone: 3 });
    expect(courseDayAt(open, at('2026-10-04T08:00Z'))).toMatchObject({
      state: 'IN_PROGRESS',
      day: 3,
    });
  });

  it('survives a pause that starts before day 1 ends and one that swallows the whole start date', () => {
    const swallowed: CourseTimeline = {
      ...week,
      durationDays: 2,
      pauses: [{ from: at('2026-10-01T10:00Z'), to: at('2026-10-02T19:00Z') }],
    };
    expect(courseDayAt(swallowed, at('2026-10-02T05:00Z'))).toEqual({
      state: 'PAUSED',
      daysDone: 0,
    });
    expect(dateOfCourseDay(swallowed, 1)).toBe('2026-10-03');
    expect(lastCourseDay(swallowed)).toBe('2026-10-04');
  });

  it('gives up on a runaway pause instead of looping', () => {
    const forever: CourseTimeline = {
      ...week,
      pauses: [{ from: at('2026-10-02T19:00Z'), to: at('2040-01-01T00:00Z') }],
    };
    expect(errorCode(() => lastCourseDay(forever))).toBe('TIMELINE_TOO_LONG');
  });

  it('measures a day by the clock, so a 23-hour day (clocks forward) is still one whole day', () => {
    const berlin: CourseTimeline = {
      effectiveStartDate: '2026-03-28',
      timezone: BERLIN,
      durationDays: 3,
      // Exactly the 23 hours of 29 March in Berlin.
      pauses: [
        { from: startOfLocalDay('2026-03-29', BERLIN), to: startOfLocalDay('2026-03-30', BERLIN) },
      ],
    };
    expect([...courseDays(berlin)].map((counted) => counted.date)).toEqual([
      '2026-03-28',
      '2026-03-30',
      '2026-03-31',
    ]);
  });
});

describe('counting days (randomised against a minute-by-minute check)', () => {
  it.each([TASHKENT, BERLIN])('in %s: counts exactly the days not wholly paused', (zone) => {
    const random = seeded(zone === TASHKENT ? 7 : 11);
    const startDate = '2026-03-26'; // Berlin's clocks change on the 29th, so DST days are crossed
    const origin = startOfLocalDay(startDate, zone).getTime();
    const minute = 60_000;

    for (let round = 0; round < 60; round += 1) {
      const durationDays = 1 + Math.floor(random() * 12);
      const pauses: Pause[] = Array.from({ length: Math.floor(random() * 4) }, () => {
        const from = origin + Math.floor(random() * 14 * 24 * 60) * minute;
        const length = (30 + Math.floor(random() * 4 * 24 * 60)) * minute;
        return { from: new Date(from), to: new Date(from + length) };
      });
      const timeline: CourseTimeline = {
        effectiveStartDate: startDate,
        timezone: zone,
        durationDays,
        pauses,
      };

      const counted = [...courseDays(timeline)];
      expect(
        counted.map((entry) => entry.day),
        `round ${String(round)}`,
      ).toEqual(Array.from({ length: durationDays }, (_unused, index) => index + 1));

      const countedDates = new Set(counted.map((entry) => entry.date));
      const last = counted.at(-1)?.date ?? startDate;
      const inAnyPause = (ms: number) =>
        pauses.some((p) => ms >= p.from.getTime() && ms < (p.to?.getTime() ?? Infinity));

      for (let date = startDate; date <= last; date = addDays(date, 1)) {
        const dayStart = startOfLocalDay(date, zone).getTime();
        const dayEnd = startOfLocalDay(addDays(date, 1), zone).getTime();
        let wholly = true;
        for (let ms = dayStart; ms < dayEnd && wholly; ms += minute) {
          wholly = inAnyPause(ms);
        }
        expect(
          countedDates.has(date),
          `round ${String(round)}, ${date}, wholly paused: ${String(wholly)}`,
        ).toBe(!wholly);
      }
    }
  });
});
