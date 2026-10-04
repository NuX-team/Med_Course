import { bigint, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { careRelationships, clinicianProfiles, users } from './people';

// Constraints (including the composite foreign key to care_relationships) live in the SQL
// migrations; schema.db.test.ts keeps these definitions honest.

export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clinicianId: uuid('clinician_id')
      .notNull()
      .references(() => clinicianProfiles.userId),
    /** SHA-256 of the code, hex. The code itself is never stored. */
    codeHash: text('code_hash').notNull(),
    /** The doctor's own note about who the invitation is for; never shown to the patient. */
    label: text('label'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    usedBy: uuid('used_by'),
    careRelationshipId: uuid('care_relationship_id').references(() => careRelationships.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('invitations_code_hash_key').on(table.codeHash),
    index('invitations_clinician_idx').on(table.clinicianId, table.createdAt),
  ],
);

/** A one-time link a doctor hands to a person who is to watch over a patient's course. */
export const caregiverInvitations = pgTable(
  'caregiver_invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    careRelationshipId: uuid('care_relationship_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    clinicianId: uuid('clinician_id').notNull(),
    /** SHA-256 of the code, hex. The code itself is never stored. */
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    usedBy: uuid('used_by').references(() => users.id),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('caregiver_invitations_code_hash_key').on(table.codeHash),
    index('caregiver_invitations_patient_idx').on(table.patientId, table.createdAt),
  ],
);

export const invitationAttempts = pgTable(
  'invitation_attempts',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    telegramUserId: bigint('telegram_user_id', { mode: 'number' }).notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('invitation_attempts_user_idx').on(table.telegramUserId, table.at)],
);
