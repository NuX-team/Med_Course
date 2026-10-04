import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { ACTOR_KINDS, COURSE_STATUSES, DOSE_UNITS, FOOD_RULES, REVISION_STATUSES } from './enums';
import { users } from './people';

// Foreign keys, including the composite ones that tie a course to its relationship, clinic and
// revisions, live in the SQL migrations. They are not repeated here because no query in this
// codebase uses Drizzle's relational API, and a second copy could only drift.

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const treatmentCourses = pgTable(
  'treatment_courses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    careRelationshipId: uuid('care_relationship_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    clinicianId: uuid('clinician_id').notNull(),
    clinicId: uuid('clinic_id').notNull(),
    status: text('status', { enum: COURSE_STATUSES }).notNull().default('DRAFT'),
    durationDays: integer('duration_days').notNull(),
    plannedStartAt: timestamp('planned_start_at', { withTimezone: true }),
    startWindowFrom: timestamp('start_window_from', { withTimezone: true }),
    startWindowTo: timestamp('start_window_to', { withTimezone: true }),
    startAt: timestamp('start_at', { withTimezone: true }),
    effectiveStartDate: date('effective_start_date', { mode: 'string' }),
    timezone: text('timezone').notNull(),
    currentRevisionId: uuid('current_revision_id'),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    cancellationReasonCode: text('cancellation_reason_code'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index('treatment_courses_patient_idx').on(table.patientId, table.status),
    index('treatment_courses_clinician_idx').on(table.clinicianId, table.status),
    index('treatment_courses_clinic_idx').on(table.clinicId, table.status),
    index('treatment_courses_relationship_idx').on(table.careRelationshipId),
    index('treatment_courses_planned_start_idx').on(table.plannedStartAt),
    index('treatment_courses_start_idx').on(table.startAt),
    index('treatment_courses_running_idx')
      .on(table.effectiveStartDate)
      .where(sql`${table.status} = 'ACTIVE'`),
    uniqueIndex('treatment_courses_one_draft_idx')
      .on(table.careRelationshipId)
      .where(sql`${table.status} = 'DRAFT'`),
  ],
);

export const courseRevisions = pgTable(
  'course_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    courseId: uuid('course_id').notNull(),
    revNo: integer('rev_no').notNull(),
    status: text('status', { enum: REVISION_STATUSES }).notNull().default('DRAFT'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    reason: text('reason'),
    confirmedByClinicianAt: timestamp('confirmed_by_clinician_at', { withTimezone: true }),
    confirmedByPatientAt: timestamp('confirmed_by_patient_at', { withTimezone: true }),
    appliedAt: timestamp('applied_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('course_revisions_one_applied_idx')
      .on(table.courseId)
      .where(sql`${table.status} = 'APPLIED'`),
    uniqueIndex('course_revisions_one_pending_idx')
      .on(table.courseId)
      .where(sql`${table.status} in ('DRAFT', 'CONFIRMED')`),
  ],
);

/** When a course was on hold. `resumedAt` is null while it still is. */
export const coursePauses = pgTable(
  'course_pauses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    courseId: uuid('course_id').notNull(),
    pausedAt: timestamp('paused_at', { withTimezone: true }).notNull(),
    pausedBy: uuid('paused_by')
      .notNull()
      .references(() => users.id),
    resumedAt: timestamp('resumed_at', { withTimezone: true }),
    resumedBy: uuid('resumed_by').references(() => users.id),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('course_pauses_one_open_idx')
      .on(table.courseId)
      .where(sql`${table.resumedAt} is null`),
    index('course_pauses_course_idx').on(table.courseId, table.pausedAt),
  ],
);

export const courseMedications = pgTable(
  'course_medications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    revisionId: uuid('revision_id').notNull(),
    /** Stable across the revisions of one course. */
    lineId: uuid('line_id').notNull(),
    displayName: text('display_name').notNull(),
    doseValue: numeric('dose_value', { precision: 10, scale: 3 }).notNull(),
    doseUnit: text('dose_unit', { enum: DOSE_UNITS }).notNull(),
    doseDisplay: text('dose_display'),
    foodRule: text('food_rule', { enum: FOOD_RULES }).notNull().default('ANY'),
    /** Encrypted: see FieldCipher. */
    instructionsEnc: text('instructions_enc'),
    prn: boolean('prn').notNull().default(false),
    maxDailyDoses: integer('max_daily_doses'),
    minimumIntervalMinutes: integer('minimum_interval_minutes'),
    activeFromDay: integer('active_from_day').notNull(),
    activeToDay: integer('active_to_day').notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('course_medications_revision_idx').on(table.revisionId)],
);

export const scheduleRules = pgTable(
  'schedule_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    medicationId: uuid('medication_id').notNull(),
    /** Local wall-clock time in the course timezone, "HH:MM:SS". */
    localTime: time('local_time', { precision: 0 }).notNull(),
    /** ISO weekdays, 1 = Monday. Null means every day. */
    daysOfWeek: smallint('days_of_week').array(),
    dayFrom: integer('day_from'),
    dayTo: integer('day_to'),
    createdAt: createdAt(),
  },
  (table) => [index('schedule_rules_medication_idx').on(table.medicationId)],
);

export const reminderPolicies = pgTable('reminder_policies', {
  id: uuid('id').primaryKey().defaultRandom(),
  courseId: uuid('course_id').notNull().unique(),
  attempts: integer('attempts').notNull().default(3),
  retryIntervalMinutes: integer('retry_interval_minutes').notNull().default(10),
  missAfterMinutes: integer('miss_after_minutes').notNull().default(30),
  snoozeOptionsMinutes: integer('snooze_options_minutes')
    .array()
    .notNull()
    .default(sql`'{5,10,15}'`),
  maxSnoozes: integer('max_snoozes').notNull().default(3),
  correctionWindowMinutes: integer('correction_window_minutes').notNull().default(60),
  leadMinutes: integer('lead_minutes').notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const courseTransitions = pgTable(
  'course_transitions',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    courseId: uuid('course_id').notNull(),
    fromStatus: text('from_status', { enum: COURSE_STATUSES }),
    toStatus: text('to_status', { enum: COURSE_STATUSES }).notNull(),
    actorKind: text('actor_kind', { enum: ACTOR_KINDS }).notNull(),
    actorUserId: uuid('actor_user_id'),
    reason: text('reason'),
    requestId: text('request_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('course_transitions_course_idx').on(table.courseId, table.at)],
);
