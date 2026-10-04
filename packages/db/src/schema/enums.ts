/**
 * Allowed values of every enum-like column. The SQL migrations hold the matching CHECK
 * constraints; schema.test.ts proves the two lists agree, so adding a value means changing
 * both a migration and this file.
 */

export const CLINIC_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export const USER_STATUSES = ['ACTIVE', 'BLOCKED', 'DELETED'] as const;
export const LOCALES = ['ru', 'uz'] as const;
export const VERIFICATION_STATUSES = ['PENDING', 'VERIFIED', 'REVOKED'] as const;
export const CLINIC_STAFF_ROLES = ['RECEPTION', 'CLINIC_ADMIN'] as const;
export const PLATFORM_ROLES = ['TECH_ADMIN'] as const;
export const STAFF_STATUSES = ['ACTIVE', 'REVOKED'] as const;
export const CARE_RELATIONSHIP_STATUSES = ['PENDING', 'ACTIVE', 'ENDED'] as const;
export const CAREGIVER_SCOPES = ['SCHEDULE', 'SCHEDULE_AND_REASONS'] as const;
export const CAREGIVER_STATUSES = ['PENDING', 'ACTIVE', 'REVOKED'] as const;

export const COURSE_STATUSES = [
  'DRAFT',
  'PENDING_PATIENT',
  'ACTIVE',
  'PAUSED',
  'CANCELLATION_REVIEW',
  'CANCELLED',
  'EXPIRED_NOT_STARTED',
  'COMPLETED',
  'ARCHIVED',
] as const;
export const REVISION_STATUSES = ['DRAFT', 'CONFIRMED', 'APPLIED', 'SUPERSEDED'] as const;
export const DOSE_UNITS = [
  'MG',
  'G',
  'MCG',
  'ML',
  'TABLET',
  'CAPSULE',
  'DROP',
  'IU',
  'PUFF',
  'SACHET',
  'OTHER',
] as const;
export const FOOD_RULES = ['BEFORE_MEAL', 'WITH_MEAL', 'AFTER_MEAL', 'ANY'] as const;

export const DOSE_STATUSES = [
  'SCHEDULED',
  'NOTIFIED',
  'SNOOZED',
  'TAKEN',
  'SKIPPED',
  'MISSED',
  'TAKEN_LATE',
  'SUPERSEDED',
] as const;
export const DOSE_EVENT_TYPES = [
  'NOTIFIED',
  'SNOOZED',
  'TAKEN',
  'SKIPPED',
  'MISSED',
  'LATE_TAKEN',
  'CORRECTION',
  'SUPERSEDED',
  'PRN_TAKEN',
  'PRN_CANCELLED',
] as const;
export const SKIP_REASONS = ['FORGOT', 'NO_MEDICATION', 'OTHER'] as const;
export const EVENT_SOURCES = ['TELEGRAM', 'SYSTEM', 'ADMIN'] as const;

export const NOTIFICATION_KINDS = ['DOSE_REMINDER', 'DOSE_LEAD'] as const;
export const NOTIFICATION_STATUSES = ['QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED'] as const;
export const DOCTOR_ALERT_KINDS = [
  'MISSED',
  'SKIPPED',
  'SERIES',
  'DIGEST',
  'UNDELIVERED',
  'PAUSE_REQUEST',
  'PRN_OVER',
] as const;

export const INCIDENT_KINDS = ['OPERATIONAL', 'TECHNICAL'] as const;
export const INCIDENT_TYPES = [
  'UNDELIVERED',
  'MISS_SERIES',
  'QUEUE_STUCK',
  'QUEUE_LATE',
  'SWEEP_LATE',
] as const;
export const INCIDENT_STATUSES = ['OPEN', 'RESOLVED'] as const;

export const DELETION_STATUSES = ['PENDING', 'CANCELLED', 'DONE'] as const;

export const EXPORT_FORMATS = ['CSV', 'PDF'] as const;
/** Who may be handed a report of a course: its patient and the doctor treating them. */
export const EXPORT_ACTOR_KINDS = ['PATIENT', 'CLINICIAN'] as const;

export const ACTOR_KINDS = [
  'PATIENT',
  'CLINICIAN',
  'CLINIC_STAFF',
  'CAREGIVER',
  'TECH_ADMIN',
  'SYSTEM',
] as const;

export const CONVERSATION_FLOWS = [
  'ONBOARDING',
  'SETTINGS',
  'DOCTOR',
  'INVITE',
  'COURSE',
  'DOSE',
  'CAREGIVER',
] as const;
export const CONSENT_KINDS = ['PERSONAL_DATA'] as const;
export const CONSENT_DECISIONS = ['GRANTED', 'REVOKED'] as const;
export const CONSENT_CONTEXTS = ['ONBOARDING', 'SETTINGS'] as const;

export type CourseStatus = (typeof COURSE_STATUSES)[number];
export type DoseStatus = (typeof DOSE_STATUSES)[number];
export type DoseEventType = (typeof DOSE_EVENT_TYPES)[number];
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** Every enum column, for the test that compares this file with the database. */
export const ENUM_COLUMNS: readonly {
  readonly table: string;
  readonly column: string;
  readonly values: readonly string[];
}[] = [
  { table: 'clinics', column: 'status', values: CLINIC_STATUSES },
  { table: 'users', column: 'status', values: USER_STATUSES },
  { table: 'users', column: 'locale', values: LOCALES },
  { table: 'clinician_profiles', column: 'verification_status', values: VERIFICATION_STATUSES },
  { table: 'clinic_staff', column: 'role', values: CLINIC_STAFF_ROLES },
  { table: 'clinic_staff', column: 'status', values: STAFF_STATUSES },
  { table: 'platform_staff', column: 'role', values: PLATFORM_ROLES },
  { table: 'platform_staff', column: 'status', values: STAFF_STATUSES },
  { table: 'care_relationships', column: 'status', values: CARE_RELATIONSHIP_STATUSES },
  { table: 'caregiver_relationships', column: 'scope', values: CAREGIVER_SCOPES },
  { table: 'caregiver_relationships', column: 'status', values: CAREGIVER_STATUSES },
  { table: 'treatment_courses', column: 'status', values: COURSE_STATUSES },
  { table: 'course_revisions', column: 'status', values: REVISION_STATUSES },
  { table: 'course_medications', column: 'dose_unit', values: DOSE_UNITS },
  { table: 'course_medications', column: 'food_rule', values: FOOD_RULES },
  { table: 'course_transitions', column: 'from_status', values: COURSE_STATUSES },
  { table: 'course_transitions', column: 'to_status', values: COURSE_STATUSES },
  { table: 'course_transitions', column: 'actor_kind', values: ACTOR_KINDS },
  { table: 'scheduled_doses', column: 'status', values: DOSE_STATUSES },
  { table: 'dose_events', column: 'event_type', values: DOSE_EVENT_TYPES },
  { table: 'dose_events', column: 'actor_kind', values: ACTOR_KINDS },
  { table: 'dose_events', column: 'reason_code', values: SKIP_REASONS },
  { table: 'dose_events', column: 'source', values: EVENT_SOURCES },
  { table: 'notifications', column: 'kind', values: NOTIFICATION_KINDS },
  { table: 'notifications', column: 'status', values: NOTIFICATION_STATUSES },
  { table: 'doctor_alerts', column: 'kind', values: DOCTOR_ALERT_KINDS },
  { table: 'doctor_alerts', column: 'status', values: NOTIFICATION_STATUSES },
  { table: 'incidents', column: 'kind', values: INCIDENT_KINDS },
  { table: 'incidents', column: 'type', values: INCIDENT_TYPES },
  { table: 'incidents', column: 'status', values: INCIDENT_STATUSES },
  { table: 'course_exports', column: 'actor_kind', values: EXPORT_ACTOR_KINDS },
  { table: 'course_exports', column: 'format', values: EXPORT_FORMATS },
  { table: 'deletion_requests', column: 'status', values: DELETION_STATUSES },
  { table: 'audit_log', column: 'actor_kind', values: ACTOR_KINDS },
  { table: 'conversation_states', column: 'flow', values: CONVERSATION_FLOWS },
  { table: 'consent_records', column: 'kind', values: CONSENT_KINDS },
  { table: 'consent_records', column: 'decision', values: CONSENT_DECISIONS },
  { table: 'consent_records', column: 'locale', values: LOCALES },
  { table: 'consent_records', column: 'context', values: CONSENT_CONTEXTS },
];
