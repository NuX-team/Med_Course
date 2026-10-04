import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertClinic, insertClinician, insertPatient, insertRelationship } from '../test/fixtures';
import { createTestDatabase, type TestDatabase } from '../test/helpers';
import { systemActor, type Actor } from './access/actor';
import { ForbiddenError } from './access/errors';
import {
  createRepositories,
  createRepositoryDeps,
  type NewMedication,
  type Repositories,
} from './repositories';

let testDatabase: TestDatabase;
let repos: Repositories;

const sql = () => testDatabase.db.sql;
const system = systemActor('run test');
const patient = (userId: string): Actor => ({ kind: 'PATIENT', userId });
const clinician = (userId: string): Actor => ({ kind: 'CLINICIAN', userId });

/** 15:00 on 2 October 2026 in Tashkent (UTC+5, no daylight saving). */
const NOW = new Date('2026-10-02T10:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = (iso: string): Date => new Date(iso);

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

interface Pair {
  readonly clinicId: string;
  readonly doctorId: string;
  readonly patientId: string;
  readonly relationshipId: string;
}

async function pair(options: { timezone?: string } = {}): Promise<Pair> {
  const clinicId = await insertClinic(sql());
  const doctorId = await insertClinician(sql(), clinicId, { firstName: 'Rustam' });
  const patientId = await insertPatient(sql());
  if (options.timezone !== undefined) {
    await sql()`update users set timezone = ${options.timezone} where id = ${patientId}`;
  }
  const relationshipId = await insertRelationship(sql(), patientId, doctorId, 'ACTIVE');
  return { clinicId, doctorId, patientId, relationshipId };
}

const TWICE_A_DAY: NewMedication = {
  displayName: 'Testamol',
  doseValue: 500,
  doseUnit: 'MG',
  foodRule: 'AFTER_MEAL',
  activeFromDay: 1,
  activeToDay: 7,
  schedule: { kind: 'TIMES', times: ['08:00', '20:00'] },
};

/** A course sent at NOW with a seven-day start window. */
async function sentCourse(
  p: Pair,
  options: {
    durationDays?: number;
    medications?: Partial<NewMedication>[];
    windowDays?: number;
  } = {},
): Promise<string> {
  const durationDays = options.durationDays ?? 7;
  const opened = await repos.plans.openDraft(clinician(p.doctorId), {
    relationshipId: p.relationshipId,
    durationDays,
  });
  const courseId = opened?.course.id ?? '';
  for (const medication of options.medications ?? [{}]) {
    const added = await repos.plans.addMedication(clinician(p.doctorId), courseId, {
      ...TWICE_A_DAY,
      activeToDay: durationDays,
      ...medication,
    });
    expect(added.status).toBe('ADDED');
  }
  const sent = await repos.plans.send(clinician(p.doctorId), courseId, {
    windowDays: options.windowDays ?? 7,
    now: NOW,
  });
  expect(sent.status).toBe('SENT');
  return courseId;
}

const start = (p: Pair, courseId: string, now = NOW) =>
  repos.runs.start(patient(p.patientId), courseId, now);
const preview = (p: Pair, courseId: string, now = NOW) =>
  repos.runs.previewStart(patient(p.patientId), courseId, now);

async function courseRow(courseId: string) {
  const [row] = await sql()<
    {
      status: string;
      start_at: Date | null;
      effective_start_date: string | null;
      ended_at: Date | null;
    }[]
  >`select status, start_at, effective_start_date::text, ended_at
    from treatment_courses where id = ${courseId}`;
  return row;
}

async function dosesOf(courseId: string) {
  return sql()<{ id: string; scheduled_at: Date; deadline_at: Date; status: string }[]>`
    select id, scheduled_at, deadline_at, status from scheduled_doses
    where course_id = ${courseId} order by scheduled_at`;
}

async function remindersOf(courseId: string) {
  return sql()<
    {
      scheduled_dose_id: string;
      kind: string;
      attempt_no: number;
      due_at: Date;
      status: string;
      recipient_user_id: string;
    }[]
  >`select scheduled_dose_id, kind, attempt_no, due_at, status, recipient_user_id
    from notifications where course_id = ${courseId} order by due_at, attempt_no`;
}

async function violation(statement: PromiseLike<unknown>): Promise<string | undefined> {
  try {
    await statement;
  } catch (error) {
    if (error instanceof postgres.PostgresError) {
      return error.constraint_name ?? error.code;
    }
    throw error;
  }
  return undefined;
}

describe('what starting would do', () => {
  it('tells an afternoon starter that part of today has already passed', async () => {
    const p = await pair();
    const courseId = await sentCourse(p);

    const result = await preview(p, courseId);

    // 15:00 in Tashkent: the 08:00 dose is gone, the 20:00 one is still ahead.
    expect(result).toMatchObject({
      status: 'READY',
      outlook: {
        effectiveStartDate: '2026-10-02',
        lastDay: '2026-10-08',
        plannedToday: 2,
        slotsToday: 1,
        slotsTotal: 13,
        firstSlotAt: at('2026-10-02T15:00:00Z'),
      },
    });
  });

  it('promises a full first day to someone who starts before the first dose', async () => {
    const p = await pair();
    const courseId = await sentCourse(p);
    // 05:00 the next morning in Tashkent.
    const result = await preview(p, courseId, at('2026-10-03T00:00:00Z'));
    expect(result).toMatchObject({
      status: 'READY',
      outlook: {
        effectiveStartDate: '2026-10-03',
        lastDay: '2026-10-09',
        plannedToday: 2,
        slotsToday: 2,
        slotsTotal: 14,
      },
    });
  });

  it('changes nothing: looking is not starting', async () => {
    const p = await pair();
    const courseId = await sentCourse(p);
    await preview(p, courseId);
    await preview(p, courseId);
    expect(await courseRow(courseId)).toMatchObject({ status: 'PENDING_PATIENT', start_at: null });
    expect(await dosesOf(courseId)).toEqual([]);
  });

  it('refuses a start that would leave no dose at all', async () => {
    const p = await pair();
    const courseId = await sentCourse(p, { durationDays: 1 });
    // 21:00 in Tashkent: both doses of the only day are behind.
    const late = at('2026-10-02T16:00:00Z');
    expect((await preview(p, courseId, late)).status).toBe('NOTHING_LEFT');
    expect((await start(p, courseId, late)).status).toBe('NOTHING_LEFT');
    expect((await courseRow(courseId))?.status).toBe('PENDING_PATIENT');
  });

  it('lets a course of as-needed medications only be started: it has no doses to lose', async () => {
    const p = await pair();
    const courseId = await sentCourse(p, {
      medications: [{ schedule: { kind: 'PRN', maxDailyDoses: 3, minimumIntervalMinutes: 240 } }],
    });
    expect(await preview(p, courseId)).toMatchObject({
      status: 'READY',
      outlook: { slotsTotal: 0, plannedToday: 0, firstSlotAt: null },
    });
  });

  it('is only about the patient’s own, sent course', async () => {
    const p = await pair();
    const other = await pair();
    const courseId = await sentCourse(p);
    const draft = await repos.plans.openDraft(clinician(other.doctorId), {
      relationshipId: other.relationshipId,
      durationDays: 7,
    });

    expect(await preview(other, courseId)).toEqual({ status: 'NOT_AVAILABLE' });
    expect(await preview(other, draft?.course.id ?? '')).toEqual({ status: 'NOT_AVAILABLE' });
    expect(await preview(p, '00000000-0000-4000-8000-000000000000')).toEqual({
      status: 'NOT_AVAILABLE',
    });
    for (const actor of [clinician(p.doctorId), system]) {
      await expect(repos.runs.previewStart(actor, courseId, NOW)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(repos.runs.start(actor, courseId, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});

describe('starting a course', () => {
  it('makes it active from this moment, with today as day 1, and applies the confirmed plan', async () => {
    const p = await pair();
    const courseId = await sentCourse(p);

    const result = await start(p, courseId);

    expect(result).toMatchObject({
      status: 'STARTED',
      outlook: { slotsTotal: 13, lastDay: '2026-10-08' },
      doctor: { locale: 'ru' },
      plan: { course: { status: 'ACTIVE' } },
    });
    expect(await courseRow(courseId)).toEqual({
      status: 'ACTIVE',
      start_at: NOW,
      effective_start_date: '2026-10-02',
      ended_at: null,
    });
    const [revision] = await sql()<
      { status: string; applied_at: Date; confirmed_by_patient_at: Date }[]
    >`select status, applied_at, confirmed_by_patient_at from course_revisions where course_id = ${courseId}`;
    expect(revision).toEqual({ status: 'APPLIED', applied_at: NOW, confirmed_by_patient_at: NOW });
    const history = await sql()<{ to_status: string; actor_kind: string; at: Date }[]>`
      select to_status, actor_kind, at from course_transitions where course_id = ${courseId} order by id`;
    expect(history.at(-1)).toEqual({ to_status: 'ACTIVE', actor_kind: 'PATIENT', at: NOW });
  });

  it('creates exactly the doses still ahead, each at the patient’s local time', async () => {
    const p = await pair();
    const courseId = await sentCourse(p);
    await start(p, courseId);

    // Worked out independently: 08:00 and 20:00 Tashkent are 03:00 and 15:00 UTC, for seven
    // days from 2 October, keeping only what is after 10:00 UTC on the first day.
    const expected: Date[] = [];
    for (let day = 0; day < 7; day += 1) {
      for (const hour of [3, 15]) {
        const instant = new Date(Date.UTC(2026, 9, 2 + day, hour));
        if (instant > NOW) {
          expected.push(instant);
        }
      }
    }
    const doses = await dosesOf(courseId);
    expect(doses.map((dose) => dose.scheduled_at)).toEqual(expected);
    expect(doses).toHaveLength(13);
    for (const dose of doses) {
      expect(dose.status).toBe('SCHEDULED');
      expect(dose.deadline_at.getTime() - dose.scheduled_at.getTime()).toBe(30 * MINUTE);
    }
  });

  it('queues three reminders per dose for the patient: at the time, then every ten minutes', async () => {
    const p = await pair();
    const courseId = await sentCourse(p);
    await start(p, courseId);

    const doses = await dosesOf(courseId);
    const reminders = await remindersOf(courseId);
    expect(reminders).toHaveLength(doses.length * 3);
    for (const dose of doses) {
      const mine = reminders.filter((reminder) => reminder.scheduled_dose_id === dose.id);
      expect(mine.map((reminder) => [reminder.kind, reminder.attempt_no])).toEqual([
        ['DOSE_REMINDER', 1],
        ['DOSE_REMINDER', 2],
        ['DOSE_REMINDER', 3],
      ]);
      expect(
        mine.map((reminder) => reminder.due_at.getTime() - dose.scheduled_at.getTime()),
      ).toEqual([0, 10 * MINUTE, 20 * MINUTE]);
    }
    expect(new Set(reminders.map((reminder) => reminder.status))).toEqual(new Set(['QUEUED']));
    expect(new Set(reminders.map((reminder) => reminder.recipient_user_id))).toEqual(
      new Set([p.patientId]),
    );
  });

  it('does not create a dose whose time is exactly the moment of the tap', async () => {
    const p = await pair();
    const courseId = await sentCourse(p);
    const atEightPm = at('2026-10-02T15:00:00Z');

    await start(p, courseId, atEightPm);

    const doses = await dosesOf(courseId);
    expect(doses).toHaveLength(12);
    expect(doses[0]?.scheduled_at).toEqual(at('2026-10-03T03:00:00Z'));
  });

  it('lays the plan out in the course’s own time zone', async () => {
    const p = await pair({ timezone: 'Europe/Moscow' });
    const courseId = await sentCourse(p);
    await start(p, courseId);
    // 13:00 in Moscow: 20:00 Moscow time is 17:00 UTC.
    expect((await dosesOf(courseId))[0]?.scheduled_at).toEqual(at('2026-10-02T17:00:00Z'));
    expect((await courseRow(courseId))?.effective_start_date).toBe('2026-10-02');
  });

  it('counts day 1 on the patient’s calendar, not the server’s', async () => {
    const p = await pair();
    const courseId = await sentCourse(p);
    // 01:00 on 3 October in Tashkent is still 2 October in UTC.
    const afterMidnight = at('2026-10-02T20:00:00Z');

    const result = await start(p, courseId, afterMidnight);

    expect(result).toMatchObject({
      status: 'STARTED',
      outlook: { effectiveStartDate: '2026-10-03', lastDay: '2026-10-09', slotsToday: 2 },
    });
    expect((await courseRow(courseId))?.effective_start_date).toBe('2026-10-03');
    expect((await dosesOf(courseId)).at(-1)?.scheduled_at).toEqual(at('2026-10-09T15:00:00Z'));
  });

  it('gives a medication prescribed for some days doses on those days only', async () => {
    const p = await pair();
    const courseId = await sentCourse(p, {
      medications: [
        { activeFromDay: 2, activeToDay: 3, schedule: { kind: 'TIMES', times: ['08:00'] } },
      ],
    });
    await start(p, courseId);
    expect((await dosesOf(courseId)).map((dose) => dose.scheduled_at)).toEqual([
      at('2026-10-03T03:00:00Z'),
      at('2026-10-04T03:00:00Z'),
    ]);
  });

  it('starts a course of as-needed medications with nothing scheduled', async () => {
    const p = await pair();
    const courseId = await sentCourse(p, {
      medications: [{ schedule: { kind: 'PRN', maxDailyDoses: 3, minimumIntervalMinutes: 240 } }],
    });
    expect((await start(p, courseId)).status).toBe('STARTED');
    expect(await dosesOf(courseId)).toEqual([]);
    expect(await remindersOf(courseId)).toEqual([]);
    expect((await courseRow(courseId))?.status).toBe('ACTIVE');
  });

  it('adds a heads-up before each dose when the course has one, but never in the past', async () => {
    const p = await pair();
    const courseId = await sentCourse(p);
    await sql()`update reminder_policies set lead_minutes = 30 where course_id = ${courseId}`;
    // 19:45 in Tashkent: the heads-up for today's 20:00 dose (19:30) is already behind.
    const now = at('2026-10-02T14:45:00Z');

    await start(p, courseId, now);

    const doses = await dosesOf(courseId);
    const leads = (await remindersOf(courseId)).filter((reminder) => reminder.kind === 'DOSE_LEAD');
    expect(leads).toHaveLength(doses.length - 1);
    expect(leads[0]?.due_at).toEqual(at('2026-10-03T02:30:00Z'));
    expect(leads.every((lead) => lead.due_at > now)).toBe(true);
  });

  it('follows the course’s own reminder settings', async () => {
    const p = await pair();
    const courseId = await sentCourse(p);
    await sql()`
      update reminder_policies set attempts = 2, retry_interval_minutes = 15, miss_after_minutes = 45
      where course_id = ${courseId}`;
    await start(p, courseId);

    const [dose] = await dosesOf(courseId);
    const mine = (await remindersOf(courseId)).filter((r) => r.scheduled_dose_id === dose?.id);
    expect((dose?.deadline_at.getTime() ?? 0) - (dose?.scheduled_at.getTime() ?? 0)).toBe(
      45 * MINUTE,
    );
    expect(mine.map((r) => r.due_at.getTime() - (dose?.scheduled_at.getTime() ?? 0))).toEqual([
      0,
      15 * MINUTE,
    ]);
  });

  it('lays out a long, dense course completely', async () => {
    const p = await pair();
    const courseId = await sentCourse(p, {
      durationDays: 120,
      medications: [
        { schedule: { kind: 'TIMES', times: ['06:00', '10:00', '14:00', '18:00', '22:00'] } },
        { displayName: 'Second', schedule: { kind: 'TIMES', times: ['09:00', '21:00'] } },
      ],
    });
    // 05:00 in Tashkent: every dose of the first day is still ahead.
    const result = await start(p, courseId, at('2026-10-03T00:00:00Z'));

    expect(result).toMatchObject({ status: 'STARTED', outlook: { slotsTotal: 840 } });
    const [counts] = await sql()<{ doses: number; reminders: number }[]>`
      select (select count(*) from scheduled_doses where course_id = ${courseId})::int as doses,
             (select count(*) from notifications where course_id = ${courseId})::int as reminders`;
    expect(counts).toEqual({ doses: 840, reminders: 2520 });
  });

  it('is audited without anything about the medications', async () => {
    const p = await pair();
    const courseId = await sentCourse(p, { medications: [{ displayName: 'Unmistakablol' }] });
    await start(p, courseId);
    const rows = await sql()<{ action: string; changes: string[]; blob: string }[]>`
      select action, changes, a::text as blob from audit_log a
      where entity_id = ${courseId} and action = 'START'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.changes.sort()).toEqual(['effective_start_date', 'start_at', 'status']);
    expect(rows[0]?.blob).not.toContain('Unmistakablol');
  });
});

describe('starting happens once', () => {
  it('lets exactly one of twenty simultaneous taps start the course', async () => {
    const p = await pair();
    const courseId = await sentCourse(p);

    const results = await Promise.all(Array.from({ length: 20 }, () => start(p, courseId)));

    expect(results.filter((result) => result.status === 'STARTED')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'ALREADY_STARTED')).toHaveLength(19);
    expect(await dosesOf(courseId)).toHaveLength(13);
    expect(await remindersOf(courseId)).toHaveLength(39);
    const [history] = await sql()<{ n: number }[]>`
      select count(*)::int as n from course_transitions
      where course_id = ${courseId} and to_status = 'ACTIVE'`;
    expect(history?.n).toBe(1);
  });

  it('lets one tap win even when every tap has already seen the course as startable', async () => {
    const p = await pair();
    const courseId = await sentCourse(p);
    const TAPS = 5;

    // Hold the course row from another connection. Every tap reads the course (still waiting to
    // be started), decides it may start it, and then queues up behind this lock at the UPDATE.
    let release = (): void => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked = (): void => undefined;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = sql().begin(async (tx) => {
      await tx`select 1 from treatment_courses where id = ${courseId} for update`;
      locked();
      await released;
    });
    await isLocked;

    const taps = Array.from({ length: TAPS }, () => start(p, courseId));
    // Wait until all of them are really blocked on the row, then let them go at once.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [row] = await sql()<{ waiting: number }[]>`
        select count(*)::int as waiting from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`;
      if ((row?.waiting ?? 0) >= TAPS) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const [blocked] = await sql()<{ waiting: number }[]>`
      select count(*)::int as waiting from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`;
    expect(blocked?.waiting).toBe(TAPS);
    release();
    await holder;

    const results = await Promise.all(taps);
    expect(results.map((result) => result.status).sort()).toEqual([
      ...Array.from({ length: TAPS - 1 }, () => 'ALREADY_STARTED'),
      'STARTED',
    ]);
    expect(await dosesOf(courseId)).toHaveLength(13);
    expect(await remindersOf(courseId)).toHaveLength(39);
  });

  it('cannot be moved by a later tap: the start and day 1 stay where they were', async () => {
    const p = await pair();
    const courseId = await sentCourse(p);
    await start(p, courseId);

    const again = await start(p, courseId, new Date(NOW.getTime() + 2 * DAY));

    expect(again.status).toBe('ALREADY_STARTED');
    expect(await courseRow(courseId)).toMatchObject({
      start_at: NOW,
      effective_start_date: '2026-10-02',
    });
    expect(await dosesOf(courseId)).toHaveLength(13);
    expect((await preview(p, courseId, new Date(NOW.getTime() + 2 * DAY))).status).toBe(
      'ALREADY_STARTED',
    );
  });
});

describe('the start window', () => {
  it('is open up to and including its last moment, and closed right after', async () => {
    const onTime = await pair();
    const onTimeCourse = await sentCourse(onTime, { windowDays: 3 });
    const late = await pair();
    const lateCourse = await sentCourse(late, { windowDays: 3 });
    const end = new Date(NOW.getTime() + 3 * DAY);

    expect((await start(onTime, onTimeCourse, end)).status).toBe('STARTED');
    expect(await start(late, lateCourse, new Date(end.getTime() + 1))).toMatchObject({
      status: 'OUTSIDE_WINDOW',
      when: 'AFTER',
    });
    expect(await courseRow(lateCourse)).toMatchObject({
      status: 'PENDING_PATIENT',
      start_at: null,
    });
    expect(await dosesOf(lateCourse)).toEqual([]);
  });

  it('is not open before the course was sent', async () => {
    const p = await pair();
    const courseId = await sentCourse(p);
    expect(await start(p, courseId, new Date(NOW.getTime() - 1))).toMatchObject({
      status: 'OUTSIDE_WINDOW',
      when: 'BEFORE',
    });
  });

  it('closes courses nobody started in time, once, and leaves the rest alone', async () => {
    const expired = await pair();
    const expiredCourse = await sentCourse(expired, { windowDays: 1 });
    const open = await pair();
    const openCourse = await sentCourse(open, { windowDays: 7 });
    const running = await pair();
    const runningCourse = await sentCourse(running, { windowDays: 1 });
    await start(running, runningCourse);
    const edge = new Date(NOW.getTime() + DAY);

    // Exactly at the end the window is still open.
    await repos.runs.expireUnstarted(system, edge);
    expect((await courseRow(expiredCourse))?.status).toBe('PENDING_PATIENT');

    const later = new Date(edge.getTime() + HOUR);
    await repos.runs.expireUnstarted(system, later);

    expect(await courseRow(expiredCourse)).toMatchObject({
      status: 'EXPIRED_NOT_STARTED',
      ended_at: later,
    });
    expect((await courseRow(openCourse))?.status).toBe('PENDING_PATIENT');
    expect((await courseRow(runningCourse))?.status).toBe('ACTIVE');
    const history = await sql()<{ to_status: string; actor_kind: string }[]>`
      select to_status, actor_kind from course_transitions
      where course_id = ${expiredCourse} order by id`;
    expect(history.at(-1)).toEqual({ to_status: 'EXPIRED_NOT_STARTED', actor_kind: 'SYSTEM' });

    await repos.runs.expireUnstarted(system, later);
    const [count] = await sql()<{ n: number }[]>`
      select count(*)::int as n from course_transitions
      where course_id = ${expiredCourse} and to_status = 'EXPIRED_NOT_STARTED'`;
    expect(count?.n).toBe(1);

    expect(await start(expired, expiredCourse, later)).toMatchObject({
      status: 'OUTSIDE_WINDOW',
      when: 'AFTER',
    });
  });

  it('is closed by the system only', async () => {
    const p = await pair();
    for (const actor of [patient(p.patientId), clinician(p.doctorId)]) {
      await expect(repos.runs.expireUnstarted(actor, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});

describe('a prescription whose author has lost standing', () => {
  it.each([
    [
      'the doctor is no longer verified',
      (p: Pair) =>
        sql()`update clinician_profiles set verification_status = 'REVOKED' where user_id = ${p.doctorId}`,
    ],
    [
      'the practice is suspended',
      (p: Pair) => sql()`update clinics set status = 'SUSPENDED' where id = ${p.clinicId}`,
    ],
    [
      'the relationship has ended',
      (p: Pair) =>
        sql()`update care_relationships set status = 'ENDED', ended_at = now() where id = ${p.relationshipId}`,
    ],
    [
      'the doctor’s account is closed',
      (p: Pair) => sql()`update users set status = 'BLOCKED' where id = ${p.doctorId}`,
    ],
  ])('cannot be started when %s', async (_label, revoke) => {
    const p = await pair();
    const courseId = await sentCourse(p);
    await revoke(p);

    expect((await preview(p, courseId)).status).toBe('DOCTOR_UNAVAILABLE');
    expect((await start(p, courseId)).status).toBe('DOCTOR_UNAVAILABLE');
    expect((await courseRow(courseId))?.status).toBe('PENDING_PATIENT');
    expect(await dosesOf(courseId)).toEqual([]);
  });
});

describe('today', () => {
  it('lists what today asks of the patient, in order, with what to take', async () => {
    const p = await pair();
    const courseId = await sentCourse(p, {
      medications: [
        { displayName: 'Evening', schedule: { kind: 'TIMES', times: ['20:00'] } },
        { displayName: 'Both', doseValue: 0.5, doseDisplay: '1/2', doseUnit: 'TABLET' },
      ],
    });
    // 05:00 on 3 October in Tashkent.
    const morning = at('2026-10-03T00:00:00Z');
    await start(p, courseId, morning);

    const [today] = await repos.runs.today(patient(p.patientId), morning);

    expect(today?.courseId).toBe(courseId);
    expect(today?.doses.map((dose) => [dose.scheduledAt.toISOString(), dose.displayName])).toEqual([
      ['2026-10-03T03:00:00.000Z', 'Both'],
      ['2026-10-03T15:00:00.000Z', 'Both'],
      ['2026-10-03T15:00:00.000Z', 'Evening'],
    ]);
    expect(today?.doses[0]).toMatchObject({
      status: 'SCHEDULED',
      doseValue: '0.500',
      doseDisplay: '1/2',
      doseUnit: 'TABLET',
    });
  });

  it('follows the patient’s calendar day, not the server’s', async () => {
    const p = await pair();
    const courseId = await sentCourse(p);
    await start(p, courseId);
    // 23:30 on 2 October in Tashkent is already 18:30 UTC; 00:30 on the 3rd is 19:30 UTC.
    const lateEvening = await repos.runs.today(patient(p.patientId), at('2026-10-02T18:30:00Z'));
    const afterMidnight = await repos.runs.today(patient(p.patientId), at('2026-10-02T19:30:00Z'));

    expect(lateEvening[0]?.doses.map((dose) => dose.scheduledAt.toISOString())).toEqual([
      '2026-10-02T15:00:00.000Z',
    ]);
    expect(afterMidnight[0]?.doses.map((dose) => dose.scheduledAt.toISOString())).toEqual([
      '2026-10-03T03:00:00.000Z',
      '2026-10-03T15:00:00.000Z',
    ]);
  });

  it('is empty before the start, for anyone else, and is the patient’s alone to ask', async () => {
    const p = await pair();
    const other = await pair();
    const courseId = await sentCourse(p);
    expect(await repos.runs.today(patient(p.patientId), NOW)).toEqual([]);

    await start(p, courseId);
    expect(await repos.runs.today(patient(other.patientId), NOW)).toEqual([]);
    await expect(repos.runs.today(clinician(p.doctorId), NOW)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('what the database itself refuses about reminders', () => {
  async function runningDose(): Promise<{ p: Pair; courseId: string; doseId: string }> {
    const p = await pair();
    const courseId = await sentCourse(p);
    await start(p, courseId);
    const [dose] = await dosesOf(courseId);
    return { p, courseId, doseId: dose?.id ?? '' };
  }

  it('refuses a second reminder for the same dose, kind and attempt', async () => {
    const { p, courseId, doseId } = await runningDose();
    expect(
      await violation(sql()`
        insert into notifications (course_id, scheduled_dose_id, recipient_user_id, kind, attempt_no, due_at)
        values (${courseId}, ${doseId}, ${p.patientId}, 'DOSE_REMINDER', 1, now())`),
    ).toBe('notifications_dose_attempt_idx');
  });

  it('refuses a reminder that points at a dose of another course', async () => {
    const first = await runningDose();
    const second = await runningDose();
    expect(
      await violation(sql()`
        insert into notifications (course_id, scheduled_dose_id, recipient_user_id, kind, attempt_no, due_at)
        values (${second.courseId}, ${first.doseId}, ${first.p.patientId}, 'DOSE_LEAD', 1, now())`),
    ).toBe('notifications_dose_fk');
  });

  it('keeps "sent" and "being sent" honest', async () => {
    const { courseId } = await runningDose();
    const [row] = await sql()<{ id: string }[]>`
      select id from notifications where course_id = ${courseId} limit 1`;
    const id = row?.id ?? '';

    expect(await violation(sql()`update notifications set status = 'SENT' where id = ${id}`)).toBe(
      'notifications_sent_chk',
    );
    expect(await violation(sql()`update notifications set sent_at = now() where id = ${id}`)).toBe(
      'notifications_sent_chk',
    );
    expect(
      await violation(sql()`update notifications set status = 'SENDING' where id = ${id}`),
    ).toBe('notifications_lock_chk');
    expect(await violation(sql()`update notifications set attempt_no = 31 where id = ${id}`)).toBe(
      'notifications_attempt_no_chk',
    );
    expect(await violation(sql()`update notifications set kind = 'SPAM' where id = ${id}`)).toBe(
      'notifications_kind_chk',
    );
  });
});
