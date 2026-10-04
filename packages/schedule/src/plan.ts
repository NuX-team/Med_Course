import { ScheduleError } from './errors';
import { isValidLocalTime, isValidTimeZone, type LocalDate } from './local-time';
import { generateSlots } from './slots';
import { MAX_DURATION_DAYS, type MedicationInput } from './types';

export { MAX_DURATION_DAYS, MAX_SLOTS } from './types';
export type { MedicationInput, RuleInput } from './types';

export type PlanProblemCode =
  | 'DURATION_OUT_OF_RANGE'
  | 'INVALID_TIME_ZONE'
  | 'NO_MEDICATIONS'
  | 'DUPLICATE_ID'
  | 'MEDICATION_DAYS_INVALID'
  | 'MEDICATION_OUTSIDE_COURSE'
  | 'PRN_LIMITS_MISSING'
  | 'PRN_HAS_SCHEDULE'
  | 'NO_SCHEDULE'
  | 'RULE_TIME_INVALID'
  | 'RULE_WEEKDAYS_INVALID'
  | 'RULE_DAYS_INVALID'
  | 'RULE_OUTSIDE_MEDICATION'
  | 'DUPLICATE_SLOT'
  | 'TOO_MANY_SLOTS';

/** One thing wrong with a plan. The UI turns `code` into words in the user's language. */
export interface PlanProblem {
  readonly code: PlanProblemCode;
  readonly medicationId?: string;
  readonly ruleId?: string;
}

function problem(code: PlanProblemCode, medicationId?: string, ruleId?: string): PlanProblem {
  return {
    code,
    ...(medicationId === undefined ? {} : { medicationId }),
    ...(ruleId === undefined ? {} : { ruleId }),
  };
}

const isPositiveInteger = (value: number | null | undefined): value is number =>
  value !== null && value !== undefined && Number.isInteger(value) && value >= 1;

function weekdaysValid(days: readonly number[]): boolean {
  return (
    days.length >= 1 &&
    days.length <= 7 &&
    days.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)
  );
}

/**
 * Everything wrong with a plan, all at once (TZ §15: say which field to fix). An empty list
 * means the plan can be materialised. The structural rules mirror the database constraints;
 * the slot-level ones (two rules landing on one moment, an absurd number of slots) can only
 * be found by actually laying the plan out, which is done last and only for a sound plan.
 */
export function validatePlan(plan: {
  readonly durationDays: number;
  readonly timezone: string;
  readonly medications: readonly MedicationInput[];
  /**
   * Where to lay the plan out for the slot-level checks. The real start date is not known while
   * the doctor is still drafting, so the default is an arbitrary date. That is exact for zones
   * without daylight saving (all of Uzbekistan); in other zones a clash that only a clock change
   * creates surfaces when the plan is materialised, as a `DUPLICATE_SLOT` error.
   */
  readonly referenceStartDate?: LocalDate;
}): PlanProblem[] {
  const problems: PlanProblem[] = [];

  const durationValid =
    Number.isInteger(plan.durationDays) &&
    plan.durationDays >= 1 &&
    plan.durationDays <= MAX_DURATION_DAYS;
  if (!durationValid) {
    problems.push(problem('DURATION_OUT_OF_RANGE'));
  }
  if (!isValidTimeZone(plan.timezone)) {
    problems.push(problem('INVALID_TIME_ZONE'));
  }
  if (plan.medications.length === 0) {
    problems.push(problem('NO_MEDICATIONS'));
  }

  const seenMedications = new Set<string>();
  const seenLines = new Set<string>();
  const seenRules = new Set<string>();

  for (const medication of plan.medications) {
    const id = medication.id;
    if (seenMedications.has(id) || seenLines.has(medication.lineId)) {
      problems.push(problem('DUPLICATE_ID', id));
    }
    seenMedications.add(id);
    seenLines.add(medication.lineId);

    const rangeValid =
      isPositiveInteger(medication.activeFromDay) &&
      isPositiveInteger(medication.activeToDay) &&
      medication.activeToDay >= medication.activeFromDay;
    if (!rangeValid) {
      problems.push(problem('MEDICATION_DAYS_INVALID', id));
    } else if (durationValid && medication.activeToDay > plan.durationDays) {
      problems.push(problem('MEDICATION_OUTSIDE_COURSE', id));
    }

    if (medication.prn) {
      if (
        !isPositiveInteger(medication.maxDailyDoses) ||
        !isPositiveInteger(medication.minimumIntervalMinutes)
      ) {
        problems.push(problem('PRN_LIMITS_MISSING', id));
      }
      if (medication.rules.length > 0) {
        problems.push(problem('PRN_HAS_SCHEDULE', id));
      }
      continue;
    }

    if (medication.rules.length === 0) {
      problems.push(problem('NO_SCHEDULE', id));
    }
    for (const rule of medication.rules) {
      if (seenRules.has(rule.id)) {
        problems.push(problem('DUPLICATE_ID', id, rule.id));
      }
      seenRules.add(rule.id);

      if (!isValidLocalTime(rule.localTime)) {
        problems.push(problem('RULE_TIME_INVALID', id, rule.id));
      }
      if (
        rule.daysOfWeek !== null &&
        rule.daysOfWeek !== undefined &&
        !weekdaysValid(rule.daysOfWeek)
      ) {
        problems.push(problem('RULE_WEEKDAYS_INVALID', id, rule.id));
      }

      const hasFrom = rule.dayFrom !== null && rule.dayFrom !== undefined;
      const hasTo = rule.dayTo !== null && rule.dayTo !== undefined;
      if (
        hasFrom !== hasTo ||
        (hasFrom &&
          (!isPositiveInteger(rule.dayFrom) ||
            !isPositiveInteger(rule.dayTo) ||
            rule.dayTo < rule.dayFrom))
      ) {
        problems.push(problem('RULE_DAYS_INVALID', id, rule.id));
      } else if (
        hasFrom &&
        rangeValid &&
        isPositiveInteger(rule.dayFrom) &&
        isPositiveInteger(rule.dayTo) &&
        (rule.dayFrom < medication.activeFromDay || rule.dayTo > medication.activeToDay)
      ) {
        problems.push(problem('RULE_OUTSIDE_MEDICATION', id, rule.id));
      }
    }
  }

  if (problems.length > 0) {
    return problems;
  }

  try {
    generateSlots({
      medications: plan.medications,
      timeline: {
        effectiveStartDate: plan.referenceStartDate ?? '2026-01-01',
        timezone: plan.timezone,
        durationDays: plan.durationDays,
      },
    });
  } catch (error) {
    if (error instanceof ScheduleError && error.code === 'DUPLICATE_SLOT') {
      return [problem('DUPLICATE_SLOT', error.details.medicationId)];
    }
    if (error instanceof ScheduleError && error.code === 'TOO_MANY_SLOTS') {
      return [problem('TOO_MANY_SLOTS')];
    }
    throw error;
  }
  return [];
}
