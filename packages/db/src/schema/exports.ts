import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { treatmentCourses } from './courses';
import { EXPORT_ACTOR_KINDS, EXPORT_FORMATS } from './enums';
import { users } from './people';

// Constraints and triggers live in the SQL migrations.

/** A report of a course handed out as a file. The file is not kept; this row is the record. */
export const courseExports = pgTable(
  'course_exports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    courseId: uuid('course_id')
      .notNull()
      .references(() => treatmentCourses.id),
    requestedBy: uuid('requested_by')
      .notNull()
      .references(() => users.id),
    actorKind: text('actor_kind', { enum: EXPORT_ACTOR_KINDS }).notNull(),
    format: text('format', { enum: EXPORT_FORMATS }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    index('course_exports_requester_idx').on(table.requestedBy, table.createdAt),
    index('course_exports_course_idx').on(table.courseId, table.createdAt),
  ],
);
