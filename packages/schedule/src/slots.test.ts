import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, isoWeekday, localSecondsOfDay, secondsOfDay } from './local-time';
import { generateSlots, type Slot } from './slots';
import { at, errorCode, seeded } from './test-helpers';
import type { CourseTimeline, Pause } from './timeline';
import type { MedicationInput, RuleInput } from './types';

const TASHKENT = 'Asia/Tashkent';
const BERLIN = 'Europe/Berlin';

const week: CourseTimeline = {
  effectiveStartDate: '2026-10-02', // a Friday
  timezone: TASHKENT,
  durationDays: 7,
};

const rule = (id: string, localTime: string, extra: Partial<RuleInput> = {}): RuleInput => ({
  id,
  localTime,
  ...extra,
});

const med = (
  id: string,
  rules: RuleInput[],
  extra: Partial<MedicationInput> = {},
): MedicationInput => ({
  id,
  lineId: `line-${id}`,
  prn: false,
  activeFromDay: 1,
  activeToDay: 7,
  rules,
  ...extra,
});

const instants = (slots: readonly Slot[]): string[] =>
  slots.map((slot) => slot.scheduledAt.toISOString());

describe('laying a plan out on the calendar', () => {
  it('puts a daily 08:00 dose at 03:00 UTC for every day of a Tashkent course', () => {
    const slots = generateSlots({ medications: [med('a', [rule('r1', '08:00')])], timeline: week });

    expect(instants(slots)).toEqual([
      '2026-10-02T03:00:00.000Z',
      '2026-10-03T03:00:00.000Z',
      '2026-10-04T03:00:00.000Z',
      '2026-10-05T03:00:00.000Z',
      '2026-10-06T03:00:00.000Z',
      '2026-10-07T03:00:00.000Z',
      '2026-10-08T03:00:00.000Z',
    ]);
    expect(slots.map((slot) => slot.courseDay)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(slots.map((slot) => slot.localDate)).toEqual([
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
    ]);
    expect(slots[0]).toMatchObject({ medicationId: 'a', medicationLineId: 'line-a', ruleId: 'r1' });
  });

  it('interleaves several rules in time order', () => {
    const slots = generateSlots({
      medications: [med('a', [rule('evening', '20:00'), rule('morning', '08:00')])],
      timeline: { ...week, durationDays: 2 },
    });

    expect(instants(slots)).toEqual([
      '2026-10-02T03:00:00.000Z',
      '2026-10-02T15:00:00.000Z',
      '2026-10-03T03:00:00.000Z',
      '2026-10-03T15:00:00.000Z',
    ]);
    expect(slots.map((slot) => slot.ruleId)).toEqual(['morning', 'evening', 'morning', 'evening']);
  });

  it('keeps a drug to the days it is prescribed for', () => {
    const slots = generateSlots({
      medications: [med('a', [rule('r1', '08:00')], { activeFromDay: 3, activeToDay: 5 })],
      timeline: week,
    });
    expect(slots.map((slot) => slot.courseDay)).toEqual([3, 4, 5]);
    expect(slots.map((slot) => slot.localDate)).toEqual(['2026-10-04', '2026-10-05', '2026-10-06']);
  });

  it('applies a rule only on its weekdays (Mon, Wed, Fri from a Friday start)', () => {
    const slots = generateSlots({
      medications: [med('a', [rule('r1', '08:00', { daysOfWeek: [1, 3, 5] })])],
      timeline: week,
    });
    expect(slots.map((slot) => slot.localDate)).toEqual(['2026-10-02', '2026-10-05', '2026-10-07']);
    expect(slots.map((slot) => isoWeekday(slot.localDate))).toEqual([5, 1, 3]);
  });

  it('applies a rule only on its own range of days inside the drug’s range', () => {
    const slots = generateSlots({
      medications: [
        med(
          'a',
          [
            rule('first-half', '08:00', { dayFrom: 1, dayTo: 5 }),
            rule('second-half', '20:00', { dayFrom: 6, dayTo: 10 }),
          ],
          { activeToDay: 10 },
        ),
      ],
      timeline: { ...week, durationDays: 10 },
    });

    expect(slots).toHaveLength(10);
    expect(
      slots.filter((slot) => slot.ruleId === 'first-half').map((slot) => slot.courseDay),
    ).toEqual([1, 2, 3, 4, 5]);
    expect(
      slots.filter((slot) => slot.ruleId === 'second-half').map((slot) => slot.courseDay),
    ).toEqual([6, 7, 8, 9, 10]);
  });

  it('produces nothing for an as-needed (PRN) drug', () => {
    const slots = generateSlots({
      medications: [med('prn', [], { prn: true, maxDailyDoses: 3, minimumIntervalMinutes: 240 })],
      timeline: week,
    });
    expect(slots).toEqual([]);
  });

  it('allows two different drugs at the same moment, ordered by drug id', () => {
    const slots = generateSlots({
      medications: [med('zeta', [rule('r', '08:00')]), med('alpha', [rule('r', '08:00')])],
      timeline: { ...week, durationDays: 1 },
    });
    expect(slots.map((slot) => slot.medicationId)).toEqual(['alpha', 'zeta']);
  });

  it('is independent of the order the plan is written in', () => {
    const medications = [
      med('a', [rule('a1', '08:00'), rule('a2', '20:00')]),
      med('b', [rule('b1', '12:00', { daysOfWeek: [1, 5] })]),
      med('c', [rule('c1', '08:00')]),
    ];
    const expected = JSON.stringify(generateSlots({ medications, timeline: week }));

    const random = seeded(3);
    for (let round = 0; round < 20; round += 1) {
      const shuffled = [...medications]
        .sort(() => random() - 0.5)
        .map((medication) => ({
          ...medication,
          rules: [...medication.rules].sort(() => random() - 0.5),
        }));
      expect(JSON.stringify(generateSlots({ medications: shuffled, timeline: week }))).toBe(
        expected,
      );
    }
  });
});

describe('slots that are already in the past when the course starts (D-8)', () => {
  const twiceDaily = [med('a', [rule('morning', '08:00'), rule('evening', '20:00')])];
  const count = (after: Date) => generateSlots({ medications: twiceDaily, timeline: week, after });

  it('creates both doses of day 1 when the course starts before the first one', () => {
    expect(count(at('2026-10-02T02:59:59.999Z'))).toHaveLength(14);
  });

  it('leaves out a slot at exactly the start moment: only strictly later ones count', () => {
    const slots = count(at('2026-10-02T03:00:00.000Z'));
    expect(slots).toHaveLength(13);
    expect(slots[0]?.scheduledAt.toISOString()).toBe('2026-10-02T15:00:00.000Z');
  });

  it('starts the first day with nothing when the tap comes at 23:50', () => {
    const slots = count(at('2026-10-02T18:50:00.000Z'));
    expect(slots).toHaveLength(12);
    expect(slots[0]?.scheduledAt.toISOString()).toBe('2026-10-03T03:00:00.000Z');
    expect(slots.some((slot) => slot.localDate === '2026-10-02')).toBe(false);
  });

  it('keeps course days numbered from the start date, not from the first slot', () => {
    const slots = count(at('2026-10-02T18:50:00.000Z'));
    expect(slots[0]?.courseDay).toBe(2);
  });

  it('creates nothing when the start moment is after the last slot', () => {
    expect(count(at('2026-10-09T00:00:00Z'))).toEqual([]);
  });
});

describe('pauses', () => {
  const daily = [med('a', [rule('r1', '08:00')], { activeToDay: 3 })];
  const threeDays: CourseTimeline = { ...week, durationDays: 3 };

  it('skips a day wholly inside a pause and moves the rest of the course later', () => {
    const pauses: Pause[] = [{ from: at('2026-10-02T19:00Z'), to: at('2026-10-03T19:00Z') }]; // all of 3 Oct
    const slots = generateSlots({ medications: daily, timeline: { ...threeDays, pauses } });

    expect(slots.map((slot) => slot.localDate)).toEqual(['2026-10-02', '2026-10-04', '2026-10-05']);
    expect(slots.map((slot) => slot.courseDay)).toEqual([1, 2, 3]);
  });

  it('drops only the slots inside a pause that covers part of a day', () => {
    const twiceDaily = [
      med('a', [rule('morning', '08:00'), rule('evening', '20:00')], { activeToDay: 2 }),
    ];
    // 12:00 on 3 Oct to 06:00 on 4 Oct, Tashkent: swallows the evening of the 3rd, not the morning.
    const pauses: Pause[] = [{ from: at('2026-10-03T07:00Z'), to: at('2026-10-04T01:00Z') }];
    const slots = generateSlots({
      medications: twiceDaily,
      timeline: { effectiveStartDate: '2026-10-03', timezone: TASHKENT, durationDays: 2, pauses },
    });

    expect(instants(slots)).toEqual([
      '2026-10-03T03:00:00.000Z', // 3 Oct 08:00, before the pause
      '2026-10-04T03:00:00.000Z', // 4 Oct 08:00, after it
      '2026-10-04T15:00:00.000Z', // 4 Oct 20:00
    ]);
  });

  it('includes a slot at the very end of a pause and drops one at its very start', () => {
    // 08:00 on 3 Oct to 08:00 on 4 Oct. The dose at the start is inside the pause, the one at the
    // end is not. Both days are only partly paused, so both still count as days of the course:
    // it ends on the 4th, and the paused dose is not made up (see D-20).
    const pauses: Pause[] = [{ from: at('2026-10-03T03:00Z'), to: at('2026-10-04T03:00Z') }];
    const slots = generateSlots({ medications: daily, timeline: { ...threeDays, pauses } });
    expect(instants(slots)).toEqual(['2026-10-02T03:00:00.000Z', '2026-10-04T03:00:00.000Z']);
    expect(slots.map((slot) => slot.courseDay)).toEqual([1, 3]);
  });

  it('plans only up to an open pause', () => {
    const pauses: Pause[] = [{ from: at('2026-10-03T05:00Z'), to: null }];
    const slots = generateSlots({ medications: daily, timeline: { ...threeDays, pauses } });
    expect(slots.map((slot) => slot.localDate)).toEqual(['2026-10-02', '2026-10-03']);
  });
});

describe('daylight saving', () => {
  const berlin = (startDate: string, durationDays: number): CourseTimeline => ({
    effectiveStartDate: startDate,
    timezone: BERLIN,
    durationDays,
  });

  it('moves a dose scheduled in the skipped hour forward, so it is not lost', () => {
    const slots = generateSlots({
      medications: [med('a', [rule('r1', '02:30')], { activeToDay: 3 })],
      timeline: berlin('2026-03-28', 3),
    });
    expect(instants(slots)).toEqual([
      '2026-03-28T01:30:00.000Z', // 02:30 CET
      '2026-03-29T01:30:00.000Z', // 02:30 does not exist: 03:30 CEST
      '2026-03-30T00:30:00.000Z', // 02:30 CEST
    ]);
  });

  it('keeps one dose when the repeated hour comes round twice', () => {
    const slots = generateSlots({
      medications: [med('a', [rule('r1', '02:30')], { activeToDay: 3 })],
      timeline: berlin('2026-10-24', 3),
    });
    expect(instants(slots)).toEqual([
      '2026-10-24T00:30:00.000Z',
      '2026-10-25T00:30:00.000Z', // first of the two 02:30s
      '2026-10-26T01:30:00.000Z',
    ]);
  });

  it('refuses a plan in which the clock change makes one drug due twice at once', () => {
    // 02:30 and 03:30 both land on 03:30 CEST on the day the clocks go forward.
    const medications = [med('a', [rule('r1', '02:30'), rule('r2', '03:30')], { activeToDay: 3 })];
    expect(errorCode(() => generateSlots({ medications, timeline: berlin('2026-03-28', 3) }))).toBe(
      'DUPLICATE_SLOT',
    );
    expect(generateSlots({ medications, timeline: berlin('2026-04-10', 3) })).toHaveLength(6);
  });

  it('keeps the wall-clock time through a whole year of clock changes', () => {
    const slots = generateSlots({
      medications: [med('a', [rule('r1', '08:00')], { activeToDay: 365 })],
      timeline: berlin('2026-01-01', 365),
    });

    expect(slots).toHaveLength(365);
    expect(slots.every((slot) => localSecondsOfDay(slot.scheduledAt, BERLIN) === 8 * 3600)).toBe(
      true,
    );
    expect(new Set(slots.map((slot) => slot.scheduledAt.getUTCHours()))).toEqual(new Set([6, 7]));
  });
});

describe('plans that cannot be laid out', () => {
  it('refuses a drug due twice at the same moment', () => {
    const medications = [med('a', [rule('r1', '08:00'), rule('r2', '08:00')])];
    expect(errorCode(() => generateSlots({ medications, timeline: week }))).toBe('DUPLICATE_SLOT');
    try {
      generateSlots({ medications, timeline: week });
    } catch (error) {
      expect(error).toMatchObject({ details: { medicationId: 'a' } });
    }
  });

  it('allows the same time when the rules never overlap in days or weekdays', () => {
    const byRange = [
      med('a', [
        rule('early', '08:00', { dayFrom: 1, dayTo: 3 }),
        rule('late', '08:00', { dayFrom: 4, dayTo: 7 }),
      ]),
    ];
    const byWeekday = [
      med('a', [
        rule('mwf', '08:00', { daysOfWeek: [1, 3, 5] }),
        rule('tts', '08:00', { daysOfWeek: [2, 4, 6, 7] }),
      ]),
    ];
    expect(generateSlots({ medications: byRange, timeline: week })).toHaveLength(7);
    expect(generateSlots({ medications: byWeekday, timeline: week })).toHaveLength(7);
  });

  it('stops at the slot limit', () => {
    const medications = [med('a', [rule('r1', '08:00')])];
    expect(errorCode(() => generateSlots({ medications, timeline: week, maxSlots: 6 }))).toBe(
      'TOO_MANY_SLOTS',
    );
    expect(generateSlots({ medications, timeline: week, maxSlots: 7 })).toHaveLength(7);
  });

  it('refuses an unknown zone or a bad start date', () => {
    const medications = [med('a', [rule('r1', '08:00')])];
    expect(
      errorCode(() => generateSlots({ medications, timeline: { ...week, timezone: 'nope' } })),
    ).toBe('INVALID_TIME_ZONE');
    expect(
      errorCode(() =>
        generateSlots({ medications, timeline: { ...week, effectiveStartDate: 'soon' } }),
      ),
    ).toBe('INVALID_DATE');
  });
});

/**
 * Tashkent has been UTC+5 all year since 1991, so an independent oracle needs no time zone
 * library at all: plain UTC arithmetic. If the slot generator and the oracle disagree, one of
 * them has an off-by-one.
 */
describe('against an oracle built from plain UTC arithmetic (randomised)', () => {
  const OFFSET_MS = 5 * 3_600_000;
  const TIMES = ['00:00', '06:00', '08:00', '12:30', '20:00', '22:15', '23:59'];

  function expectedKeys(
    medications: readonly MedicationInput[],
    durationDays: number,
    after: Date | undefined,
  ): string[] {
    const keys: string[] = [];
    for (let day = 1; day <= durationDays; day += 1) {
      const midnightUtc = Date.UTC(2026, 9, 2 + day - 1);
      const weekday = ((new Date(midnightUtc).getUTCDay() + 6) % 7) + 1;
      for (const medication of medications) {
        if (medication.prn || day < medication.activeFromDay || day > medication.activeToDay)
          continue;
        for (const r of medication.rules) {
          if (
            day < (r.dayFrom ?? medication.activeFromDay) ||
            day > (r.dayTo ?? medication.activeToDay)
          )
            continue;
          if (r.daysOfWeek && !r.daysOfWeek.includes(weekday)) continue;
          const instant = midnightUtc + secondsOfDay(r.localTime) * 1000 - OFFSET_MS;
          if (after && instant <= after.getTime()) continue;
          keys.push(`${medication.lineId}|${String(instant)}`);
        }
      }
    }
    return keys.sort();
  }

  it('lays out 300 random plans exactly as the oracle does', () => {
    const random = seeded(2026);
    for (let round = 0; round < 300; round += 1) {
      const durationDays = 1 + Math.floor(random() * 20);
      const medications: MedicationInput[] = Array.from(
        { length: 1 + Math.floor(random() * 3) },
        (_unused, index) => {
          const from = 1 + Math.floor(random() * durationDays);
          const to = from + Math.floor(random() * (durationDays - from + 1));
          const times = [...TIMES].sort(() => random() - 0.5).slice(0, Math.floor(random() * 4));
          return med(
            `m${String(index)}`,
            times.map((time, ruleIndex): RuleInput => {
              const useRange = random() < 0.3;
              const rangeFrom = from + Math.floor(random() * (to - from + 1));
              const weekdays = [1, 2, 3, 4, 5, 6, 7].filter(() => random() < 0.5);
              return {
                id: `m${String(index)}r${String(ruleIndex)}`,
                localTime: time,
                daysOfWeek: random() < 0.3 && weekdays.length > 0 ? weekdays : null,
                dayFrom: useRange ? rangeFrom : null,
                dayTo: useRange ? rangeFrom + Math.floor(random() * (to - rangeFrom + 1)) : null,
              };
            }),
            { activeFromDay: from, activeToDay: to },
          );
        },
      );
      const after =
        random() < 0.5
          ? undefined
          : new Date(
              Date.UTC(2026, 9, 1, 19) + Math.floor(random() * (durationDays + 1) * 86_400_000),
            );
      const timeline: CourseTimeline = { ...week, durationDays };
      const slots = generateSlots({
        medications: medications,
        timeline,
        ...(after ? { after } : {}),
      });

      const actual = slots
        .map((slot) => `${slot.medicationLineId}|${String(slot.scheduledAt.getTime())}`)
        .sort();
      expect(actual, `round ${String(round)}`).toEqual(
        expectedKeys(medications, durationDays, after),
      );

      // Structural invariants, whatever the plan.
      for (let index = 1; index < slots.length; index += 1) {
        expect(slots[index - 1]?.scheduledAt.getTime() ?? 0).toBeLessThanOrEqual(
          slots[index]?.scheduledAt.getTime() ?? 0,
        );
      }
      for (const slot of slots) {
        expect(slot.courseDay).toBe(daysBetween('2026-10-02', slot.localDate) + 1);
        expect(addDays('2026-10-02', slot.courseDay - 1)).toBe(slot.localDate);
        if (after) expect(slot.scheduledAt.getTime()).toBeGreaterThan(after.getTime());
      }
    }
  });
});
