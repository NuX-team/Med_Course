import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertClinic, insertClinician } from '../test/fixtures';
import { createTestDatabase, type TestDatabase } from '../test/helpers';
import { holdLock, waitForBlocked } from '../test/locks';
import {
  SENT_AT,
  STARTED_AT,
  TWICE_A_DAY,
  startRunningCourse,
  type RunningCourse,
} from '../test/running-course';
import { systemActor, type Actor } from './access/actor';
import { ForbiddenError } from './access/errors';
import {
  CANCELLED_BY_DOCTOR,
  WITHDRAWN_BEFORE_START,
  createRepositories,
  createRepositoryDeps,
  type NewMedication,
  type Repositories,
} from './repositories';

/**
 * A course after it has been sent: put on hold, resumed, taken back, stopped, finished.
 *
 * The course of these tests starts at 05:00 on 3 October 2026 in Tashkent (UTC+5), lasts seven
 * days (3-9 October) and has one drug at 08:00 and 20:00: fourteen doses, three reminders each.
 */

let testDatabase: TestDatabase;
let repos: Repositories;

const sql = () => testDatabase.db.sql;
const system = systemActor('lifecycle test');
let tap = 0;
const key = (): string => `tap-${String((tap += 1))}`;

/** A moment on the patient's own clock: day 1 is 3 October 2026. */
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

const running = (medications?: Partial<NewMedication>[]): Promise<RunningCourse> =>
  startRunningCourse(sql(), repos, medications === undefined ? {} : { medications });

/** Records every miss there is to record, across every course in this database. */
async function sweepAll(now: Date): Promise<void> {
  while ((await repos.answers.sweepMissed(system, now)) > 0) {
    // until nothing is left
  }
}

const pause = (c: RunningCourse, now: Date, actor: Actor = c.doctor) =>
  repos.lifecycle.pause(actor, { courseId: c.courseId, now, key: key() });
const resume = (c: RunningCourse, now: Date, actor: Actor = c.doctor) =>
  repos.lifecycle.resume(actor, { courseId: c.courseId, now, key: key() });
const cancel = (c: RunningCourse, now: Date, actor: Actor = c.doctor) =>
  repos.lifecycle.cancel(actor, { courseId: c.courseId, now, key: key() });
const take = (c: RunningCourse, now: Date, doseId = c.firstDoseId) =>
  repos.answers.take(c.patient, { doseId, now, key: key() });

async function courseRow(courseId: string) {
  const [row] = await sql()<
    { status: string; ended_at: Date | null; cancellation_reason_code: string | null }[]
  >`select status, ended_at, cancellation_reason_code from treatment_courses where id = ${courseId}`;
  return row;
}

async function dosesOf(courseId: string) {
  return sql()<{ id: string; scheduled_at: Date; status: string; missed_at: Date | null }[]>`
    select id, scheduled_at, status, missed_at from scheduled_doses
    where course_id = ${courseId} order by scheduled_at, created_at, id`;
}

async function tally(courseId: string): Promise<Record<string, number>> {
  const rows = await sql()<{ status: string; n: number }[]>`
    select status, count(*)::int as n from scheduled_doses
    where course_id = ${courseId} group by status`;
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}

async function reminderTally(courseId: string): Promise<Record<string, number>> {
  const rows = await sql()<{ status: string; n: number }[]>`
    select status, count(*)::int as n from notifications
    where course_id = ${courseId} group by status`;
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}

async function pausesOf(courseId: string) {
  return sql()<{ paused_at: Date; resumed_at: Date | null }[]>`
    select paused_at, resumed_at from course_pauses where course_id = ${courseId} order by paused_at`;
}

async function transitionsOf(courseId: string) {
  return sql()<{ from_status: string | null; to_status: string; actor_kind: string }[]>`
    select from_status, to_status, actor_kind from course_transitions
    where course_id = ${courseId} order by id`;
}

/** The live (not superseded) doses of a course, as "day time" on the patient's clock. */
async function liveSchedule(courseId: string): Promise<string[]> {
  const rows = await sql()<{ at: string }[]>`
    select to_char(scheduled_at at time zone 'Asia/Tashkent', 'MM-DD HH24:MI') as at
    from scheduled_doses where course_id = ${courseId} and status <> 'SUPERSEDED'
    order by scheduled_at, id`;
  return rows.map((row) => row.at);
}

async function otherDoctor(): Promise<Actor> {
  const clinicId = await insertClinic(sql());
  return { kind: 'CLINICIAN', userId: await insertClinician(sql(), clinicId) };
}

describe('pause', () => {
  it('takes every open dose out of the schedule, the one being reminded included, and keeps the past', async () => {
    const c = await running();
    await take(c, local(1, '08:05'));
    await sweepAll(local(1, '21:00'));
    const before = await sql()`
      select id, event_type, occurred_at from dose_events where course_id = ${c.courseId} order by id`;

    // 08:10 on day 2: the 08:00 dose is being reminded and its deadline (08:30) is still ahead.
    const now = local(2, '08:10');
    const result = await pause(c, now);

    expect(result).toMatchObject({
      status: 'PAUSED',
      superseded: 12,
      plan: { course: { status: 'PAUSED' }, pauses: [{ from: now, to: null }] },
      patient: { telegramUserId: c.patientTelegramId, locale: 'ru' },
    });
    expect(await tally(c.courseId)).toEqual({ TAKEN: 1, MISSED: 1, SUPERSEDED: 12 });
    expect((await courseRow(c.courseId))?.status).toBe('PAUSED');
    expect(await pausesOf(c.courseId)).toEqual([{ paused_at: now, resumed_at: null }]);
    expect((await transitionsOf(c.courseId)).at(-1)).toEqual({
      from_status: 'ACTIVE',
      to_status: 'PAUSED',
      actor_kind: 'CLINICIAN',
    });

    // What was already recorded is exactly as it was.
    const after = await sql()`
      select id, event_type, occurred_at from dose_events
      where course_id = ${c.courseId} and event_type <> 'SUPERSEDED' order by id`;
    expect(after).toEqual(before);
    const [first] = await dosesOf(c.courseId);
    expect(first).toMatchObject({ status: 'TAKEN', scheduled_at: local(1, '08:00') });
  });

  it('logs why each dose went, and by whom', async () => {
    const c = await running();
    await pause(c, local(1, '07:00'));
    const events = await sql()<
      { event_type: string; actor_kind: string; source: string; details: { reason: string } }[]
    >`select event_type, actor_kind, source, details from dose_events where course_id = ${c.courseId}`;
    expect(events).toHaveLength(14);
    expect(new Set(events.map((event) => event.event_type))).toEqual(new Set(['SUPERSEDED']));
    expect(events[0]).toMatchObject({
      actor_kind: 'CLINICIAN',
      source: 'TELEGRAM',
      details: { reason: 'paused' },
    });
  });

  it('cancels every reminder still waiting, and nothing is left to send', async () => {
    const c = await running();
    await pause(c, local(1, '07:00'));
    expect(await reminderTally(c.courseId)).toEqual({ CANCELLED: 42 });
    const due = await repos.outbox.claimDue(system, {
      now: local(7, '23:00'),
      limit: 100,
      lockMs: 60_000,
    });
    expect(due.filter((reminder) => reminder.courseId === c.courseId)).toEqual([]);
  });

  it('records an open dose that was already past its deadline as the miss it was', async () => {
    const c = await running();
    // 08:40 on day 1: the first deadline (08:30) has passed and the sweeper has not run.
    await pause(c, local(1, '08:40'));
    const [first] = await dosesOf(c.courseId);
    expect(first).toMatchObject({ status: 'MISSED', missed_at: local(1, '08:30') });
    expect(await tally(c.courseId)).toEqual({ MISSED: 1, SUPERSEDED: 13 });
    const [event] = await sql()<{ actor_kind: string; occurred_at: Date }[]>`
      select actor_kind, occurred_at from dose_events
      where scheduled_dose_id = ${c.firstDoseId} and event_type = 'MISSED'`;
    expect(event).toEqual({ actor_kind: 'SYSTEM', occurred_at: local(1, '08:30') });
  });

  it('treats a dose exactly at its deadline as a miss, and one a millisecond before as open', async () => {
    const atDeadline = await running();
    await pause(atDeadline, local(1, '08:30'));
    expect((await dosesOf(atDeadline.courseId))[0]?.status).toBe('MISSED');

    const justBefore = await running();
    await pause(justBefore, new Date(local(1, '08:30').getTime() - 1));
    expect((await dosesOf(justBefore.courseId))[0]?.status).toBe('SUPERSEDED');
  });

  it('stops a reminder a worker has already taken from the queue', async () => {
    const c = await running();
    await sql()`
      update notifications set status = 'CANCELLED', locked_until = null
      where course_id <> ${c.courseId} and status in ('QUEUED', 'SENDING')`;
    const [claimed] = await repos.outbox.claimDue(system, {
      now: local(1, '08:00'),
      limit: 5,
      lockMs: 60_000,
    });
    expect(claimed?.doseId).toBe(c.firstDoseId);
    expect(await repos.outbox.stillClaimed(system, claimed?.notificationId ?? '')).toBe(true);

    await pause(c, local(1, '08:00'));

    expect(await repos.outbox.stillClaimed(system, claimed?.notificationId ?? '')).toBe(false);
    // A worker that sent it anyway cannot mark the dose as reminded.
    expect(
      await repos.outbox.finish(system, claimed?.notificationId ?? '', {
        status: 'SENT',
        at: local(1, '08:00'),
      }),
    ).toBe(false);
    expect((await dosesOf(c.courseId))[0]?.status).toBe('SUPERSEDED');
  });

  it('leaves a paused course with nothing to answer, nothing to sweep and nothing for today', async () => {
    const c = await running();
    await pause(c, local(1, '08:10'));

    expect(await take(c, local(1, '08:15'))).toEqual({ result: 'NOT_AVAILABLE' });
    expect(await repos.answers.get(c.patient, c.firstDoseId, local(1, '08:15'))).toBeNull();
    await sweepAll(local(3, '00:00'));
    expect(await tally(c.courseId)).toEqual({ SUPERSEDED: 14 });
    expect(await repos.runs.today(c.patient, local(1, '09:00'))).toEqual([]);
  });

  it('does not let an answer given before the pause be taken back during it', async () => {
    const c = await running();
    await take(c, local(1, '08:05'));
    await pause(c, local(1, '08:10'));
    expect(
      await repos.answers.undo(c.patient, {
        doseId: c.firstDoseId,
        now: local(1, '08:12'),
        key: key(),
      }),
    ).toEqual({ result: 'NOT_AVAILABLE' });
    expect((await dosesOf(c.courseId))[0]?.status).toBe('TAKEN');
  });

  it('is the doctor’s own to do: not another doctor’s, not the patient’s, not without standing', async () => {
    const c = await running();
    expect(await pause(c, local(1, '07:00'), await otherDoctor())).toEqual({
      status: 'NOT_AVAILABLE',
    });
    await expect(pause(c, local(1, '07:00'), c.patient)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(pause(c, local(1, '07:00'), system)).rejects.toBeInstanceOf(ForbiddenError);

    await sql()`update clinician_profiles set verification_status = 'REVOKED' where user_id = ${c.doctorId}`;
    expect(await pause(c, local(1, '07:00'))).toEqual({ status: 'NOT_AVAILABLE' });
    expect((await courseRow(c.courseId))?.status).toBe('ACTIVE');
    expect(await tally(c.courseId)).toEqual({ SCHEDULED: 14 });
  });

  it('twice is once: the second pause is refused and changes nothing', async () => {
    const c = await running();
    await pause(c, local(1, '07:00'));
    const again = await pause(c, local(1, '07:05'));
    expect(again).toMatchObject({ status: 'WRONG_STATE', plan: { course: { status: 'PAUSED' } } });
    expect(await pausesOf(c.courseId)).toHaveLength(1);
    expect(await transitionsOf(c.courseId)).toHaveLength(4);
  });

  it('lets exactly one of several simultaneous pauses through', async () => {
    const c = await running();
    const held = await holdLock(
      sql(),
      (tx) => tx`select 1 from treatment_courses where id = ${c.courseId} for update`,
    );
    const taps = Array.from({ length: 3 }, () => pause(c, local(1, '07:00')));
    await waitForBlocked(sql(), 3);
    await held.release();

    const results = await Promise.all(taps);
    expect(results.map((result) => result.status).sort()).toEqual([
      'PAUSED',
      'WRONG_STATE',
      'WRONG_STATE',
    ]);
    expect(await pausesOf(c.courseId)).toHaveLength(1);
    expect(await tally(c.courseId)).toEqual({ SUPERSEDED: 14 });
  });

  it('keeps an answer that got in first: the pause waits for it and leaves that dose alone', async () => {
    const c = await running();
    const held = await holdLock(
      sql(),
      (tx) => tx`select 1 from scheduled_doses where id = ${c.firstDoseId} for update`,
    );
    const answer = take(c, local(1, '08:05'));
    await waitForBlocked(sql(), 1);
    const pausing = pause(c, local(1, '08:06'));
    await waitForBlocked(sql(), 2);
    await held.release();

    expect((await answer).result).toBe('DONE');
    expect((await pausing).status).toBe('PAUSED');
    expect(await tally(c.courseId)).toEqual({ TAKEN: 1, SUPERSEDED: 13 });
  });

  it('waits for an answer being taken back, so the dose it reopens does not outlive the pause', async () => {
    const c = await running();
    await take(c, local(1, '08:05'));
    const held = await holdLock(
      sql(),
      (tx) => tx`select 1 from scheduled_doses where id = ${c.firstDoseId} for update`,
    );
    // The patient takes the answer back: the course is held still, then the dose is waited for.
    const undoing = repos.answers.undo(c.patient, {
      doseId: c.firstDoseId,
      now: local(1, '08:10'),
      key: key(),
    });
    await waitForBlocked(sql(), 1);
    // The pause has no business with an answered dose, so only the course itself can make it
    // wait. If it did not, it would finish first and leave a reopened dose in a paused course.
    const pausing = pause(c, local(1, '08:11'));
    await waitForBlocked(sql(), 2);
    await held.release();

    expect((await undoing).result).toBe('DONE');
    expect((await pausing).status).toBe('PAUSED');
    expect(await tally(c.courseId)).toEqual({ SUPERSEDED: 14 });
    expect((await reminderTally(c.courseId)).QUEUED).toBeUndefined();
  });

  it('refuses an answer that arrives behind the pause: the dose is gone, not taken', async () => {
    const c = await running();
    const held = await holdLock(
      sql(),
      (tx) => tx`select 1 from scheduled_doses where id = ${c.firstDoseId} for update`,
    );
    const pausing = pause(c, local(1, '08:05'));
    await waitForBlocked(sql(), 1);
    const answer = take(c, local(1, '08:06'));
    await waitForBlocked(sql(), 2);
    await held.release();

    expect((await pausing).status).toBe('PAUSED');
    expect(await answer).toEqual({ result: 'NOT_AVAILABLE' });
    expect(await tally(c.courseId)).toEqual({ SUPERSEDED: 14 });
    const [events] = await sql()<{ n: number }[]>`
      select count(*)::int as n from dose_events
      where scheduled_dose_id = ${c.firstDoseId} and event_type = 'TAKEN'`;
    expect(events?.n).toBe(0);
  });
});

describe('resume', () => {
  it('lays the rest of the plan out again; a pause inside one day moves nothing and makes nothing up', async () => {
    const c = await running();
    await take(c, local(1, '08:05'));
    await take(c, local(1, '20:05'), (await dosesOf(c.courseId))[1]?.id);
    await pause(c, local(2, '08:10'));

    const now = local(2, '12:00');
    const result = await resume(c, now);

    expect(result).toMatchObject({
      status: 'RESUMED',
      firstSlotAt: local(2, '20:00'),
      lastDay: '2026-10-09',
      plan: { course: { status: 'ACTIVE' }, pauses: [{ from: local(2, '08:10'), to: now }] },
    });
    // The 08:00 dose of day 2 fell inside the pause: it stays out and is not made up.
    expect(await tally(c.courseId)).toEqual({ TAKEN: 2, SUPERSEDED: 12, SCHEDULED: 11 });
    expect(await liveSchedule(c.courseId)).toEqual([
      '10-03 08:00',
      '10-03 20:00',
      '10-04 20:00',
      ...[5, 6, 7, 8, 9].flatMap((day) => [`10-0${String(day)} 08:00`, `10-0${String(day)} 20:00`]),
    ]);
    expect(await reminderTally(c.courseId)).toMatchObject({ QUEUED: 33 });
    expect((await transitionsOf(c.courseId)).at(-1)).toEqual({
      from_status: 'PAUSED',
      to_status: 'ACTIVE',
      actor_kind: 'CLINICIAN',
    });
  });

  it('ends the course later by every whole day it was on hold', async () => {
    const c = await running();
    await pause(c, local(2, '12:00'));

    // 4 October 12:00 to 7 October 10:00: the 5th and the 6th were wholly on hold.
    const result = await resume(c, local(5, '10:00'));

    expect(result).toMatchObject({
      status: 'RESUMED',
      lastDay: '2026-10-11',
      firstSlotAt: local(5, '20:00'),
    });
    expect((await liveSchedule(c.courseId)).slice(-9)).toEqual([
      '10-07 20:00',
      '10-08 08:00',
      '10-08 20:00',
      '10-09 08:00',
      '10-09 20:00',
      '10-10 08:00',
      '10-10 20:00',
      '10-11 08:00',
      '10-11 20:00',
    ]);
  });

  it('counts a drug’s days as days of treatment: days on hold do not use them up', async () => {
    const c = await running([
      {},
      {
        displayName: 'Shortcillin',
        activeFromDay: 1,
        activeToDay: 3,
        schedule: { kind: 'TIMES', times: ['12:00'] },
      },
    ]);
    await pause(c, local(2, '13:00'));
    await resume(c, local(5, '10:00'));

    const short = await sql()<{ at: string; status: string }[]>`
      select to_char(d.scheduled_at at time zone 'Asia/Tashkent', 'MM-DD HH24:MI') as at, d.status
      from scheduled_doses d join course_medications m on m.id = d.medication_id
      where d.course_id = ${c.courseId} and m.display_name = 'Shortcillin' and d.status <> 'SUPERSEDED'
      order by d.scheduled_at`;
    // Day 3 of the course is 7 October: the third and last dose of this drug.
    expect(short.map((dose) => dose.at)).toEqual(['10-03 12:00', '10-04 12:00', '10-07 12:00']);
  });

  it('can be done again and again, each hold recorded on its own', async () => {
    const c = await running();
    await pause(c, local(1, '07:00'));
    await resume(c, local(1, '07:30'));
    await pause(c, local(2, '07:00'));
    await resume(c, local(2, '07:30'));

    expect(await pausesOf(c.courseId)).toEqual([
      { paused_at: local(1, '07:00'), resumed_at: local(1, '07:30') },
      { paused_at: local(2, '07:00'), resumed_at: local(2, '07:30') },
    ]);
    expect((await liveSchedule(c.courseId)).length).toBe(14);
    // The two doses of day 1 went unanswered before the second hold: misses, not superseded.
    expect(await tally(c.courseId)).toEqual({ SUPERSEDED: 26, MISSED: 2, SCHEDULED: 12 });
  });

  it('works in the very instant of the pause: a hold always has a length', async () => {
    const c = await running();
    const now = local(1, '07:00');
    await pause(c, now);
    expect((await resume(c, now)).status).toBe('RESUMED');
    expect((await pausesOf(c.courseId))[0]?.resumed_at).toEqual(new Date(now.getTime() + 1));
    expect((await liveSchedule(c.courseId)).length).toBe(14);
  });

  it('is refused for a course that is not on hold, and for anyone but its doctor', async () => {
    const c = await running();
    expect((await resume(c, local(1, '07:00'))).status).toBe('WRONG_STATE');
    await pause(c, local(1, '07:00'));
    expect(await resume(c, local(1, '07:10'), await otherDoctor())).toEqual({
      status: 'NOT_AVAILABLE',
    });
    await expect(resume(c, local(1, '07:10'), c.patient)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await tally(c.courseId)).toEqual({ SUPERSEDED: 14 });
  });

  it('lets exactly one of several simultaneous resumes through, and lays the plan out once', async () => {
    const c = await running();
    await pause(c, local(1, '07:00'));
    const held = await holdLock(
      sql(),
      (tx) => tx`select 1 from treatment_courses where id = ${c.courseId} for update`,
    );
    const taps = Array.from({ length: 3 }, () => resume(c, local(1, '07:30')));
    await waitForBlocked(sql(), 3);
    await held.release();

    const results = await Promise.all(taps);
    expect(results.map((result) => result.status).sort()).toEqual([
      'RESUMED',
      'WRONG_STATE',
      'WRONG_STATE',
    ]);
    expect(await tally(c.courseId)).toEqual({ SUPERSEDED: 14, SCHEDULED: 14 });
    expect(await reminderTally(c.courseId)).toEqual({ CANCELLED: 42, QUEUED: 42 });
  });
});

describe('cancel', () => {
  async function sentCourse(): Promise<RunningCourse> {
    // A course of its own that is sent but not started.
    const c = await running();
    const opened = await repos.plans.openDraft(c.doctor, {
      relationshipId: c.relationshipId,
      durationDays: 5,
    });
    const courseId = opened?.course.id ?? '';
    await repos.plans.addMedication(c.doctor, courseId, { ...TWICE_A_DAY, activeToDay: 5 });
    await repos.plans.send(c.doctor, courseId, { windowDays: 7, now: SENT_AT });
    return { ...c, courseId };
  }

  it('takes back a course the patient has not started: it can no longer be started', async () => {
    const c = await sentCourse();
    const now = new Date(SENT_AT.getTime() + 3_600_000);

    const result = await cancel(c, now);

    expect(result).toMatchObject({
      status: 'CANCELLED',
      withdrawn: true,
      patient: { telegramUserId: c.patientTelegramId },
    });
    expect(await courseRow(c.courseId)).toEqual({
      status: 'CANCELLED',
      ended_at: now,
      cancellation_reason_code: WITHDRAWN_BEFORE_START,
    });
    expect((await repos.runs.previewStart(c.patient, c.courseId, STARTED_AT)).status).toBe(
      'WITHDRAWN',
    );
    expect((await repos.runs.start(c.patient, c.courseId, STARTED_AT)).status).toBe('WITHDRAWN');
    expect(await tally(c.courseId)).toEqual({});
    const listed = await repos.plans.listForPatient(c.patient);
    expect(listed.map((plan) => plan.course.id)).not.toContain(c.courseId);
  });

  it('stops a running course at once: nothing more is asked or sent, and the past stays', async () => {
    const c = await running();
    await take(c, local(1, '08:05'));
    const now = local(1, '12:00');

    const result = await cancel(c, now);

    expect(result).toMatchObject({ status: 'CANCELLED', withdrawn: false });
    expect(await courseRow(c.courseId)).toEqual({
      status: 'CANCELLED',
      ended_at: now,
      cancellation_reason_code: CANCELLED_BY_DOCTOR,
    });
    expect(await tally(c.courseId)).toEqual({ TAKEN: 1, SUPERSEDED: 13 });
    expect((await reminderTally(c.courseId)).QUEUED).toBeUndefined();
    expect(await take(c, local(1, '20:05'), (await dosesOf(c.courseId))[1]?.id)).toEqual({
      result: 'NOT_AVAILABLE',
    });
    expect((await transitionsOf(c.courseId)).at(-1)).toEqual({
      from_status: 'ACTIVE',
      to_status: 'CANCELLED',
      actor_kind: 'CLINICIAN',
    });
  });

  it('stops a course that is on hold, and it cannot be resumed afterwards', async () => {
    const c = await running();
    await pause(c, local(1, '07:00'));
    expect((await cancel(c, local(1, '09:00'))).status).toBe('CANCELLED');
    expect((await resume(c, local(1, '10:00'))).status).toBe('WRONG_STATE');
    expect((await courseRow(c.courseId))?.status).toBe('CANCELLED');
  });

  it('is refused for a draft, for a course already ended, and for anyone but its doctor', async () => {
    const c = await running();
    const draft = await repos.plans.openDraft(c.doctor, {
      relationshipId: c.relationshipId,
      durationDays: 5,
    });
    expect(
      (
        await repos.lifecycle.cancel(c.doctor, {
          courseId: draft?.course.id ?? '',
          now: SENT_AT,
          key: key(),
        })
      ).status,
    ).toBe('WRONG_STATE');

    expect(await cancel(c, local(1, '07:00'), await otherDoctor())).toEqual({
      status: 'NOT_AVAILABLE',
    });
    await expect(cancel(c, local(1, '07:00'), c.patient)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await courseRow(c.courseId))?.status).toBe('ACTIVE');

    await cancel(c, local(1, '07:00'));
    expect((await cancel(c, local(1, '07:05'))).status).toBe('WRONG_STATE');
    expect(
      (await transitionsOf(c.courseId)).filter((row) => row.to_status === 'CANCELLED'),
    ).toHaveLength(1);
  });

  it('racing the patient’s start ends cancelled either way, with nothing left open', async () => {
    const c = await sentCourse();
    const held = await holdLock(
      sql(),
      (tx) => tx`select 1 from treatment_courses where id = ${c.courseId} for update`,
    );
    const starting = repos.runs.start(c.patient, c.courseId, STARTED_AT);
    const cancelling = cancel(c, STARTED_AT);
    await waitForBlocked(sql(), 2);
    await held.release();

    const [started, cancelled] = await Promise.all([starting, cancelling]);
    expect(cancelled.status).toBe('CANCELLED');
    expect(['STARTED', 'WITHDRAWN']).toContain(started.status);
    if (cancelled.status === 'CANCELLED') {
      // Whoever got the row first, the two agree about what happened.
      expect(cancelled.withdrawn).toBe(started.status === 'WITHDRAWN');
    }
    expect((await courseRow(c.courseId))?.status).toBe('CANCELLED');
    const open = await tally(c.courseId);
    expect(open.SCHEDULED).toBeUndefined();
    expect((await reminderTally(c.courseId)).QUEUED).toBeUndefined();
  });
});

describe('completion', () => {
  const END = local(8, '00:00'); // midnight after the last day, 9 October
  const completeDue = async (c: RunningCourse, now: Date) =>
    (await repos.lifecycle.completeDue(system, now)).filter((done) => done.courseId === c.courseId);

  it('closes a course once its last day is over and every dose has an outcome', async () => {
    const c = await running();
    await sweepAll(END);

    expect(await completeDue(c, new Date(END.getTime() - 1))).toEqual([]);
    expect((await courseRow(c.courseId))?.status).toBe('ACTIVE');

    const done = await completeDue(c, END);

    expect(done).toEqual([
      {
        courseId: c.courseId,
        lastDay: '2026-10-09',
        patient: { telegramUserId: c.patientTelegramId, locale: 'ru' },
      },
    ]);
    expect(await courseRow(c.courseId)).toMatchObject({ status: 'COMPLETED', ended_at: END });
    expect((await transitionsOf(c.courseId)).at(-1)).toEqual({
      from_status: 'ACTIVE',
      to_status: 'COMPLETED',
      actor_kind: 'SYSTEM',
    });
    expect(await tally(c.courseId)).toEqual({ MISSED: 14 });
    // Running it again finds nothing more to do.
    expect(await completeDue(c, new Date(END.getTime() + 60_000))).toEqual([]);
  });

  it('waits while a dose is still open, however late it is', async () => {
    const c = await running();
    // Nobody has swept: fourteen doses are still waiting for an outcome.
    expect(await completeDue(c, local(9, '12:00'))).toEqual([]);
    expect((await courseRow(c.courseId))?.status).toBe('ACTIVE');

    await sweepAll(local(9, '12:00'));
    expect(await completeDue(c, local(9, '12:00'))).toHaveLength(1);
  });

  it('counts the holds: a paused course ends later, and never while it is on hold', async () => {
    const c = await running();
    await pause(c, local(2, '12:00'));
    expect(await completeDue(c, local(30, '00:00'))).toEqual([]);
    expect((await courseRow(c.courseId))?.status).toBe('PAUSED');

    await resume(c, local(5, '10:00')); // the last day moves to 11 October
    await sweepAll(local(10, '00:00'));
    expect(await completeDue(c, END)).toEqual([]);
    expect(await completeDue(c, new Date(local(10, '00:00').getTime() - 1))).toEqual([]);
    expect(await completeDue(c, local(10, '00:00'))).toMatchObject([{ lastDay: '2026-10-11' }]);
  });

  it('is the system’s to do', async () => {
    const c = await running();
    await expect(repos.lifecycle.completeDue(c.doctor, END)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(repos.lifecycle.completeDue(c.patient, END)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('cannot be paused, resumed or cancelled afterwards', async () => {
    const c = await running();
    await sweepAll(END);
    await completeDue(c, END);
    expect((await pause(c, END)).status).toBe('WRONG_STATE');
    expect((await resume(c, END)).status).toBe('WRONG_STATE');
    expect((await cancel(c, END)).status).toBe('WRONG_STATE');
    expect((await courseRow(c.courseId))?.status).toBe('COMPLETED');
  });
});
