import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  insertCaregiver,
  insertClinic,
  insertClinicStaff,
  insertClinician,
  insertPatient,
  insertRelationship,
  insertTechAdmin,
} from '../test/fixtures';
import { createTestDatabase, type TestDatabase } from '../test/helpers';
import { systemActor, type Actor } from './access/actor';
import { ForbiddenError } from './access/errors';
import {
  DRAFT_DISCARDED,
  MAX_MEDICATIONS,
  createRepositories,
  createRepositoryDeps,
  type NewMedication,
  type Repositories,
} from './repositories';

let testDatabase: TestDatabase;
let repos: Repositories;

const sql = () => testDatabase.db.sql;
const system = systemActor('plan test');
const patient = (userId: string): Actor => ({ kind: 'PATIENT', userId });
const clinician = (userId: string): Actor => ({ kind: 'CLINICIAN', userId });
const NOW = new Date('2026-10-02T10:00:00Z');
const DAY = 86_400_000;

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
  const patientId = await insertPatient(sql(), { firstName: 'Aziza', lastName: 'Karimova' });
  if (options.timezone !== undefined) {
    await sql()`update users set timezone = ${options.timezone} where id = ${patientId}`;
  }
  const relationshipId = await insertRelationship(sql(), patientId, doctorId, 'ACTIVE');
  return { clinicId, doctorId, patientId, relationshipId };
}

async function draft(p: Pair, durationDays = 7): Promise<string> {
  const opened = await repos.plans.openDraft(clinician(p.doctorId), {
    relationshipId: p.relationshipId,
    durationDays,
  });
  if (opened === null) {
    throw new Error('could not open a draft');
  }
  return opened.course.id;
}

const TABLET: NewMedication = {
  displayName: 'Testamol',
  doseValue: 500,
  doseUnit: 'MG',
  foodRule: 'AFTER_MEAL',
  activeFromDay: 1,
  activeToDay: 7,
  schedule: { kind: 'TIMES', times: ['08:00', '20:00'] },
};

const add = (p: Pair, courseId: string, medication: Partial<NewMedication> = {}) =>
  repos.plans.addMedication(clinician(p.doctorId), courseId, { ...TABLET, ...medication });

/** A draft with one medication, sent to the patient. */
async function sent(p: Pair, medication: Partial<NewMedication> = {}): Promise<string> {
  const courseId = await draft(p);
  await add(p, courseId, medication);
  const result = await repos.plans.send(clinician(p.doctorId), courseId, {
    windowDays: 7,
    now: NOW,
  });
  expect(result.status).toBe('SENT');
  return courseId;
}

async function courseRow(courseId: string) {
  const [row] = await sql()<
    {
      status: string;
      duration_days: number;
      timezone: string;
      start_window_from: Date | null;
      start_window_to: Date | null;
      ended_at: Date | null;
      cancellation_reason_code: string | null;
    }[]
  >`select status, duration_days, timezone, start_window_from, start_window_to, ended_at,
           cancellation_reason_code
    from treatment_courses where id = ${courseId}`;
  return row;
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

describe('opening a draft', () => {
  it('creates an empty draft written in the patient’s own time zone', async () => {
    const p = await pair({ timezone: 'Europe/Moscow' });

    const opened = await repos.plans.openDraft(clinician(p.doctorId), {
      relationshipId: p.relationshipId,
      durationDays: 10,
    });

    expect(opened?.created).toBe(true);
    expect(await courseRow(opened?.course.id ?? '')).toMatchObject({
      status: 'DRAFT',
      duration_days: 10,
      timezone: 'Europe/Moscow',
      start_window_from: null,
    });
    const plan = await repos.plans.getPlan(clinician(p.doctorId), opened?.course.id ?? '');
    expect(plan).toMatchObject({
      patient: { firstName: 'Aziza', lastName: 'Karimova' },
      clinician: { firstName: 'Rustam' },
      medications: [],
    });
  });

  it('is the same draft the second time: nothing is created and nothing changes', async () => {
    const p = await pair();
    const first = await draft(p, 7);
    const again = await repos.plans.openDraft(clinician(p.doctorId), {
      relationshipId: p.relationshipId,
      durationDays: 30,
    });

    expect(again).toMatchObject({ created: false, course: { id: first, durationDays: 7 } });
    expect((await repos.plans.draftFor(clinician(p.doctorId), p.relationshipId))?.id).toBe(first);
  });

  it('makes exactly one draft when the doctor taps many times at once', async () => {
    const p = await pair();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        repos.plans.openDraft(clinician(p.doctorId), {
          relationshipId: p.relationshipId,
          durationDays: 7,
        }),
      ),
    );
    expect(results.filter((result) => result?.created === true)).toHaveLength(1);
    expect(new Set(results.map((result) => result?.course.id)).size).toBe(1);
  });

  it('is refused by the database itself as a second draft for the same patient', async () => {
    const p = await pair();
    await draft(p);
    expect(
      await violation(sql()`
        insert into treatment_courses
          (care_relationship_id, patient_id, clinician_id, clinic_id, duration_days, timezone)
        values (${p.relationshipId}, ${p.patientId}, ${p.doctorId}, ${p.clinicId}, 7, 'Asia/Tashkent')`),
    ).toBe('treatment_courses_one_draft_idx');
  });

  it('is only for a confirmed patient of this very doctor', async () => {
    const p = await pair();
    const other = await pair();
    const waiting = await insertPatient(sql());
    const pending = await insertRelationship(sql(), waiting, p.doctorId, 'PENDING');
    const former = await insertPatient(sql());
    const ended = await insertRelationship(sql(), former, p.doctorId, 'ENDED');

    for (const relationshipId of [
      other.relationshipId,
      pending,
      ended,
      '00000000-0000-4000-8000-000000000000',
    ]) {
      expect(
        await repos.plans.openDraft(clinician(p.doctorId), { relationshipId, durationDays: 7 }),
        relationshipId,
      ).toBeNull();
    }
  });

  it('is refused to a doctor without standing and for a patient whose account is closed', async () => {
    const revoked = await pair();
    await sql()`update clinician_profiles set verification_status = 'REVOKED' where user_id = ${revoked.doctorId}`;
    const blocked = await pair();
    await sql()`update users set status = 'BLOCKED' where id = ${blocked.patientId}`;

    for (const p of [revoked, blocked]) {
      expect(
        await repos.plans.openDraft(clinician(p.doctorId), {
          relationshipId: p.relationshipId,
          durationDays: 7,
        }),
      ).toBeNull();
    }
  });

  it('is only for doctors, and only for a sensible length', async () => {
    const p = await pair();
    for (const actor of [patient(p.patientId), system]) {
      await expect(
        repos.plans.openDraft(actor, { relationshipId: p.relationshipId, durationDays: 7 }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    for (const bad of [0, -1, 366, 1.5, Number.NaN]) {
      await expect(
        repos.plans.openDraft(clinician(p.doctorId), {
          relationshipId: p.relationshipId,
          durationDays: bad,
        }),
      ).rejects.toThrow(RangeError);
    }
  });
});

describe('medications in a draft', () => {
  it('stores a scheduled medication: dose, unit, food rule and one rule per time of day', async () => {
    const p = await pair();
    const courseId = await draft(p);

    const result = await add(p, courseId, {
      displayName: '  Amoxicillin  ',
      doseValue: 0.5,
      doseDisplay: '1/2',
      doseUnit: 'TABLET',
      schedule: { kind: 'TIMES', times: ['20:00', '08:00'] },
    });

    expect(result.status).toBe('ADDED');
    const plan = await repos.plans.getPlan(clinician(p.doctorId), courseId);
    expect(plan?.medications).toHaveLength(1);
    expect(plan?.medications[0]).toMatchObject({
      displayName: 'Amoxicillin',
      doseValue: '0.500',
      doseDisplay: '1/2',
      doseUnit: 'TABLET',
      foodRule: 'AFTER_MEAL',
      prn: false,
      activeFromDay: 1,
      activeToDay: 7,
      instructions: null,
    });
    expect(plan?.medications[0]?.rules.map((rule) => rule.localTime)).toEqual([
      '08:00:00',
      '20:00:00',
    ]);
  });

  it('stores an as-needed medication with its limits and no schedule', async () => {
    const p = await pair();
    const courseId = await draft(p);
    await add(p, courseId, {
      displayName: 'Painaway',
      schedule: { kind: 'PRN', maxDailyDoses: 3, minimumIntervalMinutes: 240 },
    });

    const plan = await repos.plans.getPlan(clinician(p.doctorId), courseId);
    expect(plan?.medications[0]).toMatchObject({
      prn: true,
      maxDailyDoses: 3,
      minimumIntervalMinutes: 240,
      rules: [],
    });
  });

  it('encrypts the instructions and keeps the name and text out of the audit log', async () => {
    const p = await pair();
    const courseId = await draft(p);
    await add(p, courseId, {
      displayName: 'Unmistakablol',
      instructions: '  Drink plenty of water afterwards  ',
    });

    const [row] = await sql()<{ instructions_enc: string }[]>`
      select m.instructions_enc from course_medications m
      join treatment_courses c on c.current_revision_id = m.revision_id where c.id = ${courseId}`;
    expect(row?.instructions_enc).not.toContain('water');
    expect(
      (await repos.plans.getPlan(clinician(p.doctorId), courseId))?.medications[0]?.instructions,
    ).toBe('Drink plenty of water afterwards');

    const [leaks] = await sql()<{ n: number }[]>`
      select count(*)::int as n from audit_log a
      where a::text like '%Unmistakablol%' or a::text like '%water%'`;
    expect(leaks?.n).toBe(0);
    const [audited] = await sql()<{ n: number }[]>`
      select count(*)::int as n from audit_log
      where entity_type = 'course_medications' and action = 'CREATE' and actor_user_id = ${p.doctorId}`;
    expect(audited?.n).toBe(1);
  });

  it('keeps medications in the order the doctor wrote them', async () => {
    const p = await pair();
    const courseId = await draft(p);
    for (const name of ['First', 'Second', 'Third']) {
      await add(p, courseId, { displayName: name });
    }
    const plan = await repos.plans.getPlan(clinician(p.doctorId), courseId);
    expect(plan?.medications.map((medication) => medication.displayName)).toEqual([
      'First',
      'Second',
      'Third',
    ]);
  });

  it.each<[string, Partial<NewMedication>]>([
    ['an empty name', { displayName: '   ' }],
    ['a name that is too long', { displayName: 'x'.repeat(121) }],
    ['a zero dose', { doseValue: 0 }],
    ['a negative dose', { doseValue: -1 }],
    ['a dose that is not a number', { doseValue: Number.NaN }],
    ['a dose finer than three decimals', { doseValue: 0.0001 }],
    ['an absurdly large dose', { doseValue: 10_000_000 }],
    ['another unit without its wording', { doseUnit: 'OTHER' }],
    ['instructions that are too long', { instructions: 'x'.repeat(301) }],
    ['a day before the course', { activeFromDay: 0 }],
    ['days beyond the course', { activeToDay: 8 }],
    ['days in the wrong order', { activeFromDay: 5, activeToDay: 3 }],
    ['no time at all', { schedule: { kind: 'TIMES', times: [] } }],
    ['the same time twice', { schedule: { kind: 'TIMES', times: ['08:00', '08:00:00'] } }],
    ['a time that does not exist', { schedule: { kind: 'TIMES', times: ['24:00'] } }],
    [
      'too many times a day',
      {
        schedule: {
          kind: 'TIMES',
          times: Array.from({ length: 13 }, (_v, hour) => `${String(hour).padStart(2, '0')}:00`),
        },
      },
    ],
    [
      'as-needed with no daily limit',
      { schedule: { kind: 'PRN', maxDailyDoses: 0, minimumIntervalMinutes: 60 } },
    ],
    [
      'as-needed with no interval',
      { schedule: { kind: 'PRN', maxDailyDoses: 2, minimumIntervalMinutes: 0 } },
    ],
    [
      'as-needed 25 times a day',
      { schedule: { kind: 'PRN', maxDailyDoses: 25, minimumIntervalMinutes: 60 } },
    ],
  ])('refuses %s, and stores nothing', async (_label, bad) => {
    const p = await pair();
    const courseId = await draft(p);
    await expect(add(p, courseId, bad)).rejects.toThrow(RangeError);
    expect((await repos.plans.getPlan(clinician(p.doctorId), courseId))?.medications).toEqual([]);
  });

  it('stops at the limit', async () => {
    const p = await pair();
    const courseId = await draft(p);
    for (let index = 0; index < MAX_MEDICATIONS; index += 1) {
      expect((await add(p, courseId, { displayName: `Drug ${String(index)}` })).status).toBe(
        'ADDED',
      );
    }
    expect((await add(p, courseId)).status).toBe('LIMIT');
  });

  it('can be removed, with its schedule, by its own doctor only', async () => {
    const p = await pair();
    const intruder = await pair();
    const courseId = await draft(p);
    const added = await add(p, courseId);
    const medicationId = added.status === 'ADDED' ? added.medicationId : '';

    expect(
      await repos.plans.removeMedication(clinician(intruder.doctorId), medicationId),
    ).toBeNull();
    expect(await repos.plans.removeMedication(clinician(p.doctorId), medicationId)).toBe(courseId);
    expect(await repos.plans.removeMedication(clinician(p.doctorId), medicationId)).toBeNull();

    const [rules] = await sql()<{ n: number }[]>`
      select count(*)::int as n from schedule_rules where medication_id = ${medicationId}`;
    expect(rules?.n).toBe(0);
    await expect(
      repos.plans.removeMedication(patient(p.patientId), medicationId),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('cannot be added by anyone but the draft’s own doctor', async () => {
    const p = await pair();
    const intruder = await pair();
    const courseId = await draft(p);

    expect(
      (await repos.plans.addMedication(clinician(intruder.doctorId), courseId, TABLET)).status,
    ).toBe('NOT_EDITABLE');
    await expect(
      repos.plans.addMedication(patient(p.patientId), courseId, TABLET),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await repos.plans.getPlan(clinician(p.doctorId), courseId))?.medications).toEqual([]);
  });

  it('cannot be added once the doctor’s right to the patient has gone', async () => {
    const ended = await pair();
    const endedCourse = await draft(ended);
    await sql()`update care_relationships set status = 'ENDED', ended_at = now() where id = ${ended.relationshipId}`;
    const revoked = await pair();
    const revokedCourse = await draft(revoked);
    await sql()`update clinician_profiles set verification_status = 'REVOKED' where user_id = ${revoked.doctorId}`;

    expect((await add(ended, endedCourse)).status).toBe('NOT_EDITABLE');
    expect((await add(revoked, revokedCourse)).status).toBe('NOT_EDITABLE');
  });
});

describe('changing the length of a draft', () => {
  it('stretches and shrinks medications prescribed for the whole course', async () => {
    const p = await pair();
    const courseId = await draft(p, 7);
    await add(p, courseId, { displayName: 'Whole', activeToDay: 7 });
    await add(p, courseId, { displayName: 'Early', activeFromDay: 1, activeToDay: 3 });

    expect(await repos.plans.setDuration(clinician(p.doctorId), courseId, 10)).toEqual({
      status: 'OK',
    });
    let plan = await repos.plans.getPlan(clinician(p.doctorId), courseId);
    expect(plan?.course.durationDays).toBe(10);
    expect(plan?.medications.map((m) => [m.displayName, m.activeFromDay, m.activeToDay])).toEqual([
      ['Whole', 1, 10],
      ['Early', 1, 3],
    ]);

    expect(await repos.plans.setDuration(clinician(p.doctorId), courseId, 5)).toEqual({
      status: 'OK',
    });
    plan = await repos.plans.getPlan(clinician(p.doctorId), courseId);
    expect(plan?.medications.map((m) => [m.displayName, m.activeFromDay, m.activeToDay])).toEqual([
      ['Whole', 1, 5],
      ['Early', 1, 3],
    ]);
  });

  it('refuses to cut off days a medication was prescribed for, and changes nothing', async () => {
    const p = await pair();
    const courseId = await draft(p, 10);
    await add(p, courseId, { displayName: 'Whole', activeToDay: 10 });
    await add(p, courseId, { displayName: 'Late', activeFromDay: 6, activeToDay: 8 });

    expect(await repos.plans.setDuration(clinician(p.doctorId), courseId, 7)).toEqual({
      status: 'CONFLICT',
      medicationName: 'Late',
    });
    const plan = await repos.plans.getPlan(clinician(p.doctorId), courseId);
    expect(plan?.course.durationDays).toBe(10);
    expect(plan?.medications[0]?.activeToDay).toBe(10);
  });

  it('is for the draft’s own doctor, while it is a draft, and for a sensible length', async () => {
    const p = await pair();
    const intruder = await pair();
    const courseId = await draft(p);
    expect(await repos.plans.setDuration(clinician(intruder.doctorId), courseId, 5)).toEqual({
      status: 'NOT_EDITABLE',
    });
    await expect(repos.plans.setDuration(clinician(p.doctorId), courseId, 0)).rejects.toThrow(
      RangeError,
    );
    const sentCourse = await sent(await pair());
    expect((await courseRow(sentCourse))?.status).toBe('PENDING_PATIENT');
  });
});

describe('sending a course to the patient', () => {
  it('confirms the plan, opens the start window and records who did it', async () => {
    const p = await pair();
    const courseId = await draft(p);
    await add(p, courseId);

    const result = await repos.plans.send(clinician(p.doctorId), courseId, {
      windowDays: 3,
      now: NOW,
    });

    if (result.status !== 'SENT') {
      throw new Error(`expected SENT, got ${result.status}`);
    }
    expect(result.patient.locale).toBe('ru');
    expect(result.plan.course.status).toBe('PENDING_PATIENT');
    expect(await courseRow(courseId)).toMatchObject({
      status: 'PENDING_PATIENT',
      start_window_from: NOW,
      start_window_to: new Date(NOW.getTime() + 3 * DAY),
    });
    const [revision] = await sql()<{ status: string; confirmed_by_clinician_at: Date }[]>`
      select status, confirmed_by_clinician_at from course_revisions where course_id = ${courseId}`;
    expect(revision).toEqual({ status: 'CONFIRMED', confirmed_by_clinician_at: NOW });
    const history = await sql()<{ from_status: string | null; to_status: string }[]>`
      select from_status, to_status from course_transitions where course_id = ${courseId} order by id`;
    expect(history).toEqual([
      { from_status: null, to_status: 'DRAFT' },
      { from_status: 'DRAFT', to_status: 'PENDING_PATIENT' },
    ]);
    const audit = await sql()<{ action: string }[]>`
      select action from audit_log where entity_id = ${courseId} order by id`;
    expect(audit.map((row) => row.action)).toEqual(['CREATE', 'SEND']);
    // Sent, not started: nothing is scheduled and nothing will be reminded.
    const [doses] = await sql()<{ n: number }[]>`
      select count(*)::int as n from scheduled_doses where course_id = ${courseId}`;
    expect(doses?.n).toBe(0);
  });

  it('does not send an empty plan', async () => {
    const p = await pair();
    const courseId = await draft(p);

    expect(
      await repos.plans.send(clinician(p.doctorId), courseId, { windowDays: 7, now: NOW }),
    ).toEqual({
      status: 'INVALID',
      problems: [{ code: 'NO_MEDICATIONS' }],
    });
    expect((await courseRow(courseId))?.status).toBe('DRAFT');
  });

  it('does not send a plan that contradicts itself, and names the medication', async () => {
    const twice = await pair();
    const twiceCourse = await draft(twice);
    const added = await add(twice, twiceCourse, { displayName: 'Doubled' });
    const medicationId = added.status === 'ADDED' ? added.medicationId : '';
    await sql()`insert into schedule_rules (medication_id, local_time) values (${medicationId}, '08:00')`;

    const beyond = await pair();
    const beyondCourse = await draft(beyond, 7);
    await add(beyond, beyondCourse, { displayName: 'Overlong' });
    await sql()`update course_medications set active_to_day = 30 where display_name = 'Overlong'`;

    expect(
      await repos.plans.send(clinician(twice.doctorId), twiceCourse, { windowDays: 7, now: NOW }),
    ).toEqual({
      status: 'INVALID',
      problems: [{ code: 'DUPLICATE_SLOT', medicationName: 'Doubled' }],
    });
    expect(
      await repos.plans.send(clinician(beyond.doctorId), beyondCourse, { windowDays: 7, now: NOW }),
    ).toEqual({
      status: 'INVALID',
      problems: [{ code: 'MEDICATION_OUTSIDE_COURSE', medicationName: 'Overlong' }],
    });
    expect((await courseRow(twiceCourse))?.status).toBe('DRAFT');
  });

  it('happens once: a second send, even at the same moment, changes nothing', async () => {
    const p = await pair();
    const courseId = await draft(p);
    await add(p, courseId);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        repos.plans.send(clinician(p.doctorId), courseId, { windowDays: 7, now: NOW }),
      ),
    );

    expect(results.filter((result) => result.status === 'SENT')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'NOT_EDITABLE')).toHaveLength(4);
    const [history] = await sql()<{ n: number }[]>`
      select count(*)::int as n from course_transitions
      where course_id = ${courseId} and to_status = 'PENDING_PATIENT'`;
    expect(history?.n).toBe(1);
  });

  it('freezes the plan: nothing can be added, removed or edited afterwards', async () => {
    const p = await pair();
    const courseId = await sent(p);
    const plan = await repos.plans.getPlan(clinician(p.doctorId), courseId);
    const medicationId = plan?.medications[0]?.id ?? '';

    expect((await add(p, courseId)).status).toBe('NOT_EDITABLE');
    expect(await repos.plans.removeMedication(clinician(p.doctorId), medicationId)).toBeNull();
    expect(await repos.plans.setDuration(clinician(p.doctorId), courseId, 5)).toEqual({
      status: 'NOT_EDITABLE',
    });
    expect(await repos.plans.discard(clinician(p.doctorId), courseId, NOW)).toBe(false);
    // And the database refuses a direct edit of a confirmed plan.
    expect(
      await violation(
        sql()`update course_medications set dose_value = 1000 where id = ${medicationId}`,
      ),
    ).toBe('23001');
  });

  it('is for the draft’s own doctor in good standing, and a patient with an open account', async () => {
    const p = await pair();
    const intruder = await pair();
    const courseId = await draft(p);
    await add(p, courseId);
    const options = { windowDays: 7, now: NOW };

    expect((await repos.plans.send(clinician(intruder.doctorId), courseId, options)).status).toBe(
      'NOT_EDITABLE',
    );
    await expect(repos.plans.send(patient(p.patientId), courseId, options)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(repos.plans.send(system, courseId, options)).rejects.toBeInstanceOf(
      ForbiddenError,
    );

    await sql()`update users set status = 'BLOCKED' where id = ${p.patientId}`;
    expect((await repos.plans.send(clinician(p.doctorId), courseId, options)).status).toBe(
      'NOT_EDITABLE',
    );
    await sql()`update users set status = 'ACTIVE' where id = ${p.patientId}`;
    await sql()`update clinician_profiles set verification_status = 'REVOKED' where user_id = ${p.doctorId}`;
    expect((await repos.plans.send(clinician(p.doctorId), courseId, options)).status).toBe(
      'NOT_EDITABLE',
    );
    expect((await courseRow(courseId))?.status).toBe('DRAFT');
  });

  it('offers only the agreed start windows', async () => {
    const p = await pair();
    const courseId = await draft(p);
    await add(p, courseId);
    for (const bad of [0, 2, 30, -1, 1.5]) {
      await expect(
        repos.plans.send(clinician(p.doctorId), courseId, { windowDays: bad, now: NOW }),
      ).rejects.toThrow(RangeError);
    }
  });
});

describe('who sees a plan', () => {
  it('is hidden from the patient while it is a draft, and shown in full once sent', async () => {
    const p = await pair();
    const courseId = await draft(p);
    await add(p, courseId, { instructions: 'With a full glass of water' });

    expect(await repos.plans.getPlan(patient(p.patientId), courseId)).toBeNull();
    expect(await repos.plans.listForPatient(patient(p.patientId), ['DRAFT'])).toEqual([]);
    expect(await repos.courses.get(patient(p.patientId), courseId)).toBeNull();

    await repos.plans.send(clinician(p.doctorId), courseId, { windowDays: 7, now: NOW });

    const plan = await repos.plans.getPlan(patient(p.patientId), courseId);
    expect(plan).toMatchObject({
      clinician: { firstName: 'Rustam' },
      medications: [{ displayName: 'Testamol', instructions: 'With a full glass of water' }],
    });
    expect(
      (await repos.plans.listForPatient(patient(p.patientId))).map((entry) => entry.course.id),
    ).toEqual([courseId]);
  });

  it('is hidden from every other patient, doctor, caregiver of a draft, and from staff', async () => {
    const p = await pair();
    const other = await pair();
    const courseId = await sent(p);
    const draftPair = await pair();
    const draftCourse = await draft(draftPair);
    const caregiver = await insertCaregiver(sql(), draftPair.patientId, {
      addedBy: draftPair.doctorId,
    });
    const reception = await insertClinicStaff(sql(), p.clinicId);
    const admin = await insertTechAdmin(sql());

    for (const actor of [
      patient(other.patientId),
      clinician(other.doctorId),
      { kind: 'CLINIC_STAFF', userId: reception, clinicId: p.clinicId, role: 'RECEPTION' } as const,
      { kind: 'TECH_ADMIN', userId: admin } as const,
    ]) {
      expect(await repos.plans.getPlan(actor, courseId), actor.kind).toBeNull();
    }
    expect(
      await repos.plans.getPlan({ kind: 'CAREGIVER', userId: caregiver }, draftCourse),
    ).toBeNull();
  });

  it('disappears for the doctor when the relationship ends', async () => {
    const p = await pair();
    const courseId = await sent(p);
    expect(await repos.plans.getPlan(clinician(p.doctorId), courseId)).not.toBeNull();

    await sql()`update care_relationships set status = 'ENDED', ended_at = now() where id = ${p.relationshipId}`;
    expect(await repos.plans.getPlan(clinician(p.doctorId), courseId)).toBeNull();
    expect(await repos.plans.listForClinician(clinician(p.doctorId))).toEqual([]);
    // It remains the patient's own record.
    expect(await repos.plans.getPlan(patient(p.patientId), courseId)).not.toBeNull();
  });

  it('lists a doctor their own courses, newest first, with who they are for', async () => {
    const clinicId = await insertClinic(sql());
    const doctorId = await insertClinician(sql(), clinicId);
    const make = async (lastName: string): Promise<Pair> => {
      const patientId = await insertPatient(sql(), { lastName });
      return {
        clinicId,
        doctorId,
        patientId,
        relationshipId: await insertRelationship(sql(), patientId, doctorId, 'ACTIVE'),
      };
    };
    const first = await make('First');
    const second = await make('Second');
    const firstCourse = await sent(first);
    const secondCourse = await draft(second);
    await sql()`update treatment_courses set created_at = '2026-01-01' where id = ${firstCourse}`;
    await sent(await pair());

    const list = await repos.plans.listForClinician(clinician(doctorId));
    expect(list.map((entry) => [entry.courseId, entry.status, entry.patient.lastName])).toEqual([
      [secondCourse, 'DRAFT', 'Second'],
      [firstCourse, 'PENDING_PATIENT', 'First'],
    ]);
    await expect(repos.plans.listForClinician(patient(first.patientId))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    await expect(repos.plans.listForPatient(clinician(doctorId))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('throwing a draft away', () => {
  it('closes it without deleting history, and the patient never learns it existed', async () => {
    const p = await pair();
    const courseId = await draft(p);
    await add(p, courseId);

    expect(await repos.plans.discard(clinician(p.doctorId), courseId, NOW)).toBe(true);

    expect(await courseRow(courseId)).toMatchObject({
      status: 'CANCELLED',
      ended_at: NOW,
      cancellation_reason_code: DRAFT_DISCARDED,
    });
    expect(await repos.plans.getPlan(patient(p.patientId), courseId)).toBeNull();
    expect(await repos.courses.list(patient(p.patientId))).toEqual([]);
    expect(await repos.plans.listForPatient(patient(p.patientId), ['CANCELLED'])).toEqual([]);
    expect(await repos.plans.listForClinician(clinician(p.doctorId))).toEqual([]);
    expect(await repos.plans.discard(clinician(p.doctorId), courseId, NOW)).toBe(false);
  });

  it('makes room for a fresh draft', async () => {
    const p = await pair();
    const first = await draft(p);
    await repos.plans.discard(clinician(p.doctorId), first, NOW);
    const second = await draft(p);
    expect(second).not.toBe(first);
  });

  it('is for the draft’s own doctor only', async () => {
    const p = await pair();
    const intruder = await pair();
    const courseId = await draft(p);
    expect(await repos.plans.discard(clinician(intruder.doctorId), courseId, NOW)).toBe(false);
    await expect(repos.plans.discard(patient(p.patientId), courseId, NOW)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect((await courseRow(courseId))?.status).toBe('DRAFT');
  });
});

describe('starting from an earlier course', () => {
  it('copies the length, medications, schedules and instructions into a new draft', async () => {
    const p = await pair();
    const source = await draft(p, 10);
    await add(p, source, {
      displayName: 'First',
      activeToDay: 10,
      instructions: 'After breakfast',
    });
    await add(p, source, {
      displayName: 'Second',
      activeToDay: 5,
      schedule: { kind: 'PRN', maxDailyDoses: 2, minimumIntervalMinutes: 360 },
    });
    await repos.plans.send(clinician(p.doctorId), source, { windowDays: 7, now: NOW });

    expect((await repos.plans.lastSent(clinician(p.doctorId), p.relationshipId))?.courseId).toBe(
      source,
    );
    const opened = await repos.plans.openDraft(clinician(p.doctorId), {
      relationshipId: p.relationshipId,
      durationDays: 1,
      copyFrom: source,
    });

    expect(opened?.created).toBe(true);
    const copy = await repos.plans.getPlan(clinician(p.doctorId), opened?.course.id ?? '');
    const original = await repos.plans.getPlan(clinician(p.doctorId), source);
    expect(copy?.course).toMatchObject({ status: 'DRAFT', durationDays: 10 });
    expect(
      copy?.medications.map((m) => [
        m.displayName,
        m.activeToDay,
        m.prn,
        m.instructions,
        m.rules.length,
      ]),
    ).toEqual([
      ['First', 10, false, 'After breakfast', 2],
      ['Second', 5, true, null, 0],
    ]);
    // A new prescription: nothing is shared with the old one.
    const oldIds = new Set(original?.medications.flatMap((m) => [m.id, m.lineId]));
    for (const medication of copy?.medications ?? []) {
      expect(oldIds.has(medication.id)).toBe(false);
      expect(oldIds.has(medication.lineId)).toBe(false);
    }
    expect(original?.course.status).toBe('PENDING_PATIENT');
  });

  it('will not copy what is not this doctor’s to copy', async () => {
    const p = await pair();
    const other = await pair();
    const theirs = await sent(other);
    const unsent = await pair();
    const unsentDraft = await draft(unsent);
    const thrown = await pair();
    const thrownDraft = await draft(thrown);
    await repos.plans.discard(clinician(thrown.doctorId), thrownDraft, NOW);

    expect(
      await repos.plans.openDraft(clinician(p.doctorId), {
        relationshipId: p.relationshipId,
        durationDays: 7,
        copyFrom: theirs,
      }),
    ).toBeNull();
    expect(await repos.plans.draftFor(clinician(p.doctorId), p.relationshipId)).toBeNull();
    expect(
      await repos.plans.lastSent(clinician(unsent.doctorId), unsent.relationshipId),
    ).toBeNull();
    expect(unsentDraft).not.toBe('');
    expect(
      await repos.plans.lastSent(clinician(thrown.doctorId), thrown.relationshipId),
    ).toBeNull();
    expect(
      await repos.plans.openDraft(clinician(thrown.doctorId), {
        relationshipId: thrown.relationshipId,
        durationDays: 7,
        copyFrom: thrownDraft,
      }),
    ).toBeNull();
  });

  it('leaves an existing draft alone instead of copying over it', async () => {
    const p = await pair();
    const source = await sent(p);
    const existing = await draft(p, 3);

    const opened = await repos.plans.openDraft(clinician(p.doctorId), {
      relationshipId: p.relationshipId,
      durationDays: 7,
      copyFrom: source,
    });
    expect(opened).toMatchObject({ created: false, course: { id: existing, durationDays: 3 } });
    expect((await repos.plans.getPlan(clinician(p.doctorId), existing))?.medications).toEqual([]);
  });
});
