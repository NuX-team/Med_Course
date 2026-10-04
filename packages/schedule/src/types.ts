import type { LocalTime } from './local-time';

export const MAX_DURATION_DAYS = 365;
/** A safety net on materialisation (ARCHITECTURE §5.2), far above any real course. */
export const MAX_SLOTS = 20_000;

export interface RuleInput {
  readonly id: string;
  readonly localTime: LocalTime;
  /** ISO weekdays, 1 = Monday. Null or absent means every day. */
  readonly daysOfWeek?: readonly number[] | null;
  /** Course days this rule covers inside the medication's own range. Both or neither. */
  readonly dayFrom?: number | null;
  readonly dayTo?: number | null;
}

export interface MedicationInput {
  readonly id: string;
  /** Stable across revisions: the identity of "this drug in this course". */
  readonly lineId: string;
  readonly prn: boolean;
  readonly maxDailyDoses?: number | null;
  readonly minimumIntervalMinutes?: number | null;
  readonly activeFromDay: number;
  readonly activeToDay: number;
  readonly rules: readonly RuleInput[];
}

/** Mirrors `DOSE_STATUSES` in @medcourse/db; a test in that package keeps the two equal. */
export const DOSE_STATUSES = [
  'SCHEDULED',
  'NOTIFIED',
  'SNOOZED',
  'TAKEN',
  'SKIPPED',
  'MISSED',
  'TAKEN_LATE',
  'SUPERSEDED',
] as const;

export type DoseStatus = (typeof DOSE_STATUSES)[number];

/** A dose whose outcome is not decided yet: still to remind, or being reminded. */
export const UNRESOLVED_STATUSES: readonly DoseStatus[] = ['SCHEDULED', 'NOTIFIED', 'SNOOZED'];

export function isUnresolved(status: DoseStatus): boolean {
  return UNRESOLVED_STATUSES.includes(status);
}
