import { describe, expect, it } from 'vitest';
import { validatePlan, type PlanProblem } from './plan';
import type { MedicationInput, RuleInput } from './types';

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

const valid = {
  durationDays: 7,
  timezone: 'Asia/Tashkent',
  medications: [med('a', [rule('r1', '08:00')])],
};

const codes = (problems: readonly PlanProblem[]): string[] =>
  problems.map((problem) => problem.code);

describe('validatePlan', () => {
  it('accepts a sound plan', () => {
    expect(validatePlan(valid)).toEqual([]);
  });

  it('accepts a sound plan with a scheduled drug and an as-needed one', () => {
    const plan = {
      ...valid,
      medications: [
        med('a', [rule('r1', '08:00'), rule('r2', '20:00', { daysOfWeek: [1, 2, 3] })]),
        med('p', [], { prn: true, maxDailyDoses: 3, minimumIntervalMinutes: 240 }),
      ],
    };
    expect(validatePlan(plan)).toEqual([]);
  });

  describe('the course', () => {
    it.each([0, 366, 1.5, -3, Number.NaN])('rejects a duration of %s days', (durationDays) => {
      expect(codes(validatePlan({ ...valid, durationDays }))).toContain('DURATION_OUT_OF_RANGE');
    });

    it.each([1, 365])('accepts a duration of %s', (durationDays) => {
      expect(
        validatePlan({
          ...valid,
          durationDays,
          medications: [med('a', [rule('r1', '08:00')], { activeToDay: durationDays })],
        }),
      ).toEqual([]);
    });

    it('rejects an unknown zone and a fixed offset', () => {
      expect(codes(validatePlan({ ...valid, timezone: 'Nowhere/Land' }))).toEqual([
        'INVALID_TIME_ZONE',
      ]);
      expect(codes(validatePlan({ ...valid, timezone: '+05:00' }))).toEqual(['INVALID_TIME_ZONE']);
    });

    it('rejects a plan with no drugs', () => {
      expect(codes(validatePlan({ ...valid, medications: [] }))).toEqual(['NO_MEDICATIONS']);
    });
  });

  describe('a drug', () => {
    const only = (medication: MedicationInput): PlanProblem[] =>
      validatePlan({ ...valid, medications: [medication] });

    it('must be active on a sensible range of days inside the course', () => {
      expect(codes(only(med('a', [rule('r', '08:00')], { activeFromDay: 0 })))).toEqual([
        'MEDICATION_DAYS_INVALID',
      ]);
      expect(
        codes(only(med('a', [rule('r', '08:00')], { activeFromDay: 5, activeToDay: 4 }))),
      ).toEqual(['MEDICATION_DAYS_INVALID']);
      expect(codes(only(med('a', [rule('r', '08:00')], { activeToDay: 2.5 })))).toEqual([
        'MEDICATION_DAYS_INVALID',
      ]);
      expect(codes(only(med('a', [rule('r', '08:00')], { activeToDay: 8 })))).toEqual([
        'MEDICATION_OUTSIDE_COURSE',
      ]);
    });

    it('needs a schedule unless it is as-needed', () => {
      expect(only(med('a', []))).toEqual([{ code: 'NO_SCHEDULE', medicationId: 'a' }]);
    });

    it('as-needed drugs need both limits and may not be scheduled', () => {
      const prn = (extra: Partial<MedicationInput>) => only(med('p', [], { prn: true, ...extra }));

      expect(codes(prn({}))).toEqual(['PRN_LIMITS_MISSING']);
      expect(codes(prn({ maxDailyDoses: 3 }))).toEqual(['PRN_LIMITS_MISSING']);
      expect(codes(prn({ minimumIntervalMinutes: 240 }))).toEqual(['PRN_LIMITS_MISSING']);
      expect(codes(prn({ maxDailyDoses: 0, minimumIntervalMinutes: 240 }))).toEqual([
        'PRN_LIMITS_MISSING',
      ]);
      expect(codes(prn({ maxDailyDoses: 3, minimumIntervalMinutes: 1.5 }))).toEqual([
        'PRN_LIMITS_MISSING',
      ]);
      expect(prn({ maxDailyDoses: 3, minimumIntervalMinutes: 240 })).toEqual([]);

      const scheduled = only(
        med('p', [rule('r', '08:00')], {
          prn: true,
          maxDailyDoses: 3,
          minimumIntervalMinutes: 240,
        }),
      );
      expect(scheduled).toEqual([{ code: 'PRN_HAS_SCHEDULE', medicationId: 'p' }]);
    });

    it('must have unique ids across the plan', () => {
      const clash = validatePlan({
        ...valid,
        medications: [med('a', [rule('r1', '08:00')]), med('a', [rule('r2', '09:00')])],
      });
      expect(codes(clash)).toContain('DUPLICATE_ID');

      const sameLine = validatePlan({
        ...valid,
        medications: [
          med('a', [rule('r1', '08:00')], { lineId: 'shared' }),
          med('b', [rule('r2', '09:00')], { lineId: 'shared' }),
        ],
      });
      expect(codes(sameLine)).toEqual(['DUPLICATE_ID']);

      const sameRule = validatePlan({
        ...valid,
        medications: [med('a', [rule('r', '08:00')]), med('b', [rule('r', '09:00')])],
      });
      expect(sameRule).toEqual([{ code: 'DUPLICATE_ID', medicationId: 'b', ruleId: 'r' }]);
    });
  });

  describe('a rule', () => {
    const only = (r: RuleInput, extra: Partial<MedicationInput> = {}): PlanProblem[] =>
      validatePlan({ ...valid, medications: [med('a', [r], extra)] });

    it.each(['25:00', '8:00', '12:60', 'noon', ''])('rejects the time %j', (localTime) => {
      expect(only(rule('r', localTime))).toEqual([
        { code: 'RULE_TIME_INVALID', medicationId: 'a', ruleId: 'r' },
      ]);
    });

    it.each([[[]], [[0]], [[8]], [[1.5]], [[1, 2, 3, 4, 5, 6, 7, 1]]])(
      'rejects the weekdays %j',
      (daysOfWeek) => {
        expect(only(rule('r', '08:00', { daysOfWeek }))).toEqual([
          { code: 'RULE_WEEKDAYS_INVALID', medicationId: 'a', ruleId: 'r' },
        ]);
      },
    );

    it('takes either all weekdays or none', () => {
      expect(only(rule('r', '08:00', { daysOfWeek: null }))).toEqual([]);
      expect(only(rule('r', '08:00', { daysOfWeek: [1, 2, 3, 4, 5, 6, 7] }))).toEqual([]);
    });

    it('needs a day range with both ends, in order', () => {
      const invalid = { code: 'RULE_DAYS_INVALID', medicationId: 'a', ruleId: 'r' };
      expect(only(rule('r', '08:00', { dayFrom: 2 }))).toEqual([invalid]);
      expect(only(rule('r', '08:00', { dayTo: 2 }))).toEqual([invalid]);
      expect(only(rule('r', '08:00', { dayFrom: 4, dayTo: 3 }))).toEqual([invalid]);
      expect(only(rule('r', '08:00', { dayFrom: 0, dayTo: 3 }))).toEqual([invalid]);
      expect(only(rule('r', '08:00', { dayFrom: 2, dayTo: 3 }))).toEqual([]);
    });

    it('stays inside the drug’s own days', () => {
      const outside = { code: 'RULE_OUTSIDE_MEDICATION', medicationId: 'a', ruleId: 'r' };
      expect(
        only(rule('r', '08:00', { dayFrom: 1, dayTo: 5 }), { activeFromDay: 2, activeToDay: 5 }),
      ).toEqual([outside]);
      expect(
        only(rule('r', '08:00', { dayFrom: 2, dayTo: 6 }), { activeFromDay: 2, activeToDay: 5 }),
      ).toEqual([outside]);
      expect(
        only(rule('r', '08:00', { dayFrom: 2, dayTo: 5 }), { activeFromDay: 2, activeToDay: 5 }),
      ).toEqual([]);
    });
  });

  describe('laying the plan out', () => {
    it('finds two rules that put one drug at the same moment, and says which drug', () => {
      const plan = {
        ...valid,
        medications: [med('a', [rule('r1', '08:00'), rule('r2', '08:00')])],
      };
      expect(validatePlan(plan)).toEqual([{ code: 'DUPLICATE_SLOT', medicationId: 'a' }]);
    });

    it('lets the same time repeat when the rules never meet', () => {
      const plan = {
        ...valid,
        medications: [
          med('a', [
            rule('r1', '08:00', { daysOfWeek: [1, 3, 5] }),
            rule('r2', '08:00', { daysOfWeek: [2, 4, 6, 7] }),
          ]),
        ],
      };
      expect(validatePlan(plan)).toEqual([]);
    });

    it('rejects a plan that would produce an absurd number of doses', () => {
      // A dose every 20 minutes, all year: 72 a day for 365 days is over the 20 000 limit.
      const everyTwentyMinutes = Array.from({ length: 72 }, (_unused, index) => {
        const minutes = index * 20;
        const time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
        return rule(`r${String(index)}`, time);
      });
      const plan = {
        durationDays: 365,
        timezone: 'Asia/Tashkent',
        medications: [med('a', everyTwentyMinutes, { activeToDay: 365 })],
      };
      expect(validatePlan(plan)).toEqual([{ code: 'TOO_MANY_SLOTS' }]);
      // The slowest case in the unit suite: it needs room when the machine is busy.
    }, 20_000);

    it('finds a clash that only a clock change creates, when given a date where it happens', () => {
      const plan = {
        durationDays: 3,
        timezone: 'Europe/Berlin',
        medications: [med('a', [rule('r1', '02:30'), rule('r2', '03:30')], { activeToDay: 3 })],
      };
      expect(validatePlan(plan)).toEqual([]);
      expect(validatePlan({ ...plan, referenceStartDate: '2026-03-28' })).toEqual([
        { code: 'DUPLICATE_SLOT', medicationId: 'a' },
      ]);
    });
  });

  it('reports every problem at once', () => {
    const problems = validatePlan({
      durationDays: 0,
      timezone: 'nope',
      medications: [
        med('a', [rule('r1', '99:99', { daysOfWeek: [9] })], { activeToDay: 0 }),
        med('b', []),
      ],
    });
    expect(codes(problems).sort()).toEqual(
      [
        'DURATION_OUT_OF_RANGE',
        'INVALID_TIME_ZONE',
        'MEDICATION_DAYS_INVALID',
        'RULE_TIME_INVALID',
        'RULE_WEEKDAYS_INVALID',
        'NO_SCHEDULE',
      ].sort(),
    );
  });

  it('does not try to lay out a plan that is already broken', () => {
    // An invalid time would make slot generation throw; the validator must report, not throw.
    expect(() =>
      validatePlan({ ...valid, medications: [med('a', [rule('r1', '99:99')])] }),
    ).not.toThrow();
  });
});
