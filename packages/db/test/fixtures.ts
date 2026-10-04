import { randomInt, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { fieldAad, type FieldCipher } from '../src';

/**
 * Rows inserted with plain SQL, deliberately bypassing the repositories: these tests need to
 * set up states (a revoked clinician, an ended relationship) the repositories would refuse to
 * create, and they must not depend on the code under test to arrange its own inputs.
 */

interface Id {
  id: string;
}

export async function insertUser(
  sql: Sql,
  options: { status?: 'ACTIVE' | 'BLOCKED' | 'DELETED'; telegramId?: number } = {},
): Promise<string> {
  const status = options.status ?? 'ACTIVE';
  const [row] = await sql<Id[]>`
    insert into users (telegram_user_id, status, deleted_at)
    values (${options.telegramId ?? randomInt(1_000_000, 2_000_000_000)}, ${status}, ${status === 'DELETED' ? new Date() : null})
    returning id`;
  return row?.id ?? '';
}

export async function insertClinic(
  sql: Sql,
  options: { name?: string; status?: 'ACTIVE' | 'SUSPENDED' } = {},
): Promise<string> {
  const [row] = await sql<Id[]>`
    insert into clinics (name, status)
    values (${options.name ?? 'Test clinic'}, ${options.status ?? 'ACTIVE'})
    returning id`;
  return row?.id ?? '';
}

export async function insertPatient(
  sql: Sql,
  options: {
    firstName?: string;
    lastName?: string;
    userStatus?: 'ACTIVE' | 'BLOCKED' | 'DELETED';
    telegramId?: number;
  } = {},
): Promise<string> {
  const userId = await insertUser(sql, {
    status: options.userStatus ?? 'ACTIVE',
    ...(options.telegramId === undefined ? {} : { telegramId: options.telegramId }),
  });
  await sql`
    insert into patient_profiles (user_id, first_name, last_name)
    values (${userId}, ${options.firstName ?? 'Pat'}, ${options.lastName ?? 'Ient'})`;
  return userId;
}

export async function insertClinician(
  sql: Sql,
  clinicId: string,
  options: {
    verification?: 'PENDING' | 'VERIFIED' | 'REVOKED';
    firstName?: string;
    telegramId?: number;
  } = {},
): Promise<string> {
  const userId = await insertUser(
    sql,
    options.telegramId === undefined ? {} : { telegramId: options.telegramId },
  );
  const verification = options.verification ?? 'VERIFIED';
  await sql`
    insert into clinician_profiles
      (user_id, clinic_id, first_name, last_name, verification_status, verified_by, verified_at)
    values (
      ${userId}, ${clinicId}, ${options.firstName ?? 'Doc'}, 'Tor', ${verification},
      ${verification === 'VERIFIED' ? userId : null}, ${verification === 'VERIFIED' ? new Date() : null}
    )`;
  return userId;
}

export async function insertClinicStaff(
  sql: Sql,
  clinicId: string,
  options: { role?: 'RECEPTION' | 'CLINIC_ADMIN'; status?: 'ACTIVE' | 'REVOKED' } = {},
): Promise<string> {
  const userId = await insertUser(sql);
  await sql`
    insert into clinic_staff (user_id, clinic_id, role, status)
    values (${userId}, ${clinicId}, ${options.role ?? 'RECEPTION'}, ${options.status ?? 'ACTIVE'})`;
  return userId;
}

export async function insertTechAdmin(sql: Sql): Promise<string> {
  const userId = await insertUser(sql);
  await sql`insert into platform_staff (user_id, role) values (${userId}, 'TECH_ADMIN')`;
  return userId;
}

export async function insertRelationship(
  sql: Sql,
  patientId: string,
  clinicianId: string,
  status: 'PENDING' | 'ACTIVE' | 'ENDED' = 'ACTIVE',
): Promise<string> {
  const [row] = await sql<Id[]>`
    insert into care_relationships (patient_id, clinician_id, status, consent_at, ended_at)
    values (
      ${patientId}, ${clinicianId}, ${status},
      ${status === 'PENDING' ? null : new Date()}, ${status === 'ENDED' ? new Date() : null}
    )
    returning id`;
  return row?.id ?? '';
}

export async function insertCaregiver(
  sql: Sql,
  patientId: string,
  options: {
    scope?: 'SCHEDULE' | 'SCHEDULE_AND_REASONS';
    status?: 'PENDING' | 'ACTIVE' | 'REVOKED';
    addedBy: string;
  },
): Promise<string> {
  const caregiverId = await insertUser(sql);
  const status = options.status ?? 'ACTIVE';
  await sql`
    insert into caregiver_relationships
      (patient_id, caregiver_user_id, added_by, scope, status, consent_at)
    values (
      ${patientId}, ${caregiverId}, ${options.addedBy}, ${options.scope ?? 'SCHEDULE'}, ${status},
      ${status === 'ACTIVE' ? new Date() : null}
    )`;
  return caregiverId;
}

export interface CourseFixture {
  readonly courseId: string;
  readonly revisionId: string;
  readonly relationshipId: string;
}

export async function insertCourse(
  sql: Sql,
  link: {
    patientId: string;
    clinicianId: string;
    clinicId: string;
    relationshipId: string;
  },
  options: { status?: 'DRAFT' | 'PENDING_PATIENT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' } = {},
): Promise<CourseFixture> {
  const status = options.status ?? 'DRAFT';
  const started = status === 'ACTIVE' || status === 'PAUSED' || status === 'COMPLETED';
  const [course] = await sql<Id[]>`
    insert into treatment_courses
      (care_relationship_id, patient_id, clinician_id, clinic_id, status, duration_days, timezone,
       start_at, effective_start_date, ended_at)
    values (
      ${link.relationshipId}, ${link.patientId}, ${link.clinicianId}, ${link.clinicId}, ${status}, 7,
      'Asia/Tashkent',
      ${started ? new Date('2026-10-01T05:00:00Z') : null}, ${started ? '2026-10-01' : null},
      ${status === 'COMPLETED' ? new Date('2026-10-08T05:00:00Z') : null}
    )
    returning id`;
  const courseId = course?.id ?? '';
  const [revision] = await sql<Id[]>`
    insert into course_revisions (course_id, rev_no, created_by)
    values (${courseId}, 1, ${link.clinicianId})
    returning id`;
  const revisionId = revision?.id ?? '';
  await sql`update treatment_courses set current_revision_id = ${revisionId} where id = ${courseId}`;
  await sql`insert into reminder_policies (course_id) values (${courseId})`;
  return { courseId, revisionId, relationshipId: link.relationshipId };
}

export interface MedicationFixture {
  readonly medicationId: string;
  readonly lineId: string;
  readonly ruleId: string;
}

/** A daily 08:00 tablet over days 1-7, in a DRAFT revision. */
export async function insertMedicationWithRule(
  sql: Sql,
  revisionId: string,
): Promise<MedicationFixture> {
  const lineId = randomUUID();
  const [medication] = await sql<Id[]>`
    insert into course_medications
      (revision_id, line_id, display_name, dose_value, dose_unit, active_from_day, active_to_day)
    values (${revisionId}, ${lineId}, 'Testamol', 500, 'MG', 1, 7)
    returning id`;
  const medicationId = medication?.id ?? '';
  const [rule] = await sql<Id[]>`
    insert into schedule_rules (medication_id, local_time) values (${medicationId}, '08:00')
    returning id`;
  return { medicationId, lineId, ruleId: rule?.id ?? '' };
}

export async function confirmRevision(sql: Sql, revisionId: string, by: string): Promise<void> {
  await sql`
    update course_revisions
    set status = 'CONFIRMED', confirmed_by_clinician_at = now(), created_by = ${by}
    where id = ${revisionId}`;
}

export async function insertDose(
  sql: Sql,
  ids: { courseId: string; revisionId: string; medication: MedicationFixture },
  options: { scheduledAt?: Date } = {},
): Promise<string> {
  const scheduledAt = options.scheduledAt ?? new Date('2026-10-02T03:00:00Z');
  const deadlineAt = new Date(scheduledAt.getTime() + 30 * 60_000);
  const [row] = await sql<Id[]>`
    insert into scheduled_doses
      (course_id, revision_id, medication_id, medication_line_id, schedule_rule_id, scheduled_at, deadline_at)
    values (
      ${ids.courseId}, ${ids.revisionId}, ${ids.medication.medicationId}, ${ids.medication.lineId},
      ${ids.medication.ruleId}, ${scheduledAt}, ${deadlineAt}
    )
    returning id`;
  return row?.id ?? '';
}

/** A SKIPPED event with a free-text reason, encrypted the way the repository stores it. */
export async function insertSkippedEvent(
  sql: Sql,
  cipher: FieldCipher,
  ids: { doseId: string; courseId: string; patientId: string },
  reasonText: string,
): Promise<string> {
  const id = randomUUID();
  await sql`
    insert into dose_events
      (id, scheduled_dose_id, course_id, event_type, actor_kind, actor_user_id, reason_code,
       reason_text_enc, source, idempotency_key, occurred_at)
    values (
      ${id}, ${ids.doseId}, ${ids.courseId}, 'SKIPPED', 'PATIENT', ${ids.patientId}, 'OTHER',
      ${cipher.encrypt(reasonText, fieldAad('dose_events', 'reason_text_enc', id))},
      'TELEGRAM', ${`fixture-${id}`}, now()
    )`;
  return id;
}

/** The people and courses the access tests argue about. See access.db.test.ts for the map. */
export interface World {
  readonly clinicA: string;
  readonly clinicB: string;
  readonly doctorA1: string;
  readonly doctorA2: string;
  readonly doctorB1: string;
  readonly receptionA: string;
  readonly receptionB: string;
  readonly techAdmin: string;
  readonly patient1: string;
  readonly patient2: string;
  readonly patient3EndedWithA1: string;
  readonly patient4PendingWithA1: string;
  readonly strangerPatient: string;
  readonly caregiverSchedule: string;
  readonly caregiverReasons: string;
  readonly caregiverPending: string;
  readonly course1: CourseFixture & { doseId: string; skipEventId: string };
  readonly course2: CourseFixture & { doseId: string };
  readonly course3: CourseFixture & { doseId: string };
  readonly course4EndedLink: CourseFixture & { doseId: string };
}

export const SKIP_REASON_TEXT = 'ran out of pills, will buy tomorrow';

export async function seedWorld(sql: Sql, cipher: FieldCipher): Promise<World> {
  const clinicA = await insertClinic(sql, { name: 'Clinic A' });
  const clinicB = await insertClinic(sql, { name: 'Clinic B' });
  const doctorA1 = await insertClinician(sql, clinicA, { firstName: 'A1' });
  const doctorA2 = await insertClinician(sql, clinicA, { firstName: 'A2' });
  const doctorB1 = await insertClinician(sql, clinicB, { firstName: 'B1' });
  const receptionA = await insertClinicStaff(sql, clinicA);
  const receptionB = await insertClinicStaff(sql, clinicB);
  const techAdmin = await insertTechAdmin(sql);

  const patient1 = await insertPatient(sql, { firstName: 'Patient', lastName: 'One' });
  const patient2 = await insertPatient(sql, { firstName: 'Patient', lastName: 'Two' });
  const patient3EndedWithA1 = await insertPatient(sql, { firstName: 'Patient', lastName: 'Three' });
  const patient4PendingWithA1 = await insertPatient(sql, {
    firstName: 'Patient',
    lastName: 'Four',
  });
  const strangerPatient = await insertPatient(sql, { firstName: 'Stranger', lastName: 'Patient' });

  const caregiverSchedule = await insertCaregiver(sql, patient1, { addedBy: doctorA1 });
  const caregiverReasons = await insertCaregiver(sql, patient1, {
    addedBy: doctorA1,
    scope: 'SCHEDULE_AND_REASONS',
  });
  const caregiverPending = await insertCaregiver(sql, patient1, {
    addedBy: doctorA1,
    status: 'PENDING',
  });

  const rel1 = await insertRelationship(sql, patient1, doctorA1);
  const rel2 = await insertRelationship(sql, patient2, doctorA2);
  const rel3 = await insertRelationship(sql, patient2, doctorB1);
  const rel4 = await insertRelationship(sql, patient3EndedWithA1, doctorA1, 'ENDED');
  await insertRelationship(sql, patient4PendingWithA1, doctorA1, 'PENDING');

  async function build(
    patientId: string,
    clinicianId: string,
    clinicId: string,
    relationshipId: string,
  ): Promise<CourseFixture & { doseId: string; medication: MedicationFixture }> {
    const course = await insertCourse(
      sql,
      { patientId, clinicianId, clinicId, relationshipId },
      // Sent to the patient and not started: a doctor has one draft per patient at most, and a
      // draft is not something a patient can see.
      { status: 'PENDING_PATIENT' },
    );
    const medication = await insertMedicationWithRule(sql, course.revisionId);
    const doseId = await insertDose(sql, { ...course, medication });
    // Confirmed by the doctor: a plan nobody has signed off is not shown to the patient.
    await confirmRevision(sql, course.revisionId, clinicianId);
    return { ...course, doseId, medication };
  }

  const c1 = await build(patient1, doctorA1, clinicA, rel1);
  const skipEventId = await insertSkippedEvent(
    sql,
    cipher,
    { doseId: c1.doseId, courseId: c1.courseId, patientId: patient1 },
    SKIP_REASON_TEXT,
  );
  const c2 = await build(patient2, doctorA2, clinicA, rel2);
  const c3 = await build(patient2, doctorB1, clinicB, rel3);
  const c4 = await build(patient3EndedWithA1, doctorA1, clinicA, rel4);

  return {
    clinicA,
    clinicB,
    doctorA1,
    doctorA2,
    doctorB1,
    receptionA,
    receptionB,
    techAdmin,
    patient1,
    patient2,
    patient3EndedWithA1,
    patient4PendingWithA1,
    strangerPatient,
    caregiverSchedule,
    caregiverReasons,
    caregiverPending,
    course1: { ...c1, skipEventId },
    course2: c2,
    course3: c3,
    course4EndedLink: c4,
  };
}
