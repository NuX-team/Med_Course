import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { INCIDENT_KINDS, INCIDENT_STATUSES, INCIDENT_TYPES } from './enums';
import { clinics, users } from './people';

// Constraints and triggers live in the SQL migrations.

/** A one-time sign-in link handed out by the bot. Only the hash of its token is stored. */
export const panelLogins = pgTable(
  'panel_logins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('panel_logins_user_idx').on(table.userId, table.createdAt)],
);

/** A signed-in browser. Carries no rights of its own: those are read on every request. */
export const panelSessions = pgTable(
  'panel_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull().unique(),
    csrfToken: text('csrf_token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('panel_sessions_user_idx').on(table.userId, table.createdAt)],
);

/** Something that needs a person's attention: a clinic's (OPERATIONAL) or the service's (TECHNICAL). */
export const incidents = pgTable(
  'incidents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind', { enum: INCIDENT_KINDS }).notNull(),
    type: text('type', { enum: INCIDENT_TYPES }).notNull(),
    clinicId: uuid('clinic_id').references(() => clinics.id),
    courseId: uuid('course_id'),
    dedupeKey: text('dedupe_key').notNull().unique(),
    /** Machine data only: counts and codes. */
    details: jsonb('details'),
    status: text('status', { enum: INCIDENT_STATUSES }).notNull().default('OPEN'),
    /** Encrypted: see FieldCipher. */
    resolutionNoteEnc: text('resolution_note_enc'),
    resolvedBy: uuid('resolved_by').references(() => users.id),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('incidents_clinic_idx').on(table.clinicId, table.status, table.openedAt),
    index('incidents_kind_idx').on(table.kind, table.status, table.openedAt),
  ],
);
