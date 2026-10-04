import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertClinic, insertClinician, insertPatient } from '../test/fixtures';
import { createTestDatabase, type TestDatabase } from '../test/helpers';
import { holdLock, waitForBlocked } from '../test/locks';
import { TWICE_A_DAY, startRunningCourse, type RunningCourse } from '../test/running-course';
import { systemActor, type Actor } from './access/actor';
import { ForbiddenError } from './access/errors';
import {
  createRepositories,
  createRepositoryDeps,
  type NewMedication,
  type Repositories,
} from './repositories';

/**
 * Changing the plan of a running course. The course starts at 05:00 on 3 October 2026 in
 * Tashkent, lasts seven days and has "Testamol" at 08:00 and 20:00. The change used in most
 * tests adds "Betadrug" at 12:00 and 18:00.
 */

let testDatabase: TestDatabase;
let repos: Repositories;

const sql = () => testDatabase.db.sql;
const system = systemActor('change test');
let tap = 0;
const key = (): string => `tap-${String((tap += 1))}`;

const local = (day: number, time: string): Date => {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 2 + day, (hours ?? 0) - 5, minutes ?? 0));
};

const BETADRUG: NewMedication = {
  ...TWICE_A_DAY,
  displayName: 'Betadrug',
  doseValue: 1,
  doseUnit: 'TABLET',
  instructions: 'запивать водой',
  schedule: { kind: 'TIMES', times: ['12:00', '18:00'] },
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

const running = (): Promise<RunningCourse> => startRunningCourse(sql(), repos);

const accept = (c: RunningCourse, now: Date, actor: Actor = c.patient) =>
  repos.changes.accept(actor, { courseId: c.courseId, now, key: key() });

/** The doctor opens a change, adds Betadrug and (unless told otherwise) sends it. */
async function proposeBetadrug(c: RunningCourse, options: { send?: boolean } = {}): Promise<void> {
  const opened = await repos.changes.open(c.doctor, c.courseId);
  const added = await repos.plans.addMedication(c.doctor, c.courseId, BETADRUG);
  if (opened.status !== 'OPENED' || added.status !== 'ADDED') {
    throw new Error(`could not prepare the change: ${opened.status}, ${added.status}`);
  }
  if (options.send !== false) {
    const sent = await repos.changes.send(c.doctor, c.courseId, local(1, '06:00'));
    if (sent.status !== 'SENT') {
      throw new Error(`could not send the change: ${sent.status}`);
    }
  }
}

async function revisionsOf(courseId: string) {
  return sql()<
    {
      id: string;
      rev_no: number;
      status: string;
      applied_at: Date | null;
      confirmed_by_patient_at: Date | null;
    }[]
  >`select id, rev_no, status, applied_at, confirmed_by_patient_at
    from course_revisions where course_id = ${courseId} order by rev_no`;
}

async function tally(courseId: string): Promise<Record<string, number>> {
  const rows = await sql()<{ status: string; n: number }[]>`
    select status, count(*)::int as n from scheduled_doses
    where course_id = ${courseId} group by status`;
  return Object.fromEntries(rows.map((row) => [row.status, row.n]));
}

/** Live doses as "drug MM-DD HH:MI", in the order they fall due. */
async function liveSchedule(courseId: string, drug?: string): Promise<string[]> {
  const rows = await sql()<{ at: string; name: string }[]>`
    select to_char(d.scheduled_at at time zone 'Asia/Tashkent', 'MM-DD HH24:MI') as at,
           m.display_name as name
    from scheduled_doses d join course_medications m on m.id = d.medication_id
    where d.course_id = ${courseId} and d.status <> 'SUPERSEDED'
    order by d.scheduled_at, m.display_name`;
  return rows.filter((row) => drug === undefined || row.name === drug).map((row) => row.at);
}

async function queued(courseId: string): Promise<number> {
  const [row] = await sql()<{ n: number }[]>`
    select count(*)::int as n from notifications where course_id = ${courseId} and status = 'QUEUED'`;
  return row?.n ?? 0;
}

describe('writing a change', () => {
  it('opens a draft copy of the plan in force, which itself does not change', async () => {
    const c = await running();
    const before = await repos.plans.getPlan(c.doctor, c.courseId);

    const opened = await repos.changes.open(c.doctor, c.courseId);

    expect(opened).toMatchObject({
      status: 'OPENED',
      change: { status: 'DRAFT', added: [], removed: [] },
    });
    const revisions = await revisionsOf(c.courseId);
    expect(revisions.map((revision) => [revision.rev_no, revision.status])).toEqual([
      [1, 'APPLIED'],
      [2, 'DRAFT'],
    ]);
    const draft = await repos.plans.getEditable(c.doctor, c.courseId);
    // Same drug, same line of the course, but a row of its own in the new revision.
    expect(draft?.medications.map((m) => [m.displayName, m.lineId])).toEqual(
      before?.medications.map((m) => [m.displayName, m.lineId]),
    );
    expect(draft?.medications[0]?.id).not.toBe(before?.medications[0]?.id);
    const after = await repos.plans.getPlan(c.doctor, c.courseId);
    expect(after?.medications).toEqual(before?.medications);
    expect(after?.course.currentRevisionId).toBe(revisions[0]?.id);
    expect(after?.change).toEqual({ revisionId: revisions[1]?.id, status: 'DRAFT' });
  });

  it('is one at a time: asking again continues the same draft', async () => {
    const c = await running();
    await repos.changes.open(c.doctor, c.courseId);
    const again = await repos.changes.open(c.doctor, c.courseId);
    expect(again.status).toBe('CONTINUED');
    expect(await revisionsOf(c.courseId)).toHaveLength(2);
  });

  it('keeps the draft out of the patient’s sight', async () => {
    const c = await running();
    await proposeBetadrug(c, { send: false });

    expect(await repos.changes.get(c.patient, c.courseId)).toBeNull();
    const seen = await repos.plans.getPlan(c.patient, c.courseId);
    expect(seen?.change).toBeNull();
    expect(seen?.medications.map((m) => m.displayName)).toEqual(['Testamol']);
    expect((await repos.plans.listForPatient(c.patient))[0]?.change).toBeNull();
    // Nor can it be accepted before the doctor has signed it off.
    expect((await accept(c, local(1, '07:00'))).status).toBe('NOTHING_PENDING');
    expect((await revisionsOf(c.courseId)).map((r) => r.status)).toEqual(['APPLIED', 'DRAFT']);
  });

  it('adds to and takes from the draft only: the plan in force cannot be edited', async () => {
    const c = await running();
    const inForce = await repos.plans.getPlan(c.doctor, c.courseId);
    await proposeBetadrug(c, { send: false });

    // The medication row of the plan in force is not the doctor's to remove.
    expect(
      await repos.plans.removeMedication(c.doctor, inForce?.medications[0]?.id ?? ''),
    ).toBeNull();

    const draft = await repos.plans.getEditable(c.doctor, c.courseId);
    const testamol = draft?.medications.find((m) => m.displayName === 'Testamol');
    expect(await repos.plans.removeMedication(c.doctor, testamol?.id ?? '')).toBe(c.courseId);

    const change = await repos.changes.get(c.doctor, c.courseId);
    expect(change?.added.map((m) => m.displayName)).toEqual(['Betadrug']);
    expect(change?.removed.map((m) => m.displayName)).toEqual(['Testamol']);
    expect(change?.proposed.medications.map((m) => m.displayName)).toEqual(['Betadrug']);
    expect(change?.added[0]?.instructions).toBe('запивать водой');
    expect(
      (await repos.plans.getPlan(c.doctor, c.courseId))?.medications.map((m) => m.displayName),
    ).toEqual(['Testamol']);
  });

  it('cannot be opened or written by anyone but the course’s doctor, or on a course that is not running', async () => {
    const c = await running();
    const clinicId = await insertClinic(sql());
    const stranger: Actor = { kind: 'CLINICIAN', userId: await insertClinician(sql(), clinicId) };

    expect(await repos.changes.open(stranger, c.courseId)).toEqual({ status: 'NOT_AVAILABLE' });
    await expect(repos.changes.open(c.patient, c.courseId)).rejects.toBeInstanceOf(ForbiddenError);
    await repos.changes.open(c.doctor, c.courseId);
    expect(await repos.plans.addMedication(stranger, c.courseId, BETADRUG)).toEqual({
      status: 'NOT_EDITABLE',
    });
    expect(await repos.changes.get(stranger, c.courseId)).toBeNull();
    expect(await repos.changes.get(system, c.courseId)).toBeNull();

    await repos.lifecycle.cancel(c.doctor, {
      courseId: c.courseId,
      now: local(1, '07:00'),
      key: key(),
    });
    expect(await repos.changes.open(c.doctor, c.courseId)).toEqual({ status: 'NOT_AVAILABLE' });
    expect(await repos.plans.addMedication(c.doctor, c.courseId, BETADRUG)).toEqual({
      status: 'NOT_EDITABLE',
    });
  });
});

describe('sending a change', () => {
  it('refuses a change that changes nothing', async () => {
    const c = await running();
    await repos.changes.open(c.doctor, c.courseId);
    expect(await repos.changes.send(c.doctor, c.courseId, local(1, '06:00'))).toEqual({
      status: 'UNCHANGED',
    });
    expect((await revisionsOf(c.courseId))[1]?.status).toBe('DRAFT');
  });

  it('refuses a plan that could not be laid out, by the same rules as a first prescription', async () => {
    const c = await running();
    await repos.changes.open(c.doctor, c.courseId);
    const draft = await repos.plans.getEditable(c.doctor, c.courseId);
    await repos.plans.removeMedication(c.doctor, draft?.medications[0]?.id ?? '');

    const result = await repos.changes.send(c.doctor, c.courseId, local(1, '06:00'));

    expect(result).toEqual({ status: 'INVALID', problems: [{ code: 'NO_MEDICATIONS' }] });
    expect((await revisionsOf(c.courseId))[1]?.status).toBe('DRAFT');
  });

  it('shows the patient the proposal and changes nothing yet', async () => {
    const c = await running();
    await proposeBetadrug(c, { send: false });
    const doses = await liveSchedule(c.courseId);

    const sent = await repos.changes.send(c.doctor, c.courseId, local(1, '06:00'));

    expect(sent).toMatchObject({
      status: 'SENT',
      change: { status: 'CONFIRMED' },
      patient: { telegramUserId: c.patientTelegramId, locale: 'ru' },
    });
    expect((await revisionsOf(c.courseId)).map((r) => r.status)).toEqual(['APPLIED', 'CONFIRMED']);
    const seen = await repos.changes.get(c.patient, c.courseId);
    expect(seen?.added.map((m) => m.displayName)).toEqual(['Betadrug']);
    expect(seen?.removed).toEqual([]);
    expect((await repos.plans.getPlan(c.patient, c.courseId))?.change?.status).toBe('CONFIRMED');
    // The plan in force keeps running exactly as before.
    expect(await liveSchedule(c.courseId)).toEqual(doses);
    expect(await queued(c.courseId)).toBe(42);
  });

  it('closes the draft to further writing while the patient is being asked', async () => {
    const c = await running();
    await proposeBetadrug(c);

    expect((await repos.changes.open(c.doctor, c.courseId)).status).toBe('WAITING_FOR_PATIENT');
    expect(await repos.plans.addMedication(c.doctor, c.courseId, BETADRUG)).toEqual({
      status: 'NOT_EDITABLE',
    });
    expect(await repos.plans.getEditable(c.doctor, c.courseId)).toBeNull();
    expect(await repos.changes.send(c.doctor, c.courseId, local(1, '06:10'))).toEqual({
      status: 'NOT_AVAILABLE',
    });
    expect(await revisionsOf(c.courseId)).toHaveLength(2);
  });
});

describe('taking a change back', () => {
  it('deletes a draft nobody else saw, with its medications', async () => {
    const c = await running();
    await proposeBetadrug(c, { send: false });

    const dropped = await repos.changes.drop(c.doctor, c.courseId);

    expect(dropped).toMatchObject({ status: 'DROPPED', wasSent: false, plan: { change: null } });
    expect((await revisionsOf(c.courseId)).map((r) => r.status)).toEqual(['APPLIED']);
    const [orphans] = await sql()<{ n: number }[]>`
      select count(*)::int as n from course_medications where display_name = 'Betadrug'
        and revision_id not in (select id from course_revisions)`;
    expect(orphans?.n).toBe(0);
    // A new change starts from the plan in force again.
    expect((await repos.changes.open(c.doctor, c.courseId)).status).toBe('OPENED');
  });

  it('keeps a change the patient was shown, as superseded, and nothing is left to accept', async () => {
    const c = await running();
    await proposeBetadrug(c);

    const dropped = await repos.changes.drop(c.doctor, c.courseId);

    expect(dropped).toMatchObject({ status: 'DROPPED', wasSent: true });
    expect((await revisionsOf(c.courseId)).map((r) => [r.rev_no, r.status, r.applied_at])).toEqual([
      [1, 'APPLIED', expect.any(Date)],
      [2, 'SUPERSEDED', null],
    ]);
    expect(await repos.changes.get(c.patient, c.courseId)).toBeNull();
    expect((await accept(c, local(1, '07:00'))).status).toBe('NOTHING_PENDING');
    expect(await liveSchedule(c.courseId, 'Betadrug')).toEqual([]);
    expect((await repos.changes.open(c.doctor, c.courseId)).status).toBe('OPENED');
    expect((await revisionsOf(c.courseId)).map((r) => r.rev_no)).toEqual([1, 2, 3]);
  });

  it('has nothing to do when there is no change', async () => {
    const c = await running();
    expect(await repos.changes.drop(c.doctor, c.courseId)).toEqual({ status: 'NOT_AVAILABLE' });
  });

  it('goes with the course when the course is cancelled', async () => {
    const draft = await running();
    await proposeBetadrug(draft, { send: false });
    await repos.lifecycle.cancel(draft.doctor, {
      courseId: draft.courseId,
      now: local(1, '07:00'),
      key: key(),
    });
    expect((await revisionsOf(draft.courseId)).map((r) => r.status)).toEqual(['APPLIED']);

    const sent = await running();
    await proposeBetadrug(sent);
    await repos.lifecycle.cancel(sent.doctor, {
      courseId: sent.courseId,
      now: local(1, '07:00'),
      key: key(),
    });
    expect((await revisionsOf(sent.courseId)).map((r) => r.status)).toEqual([
      'APPLIED',
      'SUPERSEDED',
    ]);
    expect((await accept(sent, local(1, '07:30'))).status).toBe('NOTHING_PENDING');
  });
});

describe('accepting a change', () => {
  it('puts the new plan in force for what is ahead and leaves the past exactly as recorded', async () => {
    const c = await running();
    await repos.answers.take(c.patient, {
      doseId: c.firstDoseId,
      now: local(1, '08:05'),
      key: key(),
    });
    while ((await repos.answers.sweepMissed(system, local(1, '21:00'))) > 0) {
      // record the miss of the evening dose
    }
    await proposeBetadrug(c);
    const history = await sql()`
      select id, event_type, occurred_at from dose_events where course_id = ${c.courseId} order by id`;

    // 10:00 on day 2: the morning dose of day 2 is past its deadline and nobody swept it.
    const now = local(2, '10:00');
    const result = await accept(c, now);

    expect(result).toMatchObject({
      status: 'APPLIED',
      firstSlotAt: local(2, '12:00'),
      plan: { change: null },
    });
    if (result.status === 'APPLIED') {
      expect(result.plan.medications.map((m) => m.displayName)).toEqual(['Testamol', 'Betadrug']);
      expect(result.doctor).not.toBeNull();
    }
    const revisions = await revisionsOf(c.courseId);
    expect(revisions).toMatchObject([
      { rev_no: 1, status: 'SUPERSEDED' },
      { rev_no: 2, status: 'APPLIED', applied_at: now, confirmed_by_patient_at: now },
    ]);
    const [course] = await sql()<{ current_revision_id: string; status: string }[]>`
      select current_revision_id, status from treatment_courses where id = ${c.courseId}`;
    expect(course).toEqual({ current_revision_id: revisions[1]?.id, status: 'ACTIVE' });

    // History: one taken, two missed (the unswept one dated at its own deadline), all under plan 1.
    expect(await tally(c.courseId)).toEqual({
      TAKEN: 1,
      MISSED: 2,
      SUPERSEDED: 11,
      SCHEDULED: 11 + 12,
    });
    const past = await sql()<{ status: string; rev_no: number; missed_at: Date | null }[]>`
      select d.status, r.rev_no, d.missed_at from scheduled_doses d
      join course_revisions r on r.id = d.revision_id
      where d.course_id = ${c.courseId} and d.scheduled_at <= ${now} order by d.scheduled_at`;
    expect(past).toEqual([
      { status: 'TAKEN', rev_no: 1, missed_at: null },
      { status: 'MISSED', rev_no: 1, missed_at: local(1, '20:30') },
      { status: 'MISSED', rev_no: 1, missed_at: local(2, '08:30') },
    ]);
    const kept = await sql()`
      select id, event_type, occurred_at from dose_events
      where course_id = ${c.courseId} and id in ${sql()(history.map((row) => row.id as string))}
      order by id`;
    expect(kept).toEqual(history);

    // Ahead: every open dose belongs to the new plan, and both drugs are on it.
    const ahead = await sql()<{ rev_no: number; n: number }[]>`
      select r.rev_no, count(*)::int as n from scheduled_doses d
      join course_revisions r on r.id = d.revision_id
      where d.course_id = ${c.courseId} and d.status = 'SCHEDULED' group by r.rev_no`;
    expect(ahead).toEqual([{ rev_no: 2, n: 23 }]);
    expect((await liveSchedule(c.courseId, 'Betadrug')).slice(0, 3)).toEqual([
      '10-04 12:00',
      '10-04 18:00',
      '10-05 12:00',
    ]);
    expect((await liveSchedule(c.courseId, 'Testamol')).slice(0, 5)).toEqual([
      '10-03 08:00',
      '10-03 20:00',
      '10-04 08:00',
      '10-04 20:00',
      '10-05 08:00',
    ]);
    expect(await queued(c.courseId)).toBe(23 * 3);
  });

  it('retires the dose being reminded right now and does not fill the past in', async () => {
    const c = await running();
    await proposeBetadrug(c);

    await accept(c, local(1, '08:10'));

    const [first] = await sql()<{ status: string }[]>`
      select status from scheduled_doses where id = ${c.firstDoseId}`;
    expect(first?.status).toBe('SUPERSEDED');
    expect((await liveSchedule(c.courseId, 'Testamol'))[0]).toBe('10-03 20:00');
    expect(
      await repos.answers.take(c.patient, {
        doseId: c.firstDoseId,
        now: local(1, '08:12'),
        key: key(),
      }),
    ).toEqual({ result: 'NOT_AVAILABLE' });
  });

  it('stops a drug the new plan no longer has', async () => {
    const c = await running();
    await repos.changes.open(c.doctor, c.courseId);
    await repos.plans.addMedication(c.doctor, c.courseId, BETADRUG);
    const draft = await repos.plans.getEditable(c.doctor, c.courseId);
    const testamol = draft?.medications.find((m) => m.displayName === 'Testamol');
    await repos.plans.removeMedication(c.doctor, testamol?.id ?? '');
    await repos.changes.send(c.doctor, c.courseId, local(1, '06:00'));

    await accept(c, local(1, '07:00'));

    expect(await liveSchedule(c.courseId, 'Testamol')).toEqual([]);
    expect(await liveSchedule(c.courseId, 'Betadrug')).toHaveLength(14);
    expect(await tally(c.courseId)).toEqual({ SUPERSEDED: 14, SCHEDULED: 14 });
  });

  it('twice is once: the second tap finds nothing waiting and doubles nothing', async () => {
    const c = await running();
    await proposeBetadrug(c);
    await accept(c, local(1, '07:00'));

    const again = await accept(c, local(1, '07:01'));

    expect(again.status).toBe('NOTHING_PENDING');
    expect(await tally(c.courseId)).toEqual({ SUPERSEDED: 14, SCHEDULED: 28 });
    expect(await queued(c.courseId)).toBe(84);
  });

  it('lets exactly one of several simultaneous taps apply the change', async () => {
    const c = await running();
    await proposeBetadrug(c);
    const held = await holdLock(
      sql(),
      (tx) => tx`select 1 from treatment_courses where id = ${c.courseId} for update`,
    );
    const taps = Array.from({ length: 4 }, () => accept(c, local(1, '07:00')));
    await waitForBlocked(sql(), 4);
    await held.release();

    const results = await Promise.all(taps);
    expect(results.map((result) => result.status).sort()).toEqual([
      'APPLIED',
      'NOTHING_PENDING',
      'NOTHING_PENDING',
      'NOTHING_PENDING',
    ]);
    expect(await tally(c.courseId)).toEqual({ SUPERSEDED: 14, SCHEDULED: 28 });
    expect((await revisionsOf(c.courseId)).map((r) => r.status)).toEqual(['SUPERSEDED', 'APPLIED']);
  });

  it('racing the doctor taking it back ends one way or the other, never half-way', async () => {
    const c = await running();
    await proposeBetadrug(c);
    const held = await holdLock(
      sql(),
      (tx) => tx`select 1 from treatment_courses where id = ${c.courseId} for update`,
    );
    const accepting = accept(c, local(1, '07:00'));
    const dropping = repos.changes.drop(c.doctor, c.courseId);
    await waitForBlocked(sql(), 2);
    await held.release();

    const [accepted, dropped] = await Promise.all([accepting, dropping]);
    const statuses = (await revisionsOf(c.courseId)).map((r) => r.status);
    if (accepted.status === 'APPLIED') {
      expect(dropped.status).toBe('NOT_AVAILABLE');
      expect(statuses).toEqual(['SUPERSEDED', 'APPLIED']);
      expect(await liveSchedule(c.courseId, 'Betadrug')).toHaveLength(14);
    } else {
      expect(accepted.status).toBe('NOTHING_PENDING');
      expect(dropped.status).toBe('DROPPED');
      expect(statuses).toEqual(['APPLIED', 'SUPERSEDED']);
      expect(await liveSchedule(c.courseId, 'Betadrug')).toEqual([]);
      expect(await tally(c.courseId)).toEqual({ SCHEDULED: 14 });
    }
  });

  it('cancels a reminder of the old plan that a worker has already taken', async () => {
    const c = await running();
    await proposeBetadrug(c);
    await sql()`
      update notifications set status = 'CANCELLED', locked_until = null
      where course_id <> ${c.courseId} and status in ('QUEUED', 'SENDING')`;
    const [claimed] = await repos.outbox.claimDue(system, {
      now: local(1, '08:00'),
      limit: 5,
      lockMs: 60_000,
    });
    expect(claimed).toMatchObject({ doseId: c.firstDoseId, revisionCurrent: true });

    await accept(c, local(1, '08:00'));

    expect(await repos.outbox.stillClaimed(system, claimed?.notificationId ?? '')).toBe(false);
    expect(
      await repos.outbox.finish(system, claimed?.notificationId ?? '', {
        status: 'SENT',
        at: local(1, '08:00'),
      }),
    ).toBe(false);
  });

  it('while the course is on hold switches the plan and lays nothing out until it resumes', async () => {
    const c = await running();
    await proposeBetadrug(c);
    await repos.lifecycle.pause(c.doctor, {
      courseId: c.courseId,
      now: local(1, '07:00'),
      key: key(),
    });

    const result = await accept(c, local(1, '07:30'));

    expect(result).toMatchObject({ status: 'APPLIED', firstSlotAt: null });
    expect(await tally(c.courseId)).toEqual({ SUPERSEDED: 14 });
    expect(await queued(c.courseId)).toBe(0);

    await repos.lifecycle.resume(c.doctor, {
      courseId: c.courseId,
      now: local(1, '07:45'),
      key: key(),
    });
    expect(await liveSchedule(c.courseId, 'Betadrug')).toHaveLength(14);
    expect(await liveSchedule(c.courseId, 'Testamol')).toHaveLength(14);
  });

  it('is refused when the doctor has lost standing since proposing it', async () => {
    const c = await running();
    await proposeBetadrug(c);
    await sql()`update clinician_profiles set verification_status = 'REVOKED' where user_id = ${c.doctorId}`;

    const result = await accept(c, local(1, '07:00'));

    expect(result.status).toBe('DOCTOR_UNAVAILABLE');
    expect((await revisionsOf(c.courseId)).map((r) => r.status)).toEqual(['APPLIED', 'CONFIRMED']);
    expect(await tally(c.courseId)).toEqual({ SCHEDULED: 14 });
  });

  it('is the patient’s own to do', async () => {
    const c = await running();
    await proposeBetadrug(c);
    const other: Actor = { kind: 'PATIENT', userId: await insertPatient(sql()) };

    expect(await accept(c, local(1, '07:00'), other)).toEqual({ status: 'NOT_AVAILABLE' });
    await expect(accept(c, local(1, '07:00'), c.doctor)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(accept(c, local(1, '07:00'), system)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await repos.changes.get(other, c.courseId)).toBeNull();
    expect((await revisionsOf(c.courseId)).map((r) => r.status)).toEqual(['APPLIED', 'CONFIRMED']);
  });

  it('can be followed by another change, each on top of the last', async () => {
    const c = await running();
    await proposeBetadrug(c);
    await accept(c, local(1, '07:00'));

    await repos.changes.open(c.doctor, c.courseId);
    const draft = await repos.plans.getEditable(c.doctor, c.courseId);
    const betadrug = draft?.medications.find((m) => m.displayName === 'Betadrug');
    await repos.plans.removeMedication(c.doctor, betadrug?.id ?? '');
    await repos.changes.send(c.doctor, c.courseId, local(1, '07:10'));
    await accept(c, local(1, '07:20'));

    expect((await revisionsOf(c.courseId)).map((r) => [r.rev_no, r.status])).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'SUPERSEDED'],
      [3, 'APPLIED'],
    ]);
    expect(await liveSchedule(c.courseId, 'Betadrug')).toEqual([]);
    expect(await liveSchedule(c.courseId, 'Testamol')).toHaveLength(14);
  });
});
