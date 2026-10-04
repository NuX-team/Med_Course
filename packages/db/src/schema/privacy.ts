import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { treatmentCourses } from './courses';
import { DELETION_STATUSES } from './enums';
import { users } from './people';

// Constraints and triggers live in the SQL migrations.

/** A person's request to have their data deleted: pending until it falls due or is taken back. */
export const deletionRequests = pgTable(
  'deletion_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    status: text('status', { enum: DELETION_STATUSES }).notNull().default('PENDING'),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('deletion_requests_open_idx')
      .on(table.userId)
      .where(sql`${table.status} = 'PENDING'`),
    index('deletion_requests_due_idx')
      .on(table.dueAt)
      .where(sql`${table.status} = 'PENDING'`),
  ],
);

/** What is kept of a finished course for a later doctor: dates, drugs and figures only. */
export const courseSummaries = pgTable(
  'course_summaries',
  {
    courseId: uuid('course_id')
      .primaryKey()
      .references(() => treatmentCourses.id),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => users.id),
    clinicianId: uuid('clinician_id')
      .notNull()
      .references(() => users.id),
    content: jsonb('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('course_summaries_patient_idx').on(table.patientId, table.createdAt)],
);
