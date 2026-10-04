import { describe, expect, it } from 'vitest';
import {
  DIGEST_INTERVAL_MS,
  SERIES_AT,
  missAlertFor,
  momentOutcome,
  nextDigestAt,
  notTakenRun,
  prnCheck,
  type Moment,
} from './alerts';
import { at } from './test-helpers';
import type { DoseStatus } from './types';

const moment = (...statuses: DoseStatus[]): Moment => ({ statuses });

describe('what became of a moment of the schedule', () => {
  it('is "not taken" as soon as one of its doses was missed or skipped', () => {
    expect(momentOutcome(moment('MISSED'))).toBe('NOT_TAKEN');
    expect(momentOutcome(moment('SKIPPED'))).toBe('NOT_TAKEN');
    expect(momentOutcome(moment('TAKEN', 'MISSED'))).toBe('NOT_TAKEN');
    expect(momentOutcome(moment('TAKEN', 'TAKEN', 'SKIPPED'))).toBe('NOT_TAKEN');
  });

  it('is "taken" when nothing was missed and something was taken, late or not', () => {
    expect(momentOutcome(moment('TAKEN'))).toBe('TAKEN');
    expect(momentOutcome(moment('TAKEN_LATE'))).toBe('TAKEN');
    expect(momentOutcome(moment('TAKEN', 'NOTIFIED'))).toBe('TAKEN');
  });

  it('says nothing while nothing is decided, or when everything was superseded', () => {
    expect(momentOutcome(moment('SCHEDULED', 'NOTIFIED', 'SNOOZED'))).toBe('OPEN');
    expect(momentOutcome(moment('SUPERSEDED'))).toBe('OPEN');
    expect(momentOutcome(moment())).toBe('OPEN');
  });
});

describe('the run of moments not taken', () => {
  it('counts back from the newest until something was taken', () => {
    expect(notTakenRun([])).toBe(0);
    expect(notTakenRun([moment('TAKEN'), moment('MISSED')])).toBe(0);
    expect(notTakenRun([moment('MISSED'), moment('TAKEN'), moment('MISSED')])).toBe(1);
    expect(notTakenRun([moment('MISSED'), moment('SKIPPED'), moment('MISSED')])).toBe(3);
  });

  it('counts a moment once however many drugs were due at it', () => {
    expect(notTakenRun([moment('MISSED', 'MISSED', 'MISSED'), moment('TAKEN')])).toBe(1);
  });

  it('is ended by a late confirmation: the patient is answering again', () => {
    expect(notTakenRun([moment('MISSED'), moment('TAKEN_LATE'), moment('MISSED')])).toBe(1);
  });

  it('passes over a moment with nothing decided: it neither adds nor ends', () => {
    expect(notTakenRun([moment('MISSED'), moment('NOTIFIED'), moment('MISSED')])).toBe(2);
    expect(notTakenRun([moment('SUPERSEDED'), moment('MISSED'), moment('TAKEN')])).toBe(1);
  });
});

describe('what the doctor is sent for a moment not taken (D-13)', () => {
  it('is a message of its own for the first two in a row', () => {
    expect(missAlertFor(1)).toBe('INDIVIDUAL');
    expect(missAlertFor(2)).toBe('INDIVIDUAL');
  });

  it('is one escalation for the third, and only summaries after that', () => {
    expect(SERIES_AT).toBe(3);
    expect(missAlertFor(3)).toBe('SERIES');
    for (const run of [4, 5, 10, 100]) {
      expect(missAlertFor(run)).toBe('DIGEST');
    }
  });

  it('is nothing when there is no run', () => {
    expect(missAlertFor(0)).toBeNull();
  });

  it('spaces the summaries at least six hours apart, and never schedules one in the past', () => {
    const now = at('2026-10-03T10:00:00Z');
    expect(DIGEST_INTERVAL_MS).toBe(6 * 3_600_000);
    expect(nextDigestAt(now, null)).toEqual(now);
    expect(nextDigestAt(now, at('2026-10-03T09:00:00Z'))).toEqual(at('2026-10-03T15:00:00Z'));
    expect(nextDigestAt(now, at('2026-10-03T04:00:00Z'))).toEqual(now);
    expect(nextDigestAt(now, at('2026-10-02T04:00:00Z'))).toEqual(now);
  });
});

describe('as-needed intake against what the doctor allowed', () => {
  const now = at('2026-10-03T12:00:00Z');
  const rule = { maxDailyDoses: 3, minimumIntervalMinutes: 240 };

  it('is within the limits when nothing was taken', () => {
    expect(prnCheck({ recent: [], ...rule }, now)).toEqual({ excess: null, withinLimitsFrom: now });
  });

  it('is too soon inside the minimum interval, and fine exactly at its end', () => {
    const last = at('2026-10-03T08:00:01Z');
    expect(prnCheck({ recent: [last], ...rule }, now)).toEqual({
      excess: 'INTERVAL',
      withinLimitsFrom: at('2026-10-03T12:00:01Z'),
    });
    expect(prnCheck({ recent: [at('2026-10-03T08:00:00Z')], ...rule }, now).excess).toBeNull();
  });

  it('is over the daily limit once that many were taken in any 24 hours', () => {
    const recent = [
      at('2026-10-02T13:00:00Z'),
      at('2026-10-02T20:00:00Z'),
      at('2026-10-03T03:00:00Z'),
    ];
    expect(prnCheck({ recent, ...rule }, now)).toEqual({
      excess: 'DAILY_LIMIT',
      // The oldest of the three stops counting a day after it was taken.
      withinLimitsFrom: at('2026-10-03T13:00:00Z'),
    });
  });

  it('forgets marks older than a day, the boundary included', () => {
    const recent = [
      at('2026-10-02T12:00:00Z'),
      at('2026-10-02T20:00:00Z'),
      at('2026-10-03T03:00:00Z'),
    ];
    expect(prnCheck({ recent, ...rule }, now).excess).toBeNull();
  });

  it('names the daily limit when both rules are broken, and the later of the two moments', () => {
    const recent = [
      at('2026-10-03T09:00:00Z'),
      at('2026-10-03T10:00:00Z'),
      at('2026-10-03T11:00:00Z'),
    ];
    expect(prnCheck({ recent, ...rule }, now)).toEqual({
      excess: 'DAILY_LIMIT',
      withinLimitsFrom: at('2026-10-04T09:00:00Z'),
    });
  });

  it('does not depend on the order the marks are given in', () => {
    const recent = [at('2026-10-03T11:00:00Z'), at('2026-10-03T07:00:00Z')];
    expect(prnCheck({ recent, ...rule }, now).withinLimitsFrom).toEqual(at('2026-10-03T15:00:00Z'));
    expect(prnCheck({ recent: [...recent].reverse(), ...rule }, now).withinLimitsFrom).toEqual(
      at('2026-10-03T15:00:00Z'),
    );
  });
});
