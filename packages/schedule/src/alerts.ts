import type { DoseStatus } from './types';

/**
 * What the doctor is told when doses are not taken (ARCHITECTURE §8, D-13; TZ §4.1: "notify the
 * doctor of a miss; group repeated notifications after more than two, so as not to create a
 * stream of messages").
 *
 * The unit is a moment of the schedule, not a dose: three drugs due at 08:00 and all left
 * unanswered are one occasion on which the patient did not take their medicine, not three.
 */

/** The run of not-taken moments at which the single escalation message is sent. */
export const SERIES_AT = 3;
/** After the escalation, at most one further summary per this long. */
export const DIGEST_INTERVAL_MS = 6 * 3_600_000;

/** One moment of the schedule and what became of the doses due at it. */
export interface Moment {
  readonly statuses: readonly DoseStatus[];
}

export type MomentOutcome =
  /** At least one dose missed or skipped. */
  | 'NOT_TAKEN'
  /** Nothing missed or skipped, and at least one dose taken (on time or late). */
  | 'TAKEN'
  /** Nothing decided yet (or everything superseded): says nothing either way. */
  | 'OPEN';

export function momentOutcome(moment: Moment): MomentOutcome {
  if (moment.statuses.some((status) => status === 'MISSED' || status === 'SKIPPED')) {
    return 'NOT_TAKEN';
  }
  // A late confirmation ends a run: the patient is answering again.
  return moment.statuses.some((status) => status === 'TAKEN' || status === 'TAKEN_LATE')
    ? 'TAKEN'
    : 'OPEN';
}

/**
 * How many moments in a row, counting back from the newest, were not taken. `moments` are given
 * newest first. A moment with nothing decided is passed over: it neither adds to the run nor
 * ends it.
 */
export function notTakenRun(moments: readonly Moment[]): number {
  let run = 0;
  for (const moment of moments) {
    const outcome = momentOutcome(moment);
    if (outcome === 'TAKEN') {
      break;
    }
    if (outcome === 'NOT_TAKEN') {
      run += 1;
    }
  }
  return run;
}

export type MissAlert =
  /** The first and the second in a run: the doctor is told of each. */
  | 'INDIVIDUAL'
  /** The third in a row: one escalation message instead of a third single one. */
  | 'SERIES'
  /** Beyond that: nothing per moment, only a summary every so often. */
  | 'DIGEST';

/** Which kind of message a not-taken moment calls for, given the run it is the latest of. */
export function missAlertFor(run: number): MissAlert | null {
  if (run < 1) {
    return null;
  }
  if (run < SERIES_AT) {
    return 'INDIVIDUAL';
  }
  return run === SERIES_AT ? 'SERIES' : 'DIGEST';
}

/**
 * When the next summary may go out: not before `now`, and not within `DIGEST_INTERVAL_MS` of the
 * previous escalation or summary.
 */
export function nextDigestAt(now: Date, lastEscalationAt: Date | null): Date {
  if (lastEscalationAt === null) {
    return now;
  }
  const earliest = new Date(lastEscalationAt.getTime() + DIGEST_INTERVAL_MS);
  return earliest > now ? earliest : now;
}

/** What the doctor allowed for an as-needed (PRN) drug, and what has been taken. */
export interface PrnState {
  /** Marks still standing (not taken back) in the last 24 hours, oldest first. */
  readonly recent: readonly Date[];
  readonly maxDailyDoses: number;
  readonly minimumIntervalMinutes: number;
}

export type PrnExcess = 'DAILY_LIMIT' | 'INTERVAL';

/**
 * Whether one more as-needed intake at `now` would go beyond what the doctor prescribed, and
 * from when it would not. "A day" is any 24 hours, not a calendar day: the stricter reading,
 * so that the limit cannot be doubled around midnight. This states the doctor's rule; it is
 * not advice about when to take anything (TZ §7.6).
 */
export function prnCheck(
  state: PrnState,
  now: Date,
): { readonly excess: PrnExcess | null; readonly withinLimitsFrom: Date } {
  const dayAgo = now.getTime() - 24 * 3_600_000;
  const recent = state.recent
    .filter((at) => at.getTime() > dayAgo && at <= now)
    .sort((a, b) => a.getTime() - b.getTime());
  const last = recent.at(-1);

  const afterInterval =
    last === undefined ? now : new Date(last.getTime() + state.minimumIntervalMinutes * 60_000);
  // With the limit used up, the next one fits once the oldest counted mark is a day old.
  const freeing = recent.at(recent.length - state.maxDailyDoses);
  const afterLimit =
    recent.length >= state.maxDailyDoses && freeing !== undefined
      ? new Date(freeing.getTime() + 24 * 3_600_000)
      : now;

  const withinLimitsFrom = [now, afterInterval, afterLimit].reduce((latest, candidate) =>
    candidate > latest ? candidate : latest,
  );
  const excess: PrnExcess | null =
    afterLimit > now ? 'DAILY_LIMIT' : afterInterval > now ? 'INTERVAL' : null;
  return { excess, withinLimitsFrom };
}
