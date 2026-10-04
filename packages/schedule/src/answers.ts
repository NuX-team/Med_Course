/**
 * How early a patient may mark a dose as taken, from the "Today" screen, before its slot
 * (ARCHITECTURE §6.2). Further ahead than this it is treated as a mistap.
 */
export const EARLY_MARK_WINDOW_MINUTES = 60;

export type AnswerTiming = 'TOO_EARLY' | 'ON_TIME' | 'LATE';

export interface AnswerTimingInput {
  readonly now: Date;
  readonly scheduledAt: Date;
  readonly deadlineAt: Date;
}

/**
 * Where an answer falls relative to a dose. The boundaries are exact and belong to the later
 * side of each: at the early limit it is on time, and at the deadline itself it is already late
 * (a dose is MISSED from `deadlineAt`, so an answer at that instant cannot be "on time").
 * A late answer does not erase the miss; the use case records MISSED first and then LATE_TAKEN.
 */
export function classifyAnswer(
  { now, scheduledAt, deadlineAt }: AnswerTimingInput,
  earlyWindowMinutes: number = EARLY_MARK_WINDOW_MINUTES,
): AnswerTiming {
  if (now.getTime() < scheduledAt.getTime() - earlyWindowMinutes * 60_000) {
    return 'TOO_EARLY';
  }
  return now.getTime() < deadlineAt.getTime() ? 'ON_TIME' : 'LATE';
}

/** True from the deadline onward: the sweeper may turn an unanswered dose into MISSED. */
export function isOverdue(deadlineAt: Date, now: Date): boolean {
  return now.getTime() >= deadlineAt.getTime();
}
