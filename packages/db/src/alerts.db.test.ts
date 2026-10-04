import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertPatient } from '../test/fixtures';
import { createTestDatabase, type TestDatabase } from '../test/helpers';
import { TWICE_A_DAY, startRunningCourse, type RunningCourse } from '../test/running-course';
import { systemActor, type Actor } from './access/actor';
import { ForbiddenError } from './access/errors';
import {
  createRepositories,
  createRepositoryDeps,
  type DueAlert,
  type NewMedication,
  type Repositories,
} from './repositories';

/**
 * What the doctor is told when doses are not taken. The course starts at 05:00 on 3 October
 * 2026 in Tashkent; unless a test says otherwise it has one drug at 08:00 and 20:00, so its
 * moments are day 1 08:00, day 1 20:00, day 2 08:00, and so on, each with a deadline half an
 * hour later.
 */

let testDatabase: TestDatabase;
let repos: Repositories;

const sql = () => testDatabase.db.sql;
const system = systemActor('alert test');
let tap = 0;
const key = (): string => `tap-${String((tap += 1))}`;

const local = (day: number, time: string): Date => {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 2 + day, (hours ?? 0) - 5, minutes ?? 0));
};

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  repos = createRepositories(
    testDatabase.db.orm,
    createRepositoryDeps([{ id: 't', key: randomBytes(32) }]),
  );
});

afterAll(async () => {
  await testDatabase.drop();
});

beforeEach(async () => {
  // Each test sees only the alerts of the course it starts.
  await sql()`
    update doctor_alerts set status = 'CANCELLED', locked_until = null
    where status in ('QUEUED', 'SENDING')`;
});

const running = (medications?: Partial<NewMedication>[]): Promise<RunningCourse> =>
  startRunningCourse(sql(), repos, medications === undefined ? {} : { medications });

/** Records the misses of this course up to `now`, and of no other. */
async function sweep(c: RunningCourse, now: Date): Promise<void> {
  await sql()`
    update treatment_courses set status = 'PAUSED'
    where status = 'ACTIVE' and id <> ${c.courseId}`;
  while ((await repos.answers.sweepMissed(system, now)) > 0) {
    // until nothing is left
  }
}

async function alertsOf(courseId: string) {
  return sql()<{ kind: string; status: string; slot_at: Date | null; due_at: Date }[]>`
    select kind, status, slot_at, due_at from doctor_alerts
    where course_id = ${courseId} order by created_at, due_at, kind`;
}

const kindsOf = async (courseId: string): Promise<string[]> =>
  (await alertsOf(courseId)).map((alert) => alert.kind);

async function doseAt(c: RunningCourse, at: Date): Promise<string> {
  const [row] = await sql()<{ id: string }[]>`
    select id from scheduled_doses
    where course_id = ${c.courseId} and scheduled_at = ${at} and status <> 'SUPERSEDED'
    order by id limit 1`;
  return row?.id ?? '';
}

const take = async (c: RunningCourse, at: Date, now: Date) =>
  repos.answers.take(c.patient, { doseId: await doseAt(c, at), now, key: key() });
const skip = async (c: RunningCourse, at: Date, now: Date) =>
  repos.answers.skip(c.patient, {
    doseId: await doseAt(c, at),
    now,
    key: key(),
    reason: 'NO_MEDICATION',
  });

const claim = async (c: RunningCourse, now: Date): Promise<DueAlert[]> =>
  (await repos.alerts.claimDue(system, { now, limit: 20, lockMs: 60_000 })).filter(
    (alert) => alert.courseId === c.courseId,
  );

/** Sends everything due for this course, as the worker would. */
async function sendAll(c: RunningCourse, now: Date): Promise<DueAlert[]> {
  const sent: DueAlert[] = [];
  for (;;) {
    const due = await claim(c, now);
    if (due.length === 0) {
      return sent;
    }
    for (const alert of due) {
      await repos.alerts.finish(system, alert.alertId, { status: 'SENT', at: now });
      sent.push(alert);
    }
  }
}

describe('a dose that is not taken', () => {
  it('is reported to the course’s doctor once the deadline has passed', async () => {
    const c = await running();
    await sweep(c, local(1, '08:29'));
    expect(await alertsOf(c.courseId)).toEqual([]);

    await sweep(c, local(1, '08:45'));

    expect(await alertsOf(c.courseId)).toEqual([
      {
        kind: 'MISSED',
        status: 'QUEUED',
        slot_at: local(1, '08:00'),
        // Due from the deadline itself, not from whenever the sweeper ran.
        due_at: local(1, '08:30'),
      },
    ]);
    const [alert] = await claim(c, local(1, '08:45'));
    expect(alert).toMatchObject({
      kind: 'MISSED',
      courseStatus: 'ACTIVE',
      timezone: 'Asia/Tashkent',
      patient: { firstName: 'Aziza', lastName: 'Karimova' },
      recipient: { locale: 'ru', entitled: true },
      slotAt: local(1, '08:00'),
      doses: [{ displayName: 'Testamol', status: 'MISSED', doseUnit: 'MG', skipReason: null }],
    });
    const [doctor] = await sql()<{ telegram_user_id: string }[]>`
      select telegram_user_id from users where id = ${c.doctorId}`;
    expect(alert?.recipient.telegramUserId).toBe(Number(doctor?.telegram_user_id));
  });

  it('is one message per moment, however many drugs were due at it', async () => {
    const c = await running([{}, { displayName: 'Secondol' }]);
    await sweep(c, local(1, '09:00'));

    expect(await kindsOf(c.courseId)).toEqual(['MISSED']);
    const [alert] = await claim(c, local(1, '09:00'));
    expect(alert?.doses.map((dose) => dose.displayName)).toEqual(['Secondol', 'Testamol']);
  });

  it('skipped by the patient is reported with the reason, but never with their own words', async () => {
    const c = await running();
    await repos.answers.skip(c.patient, {
      doseId: c.firstDoseId,
      now: local(1, '08:05'),
      key: key(),
      reason: 'OTHER',
      text: 'болит живот',
    });

    expect(await alertsOf(c.courseId)).toMatchObject([
      { kind: 'SKIPPED', slot_at: null, due_at: local(1, '08:05') },
    ]);
    const [alert] = await claim(c, local(1, '08:05'));
    expect(alert?.doses).toMatchObject([{ status: 'SKIPPED', skipReason: 'OTHER' }]);
    expect(JSON.stringify(alert)).not.toContain('болит');
  });

  it('is not reported when the patient marks it late in the very tap that finds it overdue', async () => {
    const c = await running();
    // 08:40: past the deadline, the sweeper has not run, and the patient taps "took it".
    await take(c, local(1, '08:00'), local(1, '08:40'));
    expect(await alertsOf(c.courseId)).toEqual([]);
  });

  it('is reported when a pause finds it already overdue', async () => {
    const c = await running();
    await repos.lifecycle.pause(c.doctor, {
      courseId: c.courseId,
      now: local(1, '08:40'),
      key: key(),
    });
    expect(await kindsOf(c.courseId)).toEqual(['MISSED']);
  });

  it('has nothing left to report if the patient put it right before the message went out', async () => {
    const c = await running();
    await sweep(c, local(1, '08:30'));
    await take(c, local(1, '08:00'), local(1, '08:31'));
    const [missed] = await claim(c, local(1, '08:31'));
    expect(missed).toMatchObject({ kind: 'MISSED', doses: [] });

    const other = await running();
    const skipped = await repos.answers.skip(other.patient, {
      doseId: other.firstDoseId,
      now: local(1, '08:05'),
      key: key(),
      reason: 'FORGOT',
    });
    expect(skipped.result).toBe('DONE');
    await repos.answers.undo(other.patient, {
      doseId: other.firstDoseId,
      now: local(1, '08:06'),
      key: key(),
    });
    const [undone] = await claim(other, local(1, '08:06'));
    expect(undone).toMatchObject({ kind: 'SKIPPED', doses: [] });
  });

  it('is reported when an answer is taken back after the deadline', async () => {
    const c = await running();
    await take(c, local(1, '08:00'), local(1, '08:20'));
    await repos.answers.undo(c.patient, {
      doseId: c.firstDoseId,
      now: local(1, '08:50'),
      key: key(),
    });
    expect(await alertsOf(c.courseId)).toMatchObject([
      { kind: 'MISSED', slot_at: local(1, '08:00'), due_at: local(1, '08:50') },
    ]);
  });
});

describe('a run of doses not taken (D-13)', () => {
  it('gives a message for the first and the second, one escalation for the third, and no fourth', async () => {
    const c = await running();
    await sweep(c, local(1, '08:30'));
    await sweep(c, local(1, '20:30'));
    expect(await kindsOf(c.courseId)).toEqual(['MISSED', 'MISSED']);

    await sweep(c, local(2, '08:30'));

    expect(await alertsOf(c.courseId)).toMatchObject([
      { kind: 'MISSED', slot_at: local(1, '08:00') },
      { kind: 'MISSED', slot_at: local(1, '20:00') },
      { kind: 'SERIES', slot_at: local(2, '08:00'), due_at: local(2, '08:30') },
    ]);
    const sent = await sendAll(c, local(2, '08:30'));
    expect(sent.find((alert) => alert.kind === 'SERIES')).toMatchObject({
      run: 3,
      runSince: local(1, '08:00'),
    });
  });

  it('counts a skip like a miss', async () => {
    const c = await running();
    await sweep(c, local(1, '08:30'));
    await skip(c, local(1, '20:00'), local(1, '20:05'));
    await sweep(c, local(2, '08:30'));
    expect(await kindsOf(c.courseId)).toEqual(['MISSED', 'SKIPPED', 'SERIES']);
  });

  it('is ended by a dose taken, on time or late: the count starts again', async () => {
    const c = await running();
    await sweep(c, local(1, '08:30'));
    await sweep(c, local(1, '20:30'));
    await take(c, local(2, '08:00'), local(2, '08:05'));
    await sweep(c, local(2, '20:30'));
    await sweep(c, local(3, '08:30'));
    // Late, an hour after its deadline: the run of two ends here as well.
    await take(c, local(3, '08:00'), local(3, '09:30'));
    await sweep(c, local(3, '20:30'));

    expect(await kindsOf(c.courseId)).toEqual(['MISSED', 'MISSED', 'MISSED', 'MISSED', 'MISSED']);
  });

  it('after the escalation sends only a summary, at most one per six hours', async () => {
    // Every two hours from 08:00 to 20:00: seven moments on day 1.
    const c = await running([
      {
        schedule: {
          kind: 'TIMES',
          times: ['08:00', '10:00', '12:00', '14:00', '16:00', '18:00', '20:00'],
        },
      },
    ]);
    await sweep(c, local(1, '08:30'));
    await sweep(c, local(1, '10:30'));
    await sweep(c, local(1, '12:30'));
    await sendAll(c, local(1, '12:30'));
    expect(await kindsOf(c.courseId)).toEqual(['MISSED', 'MISSED', 'SERIES']);

    // The fourth, fifth and sixth in a row: one summary, due six hours after the escalation.
    await sweep(c, local(1, '14:30'));
    await sweep(c, local(1, '16:30'));
    await sweep(c, local(1, '18:30'));
    const queued = (await alertsOf(c.courseId)).filter((alert) => alert.status === 'QUEUED');
    expect(queued).toEqual([
      {
        kind: 'DIGEST',
        status: 'QUEUED',
        slot_at: local(1, '12:30'),
        due_at: local(1, '18:30'),
      },
    ]);
    expect(await claim(c, local(1, '18:29'))).toEqual([]);

    const [digest] = await sendAll(c, local(1, '18:30'));
    expect(digest).toMatchObject({ kind: 'DIGEST', run: 6, runSince: local(1, '08:00') });

    // The seventh: the next summary waits out the six hours from the last one.
    await sweep(c, local(1, '20:30'));
    expect((await alertsOf(c.courseId)).at(-1)).toMatchObject({
      kind: 'DIGEST',
      status: 'QUEUED',
      due_at: local(2, '00:30'),
    });
    expect((await kindsOf(c.courseId)).filter((kind) => kind === 'SERIES')).toHaveLength(1);
  });

  it('escalates again only for a new run of three', async () => {
    const c = await running();
    for (const [day, time] of [
      [1, '08:30'],
      [1, '20:30'],
      [2, '08:30'],
    ] as const) {
      await sweep(c, local(day, time));
    }
    await take(c, local(2, '20:00'), local(2, '20:05'));
    for (const [day, time] of [
      [3, '08:30'],
      [3, '20:30'],
      [4, '08:30'],
    ] as const) {
      await sweep(c, local(day, time));
    }
    expect(await kindsOf(c.courseId)).toEqual([
      'MISSED',
      'MISSED',
      'SERIES',
      'MISSED',
      'MISSED',
      'SERIES',
    ]);
  });
});

describe('a reminder that could not be delivered', () => {
  it('is reported to the doctor once per course per day', async () => {
    const c = await running();
    await sql()`
      update notifications set status = 'CANCELLED', locked_until = null
      where course_id <> ${c.courseId} and status in ('QUEUED', 'SENDING')`;
    for (const now of [local(1, '08:00'), local(1, '08:10')]) {
      const [reminder] = await repos.outbox.claimDue(system, { now, limit: 5, lockMs: 60_000 });
      await repos.outbox.finish(system, reminder?.notificationId ?? '', {
        status: 'FAILED',
        error: 'HTTP_403',
        at: now,
      });
    }

    expect(await alertsOf(c.courseId)).toMatchObject([
      { kind: 'UNDELIVERED', status: 'QUEUED', due_at: local(1, '08:00') },
    ]);
  });
});

describe('a patient asking for a pause', () => {
  it('reaches the doctor once a day and changes nothing about the course', async () => {
    const c = await running();
    const now = local(1, '09:00');

    expect(await repos.alerts.requestPause(c.patient, { courseId: c.courseId, now })).toEqual({
      status: 'REQUESTED',
    });
    expect(
      await repos.alerts.requestPause(c.patient, { courseId: c.courseId, now: local(1, '11:00') }),
    ).toEqual({ status: 'ALREADY' });

    expect(await kindsOf(c.courseId)).toEqual(['PAUSE_REQUEST']);
    const [course] = await sql()<{ status: string }[]>`
      select status from treatment_courses where id = ${c.courseId}`;
    expect(course?.status).toBe('ACTIVE');
    const [open] = await sql()<{ n: number }[]>`
      select count(*)::int as n from scheduled_doses
      where course_id = ${c.courseId} and status = 'SCHEDULED'`;
    expect(open?.n).toBe(14);
  });

  it('is only for the patient’s own running course', async () => {
    const c = await running();
    const now = local(1, '09:00');
    const stranger: Actor = { kind: 'PATIENT', userId: await insertPatient(sql()) };

    expect(await repos.alerts.requestPause(stranger, { courseId: c.courseId, now })).toEqual({
      status: 'NOT_AVAILABLE',
    });
    await expect(
      repos.alerts.requestPause(c.doctor, { courseId: c.courseId, now }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    await repos.lifecycle.pause(c.doctor, { courseId: c.courseId, now, key: key() });
    expect(await repos.alerts.requestPause(c.patient, { courseId: c.courseId, now })).toEqual({
      status: 'NOT_AVAILABLE',
    });
    expect(await kindsOf(c.courseId)).not.toContain('PAUSE_REQUEST');
  });
});

describe('the alert queue', () => {
  it('is worked by the system only', async () => {
    const c = await running();
    const input = { now: local(1, '09:00'), limit: 5, lockMs: 60_000 };
    await expect(repos.alerts.claimDue(c.doctor, input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(repos.alerts.claimDue(c.patient, input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      repos.alerts.finish(c.doctor, c.courseId, { status: 'SENT', at: input.now }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('hands a doctor one alert per round, and each alert to one worker', async () => {
    const c = await running();
    await sweep(c, local(1, '08:30'));
    await repos.alerts.requestPause(c.patient, { courseId: c.courseId, now: local(1, '08:40') });
    const now = local(1, '09:00');

    const first = await claim(c, now);
    expect(first.map((alert) => alert.kind)).toEqual(['MISSED']);
    // Still reserved by the first worker: a second one gets the next alert, not the same.
    const second = await claim(c, now);
    expect(second.map((alert) => alert.kind)).toEqual(['PAUSE_REQUEST']);
    expect(await claim(c, now)).toEqual([]);
  });

  it('takes over an alert whose worker died, once its lock has run out', async () => {
    const c = await running();
    await sweep(c, local(1, '08:30'));
    const now = local(1, '09:00');
    await claim(c, now);

    expect(await claim(c, new Date(now.getTime() + 59_000))).toEqual([]);
    expect(await claim(c, new Date(now.getTime() + 61_000))).toHaveLength(1);
  });

  it('records what became of an alert, and ignores a report that comes too late', async () => {
    const c = await running();
    await sweep(c, local(1, '08:30'));
    const now = local(1, '09:00');
    const [alert] = await claim(c, now);
    const id = alert?.alertId ?? '';

    const later = new Date(now.getTime() + 5_000);
    expect(
      await repos.alerts.finish(system, id, { status: 'RETRY', at: later, error: 'NETWORK' }),
    ).toBe(true);
    expect(await claim(c, now)).toEqual([]);
    const [again] = await claim(c, later);
    expect(again).toMatchObject({ alertId: id, tries: 1 });

    expect(await repos.alerts.finish(system, id, { status: 'SENT', at: later })).toBe(true);
    // Already recorded: a second report changes nothing.
    expect(
      await repos.alerts.finish(system, id, { status: 'FAILED', error: 'HTTP_403', at: later }),
    ).toBe(false);
    expect(await alertsOf(c.courseId)).toMatchObject([{ kind: 'MISSED', status: 'SENT' }]);
  });

  it('says when the recipient is no longer the course’s doctor in good standing', async () => {
    const c = await running();
    await sweep(c, local(1, '08:30'));
    await sql()`update clinician_profiles set verification_status = 'REVOKED' where user_id = ${c.doctorId}`;
    const [alert] = await claim(c, local(1, '09:00'));
    expect(alert?.recipient.entitled).toBe(false);
  });

  it('never queues anything for doses taken off the schedule', async () => {
    const c = await running();
    await repos.lifecycle.pause(c.doctor, {
      courseId: c.courseId,
      now: local(1, '07:00'),
      key: key(),
    });
    await sweep(c, local(3, '00:00'));
    expect(await alertsOf(c.courseId)).toEqual([]);
  });
});

describe('the drugs in these tests', () => {
  it('are the ones the comments say', () => {
    expect(TWICE_A_DAY.schedule).toEqual({ kind: 'TIMES', times: ['08:00', '20:00'] });
  });
});
