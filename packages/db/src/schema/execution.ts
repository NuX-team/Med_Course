import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  ACTOR_KINDS,
  DOCTOR_ALERT_KINDS,
  DOSE_EVENT_TYPES,
  DOSE_STATUSES,
  EVENT_SOURCES,
  NOTIFICATION_KINDS,
  NOTIFICATION_STATUSES,
  SKIP_REASONS,
} from './enums';

// Constraints, composite foreign keys and triggers live in the SQL migrations.

export const scheduledDoses = pgTable(
  'scheduled_doses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    courseId: uuid('course_id').notNull(),
    revisionId: uuid('revision_id').notNull(),
    medicationId: uuid('medication_id').notNull(),
    medicationLineId: uuid('medication_line_id').notNull(),
    scheduleRuleId: uuid('schedule_rule_id').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    status: text('status', { enum: DOSE_STATUSES }).notNull().default('SCHEDULED'),
    missedAt: timestamp('missed_at', { withTimezone: true }),
    lateTakenAt: timestamp('late_taken_at', { withTimezone: true }),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('scheduled_doses_slot_idx')
      .on(table.courseId, table.medicationLineId, table.scheduledAt)
      .where(sql`${table.status} <> 'SUPERSEDED'`),
    index('scheduled_doses_due_idx')
      .on(table.deadlineAt)
      .where(sql`${table.status} in ('SCHEDULED', 'NOTIFIED', 'SNOOZED')`),
    index('scheduled_doses_course_idx').on(table.courseId, table.scheduledAt),
  ],
);

export const doseEvents = pgTable(
  'dose_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scheduledDoseId: uuid('scheduled_dose_id'),
    courseId: uuid('course_id').notNull(),
    medicationLineId: uuid('medication_line_id'),
    eventType: text('event_type', { enum: DOSE_EVENT_TYPES }).notNull(),
    actorKind: text('actor_kind', { enum: ACTOR_KINDS }).notNull(),
    actorUserId: uuid('actor_user_id'),
    reasonCode: text('reason_code', { enum: SKIP_REASONS }),
    /** Encrypted: see FieldCipher. Only present next to reason "OTHER". */
    reasonTextEnc: text('reason_text_enc'),
    source: text('source', { enum: EVENT_SOURCES }).notNull(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    details: jsonb('details'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('dose_events_dose_idx').on(table.scheduledDoseId, table.occurredAt),
    index('dose_events_course_idx').on(table.courseId, table.occurredAt),
    index('dose_events_prn_idx')
      .on(table.courseId, table.medicationLineId, table.occurredAt)
      .where(sql`${table.scheduledDoseId} is null`),
  ],
);

/** The outbox: one row per reminder owed, with the moment it is due (ARCHITECTURE §8). */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    courseId: uuid('course_id').notNull(),
    scheduledDoseId: uuid('scheduled_dose_id').notNull(),
    recipientUserId: uuid('recipient_user_id').notNull(),
    kind: text('kind', { enum: NOTIFICATION_KINDS }).notNull(),
    attemptNo: integer('attempt_no').notNull().default(1),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    status: text('status', { enum: NOTIFICATION_STATUSES }).notNull().default('QUEUED'),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** How many times sending was tried. */
    tries: integer('tries').notNull().default(0),
    /** A machine code for the last failure, never free text. */
    lastError: text('last_error'),
  },
  (table) => [
    index('notifications_stuck_idx')
      .on(table.lockedUntil)
      .where(sql`${table.status} = 'SENDING'`),
    uniqueIndex('notifications_dose_attempt_idx').on(
      table.scheduledDoseId,
      table.kind,
      table.attemptNo,
    ),
    index('notifications_due_idx')
      .on(table.dueAt)
      .where(sql`${table.status} = 'QUEUED'`),
    index('notifications_course_idx').on(table.courseId),
  ],
);

/** Messages owed to a doctor about a course; sent by the worker (ARCHITECTURE §8). */
export const doctorAlerts = pgTable(
  'doctor_alerts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    courseId: uuid('course_id').notNull(),
    recipientUserId: uuid('recipient_user_id').notNull(),
    kind: text('kind', { enum: DOCTOR_ALERT_KINDS }).notNull(),
    scheduledDoseId: uuid('scheduled_dose_id'),
    slotAt: timestamp('slot_at', { withTimezone: true }),
    medicationLineId: uuid('medication_line_id'),
    dedupeKey: text('dedupe_key').notNull().unique(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    status: text('status', { enum: NOTIFICATION_STATUSES }).notNull().default('QUEUED'),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    tries: integer('tries').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('doctor_alerts_due_idx')
      .on(table.dueAt)
      .where(sql`${table.status} = 'QUEUED'`),
    index('doctor_alerts_stuck_idx')
      .on(table.lockedUntil)
      .where(sql`${table.status} = 'SENDING'`),
    index('doctor_alerts_course_idx').on(table.courseId, table.kind, table.dueAt),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorKind: text('actor_kind', { enum: ACTOR_KINDS }).notNull(),
    actorUserId: uuid('actor_user_id'),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    action: text('action').notNull(),
    /** Names of changed fields, never their values. */
    changes: text('changes')
      .array()
      .notNull()
      .default(sql`'{}'`),
    beforeHash: text('before_hash'),
    afterHash: text('after_hash'),
    reason: text('reason'),
    requestId: text('request_id'),
  },
  (table) => [
    index('audit_log_entity_idx').on(table.entityType, table.entityId, table.at),
    index('audit_log_actor_idx').on(table.actorUserId, table.at),
  ],
);
