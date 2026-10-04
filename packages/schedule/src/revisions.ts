import type { Slot } from './slots';
import { isUnresolved, type DoseStatus } from './types';

export interface ExistingDose {
  readonly id: string;
  readonly scheduledAt: Date;
  readonly deadlineAt: Date;
  readonly status: DoseStatus;
}

/** What becomes of the doses still waiting for an answer when the plan they belong to stops. */
export interface RetirePlan {
  /** Open doses whose deadline is still ahead: they no longer apply and are not counted. */
  readonly supersede: readonly string[];
  /** Open doses whose deadline had already passed: they were missed before anything changed. */
  readonly miss: readonly string[];
}

export interface RevisionSwitchPlan extends RetirePlan {
  /** Slots of the new plan to materialise. */
  readonly create: readonly Slot[];
}

/**
 * The cut that a pause, a cancellation and a change of plan all make (ARCHITECTURE §5.4, §5.5).
 * From `now` on, nothing of the old plan may be asked of the patient:
 *
 * - a dose with an outcome (taken, skipped, missed, taken late) is history and is never touched;
 * - an open dose whose deadline has passed is a miss, whether or not the sweeper got to it yet;
 * - every other open dose is superseded, including one being reminded right now. A reminder
 *   for a plan the doctor has just stopped or replaced is worse than a dose left uncounted.
 *
 * Exactly at the deadline a dose is already a miss, as everywhere else.
 */
export function planRetire(input: {
  readonly existing: readonly ExistingDose[];
  readonly now: Date;
}): RetirePlan {
  const open = input.existing
    .filter((dose) => isUnresolved(dose.status))
    .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
  return {
    supersede: open.filter((dose) => dose.deadlineAt > input.now).map((dose) => dose.id),
    miss: open.filter((dose) => dose.deadlineAt <= input.now).map((dose) => dose.id),
  };
}

/**
 * What changes when a plan is replaced by a new revision: the old plan is retired as above, and
 * the new one is laid out strictly after `now`. A slot of the new plan at or before `now` is not
 * created, even if the dose it would replace has just been superseded: the past is never filled
 * in afterwards. A slot identical to a superseded dose is created anew (a superseded slot is free).
 */
export function planRevisionSwitch(input: {
  readonly existing: readonly ExistingDose[];
  readonly newSlots: readonly Slot[];
  readonly now: Date;
}): RevisionSwitchPlan {
  return {
    ...planRetire(input),
    create: input.newSlots.filter((slot) => slot.scheduledAt > input.now),
  };
}

/** What a pause does to the doses already laid out: the same cut, with nothing created. */
export function planPause(input: {
  readonly existing: readonly ExistingDose[];
  readonly now: Date;
}): RetirePlan {
  return planRetire(input);
}
