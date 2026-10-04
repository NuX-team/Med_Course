import { ScheduleError } from './errors';

/**
 * How reminders for one course behave (ARCHITECTURE §5.3). Mirrors the `reminder_policies`
 * table and its CHECK constraints. The defaults are proposals awaiting approval (D-9).
 */
export interface ReminderPolicy {
  /** Reminders per slot, the first at the slot time and the rest `retryIntervalMinutes` apart. */
  readonly attempts: number;
  readonly retryIntervalMinutes: number;
  /** After this many minutes from the slot, an unanswered dose is MISSED. */
  readonly missAfterMinutes: number;
  readonly snoozeOptionsMinutes: readonly number[];
  readonly maxSnoozes: number;
  /** How long the patient may change their own answer. A doctor is not bound by it. */
  readonly correctionWindowMinutes: number;
  /** An extra heads-up this long before the slot; 0 means none. */
  readonly leadMinutes: number;
}

export const DEFAULT_REMINDER_POLICY: ReminderPolicy = {
  attempts: 3,
  retryIntervalMinutes: 10,
  missAfterMinutes: 30,
  snoozeOptionsMinutes: [5, 10, 15],
  maxSnoozes: 3,
  correctionWindowMinutes: 60,
  leadMinutes: 0,
};

/** A snoozed reminder must still fire this long before the deadline, or it is pointless. */
export const SNOOZE_MARGIN_MINUTES = 1;

export type PolicyProblem =
  | 'ATTEMPTS_OUT_OF_RANGE'
  | 'RETRY_INTERVAL_OUT_OF_RANGE'
  | 'MISS_AFTER_OUT_OF_RANGE'
  | 'DEADLINE_BEFORE_LAST_ATTEMPT'
  | 'SNOOZE_OPTIONS_INVALID'
  | 'MAX_SNOOZES_OUT_OF_RANGE'
  | 'CORRECTION_WINDOW_OUT_OF_RANGE'
  | 'LEAD_OUT_OF_RANGE';

const between = (value: number, min: number, max: number): boolean =>
  Number.isInteger(value) && value >= min && value <= max;

/** The same rules the database enforces, so a bad policy is caught before it is written. */
export function validateReminderPolicy(policy: ReminderPolicy): PolicyProblem[] {
  const problems: PolicyProblem[] = [];
  if (!between(policy.attempts, 1, 10)) problems.push('ATTEMPTS_OUT_OF_RANGE');
  if (!between(policy.retryIntervalMinutes, 1, 120)) problems.push('RETRY_INTERVAL_OUT_OF_RANGE');
  if (!between(policy.missAfterMinutes, 1, 1440)) problems.push('MISS_AFTER_OUT_OF_RANGE');
  if (
    problems.length === 0 &&
    policy.missAfterMinutes <= (policy.attempts - 1) * policy.retryIntervalMinutes
  ) {
    // The last attempt would fire at or after the deadline and could never be answered in time.
    problems.push('DEADLINE_BEFORE_LAST_ATTEMPT');
  }
  if (
    !between(policy.snoozeOptionsMinutes.length, 1, 5) ||
    !policy.snoozeOptionsMinutes.every((minutes) => between(minutes, 1, 240))
  ) {
    problems.push('SNOOZE_OPTIONS_INVALID');
  }
  if (!between(policy.maxSnoozes, 0, 10)) problems.push('MAX_SNOOZES_OUT_OF_RANGE');
  if (!between(policy.correctionWindowMinutes, 0, 10_080))
    problems.push('CORRECTION_WINDOW_OUT_OF_RANGE');
  if (!between(policy.leadMinutes, 0, 240)) problems.push('LEAD_OUT_OF_RANGE');
  return problems;
}

function assertPolicy(policy: ReminderPolicy): void {
  if (validateReminderPolicy(policy).length > 0) {
    throw new ScheduleError('INVALID_POLICY', 'the reminder policy is not valid');
  }
}

const minutes = (count: number): number => count * 60_000;

/** The moment after which an unanswered dose is MISSED. */
export function deadlineAt(scheduledAt: Date, policy: ReminderPolicy): Date {
  assertPolicy(policy);
  return new Date(scheduledAt.getTime() + minutes(policy.missAfterMinutes));
}

/** When each reminder for a slot is due: the slot time, then every retry interval. */
export function attemptTimes(scheduledAt: Date, policy: ReminderPolicy): Date[] {
  assertPolicy(policy);
  return Array.from(
    { length: policy.attempts },
    (_unused, index) =>
      new Date(scheduledAt.getTime() + minutes(index * policy.retryIntervalMinutes)),
  );
}

/** The optional heads-up before a slot, or `null` when the course has none. */
export function leadReminderAt(scheduledAt: Date, policy: ReminderPolicy): Date | null {
  assertPolicy(policy);
  return policy.leadMinutes === 0
    ? null
    : new Date(scheduledAt.getTime() - minutes(policy.leadMinutes));
}

export interface SnoozeContext {
  readonly now: Date;
  readonly deadlineAt: Date;
  /** How many times this dose has already been snoozed. */
  readonly snoozesUsed: number;
}

/**
 * The "later" buttons to offer right now: only those that still land before the deadline
 * (TZ §7.9), and none once the snooze limit is used up. Never clamps silently: an option that
 * does not fit is simply not offered.
 */
export function availableSnoozeOptions(context: SnoozeContext, policy: ReminderPolicy): number[] {
  assertPolicy(policy);
  if (context.snoozesUsed >= policy.maxSnoozes) {
    return [];
  }
  const latest = context.deadlineAt.getTime() - minutes(SNOOZE_MARGIN_MINUTES);
  return policy.snoozeOptionsMinutes
    .filter((option) => context.now.getTime() + minutes(option) <= latest)
    .sort((a, b) => a - b);
}

/** When the reminder returns after a snooze. Throws `SNOOZE_NOT_ALLOWED` for an option not on offer. */
export function snoozeUntil(
  context: SnoozeContext,
  chosenMinutes: number,
  policy: ReminderPolicy,
): Date {
  if (!availableSnoozeOptions(context, policy).includes(chosenMinutes)) {
    throw new ScheduleError('SNOOZE_NOT_ALLOWED', 'that snooze is not available for this dose');
  }
  return new Date(context.now.getTime() + minutes(chosenMinutes));
}

/** Until when the patient may correct an answer given at `answeredAt`. */
export function correctionWindowEnd(answeredAt: Date, policy: ReminderPolicy): Date {
  assertPolicy(policy);
  return new Date(answeredAt.getTime() + minutes(policy.correctionWindowMinutes));
}
