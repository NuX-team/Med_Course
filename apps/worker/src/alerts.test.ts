import type { DueAlert } from '@medcourse/db';
import { describe, expect, it } from 'vitest';
import { ALERT_MAX_TRIES, alertOutcomeOfFailure, decideAlert } from './alerts';

const base: DueAlert = {
  alertId: 'a',
  kind: 'MISSED',
  tries: 0,
  dueAt: new Date('2026-10-03T03:30:00Z'),
  courseId: 'c',
  courseStatus: 'ACTIVE',
  timezone: 'Asia/Tashkent',
  patient: { firstName: 'Aziza', lastName: 'Karimova' },
  recipient: { telegramUserId: 1, locale: 'ru', entitled: true },
  slotAt: new Date('2026-10-03T03:00:00Z'),
  doses: [
    {
      scheduledAt: new Date('2026-10-03T03:00:00Z'),
      status: 'MISSED',
      displayName: 'Testamol',
      doseValue: '500.000',
      doseDisplay: null,
      doseUnit: 'MG',
      foodRule: 'ANY',
      skipReason: null,
    },
  ],
  run: 0,
  runSince: null,
  prn: null,
};
const prn = {
  displayName: 'Painaway',
  maxDailyDoses: 3,
  minimumIntervalMinutes: 240,
  takenInDay: 4,
};

describe('whether an alert is still worth sending', () => {
  it('is yes for a miss or a skip that still stands', () => {
    expect(decideAlert(base)).toEqual({ send: true });
    expect(decideAlert({ ...base, kind: 'SKIPPED' })).toEqual({ send: true });
  });

  it('is no once the patient has put it right', () => {
    expect(decideAlert({ ...base, doses: [] })).toEqual({ send: false, reason: 'put right' });
    expect(decideAlert({ ...base, kind: 'SKIPPED', doses: [] }).send).toBe(false);
  });

  it('is no for a doctor who is no longer entitled, whatever the alert', () => {
    for (const kind of ['MISSED', 'SERIES', 'UNDELIVERED', 'PAUSE_REQUEST'] as const) {
      expect(
        decideAlert({ ...base, kind, run: 5, recipient: { ...base.recipient, entitled: false } }),
      ).toEqual({ send: false, reason: 'recipient not entitled' });
    }
  });

  it('is no for a course the doctor has cancelled, and yes for one paused or finished', () => {
    expect(decideAlert({ ...base, courseStatus: 'CANCELLED' })).toEqual({
      send: false,
      reason: 'course cancelled',
    });
    expect(decideAlert({ ...base, courseStatus: 'PAUSED' }).send).toBe(true);
    expect(decideAlert({ ...base, courseStatus: 'COMPLETED' }).send).toBe(true);
  });

  it('sends the escalation only while the run is still three or more', () => {
    expect(decideAlert({ ...base, kind: 'SERIES', run: 3 }).send).toBe(true);
    expect(decideAlert({ ...base, kind: 'SERIES', run: 7 }).send).toBe(true);
    expect(decideAlert({ ...base, kind: 'SERIES', run: 2 })).toEqual({
      send: false,
      reason: 'run ended',
    });
  });

  it('sends a summary only for what goes beyond the escalation', () => {
    expect(decideAlert({ ...base, kind: 'DIGEST', run: 4 }).send).toBe(true);
    expect(decideAlert({ ...base, kind: 'DIGEST', run: 3 }).send).toBe(false);
    expect(decideAlert({ ...base, kind: 'DIGEST', run: 0 }).send).toBe(false);
  });

  it('reports an as-needed mark only while it still stands beyond the limits', () => {
    const over = { ...base, kind: 'PRN_OVER' as const, doses: [] };
    expect(decideAlert({ ...over, prn: { ...prn, stillOver: true } }).send).toBe(true);
    expect(decideAlert({ ...over, prn: { ...prn, stillOver: false } })).toEqual({
      send: false,
      reason: 'mark taken back',
    });
    expect(decideAlert({ ...over, prn: null }).send).toBe(false);
  });

  it('passes a request for a pause on only while the course is running', () => {
    const request = { ...base, kind: 'PAUSE_REQUEST' as const, doses: [] };
    expect(decideAlert(request).send).toBe(true);
    expect(decideAlert({ ...request, courseStatus: 'PAUSED' })).toEqual({
      send: false,
      reason: 'course not running',
    });
  });

  it('always reports a reminder that could not be delivered', () => {
    expect(decideAlert({ ...base, kind: 'UNDELIVERED', doses: [] }).send).toBe(true);
    expect(
      decideAlert({ ...base, kind: 'UNDELIVERED', doses: [], courseStatus: 'PAUSED' }).send,
    ).toBe(true);
  });
});

describe('what to do after an alert could not be sent', () => {
  const now = new Date('2026-10-03T04:00:00Z');
  const fixed = () => 0;

  it('never retries a doctor who blocked the bot, and stores only the code', () => {
    for (const code of [400, 403]) {
      expect(
        alertOutcomeOfFailure(
          { error_code: code, description: 'Forbidden: bot was blocked by the user' },
          { tries: 0 },
          now,
          fixed,
        ),
      ).toEqual({ status: 'FAILED', error: `HTTP_${String(code)}`, at: now });
    }
  });

  it('retries anything else with a growing pause, capped at a quarter of an hour', () => {
    const wait = (tries: number): number => {
      const outcome = alertOutcomeOfFailure(new Error('socket hang up'), { tries }, now, fixed);
      return outcome.status === 'RETRY' ? outcome.at.getTime() - now.getTime() : -1;
    };
    expect(wait(0)).toBe(5_000);
    expect(wait(1)).toBe(10_000);
    expect(wait(4)).toBe(80_000);
    expect(alertOutcomeOfFailure({ error_code: 502 }, { tries: 0 }, now, fixed)).toMatchObject({
      status: 'RETRY',
      error: 'HTTP_502',
    });
    expect(alertOutcomeOfFailure(new Error('x'), { tries: 0 }, now, fixed)).toMatchObject({
      error: 'NETWORK',
    });
  });

  it('waits as long as a rate limit says', () => {
    const outcome = alertOutcomeOfFailure(
      { error_code: 429, parameters: { retry_after: 30 } },
      { tries: 2 },
      now,
      fixed,
    );
    expect(outcome).toEqual({
      status: 'RETRY',
      at: new Date(now.getTime() + 30_000),
      error: 'HTTP_429',
    });
    expect(alertOutcomeOfFailure({ error_code: 429 }, { tries: 0 }, now, fixed)).toMatchObject({
      at: new Date(now.getTime() + 5_000),
    });
  });

  it('gives up after the last try', () => {
    expect(
      alertOutcomeOfFailure(new Error('x'), { tries: ALERT_MAX_TRIES - 2 }, now, fixed).status,
    ).toBe('RETRY');
    expect(
      alertOutcomeOfFailure(new Error('x'), { tries: ALERT_MAX_TRIES - 1 }, now, fixed),
    ).toEqual({ status: 'FAILED', error: 'NETWORK', at: now });
  });

  it('adds up to a second of jitter', () => {
    const outcome = alertOutcomeOfFailure(new Error('x'), { tries: 0 }, now, () => 0.999);
    expect(outcome.status === 'RETRY' && outcome.at.getTime() - now.getTime()).toBe(5_999);
  });
});
