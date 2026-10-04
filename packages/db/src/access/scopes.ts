import { sql, type AnyColumn, type SQL } from 'drizzle-orm';
import {
  careRelationships,
  caregiverRelationships,
  clinicStaff,
  clinicianProfiles,
  clinics,
  courseRevisions,
  patientProfiles,
  platformStaff,
  scheduledDoses,
  treatmentCourses,
  users,
} from '../schema';
import type { Actor } from './actor';

/**
 * Who may see which rows, as SQL predicates. Repositories put one of these in the WHERE of
 * every read, so data cannot come back without a path from the actor to it. Everything that
 * can be revoked (user status, clinician verification, clinic status, relationship status,
 * staff status) is evaluated here, at query time, never taken from the Actor value.
 *
 * Medical content (courses, doses, events) and administrative views are kept apart: clinic
 * staff can list courses for administration but never see what was prescribed.
 */

const DENY = sql`false`;
const ALLOW = sql`true`;

export function activeUser(userId: string): SQL {
  return sql`exists (
    select 1 from ${users} where ${users.id} = ${userId} and ${users.status} = 'ACTIVE'
  )`;
}

/** The clinician is verified and their clinic is not suspended. */
export function usableClinician(userId: string | AnyColumn): SQL {
  return sql`exists (
    select 1 from ${clinicianProfiles}
    join ${clinics} on ${clinics.id} = ${clinicianProfiles.clinicId}
    where ${clinicianProfiles.userId} = ${userId}
      and ${clinicianProfiles.verificationStatus} = 'VERIFIED'
      and ${clinics.status} = 'ACTIVE'
  )`;
}

/** The user is an active technical administrator (the only people who may verify doctors). */
export function activeTechAdmin(userId: string): SQL {
  return sql`(${activeUser(userId)} and exists (
    select 1 from ${platformStaff}
    where ${platformStaff.userId} = ${userId}
      and ${platformStaff.role} = 'TECH_ADMIN'
      and ${platformStaff.status} = 'ACTIVE'
  ))`;
}

function activeCaregiverOf(patientId: AnyColumn, caregiverId: string): SQL {
  return sql`exists (
    select 1 from ${caregiverRelationships}
    where ${caregiverRelationships.patientId} = ${patientId}
      and ${caregiverRelationships.caregiverUserId} = ${caregiverId}
      and ${caregiverRelationships.status} = 'ACTIVE'
  )`;
}

function activeStaffOfClinic(userId: string, clinicId: string | AnyColumn): SQL {
  return sql`exists (
    select 1 from ${clinicStaff}
    join ${clinics} on ${clinics.id} = ${clinicStaff.clinicId}
    where ${clinicStaff.userId} = ${userId}
      and ${clinicStaff.clinicId} = ${clinicId}
      and ${clinicStaff.status} = 'ACTIVE'
      and ${clinics.status} = 'ACTIVE'
  )`;
}

/**
 * The user is, right now, an active member of staff of this clinic, the clinic is not suspended
 * and their own account is open. Checked on every request of the staff panel.
 */
export function activeClinicStaff(userId: string, clinicId: string | AnyColumn): SQL {
  return sql`(${activeUser(userId)} and ${activeStaffOfClinic(userId, clinicId)})`;
}

/**
 * The doctor has confirmed a plan for this course at least once, i.e. it has been sent. A course
 * still being drafted (or a draft that was thrown away) is the doctor's working paper: showing
 * it to the patient would show them a prescription nobody has signed off.
 */
function everConfirmed(course: typeof treatmentCourses): SQL {
  return sql`exists (
    select 1 from ${courseRevisions}
    where ${courseRevisions.courseId} = ${course.id} and ${courseRevisions.status} <> 'DRAFT'
  )`;
}

/** Courses an actor may read in full: plan, doses, events. */
export function visibleCourses(actor: Actor, course = treatmentCourses): SQL {
  switch (actor.kind) {
    case 'SYSTEM':
      return ALLOW;
    case 'PATIENT':
      return sql`(
        ${activeUser(actor.userId)}
        and ${course.patientId} = ${actor.userId}
        and ${everConfirmed(course)}
      )`;
    case 'CLINICIAN':
      return sql`(
        ${activeUser(actor.userId)}
        and ${usableClinician(actor.userId)}
        and ${course.clinicianId} = ${actor.userId}
        and exists (
          select 1 from ${careRelationships}
          where ${careRelationships.id} = ${course.careRelationshipId}
            and ${careRelationships.status} = 'ACTIVE'
        )
      )`;
    case 'CAREGIVER':
      return sql`(
        ${activeUser(actor.userId)}
        and ${activeCaregiverOf(course.patientId, actor.userId)}
        and ${everConfirmed(course)}
      )`;
    case 'CLINIC_STAFF':
    case 'TECH_ADMIN':
      return DENY;
  }
}

/** Courses an actor may list for administration only (status, dates, who) without content. */
export function administrableCourses(actor: Actor, course = treatmentCourses): SQL {
  switch (actor.kind) {
    case 'SYSTEM':
      return ALLOW;
    case 'CLINIC_STAFF':
      // Both halves matter: the capacity names one clinic, and the user must really be staff there.
      return sql`(
        ${activeUser(actor.userId)}
        and ${course.clinicId} = ${actor.clinicId}
        and ${activeStaffOfClinic(actor.userId, course.clinicId)}
      )`;
    case 'PATIENT':
    case 'CLINICIAN':
    case 'CAREGIVER':
    case 'TECH_ADMIN':
      return DENY;
  }
}

/** Doses (and so their events) follow the course they belong to. */
export function visibleDoses(actor: Actor, dose = scheduledDoses): SQL {
  return sql`exists (
    select 1 from ${treatmentCourses}
    where ${treatmentCourses.id} = ${dose.courseId} and ${visibleCourses(actor)}
  )`;
}

/** Name-level visibility of a patient. No contact data or date of birth. */
export function visiblePatients(actor: Actor, patient = patientProfiles): SQL {
  switch (actor.kind) {
    case 'SYSTEM':
      return ALLOW;
    case 'PATIENT':
      return sql`(${activeUser(actor.userId)} and ${patient.userId} = ${actor.userId})`;
    case 'CLINICIAN':
      return sql`(${activeUser(actor.userId)} and ${usableClinician(actor.userId)} and exists (
        select 1 from ${careRelationships}
        where ${careRelationships.patientId} = ${patient.userId}
          and ${careRelationships.clinicianId} = ${actor.userId}
          and ${careRelationships.status} = 'ACTIVE'
      ))`;
    case 'CAREGIVER':
      return sql`(${activeUser(actor.userId)} and ${activeCaregiverOf(patient.userId, actor.userId)})`;
    case 'CLINIC_STAFF':
      return sql`(${activeUser(actor.userId)} and exists (
        select 1 from ${careRelationships}
        join ${clinicianProfiles} on ${clinicianProfiles.userId} = ${careRelationships.clinicianId}
        where ${careRelationships.patientId} = ${patient.userId}
          and ${careRelationships.status} = 'ACTIVE'
          and ${clinicianProfiles.clinicId} = ${actor.clinicId}
          and ${activeStaffOfClinic(actor.userId, clinicianProfiles.clinicId)}
      ))`;
    case 'TECH_ADMIN':
      return DENY;
  }
}

/** Phone and date of birth: the patient, their own clinician, and the system. */
export function patientsWithVisiblePii(actor: Actor, patient = patientProfiles): SQL {
  switch (actor.kind) {
    case 'SYSTEM':
    case 'PATIENT':
    case 'CLINICIAN':
      return visiblePatients(actor, patient);
    case 'CAREGIVER':
    case 'CLINIC_STAFF':
    case 'TECH_ADMIN':
      return DENY;
  }
}

/** Free-text skip reasons are the most sensitive part of the history. */
export function readableReasonsOfCourse(actor: Actor, course = treatmentCourses): SQL {
  switch (actor.kind) {
    case 'SYSTEM':
    case 'PATIENT':
    case 'CLINICIAN':
      return visibleCourses(actor, course);
    case 'CAREGIVER':
      return sql`(${visibleCourses(actor, course)} and exists (
        select 1 from ${caregiverRelationships}
        where ${caregiverRelationships.patientId} = ${course.patientId}
          and ${caregiverRelationships.caregiverUserId} = ${actor.userId}
          and ${caregiverRelationships.status} = 'ACTIVE'
          and ${caregiverRelationships.scope} = 'SCHEDULE_AND_REASONS'
      ))`;
    case 'CLINIC_STAFF':
    case 'TECH_ADMIN':
      return DENY;
  }
}

/** The clinician may open a new course for this patient: verified, clinic active, link ACTIVE. */
export function clinicianCanTreat(clinicianId: string, patientId: string): SQL {
  return sql`(${activeUser(clinicianId)} and ${usableClinician(clinicianId)} and exists (
    select 1 from ${careRelationships}
    where ${careRelationships.clinicianId} = ${clinicianId}
      and ${careRelationships.patientId} = ${patientId}
      and ${careRelationships.status} = 'ACTIVE'
  ))`;
}
