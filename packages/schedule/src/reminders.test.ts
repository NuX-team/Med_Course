import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REMINDER_POLICY,
  attemptTimes,
  availableSnoozeOptions,
  correctionWindowEnd,
  deadlineAt,
  leadReminderAt,
  snoozeUntil,
  validateReminderPolicy,
  type PolicyProblem,
  type ReminderPolicy,
} from './reminders';
import { at, errorCode } from './test-helpers';

const policy = (extra: Partial<ReminderPolicy> = {}): ReminderPolicy => ({
  ...DEFAULT_REMINDER_POLICY,
  ...extra,
});
const SLOT = at('2026-10-02T03:00:00Z');

describe('the default policy (D-9)', () => {
  it('is the one proposed in the architecture and is itself valid', () => {
    expect(DEFAULT_REMINDER_POLICY).toEqual({
      attempts: 3,
      retryIntervalMinutes: 10,
      missAfterMinutes: 30,
      snoozeOptionsMinutes: [5, 10, 15],
      maxSnoozes: 3,
      correctionWindowMinutes: 60,
      leadMinutes: 0,
    });
    expect(validateReminderPolicy(DEFAULT_REMINDER_POLICY)).toEqual([]);
  });
});

describe('validateReminderPolicy', () => {
  const problems = (extra: Partial<ReminderPolicy>): PolicyProblem[] =>
    validateReminderPolicy(policy(extra));

  it.each([
    [{ attempts: 0 }, 'ATTEMPTS_OUT_OF_RANGE'],
    [{ attempts: 11 }, 'ATTEMPTS_OUT_OF_RANGE'],
    [{ attempts: 2.5 }, 'ATTEMPTS_OUT_OF_RANGE'],
    [{ retryIntervalMinutes: 0 }, 'RETRY_INTERVAL_OUT_OF_RANGE'],
    [{ retryIntervalMinutes: 121 }, 'RETRY_INTERVAL_OUT_OF_RANGE'],
    [{ missAfterMinutes: 0 }, 'MISS_AFTER_OUT_OF_RANGE'],
    [{ missAfterMinutes: 1441 }, 'MISS_AFTER_OUT_OF_RANGE'],
    [{ snoozeOptionsMinutes: [] }, 'SNOOZE_OPTIONS_INVALID'],
    [{ snoozeOptionsMinutes: [1, 2, 3, 4, 5, 6] }, 'SNOOZE_OPTIONS_INVALID'],
    [{ snoozeOptionsMinutes: [5, 0] }, 'SNOOZE_OPTIONS_INVALID'],
    [{ snoozeOptionsMinutes: [5, 241] }, 'SNOOZE_OPTIONS_INVALID'],
    [{ maxSnoozes: -1 }, 'MAX_SNOOZES_OUT_OF_RANGE'],
    [{ maxSnoozes: 11 }, 'MAX_SNOOZES_OUT_OF_RANGE'],
    [{ correctionWindowMinutes: -1 }, 'CORRECTION_WINDOW_OUT_OF_RANGE'],
    [{ correctionWindowMinutes: 10_081 }, 'CORRECTION_WINDOW_OUT_OF_RANGE'],
    [{ leadMinutes: -1 }, 'LEAD_OUT_OF_RANGE'],
    [{ leadMinutes: 241 }, 'LEAD_OUT_OF_RANGE'],
  ] as const)('rejects %j', (extra, expected) => {
    expect(problems(extra)).toEqual([expected]);
  });

  it.each([
    { attempts: 1 },
    { attempts: 10, retryIntervalMinutes: 1, missAfterMinutes: 10 },
    { retryIntervalMinutes: 120, attempts: 1 },
    { missAfterMinutes: 1440, attempts: 10, retryIntervalMinutes: 120 },
    { snoozeOptionsMinutes: [240] },
    { maxSnoozes: 0 },
    { maxSnoozes: 10 },
    { correctionWindowMinutes: 0 },
    { leadMinutes: 240 },
  ])('accepts the edge %j', (extra) => {
    expect(problems(extra)).toEqual([]);
  });

  it('requires the deadline to fall after the last attempt', () => {
    // Attempts at +0, +10, +20: a deadline at +20 would leave the last one no time to be answered.
    expect(problems({ missAfterMinutes: 20 })).toEqual(['DEADLINE_BEFORE_LAST_ATTEMPT']);
    expect(problems({ missAfterMinutes: 19 })).toEqual(['DEADLINE_BEFORE_LAST_ATTEMPT']);
    expect(problems({ missAfterMinutes: 21 })).toEqual([]);
    expect(problems({ attempts: 1, missAfterMinutes: 1 })).toEqual([]);
  });

  it('agrees with the database check on the deadline for every combination', () => {
    for (let attempts = 1; attempts <= 10; attempts += 1) {
      for (const retryIntervalMinutes of [1, 10, 60, 120]) {
        for (const missAfterMinutes of [1, 9, 10, 11, 30, 600, 1440]) {
          const databaseWouldAccept = missAfterMinutes > (attempts - 1) * retryIntervalMinutes;
          const accepted = !problems({ attempts, retryIntervalMinutes, missAfterMinutes }).includes(
            'DEADLINE_BEFORE_LAST_ATTEMPT',
          );
          expect(
            accepted,
            `${String(attempts)} x ${String(retryIntervalMinutes)} / ${String(missAfterMinutes)}`,
          ).toBe(databaseWouldAccept);
        }
      }
    }
  });

  it('reports several problems at once', () => {
    expect(problems({ attempts: 0, leadMinutes: 999, maxSnoozes: 99 }).sort()).toEqual(
      ['ATTEMPTS_OUT_OF_RANGE', 'LEAD_OUT_OF_RANGE', 'MAX_SNOOZES_OUT_OF_RANGE'].sort(),
    );
  });
});

describe('when things are due', () => {
  it('puts the deadline missAfterMinutes after the slot', () => {
    expect(deadlineAt(SLOT, DEFAULT_REMINDER_POLICY).toISOString()).toBe(
      '2026-10-02T03:30:00.000Z',
    );
    expect(deadlineAt(SLOT, policy({ missAfterMinutes: 45 })).toISOString()).toBe(
      '2026-10-02T03:45:00.000Z',
    );
  });

  it('sends the first reminder at the slot and the others one interval apart', () => {
    expect(attemptTimes(SLOT, DEFAULT_REMINDER_POLICY).map((time) => time.toISOString())).toEqual([
      '2026-10-02T03:00:00.000Z',
      '2026-10-02T03:10:00.000Z',
      '2026-10-02T03:20:00.000Z',
    ]);
    expect(attemptTimes(SLOT, policy({ attempts: 1 }))).toHaveLength(1);
  });

  it('puts every attempt before the deadline', () => {
    const times = attemptTimes(SLOT, DEFAULT_REMINDER_POLICY);
    const deadline = deadlineAt(SLOT, DEFAULT_REMINDER_POLICY);
    expect(times.every((time) => time < deadline)).toBe(true);
  });

  it('has no heads-up by default and one `leadMinutes` earlier when asked', () => {
    expect(leadReminderAt(SLOT, DEFAULT_REMINDER_POLICY)).toBeNull();
    expect(leadReminderAt(SLOT, policy({ leadMinutes: 15 }))?.toISOString()).toBe(
      '2026-10-02T02:45:00.000Z',
    );
  });

  it('closes the correction window correctionWindowMinutes after the answer', () => {
    expect(
      correctionWindowEnd(at('2026-10-02T03:05:00Z'), DEFAULT_REMINDER_POLICY).toISOString(),
    ).toBe('2026-10-02T04:05:00.000Z');
    expect(
      correctionWindowEnd(
        at('2026-10-02T03:05:00Z'),
        policy({ correctionWindowMinutes: 0 }),
      ).toISOString(),
    ).toBe('2026-10-02T03:05:00.000Z');
  });

  it('refuses to compute anything from an invalid policy', () => {
    const broken = policy({ attempts: 0 });
    expect(errorCode(() => deadlineAt(SLOT, broken))).toBe('INVALID_POLICY');
    expect(errorCode(() => attemptTimes(SLOT, broken))).toBe('INVALID_POLICY');
    expect(errorCode(() => leadReminderAt(SLOT, broken))).toBe('INVALID_POLICY');
    expect(errorCode(() => correctionWindowEnd(SLOT, broken))).toBe('INVALID_POLICY');
    expect(
      errorCode(() =>
        availableSnoozeOptions({ now: SLOT, deadlineAt: SLOT, snoozesUsed: 0 }, broken),
      ),
    ).toBe('INVALID_POLICY');
  });
});

describe('snoozing (TZ §7.9)', () => {
  const deadline = at('2026-10-02T03:30:00Z');
  const options = (now: string, snoozesUsed = 0, extra: Partial<ReminderPolicy> = {}) =>
    availableSnoozeOptions({ now: at(now), deadlineAt: deadline, snoozesUsed }, policy(extra));

  it('offers all three when there is plenty of time', () => {
    expect(options('2026-10-02T03:00:00Z')).toEqual([5, 10, 15]);
  });

  it('offers only the options that still land at least a minute before the deadline', () => {
    expect(options('2026-10-02T03:14:00Z')).toEqual([5, 10, 15]); // latest 03:29 → +15 = 03:29
    expect(options('2026-10-02T03:14:00.001Z')).toEqual([5, 10]);
    expect(options('2026-10-02T03:19:00Z')).toEqual([5, 10]);
    expect(options('2026-10-02T03:20:00Z')).toEqual([5]);
    expect(options('2026-10-02T03:24:00Z')).toEqual([5]);
    expect(options('2026-10-02T03:24:00.001Z')).toEqual([]);
    expect(options('2026-10-02T03:25:00Z')).toEqual([]);
    expect(options('2026-10-02T03:40:00Z')).toEqual([]);
  });

  it('offers nothing once the snooze limit is used up', () => {
    expect(options('2026-10-02T03:00:00Z', 2)).toEqual([5, 10, 15]);
    expect(options('2026-10-02T03:00:00Z', 3)).toEqual([]);
    expect(options('2026-10-02T03:00:00Z', 4)).toEqual([]);
    expect(options('2026-10-02T03:00:00Z', 0, { maxSnoozes: 0 })).toEqual([]);
  });

  it('sorts custom options and respects them', () => {
    expect(options('2026-10-02T03:00:00Z', 0, { snoozeOptionsMinutes: [20, 5] })).toEqual([5, 20]);
    expect(options('2026-10-02T03:00:00Z', 0, { snoozeOptionsMinutes: [60] })).toEqual([]);
  });

  it('returns the moment the reminder comes back', () => {
    const context = { now: at('2026-10-02T03:00:00Z'), deadlineAt: deadline, snoozesUsed: 0 };
    expect(snoozeUntil(context, 10, DEFAULT_REMINDER_POLICY).toISOString()).toBe(
      '2026-10-02T03:10:00.000Z',
    );
    expect(snoozeUntil(context, 15, DEFAULT_REMINDER_POLICY).toISOString()).toBe(
      '2026-10-02T03:15:00.000Z',
    );
  });

  it('refuses an option that is not on offer rather than quietly shortening it', () => {
    const late = { now: at('2026-10-02T03:20:00Z'), deadlineAt: deadline, snoozesUsed: 0 };
    expect(errorCode(() => snoozeUntil(late, 15, DEFAULT_REMINDER_POLICY))).toBe(
      'SNOOZE_NOT_ALLOWED',
    );
    expect(errorCode(() => snoozeUntil(late, 10, DEFAULT_REMINDER_POLICY))).toBe(
      'SNOOZE_NOT_ALLOWED',
    );
    expect(snoozeUntil(late, 5, DEFAULT_REMINDER_POLICY).toISOString()).toBe(
      '2026-10-02T03:25:00.000Z',
    );

    const early = { now: at('2026-10-02T03:00:00Z'), deadlineAt: deadline, snoozesUsed: 0 };
    expect(errorCode(() => snoozeUntil(early, 7, DEFAULT_REMINDER_POLICY))).toBe(
      'SNOOZE_NOT_ALLOWED',
    );
    expect(
      errorCode(() => snoozeUntil({ ...early, snoozesUsed: 3 }, 5, DEFAULT_REMINDER_POLICY)),
    ).toBe('SNOOZE_NOT_ALLOWED');
  });

  it('never lets a snooze reach the deadline, whatever the policy', () => {
    for (const missAfterMinutes of [10, 21, 30, 120]) {
      const custom = policy({
        attempts: 2,
        retryIntervalMinutes: 5,
        missAfterMinutes,
        snoozeOptionsMinutes: [1, 5, 10, 15, 60],
      });
      for (let minute = 0; minute <= missAfterMinutes + 5; minute += 1) {
        const context = {
          now: new Date(SLOT.getTime() + minute * 60_000),
          deadlineAt: deadlineAt(SLOT, custom),
          snoozesUsed: 0,
        };
        for (const option of availableSnoozeOptions(context, custom)) {
          expect(snoozeUntil(context, option, custom).getTime()).toBeLessThan(
            context.deadlineAt.getTime(),
          );
        }
      }
    }
  });
});
