import { randomBytes } from 'node:crypto';
import { summarizeAdherence } from '@medcourse/schedule';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertClinic, insertClinician, insertPatient, insertTechAdmin } from '../test/fixtures';
import { createTestDatabase, type TestDatabase } from '../test/helpers';
import { holdLock, waitForBlocked } from '../test/locks';
import { startRunningCourse, type RunningCourse } from '../test/running-course';
import { systemActor, type Actor } from './access/actor';
import { ForbiddenError } from './access/errors';
import {
  MAX_EXPORTS_PER_HOUR,
  createRepositories,
  createRepositoryDeps,
  type CourseExport,
  type NewMedication,
  type Repositories,
} from './repositories';

/**
 * The data of a course's report as a file (TZ §14.3): who may have it, what is in it, and what
 * is recorded about the asking. The course starts at 05:00 on 3 October 2026 in Tashkent with
 * "Testamol" at 08:00 and 20:00 for seven days.
 */

let testDatabase: TestDatabase;
let repos: Repositories;

const sql = () => testDatabase.db.sql;
const system = systemActor('export test');
let tap = 0;
const key = (): string => `tap-${String((tap += 1))}`;
const HOUR = 3_600_000;

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

async function exported(
  actor: Actor,
  c: RunningCourse,
  now: Date,
  format: 'CSV' | 'PDF' = 'CSV',
): Promise<CourseExport> {
  const result = await repos.history.exportCourse(actor, { courseId: c.courseId, format, now });
  if (result?.status !== 'READY') {
    throw new Error(`no export: ${result?.status ?? 'null'}`);
  }
  return result.export;
}

const exportsOf = async (userId: string): Promise<number> =>
  (
    await sql()<{ n: number }[]>`
      select count(*)::int as n from course_exports where requested_by = ${userId}`
  )[0]?.n ?? 0;

describe('what a report file is built from', () => {
  it('is every dose with its outcome, when it was answered, and the patient’s own words', async () => {
    const c = await running();
    await twoDays(c);
    const now = local(3, '08:10');

    const data = await exported(c.doctor, c, now);

    expect(data).toMatchObject({ format: 'CSV', requestedAt: now });
    expect(data.exportId).toMatch(/^[0-9a-f-]{36}$/);
    const dose = { displayName: 'Testamol', doseValue: '500.000', doseUnit: 'MG' };
    expect(data.entries).toMatchObject([
      { ...dose, at: local(1, '08:00'), status: 'TAKEN', answeredAt: local(1, '08:05') },
      {
        ...dose,
        at: local(1, '20:00'),
        status: 'SKIPPED',
        skipReason: 'OTHER',
        skipText: 'была в дороге',
        answeredAt: local(1, '20:10'),
      },
      { ...dose, at: local(2, '08:00'), status: 'TAKEN_LATE', answeredAt: local(2, '09:15') },
      { ...dose, at: local(2, '20:00'), status: 'MISSED', answeredAt: null, skipText: null },
      // Its time has come, nobody has answered: listed as it stands.
      { ...dose, at: local(3, '08:00'), status: 'SCHEDULED', answeredAt: null },
    ]);
    expect(data.entries).toHaveLength(5);
    expect(new Set(data.entries.map((entry) => entry.lineId)).size).toBe(1);
    expect(data.report.plan.patient).toEqual({ firstName: 'Aziza', lastName: 'Karimova' });
    expect(data.report.plan.clinician).toMatchObject({ firstName: 'Rustam' });
  });

  it('lets the figures be recomputed from the entries, also when a dose was taken ahead of time', async () => {
    const c = await running();
    await twoDays(c);
    // 07:30 on day 3: the 08:00 dose is taken half an hour early, before the file is asked for.
    await repos.answers.take(c.patient, {
      doseId: await doseAt(c, local(3, '08:00')),
      now: local(3, '07:30'),
      key: key(),
    });

    const data = await exported(c.patient, c, local(3, '07:35'));

    expect(data.entries.at(-1)).toMatchObject({
      at: local(3, '08:00'),
      status: 'TAKEN',
      answeredAt: local(3, '07:30'),
    });
    const scheduled = data.entries.flatMap((entry) =>
      entry.status === null ? [] : [{ status: entry.status }],
    );
    expect(summarizeAdherence(scheduled)).toEqual(data.report.adherence);
    expect(data.report.adherence).toMatchObject({ taken: 2, occurred: 5, percent: 40 });
  });

  it('leaves out doses still ahead and doses taken off the schedule', async () => {
    const c = await running();
    await twoDays(c);
    await repos.lifecycle.pause(c.doctor, {
      courseId: c.courseId,
      now: local(3, '07:00'),
      key: key(),
    });

    const data = await exported(c.doctor, c, local(5, '12:00'));

    expect(data.entries.map((entry) => entry.status)).toEqual([
      'TAKEN',
      'SKIPPED',
      'TAKEN_LATE',
      'MISSED',
    ]);
    expect(data.report.plan.pauses).toMatchObject([{ from: local(3, '07:00'), to: null }]);
  });

  it('lists as-needed intake among the doses, without an outcome, and not marks taken back', async () => {
    const c = await running([
      {},
      {
        displayName: 'Painaway',
        schedule: { kind: 'PRN', maxDailyDoses: 3, minimumIntervalMinutes: 240 },
      },
    ]);
    const [prn] = await sql()<{ id: string }[]>`
      select m.id from course_medications m join course_revisions r on r.id = m.revision_id
      where r.course_id = ${c.courseId} and m.display_name = 'Painaway'`;
    const mark = (now: Date) =>
      repos.prn.take(c.patient, { medicationId: prn?.id ?? '', now, key: key() });
    await mark(local(1, '10:00'));
    await mark(local(1, '16:00'));
    const [second] = await sql()<{ id: string }[]>`
      select id from dose_events where course_id = ${c.courseId} and event_type = 'PRN_TAKEN'
      order by occurred_at desc limit 1`;
    const undone = await repos.prn.undo(c.patient, {
      eventId: second?.id ?? '',
      now: local(1, '16:05'),
    });
    expect(undone.status).toBe('UNDONE');

    const data = await exported(c.patient, c, local(1, '18:00'));

    expect(data.entries).toMatchObject([
      { displayName: 'Testamol', at: local(1, '08:00'), status: 'SCHEDULED' },
      { displayName: 'Painaway', at: local(1, '10:00'), status: null, skipReason: null },
    ]);
    expect(data.report.prn).toEqual([{ displayName: 'Painaway', count: 1 }]);
  });
});

describe('who may have the file', () => {
  it('is the patient and the doctor treating them, and nobody else', async () => {
    const c = await running();
    await twoDays(c);
    const now = local(3, '09:00');
    const ask = (actor: Actor) =>
      repos.history.exportCourse(actor, { courseId: c.courseId, format: 'PDF', now });

    expect((await ask(c.patient))?.status).toBe('READY');
    expect((await ask(c.doctor))?.status).toBe('READY');

    const otherClinic = await insertClinic(sql());
    const stranger: Actor = {
      kind: 'CLINICIAN',
      userId: await insertClinician(sql(), otherClinic),
    };
    const colleague: Actor = {
      kind: 'CLINICIAN',
      userId: await insertClinician(sql(), c.clinicId),
    };
    const someone: Actor = { kind: 'PATIENT', userId: await insertPatient(sql()) };
    for (const actor of [stranger, colleague, someone]) {
      expect(await ask(actor), actor.kind).toBeNull();
      expect(await exportsOf(actor.userId)).toBe(0);
    }

    const reception: Actor = {
      kind: 'CLINIC_STAFF',
      userId: await insertPatient(sql()),
      clinicId: c.clinicId,
      role: 'RECEPTION',
    };
    const admin: Actor = { kind: 'TECH_ADMIN', userId: await insertTechAdmin(sql()) };
    const caregiver: Actor = { kind: 'CAREGIVER', userId: c.patientId };
    for (const actor of [reception, admin, caregiver, system]) {
      await expect(ask(actor), actor.kind).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it('stops being the doctor once they no longer treat the patient or lose their standing', async () => {
    const c = await running();
    const other = await running();
    const now = local(2, '09:00');
    const ask = (course: RunningCourse) =>
      repos.history.exportCourse(course.doctor, {
        courseId: course.courseId,
        format: 'CSV',
        now,
      });

    await sql()`
      update care_relationships set status = 'ENDED', ended_at = now()
      where id = ${c.relationshipId}`;
    await sql()`
      update clinician_profiles set verification_status = 'REVOKED'
      where user_id = ${other.doctorId}`;

    expect(await ask(c)).toBeNull();
    expect(await ask(other)).toBeNull();
    // The patients themselves still may.
    expect(
      (await repos.history.exportCourse(c.patient, { courseId: c.courseId, format: 'CSV', now }))
        ?.status,
    ).toBe('READY');
  });

  it('is nobody while the course is still a draft, and anyone’s guess at an id gets nothing', async () => {
    const c = await running();
    const draft = await repos.plans.openDraft(c.doctor, {
      relationshipId: c.relationshipId,
      durationDays: 5,
    });
    const now = local(1, '09:00');
    for (const courseId of [draft?.course.id ?? '', '00000000-0000-4000-8000-000000000000']) {
      for (const actor of [c.doctor, c.patient]) {
        expect(
          await repos.history.exportCourse(actor, { courseId, format: 'PDF', now }),
        ).toBeNull();
      }
    }
  });
});

describe('asking for a file', () => {
  it('is recorded: who, which course, which format, when; and in the audit trail, without content', async () => {
    const c = await running();
    await twoDays(c);
    const now = local(3, '09:00');

    const data = await exported(c.doctor, c, now, 'PDF');

    const rows = await sql()<
      { id: string; course_id: string; actor_kind: string; format: string; created_at: Date }[]
    >`select id, course_id, actor_kind, format, created_at from course_exports
      where requested_by = ${c.doctorId}`;
    expect(rows).toEqual([
      {
        id: data.exportId,
        course_id: c.courseId,
        actor_kind: 'CLINICIAN',
        format: 'PDF',
        created_at: now,
      },
    ]);
    const audit = await sql()<{ actor_kind: string; reason: string | null; dump: string }[]>`
      select actor_kind, reason, row_to_json(a)::text as dump from audit_log a
      where entity_id = ${c.courseId} and action = 'EXPORT'`;
    expect(audit).toMatchObject([{ actor_kind: 'CLINICIAN', reason: 'PDF' }]);
    for (const secret of ['Testamol', 'дороге', 'Aziza']) {
      expect(audit[0]?.dump).not.toContain(secret);
    }
  });

  it('leaves no record when it is refused', async () => {
    const c = await running();
    const someone: Actor = { kind: 'PATIENT', userId: await insertPatient(sql()) };
    await repos.history.exportCourse(someone, {
      courseId: c.courseId,
      format: 'CSV',
      now: local(1, '09:00'),
    });
    const [audit] = await sql()<{ n: number }[]>`
      select count(*)::int as n from audit_log
      where entity_id = ${c.courseId} and action = 'EXPORT'`;
    expect(audit?.n).toBe(0);
    expect(await exportsOf(someone.userId)).toBe(0);
  });

  it('is limited per person per hour, across their courses and formats', async () => {
    const c = await running();
    const start = local(1, '09:00');
    const ask = (now: Date, format: 'CSV' | 'PDF' = 'CSV') =>
      repos.history.exportCourse(c.doctor, { courseId: c.courseId, format, now });

    for (let index = 0; index < MAX_EXPORTS_PER_HOUR; index += 1) {
      const at = new Date(start.getTime() + index * 60_000);
      expect((await ask(at, index % 2 === 0 ? 'CSV' : 'PDF'))?.status, String(index)).toBe('READY');
    }
    const soon = new Date(start.getTime() + 30 * 60_000);
    expect(await ask(soon)).toEqual({ status: 'TOO_MANY' });
    expect(await exportsOf(c.doctorId)).toBe(MAX_EXPORTS_PER_HOUR);

    // The limit is the doctor's own: the patient is not held back by it.
    expect(
      (
        await repos.history.exportCourse(c.patient, {
          courseId: c.courseId,
          format: 'CSV',
          now: soon,
        })
      )?.status,
    ).toBe('READY');
    // An hour after the first one, there is room for one more, and for one only.
    const later = new Date(start.getTime() + HOUR);
    expect((await ask(later))?.status).toBe('READY');
    expect(await ask(later)).toEqual({ status: 'TOO_MANY' });
  });

  it('holds the limit when the same person asks many times at once', async () => {
    const c = await running();
    const now = local(1, '09:00');
    for (let index = 0; index < MAX_EXPORTS_PER_HOUR - 1; index += 1) {
      await exported(c.patient, c, now);
    }
    // One place is left. Everyone queues up behind the person's own lock, held here from
    // another connection, and is let go at once: they must then go through one at a time.
    const lock = await holdLock(
      sql(),
      (tx) => tx`select pg_advisory_xact_lock(hashtext(${`export:${c.patientId}`}))`,
    );
    const attempts = Array.from({ length: 4 }, () =>
      repos.history.exportCourse(c.patient, { courseId: c.courseId, format: 'PDF', now }),
    );
    await waitForBlocked(sql(), 4);
    await lock.release();
    const results = await Promise.all(attempts);

    expect(results.filter((result) => result?.status === 'READY')).toHaveLength(1);
    expect(results.filter((result) => result?.status === 'TOO_MANY')).toHaveLength(3);
    expect(await exportsOf(c.patientId)).toBe(MAX_EXPORTS_PER_HOUR);
  });
});
