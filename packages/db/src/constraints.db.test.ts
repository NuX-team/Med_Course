import { randomBytes, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  confirmRevision,
  insertClinic,
  insertClinician,
  insertCourse,
  insertDose,
  insertMedicationWithRule,
  insertPatient,
  insertRelationship,
  insertUser,
  seedWorld,
  type World,
} from '../test/fixtures';
import { createTestDatabase, type TestDatabase } from '../test/helpers';
import { FieldCipher } from './field-cipher';

/**
 * Invariants the database enforces on its own, whatever the application does. Each test names
 * the rule it protects; most come straight from ARCHITECTURE §4, §6 and §8.3.
 */

let testDatabase: TestDatabase;
let world: World;

const sql = () => testDatabase.db.sql;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  world = await seedWorld(
    testDatabase.db.sql,
    new FieldCipher([{ id: 't', key: randomBytes(32) }]),
  );
});

afterAll(async () => {
  await testDatabase.drop();
});

const FOREIGN_KEY = '23503';
const UNIQUE = '23505';
const CHECK = '23514';
const RESTRICT = '23001';

async function violation(
  statement: PromiseLike<unknown>,
): Promise<{ code: string; constraint: string | undefined }> {
  try {
    await statement;
  } catch (error) {
    if (error instanceof postgres.PostgresError) {
      return { code: error.code, constraint: error.constraint_name };
    }
    throw error;
  }
  throw new Error('expected the database to refuse this, but the statement succeeded');
}

async function freshDraft(): Promise<{
  courseId: string;
  revisionId: string;
  medication: Awaited<ReturnType<typeof insertMedicationWithRule>>;
}> {
  // Its own patient each time: a doctor can have only one draft per patient.
  const patientId = await insertPatient(sql());
  const course = await insertCourse(sql(), {
    patientId,
    clinicianId: world.doctorA1,
    clinicId: world.clinicA,
    relationshipId: await insertRelationship(sql(), patientId, world.doctorA1),
  });
  const medication = await insertMedicationWithRule(sql(), course.revisionId);
  return { courseId: course.courseId, revisionId: course.revisionId, medication };
}

describe('people and relationships', () => {
  it('keeps telegram ids unique and positive', async () => {
    const [existing] = await sql()<{ telegram_user_id: string }[]>`
      select telegram_user_id from users limit 1`;
    expect(
      await violation(
        sql()`insert into users (telegram_user_id) values (${existing?.telegram_user_id ?? 0})`,
      ),
    ).toEqual({ code: UNIQUE, constraint: 'users_telegram_user_id_key' });
    expect(await violation(sql()`insert into users (telegram_user_id) values (0)`)).toEqual({
      code: CHECK,
      constraint: 'users_telegram_user_id_chk',
    });
  });

  it('ties the DELETED status to a deletion time', async () => {
    expect(
      await violation(
        sql()`insert into users (telegram_user_id, status) values (987654321, 'DELETED')`,
      ),
    ).toEqual({ code: CHECK, constraint: 'users_deleted_chk' });
  });

  it('does not accept a VERIFIED clinician without who verified them and when', async () => {
    const userId = await insertUser(sql());
    expect(
      await violation(sql()`
        insert into clinician_profiles (user_id, clinic_id, first_name, last_name, verification_status)
        values (${userId}, ${world.clinicA}, 'X', 'Y', 'VERIFIED')`),
    ).toEqual({ code: CHECK, constraint: 'clinician_profiles_verified_chk' });
  });

  it('allows one open relationship per clinician and patient, but any number of ended ones', async () => {
    const clinic = await insertClinic(sql());
    const clinician = await insertClinician(sql(), clinic);
    const patient = await insertPatient(sql());

    await insertRelationship(sql(), patient, clinician, 'ACTIVE');
    expect(await violation(insertRelationship(sql(), patient, clinician, 'PENDING'))).toEqual({
      code: UNIQUE,
      constraint: 'care_relationships_open_pair_idx',
    });

    await sql()`update care_relationships set status = 'ENDED', ended_at = now()
                where patient_id = ${patient} and clinician_id = ${clinician}`;
    await insertRelationship(sql(), patient, clinician, 'ACTIVE');
    await sql()`update care_relationships set status = 'ENDED', ended_at = now()
                where patient_id = ${patient} and clinician_id = ${clinician} and status = 'ACTIVE'`;
    await insertRelationship(sql(), patient, clinician, 'ENDED');
  });

  it('requires consent for ACTIVE and an end time for ENDED relationships', async () => {
    const clinic = await insertClinic(sql());
    const clinician = await insertClinician(sql(), clinic);
    const patient = await insertPatient(sql());

    expect(
      await violation(sql()`
        insert into care_relationships (patient_id, clinician_id, status)
        values (${patient}, ${clinician}, 'ACTIVE')`),
    ).toEqual({ code: CHECK, constraint: 'care_relationships_active_chk' });
    expect(
      await violation(sql()`
        insert into care_relationships (patient_id, clinician_id, status, consent_at)
        values (${patient}, ${clinician}, 'ENDED', now())`),
    ).toEqual({ code: CHECK, constraint: 'care_relationships_ended_chk' });
  });

  it('does not let someone be their own clinician', async () => {
    const clinic = await insertClinic(sql());
    const clinician = await insertClinician(sql(), clinic);
    await sql()`insert into patient_profiles (user_id, first_name, last_name) values (${clinician}, 'Self', 'Treat')`;

    expect(await violation(insertRelationship(sql(), clinician, clinician))).toEqual({
      code: CHECK,
      constraint: 'care_relationships_distinct_chk',
    });
  });

  it('does not let a caregiver be the patient, nor be added twice', async () => {
    const [existing] = await sql()<{ caregiver_user_id: string }[]>`
      select caregiver_user_id from caregiver_relationships
      where patient_id = ${world.patient1} and status = 'ACTIVE' limit 1`;

    expect(
      await violation(sql()`
        insert into caregiver_relationships (patient_id, caregiver_user_id, added_by, status, consent_at)
        values (${world.patient1}, ${world.patient1}, ${world.doctorA1}, 'ACTIVE', now())`),
    ).toEqual({ code: CHECK, constraint: 'caregiver_relationships_self_chk' });
    expect(
      await violation(sql()`
        insert into caregiver_relationships (patient_id, caregiver_user_id, added_by)
        values (${world.patient1}, ${existing?.caregiver_user_id ?? ''}, ${world.doctorA1})`),
    ).toEqual({ code: UNIQUE, constraint: 'caregiver_relationships_open_idx' });
  });

  it('refuses to delete a user who still has a profile', async () => {
    expect((await violation(sql()`delete from users where id = ${world.patient1}`)).code).toBe(
      FOREIGN_KEY,
    );
  });

  it('stamps updated_at on every update', async () => {
    const [before] = await sql()<
      { updated_at: Date }[]
    >`select updated_at from clinics where id = ${world.clinicA}`;
    await sql()`select pg_sleep(0.02)`;
    await sql()`update clinics set name = 'Clinic A renamed' where id = ${world.clinicA}`;
    const [after] = await sql()<
      { updated_at: Date }[]
    >`select updated_at from clinics where id = ${world.clinicA}`;

    expect(after?.updated_at.getTime()).toBeGreaterThan(before?.updated_at.getTime() ?? Infinity);
  });
});

describe('courses cannot be wired to the wrong people', () => {
  const insertCourseRow = (override: {
    relationship?: string;
    patient?: string;
    clinician?: string;
    clinic?: string;
  }) => sql()`
    insert into treatment_courses
      (care_relationship_id, patient_id, clinician_id, clinic_id, duration_days, timezone, status)
    values (
      ${override.relationship ?? world.course1.relationshipId}, ${override.patient ?? world.patient1},
      ${override.clinician ?? world.doctorA1}, ${override.clinic ?? world.clinicA}, 7, 'Asia/Tashkent',
      'PENDING_PATIENT'
    )`;

  it('accepts the consistent combination', async () => {
    await insertCourseRow({});
  });

  it("refuses another patient's name on a relationship", async () => {
    expect(await violation(insertCourseRow({ patient: world.patient2 }))).toEqual({
      code: FOREIGN_KEY,
      constraint: 'treatment_courses_relationship_fk',
    });
  });

  it("refuses another clinician's name on a relationship", async () => {
    expect(await violation(insertCourseRow({ clinician: world.doctorA2 }))).toEqual({
      code: FOREIGN_KEY,
      constraint: 'treatment_courses_relationship_fk',
    });
  });

  it("refuses a clinic that is not the clinician's own", async () => {
    expect(await violation(insertCourseRow({ clinic: world.clinicB }))).toEqual({
      code: FOREIGN_KEY,
      constraint: 'treatment_courses_clinician_clinic_fk',
    });
  });

  it('refuses a current revision that belongs to another course', async () => {
    const mine = await freshDraft();
    const other = await freshDraft();
    expect(
      await violation(
        sql()`update treatment_courses set current_revision_id = ${other.revisionId} where id = ${mine.courseId}`,
      ),
    ).toEqual({ code: FOREIGN_KEY, constraint: 'treatment_courses_current_revision_fk' });
  });
});

describe('course state is internally consistent', () => {
  async function updateCourse(
    set: string,
  ): Promise<{ code: string; constraint: string | undefined }> {
    const { courseId } = await freshDraft();
    return violation(sql().unsafe(`update treatment_courses set ${set} where id = '${courseId}'`));
  }

  it.each([
    ["status = 'ACTIVE'", 'treatment_courses_started_chk'],
    ["status = 'PAUSED'", 'treatment_courses_started_chk'],
    ["status = 'COMPLETED', ended_at = now()", 'treatment_courses_started_chk'],
    ["status = 'ACTIVE', start_at = now()", 'treatment_courses_start_pair_chk'],
    ["effective_start_date = '2026-10-01'", 'treatment_courses_start_pair_chk'],
    ["status = 'CANCELLED'", 'treatment_courses_ended_chk'],
    ["status = 'EXPIRED_NOT_STARTED'", 'treatment_courses_ended_chk'],
    ['duration_days = 0', 'treatment_courses_duration_chk'],
    ['duration_days = 366', 'treatment_courses_duration_chk'],
    ['start_window_from = now()', 'treatment_courses_window_chk'],
    [
      "start_window_from = now() + interval '2 days', start_window_to = now()",
      'treatment_courses_window_chk',
    ],
    ["status = 'MYSTERY'", 'treatment_courses_status_chk'],
  ])('refuses %s', async (set, constraint) => {
    expect(await updateCourse(set)).toEqual({ code: CHECK, constraint });
  });

  it('refuses a started date on a course that has not started', async () => {
    const { courseId } = await freshDraft();
    expect(
      await violation(sql()`
        update treatment_courses set start_at = now(), effective_start_date = current_date
        where id = ${courseId}`),
    ).toEqual({ code: CHECK, constraint: 'treatment_courses_not_started_chk' });
  });

  it('accepts a coherent started course', async () => {
    const { courseId } = await freshDraft();
    await sql()`
      update treatment_courses
      set status = 'ACTIVE', start_at = now(), effective_start_date = current_date
      where id = ${courseId}`;
  });
});

describe('a confirmed plan can no longer change', () => {
  it('refuses new, edited and removed medications and rules once the revision is confirmed', async () => {
    const draft = await freshDraft();
    await confirmRevision(sql(), draft.revisionId, world.doctorA1);

    const attempts = [
      sql()`insert into course_medications (revision_id, line_id, display_name, dose_value, dose_unit, active_from_day, active_to_day)
            values (${draft.revisionId}, ${randomUUID()}, 'Late', 1, 'MG', 1, 2)`,
      sql()`update course_medications set display_name = 'Edited' where id = ${draft.medication.medicationId}`,
      sql()`delete from course_medications where id = ${draft.medication.medicationId}`,
      sql()`insert into schedule_rules (medication_id, local_time) values (${draft.medication.medicationId}, '20:00')`,
      sql()`update schedule_rules set local_time = '21:00' where id = ${draft.medication.ruleId}`,
      sql()`delete from schedule_rules where id = ${draft.medication.ruleId}`,
    ];
    for (const attempt of attempts) {
      expect((await violation(attempt)).code).toBe(RESTRICT);
    }
  });

  it('lets a draft be edited freely', async () => {
    const draft = await freshDraft();
    await sql()`update course_medications set display_name = 'Edited' where id = ${draft.medication.medicationId}`;
    await sql()`delete from schedule_rules where id = ${draft.medication.ruleId}`;
    await sql()`delete from course_medications where id = ${draft.medication.medicationId}`;
  });

  it('does not let a medication move between revisions', async () => {
    const a = await freshDraft();
    const b = await freshDraft();
    expect(
      (
        await violation(
          sql()`update course_medications set revision_id = ${b.revisionId} where id = ${a.medication.medicationId}`,
        )
      ).code,
    ).toBe(RESTRICT);
  });

  it('only moves a revision forward: DRAFT, CONFIRMED, APPLIED, SUPERSEDED', async () => {
    const { revisionId } = await freshDraft();
    await confirmRevision(sql(), revisionId, world.doctorA1);

    expect(
      (
        await violation(
          sql()`update course_revisions set status = 'DRAFT' where id = ${revisionId}`,
        )
      ).code,
    ).toBe(RESTRICT);

    await sql()`update course_revisions set status = 'APPLIED', applied_at = now() where id = ${revisionId}`;
    expect(
      (
        await violation(
          sql()`update course_revisions set status = 'CONFIRMED' where id = ${revisionId}`,
        )
      ).code,
    ).toBe(RESTRICT);
    await sql()`update course_revisions set status = 'SUPERSEDED' where id = ${revisionId}`;
    expect(
      (
        await violation(
          sql()`update course_revisions set status = 'APPLIED' where id = ${revisionId}`,
        )
      ).code,
    ).toBe(RESTRICT);
  });

  it('refuses to delete a confirmed revision and to renumber any', async () => {
    const draft = await freshDraft();
    expect(
      (
        await violation(
          sql()`update course_revisions set rev_no = 9 where id = ${draft.revisionId}`,
        )
      ).code,
    ).toBe(RESTRICT);

    await confirmRevision(sql(), draft.revisionId, world.doctorA1);
    expect(
      (await violation(sql()`delete from course_revisions where id = ${draft.revisionId}`)).code,
    ).toBe(RESTRICT);
  });

  it('allows a single APPLIED revision per course', async () => {
    const { courseId, revisionId } = await freshDraft();
    await confirmRevision(sql(), revisionId, world.doctorA1);
    await sql()`update course_revisions set status = 'APPLIED', applied_at = now() where id = ${revisionId}`;

    expect(
      await violation(sql()`
        insert into course_revisions (course_id, rev_no, created_by, status, confirmed_by_clinician_at, applied_at)
        values (${courseId}, 2, ${world.doctorA1}, 'APPLIED', now(), now())`),
    ).toEqual({ code: UNIQUE, constraint: 'course_revisions_one_applied_idx' });
  });

  it('allows a single plan in the making per course, next to the one in force', async () => {
    const { courseId, revisionId } = await freshDraft();
    // While the first plan is still a draft, a second draft cannot appear.
    expect(
      await violation(sql()`
        insert into course_revisions (course_id, rev_no, created_by) values (${courseId}, 2, ${world.doctorA1})`),
    ).toEqual({ code: UNIQUE, constraint: 'course_revisions_one_pending_idx' });

    await confirmRevision(sql(), revisionId, world.doctorA1);
    await sql()`update course_revisions set status = 'APPLIED', applied_at = now() where id = ${revisionId}`;
    await sql()`
      insert into course_revisions (course_id, rev_no, created_by) values (${courseId}, 2, ${world.doctorA1})`;
    expect(
      await violation(sql()`
        insert into course_revisions (course_id, rev_no, created_by, status, confirmed_by_clinician_at)
        values (${courseId}, 3, ${world.doctorA1}, 'CONFIRMED', now())`),
    ).toEqual({ code: UNIQUE, constraint: 'course_revisions_one_pending_idx' });
  });

  it('lets a plan that was proposed and withdrawn be superseded without ever being applied', async () => {
    const { revisionId } = await freshDraft();
    await confirmRevision(sql(), revisionId, world.doctorA1);
    await sql()`update course_revisions set status = 'SUPERSEDED' where id = ${revisionId}`;
    const [row] = await sql()<{ status: string; applied_at: Date | null }[]>`
      select status, applied_at from course_revisions where id = ${revisionId}`;
    expect(row).toEqual({ status: 'SUPERSEDED', applied_at: null });
    // But a plan in force always says since when.
    const other = await freshDraft();
    await confirmRevision(sql(), other.revisionId, world.doctorA1);
    expect(
      await violation(
        sql()`update course_revisions set status = 'APPLIED' where id = ${other.revisionId}`,
      ),
    ).toEqual({ code: CHECK, constraint: 'course_revisions_applied_chk' });
  });
});

describe('the holds of a course', () => {
  const T0 = new Date('2026-10-03T03:00:00Z');
  const T1 = new Date('2026-10-04T03:00:00Z');

  async function pause(courseId: string, at: Date): Promise<string> {
    const [row] = await sql()<{ id: string }[]>`
      insert into course_pauses (course_id, paused_at, paused_by)
      values (${courseId}, ${at}, ${world.doctorA1}) returning id`;
    return row?.id ?? '';
  }

  it('are open one at a time per course', async () => {
    const { courseId } = await freshDraft();
    const first = await pause(courseId, T0);
    expect(await violation(pause(courseId, T1))).toEqual({
      code: UNIQUE,
      constraint: 'course_pauses_one_open_idx',
    });
    await sql()`update course_pauses set resumed_at = ${T1}, resumed_by = ${world.doctorA1} where id = ${first}`;
    await pause(courseId, new Date(T1.getTime() + 1000));
  });

  it('end after they begin, and say who ended them', async () => {
    const { courseId } = await freshDraft();
    const id = await pause(courseId, T1);
    for (const end of [T1, T0]) {
      expect(
        await violation(
          sql()`update course_pauses set resumed_at = ${end}, resumed_by = ${world.doctorA1} where id = ${id}`,
        ),
      ).toEqual({ code: CHECK, constraint: 'course_pauses_order_chk' });
    }
    expect(
      await violation(
        sql()`update course_pauses set resumed_at = ${new Date(T1.getTime() + 1)} where id = ${id}`,
      ),
    ).toEqual({ code: CHECK, constraint: 'course_pauses_resumed_pair_chk' });
  });

  it('are history: never deleted, never moved, and closed only once', async () => {
    const { courseId } = await freshDraft();
    const id = await pause(courseId, T0);
    expect((await violation(sql()`delete from course_pauses where id = ${id}`)).code).toBe(
      RESTRICT,
    );
    expect(
      (await violation(sql()`update course_pauses set paused_at = ${T1} where id = ${id}`)).code,
    ).toBe(RESTRICT);

    await sql()`update course_pauses set resumed_at = ${T1}, resumed_by = ${world.doctorA1} where id = ${id}`;
    expect(
      (
        await violation(
          sql()`update course_pauses set resumed_at = ${new Date(T1.getTime() + 60_000)} where id = ${id}`,
        )
      ).code,
    ).toBe(RESTRICT);
    expect(
      (
        await violation(
          sql()`update course_pauses set resumed_at = null, resumed_by = null where id = ${id}`,
        )
      ).code,
    ).toBe(RESTRICT);
  });
});

describe('medications and schedule rules', () => {
  it('never lets an as-needed (PRN) medication exist without both limits', async () => {
    const { revisionId } = await freshDraft();
    for (const limits of ['null, null', '3, null', 'null, 240']) {
      expect(
        await violation(
          sql().unsafe(`
          insert into course_medications
            (revision_id, line_id, display_name, dose_value, dose_unit, active_from_day, active_to_day,
             prn, max_daily_doses, minimum_interval_minutes)
          values ('${revisionId}', '${randomUUID()}', 'PRN drug', 1, 'TABLET', 1, 7, true, ${limits})`),
        ),
      ).toEqual({ code: CHECK, constraint: 'course_medications_prn_chk' });
    }
  });

  it('gives a PRN medication no schedule: nothing can be planned for it', async () => {
    const { revisionId } = await freshDraft();
    const [prn] = await sql()<{ id: string }[]>`
      insert into course_medications
        (revision_id, line_id, display_name, dose_value, dose_unit, active_from_day, active_to_day,
         prn, max_daily_doses, minimum_interval_minutes)
      values (${revisionId}, ${randomUUID()}, 'PRN drug', 1, 'TABLET', 1, 7, true, 3, 240)
      returning id`;

    expect(
      (
        await violation(
          sql()`insert into schedule_rules (medication_id, local_time) values (${prn?.id ?? ''}, '08:00')`,
        )
      ).code,
    ).toBe(RESTRICT);
  });

  it('does not let a scheduled medication be turned into PRN afterwards', async () => {
    const draft = await freshDraft();
    expect(
      (
        await violation(sql()`
          update course_medications
          set prn = true, max_daily_doses = 3, minimum_interval_minutes = 240
          where id = ${draft.medication.medicationId}`)
      ).code,
    ).toBe(RESTRICT);
  });

  it('requires the doctor’s own wording when the unit is OTHER', async () => {
    const { revisionId } = await freshDraft();
    expect(
      await violation(sql()`
        insert into course_medications (revision_id, line_id, display_name, dose_value, dose_unit, active_from_day, active_to_day)
        values (${revisionId}, ${randomUUID()}, 'Odd', 1, 'OTHER', 1, 7)`),
    ).toEqual({ code: CHECK, constraint: 'course_medications_other_unit_chk' });
  });

  it.each([
    ['dose_value = 0', 'course_medications_dose_value_chk'],
    ['active_from_day = 0', 'course_medications_from_day_chk'],
    ['active_to_day = 0', 'course_medications_days_chk'],
    ["dose_unit = 'BUCKET'", 'course_medications_dose_unit_chk'],
    ["food_rule = 'WHENEVER'", 'course_medications_food_rule_chk'],
    ["display_name = '   '", 'course_medications_name_len_chk'],
  ])('refuses a medication with %s', async (set, constraint) => {
    const draft = await freshDraft();
    expect(
      await violation(
        sql().unsafe(
          `update course_medications set ${set} where id = '${draft.medication.medicationId}'`,
        ),
      ),
    ).toEqual({ code: CHECK, constraint });
  });

  it.each([
    ["days_of_week = '{}'", 'schedule_rules_days_of_week_chk'],
    ["days_of_week = '{0}'", 'schedule_rules_days_of_week_chk'],
    ["days_of_week = '{8}'", 'schedule_rules_days_of_week_chk'],
    ['day_from = 2', 'schedule_rules_day_range_chk'],
    ['day_from = 3, day_to = 2', 'schedule_rules_day_range_chk'],
  ])('refuses a schedule rule with %s', async (set, constraint) => {
    const draft = await freshDraft();
    expect(
      await violation(
        sql().unsafe(`update schedule_rules set ${set} where id = '${draft.medication.ruleId}'`),
      ),
    ).toEqual({ code: CHECK, constraint });
  });

  it('keeps every reminder policy consistent: the deadline must fall after the last attempt', async () => {
    const { courseId } = await freshDraft();
    // 3 attempts every 10 minutes: the last one is sent at +20, so the deadline must be later.
    expect(
      await violation(
        sql()`update reminder_policies set miss_after_minutes = 20 where course_id = ${courseId}`,
      ),
    ).toEqual({ code: CHECK, constraint: 'reminder_policies_deadline_chk' });
    await sql()`update reminder_policies set miss_after_minutes = 21 where course_id = ${courseId}`;
  });

  it.each([
    ['attempts = 0', 'reminder_policies_attempts_chk'],
    ['retry_interval_minutes = 0', 'reminder_policies_retry_chk'],
    ["snooze_options_minutes = '{}'", 'reminder_policies_snooze_chk'],
    ["snooze_options_minutes = '{5,0}'", 'reminder_policies_snooze_chk'],
    ['max_snoozes = 11', 'reminder_policies_max_snoozes_chk'],
  ])('refuses a reminder policy with %s', async (set, constraint) => {
    const { courseId } = await freshDraft();
    expect(
      await violation(
        sql().unsafe(`update reminder_policies set ${set} where course_id = '${courseId}'`),
      ),
    ).toEqual({ code: CHECK, constraint });
  });

  it('allows one reminder policy per course', async () => {
    const { courseId } = await freshDraft();
    expect(
      await violation(sql()`insert into reminder_policies (course_id) values (${courseId})`),
    ).toEqual({
      code: UNIQUE,
      constraint: 'reminder_policies_course_id_key',
    });
  });
});

describe('scheduled doses', () => {
  async function setup() {
    const draft = await freshDraft();
    const slot = new Date('2026-10-05T03:00:00Z');
    const doseId = await insertDose(
      sql(),
      { courseId: draft.courseId, revisionId: draft.revisionId, medication: draft.medication },
      { scheduledAt: slot },
    );
    return { ...draft, doseId, slot };
  }

  const insertRaw = (
    d: Awaited<ReturnType<typeof setup>>,
    options: { at?: Date; deadlineMinutes?: number } = {},
  ) => {
    const at = options.at ?? d.slot;
    const deadline = new Date(at.getTime() + (options.deadlineMinutes ?? 30) * 60_000);
    return sql()`
      insert into scheduled_doses
        (course_id, revision_id, medication_id, medication_line_id, schedule_rule_id, scheduled_at, deadline_at)
      values (${d.courseId}, ${d.revisionId}, ${d.medication.medicationId}, ${d.medication.lineId},
              ${d.medication.ruleId}, ${at}, ${deadline})`;
  };

  it('never holds two live slots for one drug at one moment', async () => {
    const d = await setup();
    expect(await violation(insertRaw(d))).toEqual({
      code: UNIQUE,
      constraint: 'scheduled_doses_slot_idx',
    });
  });

  it('frees the slot once the old dose is SUPERSEDED, as when a plan is replaced', async () => {
    const d = await setup();
    await sql()`update scheduled_doses set status = 'SUPERSEDED' where id = ${d.doseId}`;
    await insertRaw(d);
  });

  it('puts the deadline after the slot', async () => {
    const d = await setup();
    expect(
      await violation(insertRaw(d, { at: new Date('2026-10-06T03:00:00Z'), deadlineMinutes: 0 })),
    ).toEqual({ code: CHECK, constraint: 'scheduled_doses_deadline_chk' });
  });

  it.each([
    ["status = 'TAKEN'", 'scheduled_doses_finalized_chk'],
    ["status = 'SKIPPED'", 'scheduled_doses_finalized_chk'],
    ["status = 'NOTIFIED', finalized_at = now()", 'scheduled_doses_finalized_chk'],
    ["status = 'MISSED', finalized_at = now()", 'scheduled_doses_missed_chk'],
    ["status = 'TAKEN_LATE', finalized_at = now(), missed_at = now()", 'scheduled_doses_late_chk'],
    ["status = 'TAKEN', finalized_at = now(), missed_at = now()", 'scheduled_doses_missed_chk'],
  ])('keeps outcome timestamps in step with status: %s', async (set, constraint) => {
    const d = await setup();
    expect(
      await violation(sql().unsafe(`update scheduled_doses set ${set} where id = '${d.doseId}'`)),
    ).toEqual({ code: CHECK, constraint });
  });

  it('walks SCHEDULED, NOTIFIED, MISSED, TAKEN_LATE with consistent timestamps', async () => {
    const d = await setup();
    await sql()`update scheduled_doses set status = 'NOTIFIED' where id = ${d.doseId}`;
    await sql()`update scheduled_doses set status = 'MISSED', missed_at = now(), finalized_at = now() where id = ${d.doseId}`;
    await sql()`update scheduled_doses set status = 'TAKEN_LATE', late_taken_at = now() where id = ${d.doseId}`;
  });

  it('keeps a dose inside its own course, revision, medication and rule', async () => {
    const a = await setup();
    const b = await setup();

    const wrongRevision = sql()`
      insert into scheduled_doses (course_id, revision_id, medication_id, medication_line_id, schedule_rule_id, scheduled_at, deadline_at)
      values (${a.courseId}, ${b.revisionId}, ${a.medication.medicationId}, ${a.medication.lineId},
              ${a.medication.ruleId}, '2026-10-07T03:00:00Z', '2026-10-07T03:30:00Z')`;
    const wrongRule = sql()`
      insert into scheduled_doses (course_id, revision_id, medication_id, medication_line_id, schedule_rule_id, scheduled_at, deadline_at)
      values (${a.courseId}, ${a.revisionId}, ${a.medication.medicationId}, ${a.medication.lineId},
              ${b.medication.ruleId}, '2026-10-08T03:00:00Z', '2026-10-08T03:30:00Z')`;
    const wrongLine = sql()`
      insert into scheduled_doses (course_id, revision_id, medication_id, medication_line_id, schedule_rule_id, scheduled_at, deadline_at)
      values (${a.courseId}, ${a.revisionId}, ${a.medication.medicationId}, ${b.medication.lineId},
              ${a.medication.ruleId}, '2026-10-09T03:00:00Z', '2026-10-09T03:30:00Z')`;

    expect((await violation(wrongRevision)).code).toBe(FOREIGN_KEY);
    expect((await violation(wrongRule)).code).toBe(FOREIGN_KEY);
    expect((await violation(wrongLine)).code).toBe(FOREIGN_KEY);
  });
});

describe('the event log', () => {
  const insertEvent = (o: {
    dose?: string | null;
    course?: string;
    line?: string | null;
    type?: string;
    actorKind?: string;
    actor?: string | null;
    source?: string;
    key?: string;
    reasonCode?: string | null;
    reasonText?: string | null;
  }) => {
    const e = {
      dose: world.course1.doseId,
      course: world.course1.courseId,
      line: null,
      type: 'TAKEN',
      actorKind: 'PATIENT',
      actor: world.patient1,
      source: 'TELEGRAM',
      key: randomUUID(),
      reasonCode: null,
      reasonText: null,
      ...o,
    };
    return sql()`
      insert into dose_events
        (scheduled_dose_id, course_id, medication_line_id, event_type, actor_kind, actor_user_id,
         reason_code, reason_text_enc, source, idempotency_key, occurred_at)
      values (${e.dose}, ${e.course}, ${e.line}, ${e.type}, ${e.actorKind}, ${e.actor},
              ${e.reasonCode}, ${e.reasonText}, ${e.source}, ${e.key}, now())`;
  };

  it('accepts a well-formed event', async () => {
    await insertEvent({});
  });

  it('turns a repeated idempotency key into a conflict', async () => {
    const key = randomUUID();
    await insertEvent({ key });
    expect(await violation(insertEvent({ key }))).toEqual({
      code: UNIQUE,
      constraint: 'dose_events_idempotency_key_key',
    });
  });

  it("refuses an event whose course is not the dose's course", async () => {
    expect((await violation(insertEvent({ course: world.course2.courseId }))).code).toBe(
      FOREIGN_KEY,
    );
  });

  it('ties PRN intake to a medication line, not to a slot', async () => {
    expect(await violation(insertEvent({ type: 'PRN_TAKEN', dose: null, line: null }))).toEqual({
      code: CHECK,
      constraint: 'dose_events_prn_line_chk',
    });
    expect(await violation(insertEvent({ type: 'TAKEN', dose: null, line: randomUUID() }))).toEqual(
      {
        code: CHECK,
        constraint: 'dose_events_prn_chk',
      },
    );
    await insertEvent({ type: 'PRN_TAKEN', dose: null, line: randomUUID() });
  });

  it('holds a taken-back PRN mark to the same shape: a line, and no slot', async () => {
    expect(await violation(insertEvent({ type: 'PRN_CANCELLED', dose: null, line: null }))).toEqual(
      { code: CHECK, constraint: 'dose_events_prn_line_chk' },
    );
    expect(await violation(insertEvent({ type: 'PRN_CANCELLED', line: randomUUID() }))).toEqual({
      code: CHECK,
      constraint: 'dose_events_prn_chk',
    });
    await insertEvent({ type: 'PRN_CANCELLED', dose: null, line: randomUUID() });
  });

  it('allows a reason only on SKIPPED, and free text only with reason OTHER', async () => {
    expect(await violation(insertEvent({ type: 'TAKEN', reasonCode: 'FORGOT' }))).toEqual({
      code: CHECK,
      constraint: 'dose_events_reason_chk',
    });
    expect(
      await violation(
        insertEvent({ type: 'SKIPPED', reasonCode: 'FORGOT', reasonText: 'v1.x.y.z.w' }),
      ),
    ).toEqual({ code: CHECK, constraint: 'dose_events_reason_text_chk' });
    await insertEvent({ type: 'SKIPPED', reasonCode: 'OTHER', reasonText: 'v1.x.y.z.w' });
  });

  it('writes the system as a system actor and no one else', async () => {
    expect(
      await violation(
        insertEvent({ actorKind: 'SYSTEM', actor: world.patient1, source: 'SYSTEM' }),
      ),
    ).toEqual({
      code: CHECK,
      constraint: 'dose_events_actor_chk',
    });
    expect(
      await violation(insertEvent({ actorKind: 'SYSTEM', actor: null, source: 'TELEGRAM' })),
    ).toEqual({
      code: CHECK,
      constraint: 'dose_events_source_actor_chk',
    });
    expect(
      await violation(
        insertEvent({ actorKind: 'PATIENT', actor: world.patient1, source: 'SYSTEM' }),
      ),
    ).toEqual({
      code: CHECK,
      constraint: 'dose_events_source_actor_chk',
    });
    await insertEvent({ type: 'MISSED', actorKind: 'SYSTEM', actor: null, source: 'SYSTEM' });
  });
});

describe('what the doctor is told', () => {
  const alert = (o: {
    kind?: string;
    dose?: string | null;
    slot?: Date | null;
    line?: string | null;
    key?: string;
    status?: string;
    lockedUntil?: Date | null;
    sentAt?: Date | null;
    course?: string;
  }) => {
    const a = {
      kind: 'UNDELIVERED',
      dose: null,
      slot: null,
      line: null,
      key: randomUUID(),
      status: 'QUEUED',
      lockedUntil: null,
      sentAt: null,
      course: world.course1.courseId,
      ...o,
    };
    return sql()`
      insert into doctor_alerts
        (course_id, recipient_user_id, kind, scheduled_dose_id, slot_at, medication_line_id,
         dedupe_key, due_at, status, locked_until, sent_at)
      values (${a.course}, ${world.doctorA1}, ${a.kind}, ${a.dose}, ${a.slot}, ${a.line},
              ${a.key}, now(), ${a.status}, ${a.lockedUntil}, ${a.sentAt})`;
  };

  it('is queued once per fact', async () => {
    const key = `missed:${randomUUID()}`;
    await alert({ kind: 'MISSED', slot: new Date(), key });
    expect(await violation(alert({ kind: 'MISSED', slot: new Date(), key }))).toEqual({
      code: UNIQUE,
      constraint: 'doctor_alerts_dedupe_key_key',
    });
  });

  it('names what it is about: a dose for a skip, a moment for a miss or a run, a drug for PRN', async () => {
    expect(await violation(alert({ kind: 'SKIPPED' }))).toEqual({
      code: CHECK,
      constraint: 'doctor_alerts_skipped_chk',
    });
    expect(await violation(alert({ kind: 'MISSED', dose: world.course1.doseId }))).toEqual({
      code: CHECK,
      constraint: 'doctor_alerts_skipped_chk',
    });
    for (const kind of ['MISSED', 'SERIES', 'DIGEST']) {
      expect(await violation(alert({ kind }))).toEqual({
        code: CHECK,
        constraint: 'doctor_alerts_slot_chk',
      });
    }
    expect(await violation(alert({ kind: 'PRN_OVER', slot: new Date() }))).toEqual({
      code: CHECK,
      constraint: 'doctor_alerts_prn_chk',
    });
    expect(await violation(alert({ kind: 'PAUSE_REQUEST', line: randomUUID() }))).toEqual({
      code: CHECK,
      constraint: 'doctor_alerts_prn_chk',
    });
    await alert({ kind: 'SKIPPED', dose: world.course1.doseId });
    await alert({ kind: 'PRN_OVER', slot: new Date(), line: randomUUID() });
  });

  it('refuses a dose of another course, and an unknown kind', async () => {
    expect((await violation(alert({ kind: 'SKIPPED', dose: world.course2.doseId }))).code).toBe(
      FOREIGN_KEY,
    );
    expect(await violation(alert({ kind: 'GOSSIP' }))).toEqual({
      code: CHECK,
      constraint: 'doctor_alerts_kind_chk',
    });
  });

  it('keeps its state consistent: locked only while being sent, a time only once sent', async () => {
    expect(await violation(alert({ status: 'SENDING' }))).toEqual({
      code: CHECK,
      constraint: 'doctor_alerts_lock_chk',
    });
    expect(await violation(alert({ status: 'QUEUED', lockedUntil: new Date() }))).toEqual({
      code: CHECK,
      constraint: 'doctor_alerts_lock_chk',
    });
    expect(await violation(alert({ status: 'SENT' }))).toEqual({
      code: CHECK,
      constraint: 'doctor_alerts_sent_chk',
    });
    expect(await violation(alert({ status: 'FAILED', sentAt: new Date() }))).toEqual({
      code: CHECK,
      constraint: 'doctor_alerts_sent_chk',
    });
    await alert({ status: 'SENT', sentAt: new Date() });
  });
});

describe('a caregiver link', () => {
  const HASH = (): string => randomBytes(32).toString('hex');
  const link = (o: {
    relationship?: string;
    patient?: string;
    clinician?: string;
    hash?: string;
    usedAt?: Date | null;
    usedBy?: string | null;
    revokedAt?: Date | null;
    expiresAt?: Date;
  }) => {
    const l = {
      relationship: world.course1.relationshipId,
      patient: world.patient1,
      clinician: world.doctorA1,
      hash: HASH(),
      usedAt: null,
      usedBy: null,
      revokedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000),
      ...o,
    };
    return sql()`
      insert into caregiver_invitations
        (care_relationship_id, patient_id, clinician_id, code_hash, expires_at, used_at, used_by, revoked_at)
      values (${l.relationship}, ${l.patient}, ${l.clinician}, ${l.hash}, ${l.expiresAt},
              ${l.usedAt}, ${l.usedBy}, ${l.revokedAt})`;
  };

  it('is issued by exactly the doctor who treats exactly this patient', async () => {
    await link({});
    expect(await violation(link({ patient: world.patient2 }))).toMatchObject({
      code: FOREIGN_KEY,
      constraint: 'caregiver_invitations_relationship_fk',
    });
    expect(await violation(link({ clinician: world.doctorB1 }))).toMatchObject({
      code: FOREIGN_KEY,
      constraint: 'caregiver_invitations_relationship_fk',
    });
  });

  it('stores a hash and nothing shaped like a code, once', async () => {
    expect(await violation(link({ hash: 'AAAAAAAAAAAAAAAAAAAAAA' }))).toEqual({
      code: CHECK,
      constraint: 'caregiver_invitations_code_hash_chk',
    });
    const hash = HASH();
    await link({ hash });
    expect(await violation(link({ hash }))).toEqual({
      code: UNIQUE,
      constraint: 'caregiver_invitations_code_hash_key',
    });
  });

  it('is used by someone other than the patient, with both the moment and the person recorded', async () => {
    expect(await violation(link({ usedAt: new Date() }))).toEqual({
      code: CHECK,
      constraint: 'caregiver_invitations_used_chk',
    });
    expect(await violation(link({ usedAt: new Date(), usedBy: world.patient1 }))).toEqual({
      code: CHECK,
      constraint: 'caregiver_invitations_self_chk',
    });
    expect(
      await violation(
        link({ usedAt: new Date(), usedBy: world.strangerPatient, revokedAt: new Date() }),
      ),
    ).toEqual({ code: CHECK, constraint: 'caregiver_invitations_final_chk' });
    expect(await violation(link({ expiresAt: new Date(Date.now() - 60_000) }))).toEqual({
      code: CHECK,
      constraint: 'caregiver_invitations_expiry_chk',
    });
    await link({ usedAt: new Date(), usedBy: world.strangerPatient });
  });
});

describe('the staff panel', () => {
  const HASH = (): string => randomBytes(32).toString('hex');
  const HOUR = 3_600_000;

  it('keeps a sign-in link as a hash, once, and never already expired', async () => {
    const at = new Date();
    const login = (o: { hash?: string; expiresAt?: Date }) => sql()`
      insert into panel_logins (user_id, token_hash, created_at, expires_at)
      values (${world.techAdmin}, ${o.hash ?? HASH()}, ${at},
              ${o.expiresAt ?? new Date(at.getTime() + 300_000)})`;

    await login({});
    expect(await violation(login({ hash: randomBytes(32).toString('base64url') }))).toEqual({
      code: CHECK,
      constraint: 'panel_logins_token_hash_chk',
    });
    const hash = HASH();
    await login({ hash });
    expect(await violation(login({ hash }))).toEqual({
      code: UNIQUE,
      constraint: 'panel_logins_token_hash_key',
    });
    expect(await violation(login({ expiresAt: at }))).toEqual({
      code: CHECK,
      constraint: 'panel_logins_expiry_chk',
    });
  });

  it('keeps a session as a hash, once, with a form token and an end', async () => {
    const at = new Date();
    const session = (o: { hash?: string; csrf?: string; expiresAt?: Date }) => sql()`
      insert into panel_sessions (user_id, token_hash, csrf_token, created_at, expires_at)
      values (${world.techAdmin}, ${o.hash ?? HASH()}, ${o.csrf ?? 'c'.repeat(43)}, ${at},
              ${o.expiresAt ?? new Date(at.getTime() + 12 * HOUR)})`;

    await session({});
    expect(await violation(session({ hash: 'not a hash' }))).toEqual({
      code: CHECK,
      constraint: 'panel_sessions_token_hash_chk',
    });
    const hash = HASH();
    await session({ hash });
    expect(await violation(session({ hash }))).toEqual({
      code: UNIQUE,
      constraint: 'panel_sessions_token_hash_key',
    });
    expect(await violation(session({ csrf: 'short' }))).toEqual({
      code: CHECK,
      constraint: 'panel_sessions_csrf_len_chk',
    });
    expect(await violation(session({ expiresAt: new Date(at.getTime() - 1) }))).toEqual({
      code: CHECK,
      constraint: 'panel_sessions_expiry_chk',
    });
  });

  describe('incidents', () => {
    const incident = (o: {
      kind?: string;
      type?: string;
      clinic?: string | null;
      course?: string | null;
      key?: string;
      status?: string;
      note?: string | null;
      resolvedBy?: string | null;
      resolvedAt?: Date | null;
    }) => {
      const i = {
        kind: 'OPERATIONAL',
        type: 'MISS_SERIES',
        clinic: world.clinicA as string | null,
        course: world.course1.courseId as string | null,
        key: randomUUID(),
        status: 'OPEN',
        note: null,
        resolvedBy: null,
        resolvedAt: null,
        ...o,
      };
      return sql()`
        insert into incidents
          (kind, type, clinic_id, course_id, dedupe_key, status, resolution_note_enc, resolved_by,
           resolved_at, opened_at)
        values (${i.kind}, ${i.type}, ${i.clinic}, ${i.course}, ${i.key}, ${i.status}, ${i.note},
                ${i.resolvedBy}, ${i.resolvedAt}, now())`;
    };
    const technical = { kind: 'TECHNICAL', type: 'QUEUE_LATE', clinic: null, course: null };

    it('are recorded once per fact', async () => {
      const key = randomUUID();
      await incident({ key });
      expect(await violation(incident({ key }))).toEqual({
        code: UNIQUE,
        constraint: 'incidents_dedupe_key_key',
      });
      expect(await violation(incident({ ...technical, key }))).toMatchObject({ code: UNIQUE });
    });

    it('belong to a clinic and a course when they are about a patient, and to neither when they are about the service', async () => {
      await incident({});
      await incident(technical);
      for (const wrong of [
        { clinic: null },
        { course: null },
        { ...technical, clinic: world.clinicA },
        { ...technical, course: world.course1.courseId },
      ]) {
        expect(await violation(incident(wrong)), JSON.stringify(wrong)).toEqual({
          code: CHECK,
          constraint: 'incidents_scope_chk',
        });
      }
    });

    it('are of a type that fits their kind', async () => {
      expect(await violation(incident({ type: 'QUEUE_STUCK' }))).toEqual({
        code: CHECK,
        constraint: 'incidents_type_kind_chk',
      });
      expect(await violation(incident({ ...technical, type: 'UNDELIVERED' }))).toEqual({
        code: CHECK,
        constraint: 'incidents_type_kind_chk',
      });
      expect(await violation(incident({ type: 'SOMETHING' }))).toEqual({
        code: CHECK,
        constraint: 'incidents_type_chk',
      });
      expect(await violation(incident({ kind: 'MEDICAL' }))).toMatchObject({ code: CHECK });
    });

    it('are closed by someone at some moment, and carry a note only once closed', async () => {
      const by = world.receptionA;
      const at = new Date();
      await incident({ status: 'RESOLVED', resolvedBy: by, resolvedAt: at, note: 'v1:t:abc' });
      for (const wrong of [
        { status: 'RESOLVED' },
        { status: 'RESOLVED', resolvedBy: by },
        { status: 'RESOLVED', resolvedAt: at },
        { resolvedBy: by, resolvedAt: at },
        { resolvedAt: at },
      ]) {
        expect(await violation(incident(wrong)), JSON.stringify(wrong)).toEqual({
          code: CHECK,
          constraint: 'incidents_resolved_chk',
        });
      }
      expect(await violation(incident({ note: 'v1:t:abc' }))).toEqual({
        code: CHECK,
        constraint: 'incidents_note_chk',
      });
      expect(await violation(incident({ status: 'CLOSED' }))).toMatchObject({ code: CHECK });
    });
  });
});

describe('privacy', () => {
  const HOUR = 3_600_000;

  describe('a request for deletion', () => {
    const request = (o: { user?: string; status?: string; due?: Date; closed?: Date | null }) => {
      const at = new Date('2026-10-04T00:00:00Z');
      return sql()`
        insert into deletion_requests (user_id, status, requested_at, due_at, closed_at)
        values (${o.user ?? world.patient2}, ${o.status ?? 'DONE'}, ${at},
                ${o.due ?? new Date(at.getTime() + HOUR)},
                ${o.closed === undefined ? new Date(at.getTime() + 2 * HOUR) : o.closed})`;
    };

    it('waits one at a time per person', async () => {
      await request({ user: world.strangerPatient, status: 'PENDING', closed: null });
      expect(
        await violation(request({ user: world.strangerPatient, status: 'PENDING', closed: null })),
      ).toEqual({ code: UNIQUE, constraint: 'deletion_requests_open_idx' });
      // Requests already closed do not stand in the way of a new one.
      await request({ user: world.strangerPatient, status: 'CANCELLED' });
      await request({ user: world.strangerPatient, status: 'DONE' });
    });

    it('falls due after it is made, and is closed exactly when it is no longer waiting', async () => {
      expect(await violation(request({ due: new Date('2026-10-04T00:00:00Z') }))).toEqual({
        code: CHECK,
        constraint: 'deletion_requests_due_chk',
      });
      for (const wrong of [
        { status: 'PENDING' },
        { status: 'DONE', closed: null },
        { status: 'CANCELLED', closed: null },
      ]) {
        expect(await violation(request(wrong)), JSON.stringify(wrong)).toEqual({
          code: CHECK,
          constraint: 'deletion_requests_closed_chk',
        });
      }
      expect(await violation(request({ status: 'FORGOTTEN' }))).toMatchObject({ code: CHECK });
      expect(await violation(request({ user: randomUUID() }))).toMatchObject({ code: FOREIGN_KEY });
    });
  });

  it('lets only an anonymised account be without a real Telegram id', async () => {
    const account = (telegramId: number, status: string) => sql()`
      insert into users (telegram_user_id, status, deleted_at)
      values (${telegramId}, ${status}, ${status === 'DELETED' ? new Date() : null})`;

    await account(-900_001, 'DELETED');
    await account(900_002, 'DELETED');
    for (const [telegramId, status] of [
      [-900_003, 'ACTIVE'],
      [-900_004, 'BLOCKED'],
      [0, 'ACTIVE'],
      [0, 'DELETED'],
    ] as const) {
      expect(
        await violation(account(telegramId, status)),
        `${String(telegramId)} ${status}`,
      ).toEqual({
        code: CHECK,
        constraint: 'users_telegram_user_id_chk',
      });
    }
  });

  it('keeps one summary per course, of a real course and real people', async () => {
    const summary = (o: { course?: string; patient?: string }) => sql()`
      insert into course_summaries (course_id, patient_id, clinician_id, content, created_at)
      values (${o.course ?? world.course2.courseId}, ${o.patient ?? world.patient2},
              ${world.doctorA1}, '{}'::jsonb, now())`;

    await summary({});
    expect(await violation(summary({}))).toMatchObject({ code: UNIQUE });
    expect(await violation(summary({ course: randomUUID() }))).toMatchObject({ code: FOREIGN_KEY });
    expect(
      await violation(summary({ course: world.course3.courseId, patient: randomUUID() })),
    ).toMatchObject({ code: FOREIGN_KEY });
  });
});

describe('announcing an incident', () => {
  const incident = () => sql()`
    insert into incidents (kind, type, dedupe_key, opened_at)
    values ('TECHNICAL', 'QUEUE_LATE', ${randomUUID()}, now())
    returning id`;

  it('counts the tries within a sane range', async () => {
    const [row] = await incident();
    const set = (tries: number) =>
      sql()`update incidents set notice_tries = ${tries} where id = ${row?.id as string}`;
    await set(0);
    await set(100);
    for (const wrong of [-1, 101]) {
      expect(await violation(set(wrong)), String(wrong)).toEqual({
        code: CHECK,
        constraint: 'incidents_notice_tries_chk',
      });
    }
  });

  it('starts as not yet announced', async () => {
    const [row] = await incident();
    const [stored] = await sql()<
      { notice_tries: number; notified_at: Date | null; last_notice_at: Date | null }[]
    >`
      select notice_tries, notified_at, last_notice_at from incidents where id = ${row?.id as string}`;
    expect(stored).toEqual({ notice_tries: 0, notified_at: null, last_notice_at: null });
  });
});

describe('a report handed out as a file', () => {
  const handed = (o: { course?: string; by?: string; kind?: string; format?: string }) => sql()`
    insert into course_exports (course_id, requested_by, actor_kind, format, created_at)
    values (${o.course ?? world.course1.courseId}, ${o.by ?? world.doctorA1},
            ${o.kind ?? 'CLINICIAN'}, ${o.format ?? 'PDF'}, now())`;

  it('is recorded for a real course and a real person, in one of the two formats', async () => {
    await handed({});
    await handed({ by: world.patient1, kind: 'PATIENT', format: 'CSV' });
    expect(await violation(handed({ format: 'XLSX' }))).toEqual({
      code: CHECK,
      constraint: 'course_exports_format_chk',
    });
    expect(await violation(handed({ course: randomUUID() }))).toMatchObject({ code: FOREIGN_KEY });
    expect(await violation(handed({ by: randomUUID() }))).toMatchObject({ code: FOREIGN_KEY });
  });

  it('is only ever asked for as the patient or as the doctor', async () => {
    for (const kind of ['CLINIC_STAFF', 'TECH_ADMIN', 'CAREGIVER', 'SYSTEM']) {
      expect(await violation(handed({ kind })), kind).toEqual({
        code: CHECK,
        constraint: 'course_exports_actor_kind_chk',
      });
    }
  });
});

describe('append-only tables', () => {
  it.each([
    [
      'dose_events',
      'update dose_events set source = source',
      'delete from dose_events',
      'truncate dose_events',
    ],
    [
      'audit_log',
      'update audit_log set action = action',
      'delete from audit_log',
      'truncate audit_log',
    ],
    [
      'course_transitions',
      'update course_transitions set reason = reason',
      'delete from course_transitions',
      'truncate course_transitions',
    ],
    [
      'course_exports',
      'update course_exports set format = format',
      'delete from course_exports',
      'truncate course_exports',
    ],
  ])(
    '%s refuses UPDATE, DELETE and TRUNCATE even for the table owner',
    async (table, update, del, truncate) => {
      if (table === 'audit_log') {
        await sql()`insert into audit_log (actor_kind, entity_type, entity_id, action)
                  values ('SYSTEM', 'x', '1', 'TEST')`;
      }
      if (table === 'course_transitions') {
        await sql()`insert into course_transitions (course_id, to_status, actor_kind)
                  values (${world.course1.courseId}, 'DRAFT', 'SYSTEM')`;
      }
      if (table === 'dose_events') {
        // seedWorld already wrote one.
      }
      if (table === 'course_exports') {
        await sql()`
          insert into course_exports (course_id, requested_by, actor_kind, format, created_at)
          values (${world.course1.courseId}, ${world.patient1}, 'PATIENT', 'CSV', now())`;
      }

      for (const statement of [update, del, truncate]) {
        expect((await violation(sql().unsafe(statement))).code, `${table}: ${statement}`).toBe(
          RESTRICT,
        );
      }
      const [row] = await sql().unsafe<{ count: number }[]>(
        `select count(*)::int as count from ${table}`,
      );
      expect(row?.count).toBeGreaterThan(0);
    },
  );

  it('keeps the audit trail when the person it names is deleted', async () => {
    const userId = await insertUser(sql());
    await sql()`insert into audit_log (actor_kind, actor_user_id, entity_type, entity_id, action)
                values ('PATIENT', ${userId}, 'x', '1', 'TEST')`;
    await sql()`delete from users where id = ${userId}`;

    const rows = await sql()`select 1 from audit_log where actor_user_id = ${userId}`;
    expect(rows).toHaveLength(1);
  });
});
