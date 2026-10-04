import type { Sql } from 'postgres';
import type { Actor, NewMedication, Repositories } from '../src';
import { insertClinic, insertClinician, insertPatient, insertRelationship } from './fixtures';

/**
 * A course that is really running, built through the repositories (draft, medications, send,
 * start), for tests of what happens after the start. Times are fixed so tests can name them.
 */

/** 15:00 on 2 October 2026 in Tashkent: when the course is sent. */
export const SENT_AT = new Date('2026-10-02T10:00:00Z');
/** 05:00 on 3 October 2026 in Tashkent: when the patient starts it. Day 1 is 3 October. */
export const STARTED_AT = new Date('2026-10-03T00:00:00Z');
/** 08:00 on day 1 in Tashkent: the first dose. Its deadline is half an hour later. */
export const FIRST_DOSE_AT = new Date('2026-10-03T03:00:00Z');
export const MINUTE = 60_000;

/** Minutes after the first dose's time (negative: before). */
export const afterFirstDose = (minutes: number): Date =>
  new Date(FIRST_DOSE_AT.getTime() + minutes * MINUTE);

export const TWICE_A_DAY: NewMedication = {
  displayName: 'Testamol',
  doseValue: 500,
  doseUnit: 'MG',
  foodRule: 'AFTER_MEAL',
  activeFromDay: 1,
  activeToDay: 7,
  schedule: { kind: 'TIMES', times: ['08:00', '20:00'] },
};

export interface RunningCourse {
  readonly clinicId: string;
  readonly doctorId: string;
  readonly patientId: string;
  readonly patientTelegramId: number;
  readonly relationshipId: string;
  readonly courseId: string;
  /** The 08:00 dose of day 1. */
  readonly firstDoseId: string;
  readonly patient: Actor;
  readonly doctor: Actor;
}

let telegramId = 40_000_000;

export async function startRunningCourse(
  sql: Sql,
  repos: Repositories,
  options: { medications?: Partial<NewMedication>[]; locale?: 'ru' | 'uz' } = {},
): Promise<RunningCourse> {
  telegramId += 1;
  const clinicId = await insertClinic(sql);
  const doctorId = await insertClinician(sql, clinicId, { firstName: 'Rustam' });
  const patientId = await insertPatient(sql, {
    telegramId,
    firstName: 'Aziza',
    lastName: 'Karimova',
  });
  if (options.locale !== undefined) {
    await sql`update users set locale = ${options.locale} where id = ${patientId}`;
  }
  const relationshipId = await insertRelationship(sql, patientId, doctorId, 'ACTIVE');
  const doctor: Actor = { kind: 'CLINICIAN', userId: doctorId };
  const patient: Actor = { kind: 'PATIENT', userId: patientId };

  const opened = await repos.plans.openDraft(doctor, { relationshipId, durationDays: 7 });
  const courseId = opened?.course.id ?? '';
  for (const medication of options.medications ?? [{}]) {
    const added = await repos.plans.addMedication(doctor, courseId, {
      ...TWICE_A_DAY,
      ...medication,
    });
    if (added.status !== 'ADDED') {
      throw new Error(`could not add a medication: ${added.status}`);
    }
  }
  const sent = await repos.plans.send(doctor, courseId, { windowDays: 7, now: SENT_AT });
  const started = await repos.runs.start(patient, courseId, STARTED_AT);
  if (sent.status !== 'SENT' || started.status !== 'STARTED') {
    throw new Error(`could not start the course: ${sent.status}, ${started.status}`);
  }
  const [first] = await sql<{ id: string }[]>`
    select id from scheduled_doses where course_id = ${courseId}
    order by scheduled_at, id limit 1`;
  return {
    clinicId,
    doctorId,
    patientId,
    patientTelegramId: telegramId,
    relationshipId,
    courseId,
    firstDoseId: first?.id ?? '',
    patient,
    doctor,
  };
}
