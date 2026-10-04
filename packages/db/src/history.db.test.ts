import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertClinic, insertClinician, insertPatient } from '../test/fixtures';
import { createTestDatabase, type TestDatabase } from '../test/helpers';
import {
  SENT_AT,
  TWICE_A_DAY,
  startRunningCourse,
  type RunningCourse,
} from '../test/running-course';
import { systemActor, type Actor } from './access/actor';
import { ForbiddenError } from './access/errors';
import {
  createRepositories,
  createRepositoryDeps,
  type NewMedication,
  type Repositories,
} from './repositories';

/**
 * The history of a course and its figures. The course starts at 05:00 on 3 October 2026 in
 * Tashkent with "Testamol" at 08:00 and 20:00 for seven days.
 */

let testDatabase: TestDatabase;
let repos: Repositories;

const sql = () => testDatabase.db.sql;
const system = systemActor('history test');
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

const running = (medications?: Partial<NewMedication>[]): Promise<RunningCourse> =>
  startRunningCourse(sql(), repos, medications === undefined ? {} : { medications });

async function sweepAll(now: Date): Promise<void> {
  while ((await repos.answers.sweepMissed(system, now)) > 0) {
    // until nothing is left
  }
}

async function doseAt(c: RunningCourse, at: Date, drug = 'Testamol'): Promise<string> {
  const [row] = await sql()<{ id: string }[]>`
    select d.id from scheduled_doses d join course_medications m on m.id = d.medication_id
    where d.course_id = ${c.courseId} and d.scheduled_at = ${at} and d.status <> 'SUPERSEDED'
      and m.display_name = ${drug}`;
  return row?.id ?? '';
}

/**
 * Two days lived through: day 1 morning taken on time, day 1 evening skipped with words of the
 * patient's own, day 2 morning missed and then taken late, day 2 evening missed.
 */
async function twoDays(c: RunningCourse): Promise<void> {
  await repos.answers.take(c.patient, {
    doseId: await doseAt(c, local(1, '08:00')),
    now: local(1, '08:05'),
    key: key(),
  });
  await repos.answers.skip(c.patient, {
    doseId: await doseAt(c, local(1, '20:00')),
    now: local(1, '20:10'),
    key: key(),
    reason: 'OTHER',
    text: 'была в дороге',
  });
  await sweepAll(local(2, '08:30'));
  await repos.answers.take(c.patient, {
    doseId: await doseAt(c, local(2, '08:00')),
    now: local(2, '09:15'),
    key: key(),
  });
  await sweepAll(local(2, '20:30'));
}

describe('the summary of a course', () => {
  it('counts what was due and what became of it, and nothing that is still ahead', async () => {
    const c = await running();
    await twoDays(c);

    const report = await repos.history.report(c.patient, c.courseId);

    expect(report?.adherence).toEqual({
      taken: 1,
      takenLate: 1,
      skipped: 1,
      missed: 1,
      occurred: 4,
      ratio: 0.25,
      percent: 25,
    });
    expect(report?.byMedication).toMatchObject([
      { displayName: 'Testamol', adherence: { taken: 1, occurred: 4, percent: 25 } },
    ]);
    expect(report?.skipReasons).toEqual({ FORGOT: 0, NO_MEDICATION: 0, OTHER: 1 });
    expect(report?.plan.course.id).toBe(c.courseId);
  });

  it('has no percentage while nothing has come due', async () => {
    const c = await running();
    const report = await repos.history.report(c.patient, c.courseId);
    expect(report?.adherence).toMatchObject({ occurred: 0, ratio: null, percent: null });
  });

  it('shows the doctor and the patient the patient’s own words for a skip', async () => {
    const c = await running();
    await twoDays(c);
    for (const reader of [c.doctor, c.patient]) {
      expect((await repos.history.report(reader, c.courseId))?.otherReasons).toEqual([
        { at: local(1, '20:10'), displayName: 'Testamol', text: 'была в дороге' },
      ]);
    }
    const [stored] = await sql()<{ reason_text_enc: string }[]>`
      select reason_text_enc from dose_events
      where course_id = ${c.courseId} and event_type = 'SKIPPED'`;
    expect(stored?.reason_text_enc).not.toContain('дороге');
  });

  it('gives the figures of each drug on its own', async () => {
    const c = await running([
      {},
      { displayName: 'Secondol', schedule: { kind: 'TIMES', times: ['08:00'] } },
    ]);
    await repos.answers.take(c.patient, {
      doseId: await doseAt(c, local(1, '08:00'), 'Secondol'),
      now: local(1, '08:05'),
      key: key(),
    });
    await sweepAll(local(1, '08:30'));

    const report = await repos.history.report(c.doctor, c.courseId);

    expect(report?.adherence).toMatchObject({ taken: 1, missed: 1, occurred: 2, percent: 50 });
    const figures = Object.fromEntries(
      (report?.byMedication ?? []).map((line) => [line.displayName, line.adherence.percent]),
    );
    expect(figures).toEqual({ Testamol: 0, Secondol: 100 });
  });

  it('leaves out doses taken off the schedule: they were never asked of the patient', async () => {
    const c = await running();
    await repos.answers.take(c.patient, {
      doseId: c.firstDoseId,
      now: local(1, '08:05'),
      key: key(),
    });
    await repos.lifecycle.pause(c.doctor, {
      courseId: c.courseId,
      now: local(1, '12:00'),
      key: key(),
    });

    const report = await repos.history.report(c.doctor, c.courseId);
    expect(report?.adherence).toMatchObject({ taken: 1, occurred: 1, percent: 100 });
  });

  it('keeps as-needed intake out of the percentage and counts it on its own', async () => {
    const c = await running([
      {},
      {
        displayName: 'Painaway',
        schedule: { kind: 'PRN', maxDailyDoses: 3, minimumIntervalMinutes: 60 },
      },
    ]);
    const [prn] = await sql()<{ id: string }[]>`
      select m.id from course_medications m join treatment_courses t on t.current_revision_id = m.revision_id
      where t.id = ${c.courseId} and m.prn`;
    const medicationId = prn?.id ?? '';
    await repos.prn.take(c.patient, { medicationId, now: local(1, '09:00'), key: key() });
    await repos.prn.take(c.patient, { medicationId, now: local(1, '11:00'), key: key() });
    const marks = await sql()<{ id: string }[]>`
      select id from dose_events where course_id = ${c.courseId} and event_type = 'PRN_TAKEN'
      order by occurred_at`;
    await repos.prn.undo(c.patient, { eventId: marks[1]?.id ?? '', now: local(1, '11:05') });

    const report = await repos.history.report(c.patient, c.courseId);

    expect(report?.prn).toEqual([{ displayName: 'Painaway', count: 1 }]);
    expect(report?.adherence.occurred).toBe(0);
    // The per-drug figures are for scheduled drugs: the as-needed one is not among them.
    expect(report?.byMedication.map((line) => line.displayName)).toEqual(['Testamol']);
  });

  it('follows a drug through a change of plan as one drug', async () => {
    const c = await running();
    await repos.answers.take(c.patient, {
      doseId: c.firstDoseId,
      now: local(1, '08:05'),
      key: key(),
    });
    await repos.changes.open(c.doctor, c.courseId);
    await repos.plans.addMedication(c.doctor, c.courseId, {
      ...TWICE_A_DAY,
      displayName: 'Addedol',
      schedule: { kind: 'TIMES', times: ['12:00'] },
    });
    await repos.changes.send(c.doctor, c.courseId, local(1, '09:00'));
    await repos.changes.accept(c.patient, {
      courseId: c.courseId,
      now: local(1, '10:00'),
      key: key(),
    });
    await sweepAll(local(1, '20:30'));

    const report = await repos.history.report(c.doctor, c.courseId);

    expect(report?.adherence).toMatchObject({ taken: 1, missed: 2, occurred: 3 });
    const figures = Object.fromEntries(
      (report?.byMedication ?? []).map((line) => [line.displayName, line.adherence.occurred]),
    );
    // Testamol: the morning dose under the old plan and the evening one under the new.
    expect(figures).toEqual({ Testamol: 2, Addedol: 1 });
  });

  it('is for the course’s patient and doctor, and nobody else', async () => {
    const c = await running();
    const stranger: Actor = { kind: 'PATIENT', userId: await insertPatient(sql()) };
    const clinicId = await insertClinic(sql());
    const otherDoctor: Actor = {
      kind: 'CLINICIAN',
      userId: await insertClinician(sql(), clinicId),
    };

    expect(await repos.history.report(stranger, c.courseId)).toBeNull();
    expect(await repos.history.report(otherDoctor, c.courseId)).toBeNull();
    expect(
      await repos.history.days(stranger, { courseId: c.courseId, page: 1, now: local(2, '12:00') }),
    ).toBeNull();
    await expect(repos.history.report(system, c.courseId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(repos.history.courses(c.doctor)).rejects.toBeInstanceOf(ForbiddenError);

    await sql()`update clinician_profiles set verification_status = 'REVOKED' where user_id = ${c.doctorId}`;
    expect(await repos.history.report(c.doctor, c.courseId)).toBeNull();
  });

  it('does not exist for a draft', async () => {
    const c = await running();
    const draft = await repos.plans.openDraft(c.doctor, {
      relationshipId: c.relationshipId,
      durationDays: 5,
    });
    expect(await repos.history.report(c.doctor, draft?.course.id ?? '')).toBeNull();
  });
});

describe('the patient’s list of courses', () => {
  it('holds every course that has a past, newest first, and none that is still waiting or being written', async () => {
    const c = await running();
    await twoDays(c);
    // A second course for the same patient: sent, not started.
    const pending = await repos.plans.openDraft(c.doctor, {
      relationshipId: c.relationshipId,
      durationDays: 5,
    });
    await repos.plans.addMedication(c.doctor, pending?.course.id ?? '', {
      ...TWICE_A_DAY,
      activeToDay: 5,
    });
    await repos.plans.send(c.doctor, pending?.course.id ?? '', { windowDays: 7, now: SENT_AT });

    const before = await repos.history.courses(c.patient);
    expect(before.map((summary) => summary.plan.course.id)).toEqual([c.courseId]);
    expect(before[0]?.adherence).toMatchObject({ occurred: 4, percent: 25 });

    await repos.lifecycle.cancel(c.doctor, {
      courseId: c.courseId,
      now: local(3, '07:00'),
      key: key(),
    });
    const after = await repos.history.courses(c.patient);
    expect(after.map((summary) => summary.plan.course.status)).toEqual(['CANCELLED']);
    expect(after[0]?.adherence).toMatchObject({ occurred: 4 });
  });
});

describe('the course day by day', () => {
  it('shows what has come due, newest day first, with what became of each dose', async () => {
    const c = await running();
    await twoDays(c);

    const page = await repos.history.days(c.patient, {
      courseId: c.courseId,
      page: 1,
      now: local(3, '07:00'),
    });

    expect(page).toMatchObject({ page: 1, pages: 1 });
    expect(page?.days.map((day) => day.date)).toEqual(['2026-10-04', '2026-10-03']);
    expect(page?.days[0]?.entries).toMatchObject([
      { at: local(2, '08:00'), displayName: 'Testamol', status: 'TAKEN_LATE', skipReason: null },
      { at: local(2, '20:00'), status: 'MISSED' },
    ]);
    expect(page?.days[1]?.entries).toMatchObject([
      { at: local(1, '08:00'), status: 'TAKEN' },
      { at: local(1, '20:00'), status: 'SKIPPED', skipReason: 'OTHER' },
    ]);
  });

  it('does not list doses taken off the schedule: they were never asked of the patient', async () => {
    const c = await running();
    await repos.answers.take(c.patient, {
      doseId: c.firstDoseId,
      now: local(1, '08:05'),
      key: key(),
    });
    // Paused at noon: the evening dose of day 1 and everything after it is superseded.
    await repos.lifecycle.pause(c.doctor, {
      courseId: c.courseId,
      now: local(1, '12:00'),
      key: key(),
    });

    const page = await repos.history.days(c.doctor, {
      courseId: c.courseId,
      page: 1,
      now: local(3, '12:00'),
    });

    expect(page).toMatchObject({ pages: 1 });
    expect(page?.days).toMatchObject([
      { date: '2026-10-03', entries: [{ at: local(1, '08:00'), status: 'TAKEN' }] },
    ]);
    expect(page?.days[0]?.entries).toHaveLength(1);
  });

  it('does not show doses still ahead, and shows one that is due and waiting', async () => {
    const c = await running();
    const page = await repos.history.days(c.patient, {
      courseId: c.courseId,
      page: 1,
      now: local(1, '08:10'),
    });
    expect(page?.days).toMatchObject([
      { date: '2026-10-03', entries: [{ at: local(1, '08:00'), status: 'SCHEDULED' }] },
    ]);
    expect(
      (
        await repos.history.days(c.patient, {
          courseId: c.courseId,
          page: 1,
          now: local(1, '07:00'),
        })
      )?.days,
    ).toEqual([]);
  });

  it('is cut into pages of three days and never leaves the range', async () => {
    const c = await running();
    await sweepAll(local(7, '20:30'));
    const at = (page: number) =>
      repos.history.days(c.doctor, { courseId: c.courseId, page, now: local(8, '00:00') });

    const first = await at(1);
    expect(first).toMatchObject({ page: 1, pages: 3 });
    expect(first?.days.map((day) => day.date)).toEqual(['2026-10-09', '2026-10-08', '2026-10-07']);
    expect((await at(3))?.days.map((day) => day.date)).toEqual(['2026-10-03']);
    expect(await at(99)).toMatchObject({ page: 3 });
    expect(await at(0)).toMatchObject({ page: 1 });
    expect(await at(-5)).toMatchObject({ page: 1 });
  });

  it('lists as-needed intake among the doses, by the time it was marked', async () => {
    const c = await running([
      {},
      {
        displayName: 'Painaway',
        schedule: { kind: 'PRN', maxDailyDoses: 3, minimumIntervalMinutes: 60 },
      },
    ]);
    const [prn] = await sql()<{ id: string }[]>`
      select m.id from course_medications m join treatment_courses t on t.current_revision_id = m.revision_id
      where t.id = ${c.courseId} and m.prn`;
    await repos.prn.take(c.patient, {
      medicationId: prn?.id ?? '',
      now: local(1, '09:00'),
      key: key(),
    });

    const page = await repos.history.days(c.patient, {
      courseId: c.courseId,
      page: 1,
      now: local(1, '10:00'),
    });
    expect(page?.days[0]?.entries).toMatchObject([
      { at: local(1, '08:00'), displayName: 'Testamol', status: 'SCHEDULED' },
      { at: local(1, '09:00'), displayName: 'Painaway', status: null },
    ]);
  });
});
