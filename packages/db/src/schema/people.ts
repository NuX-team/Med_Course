import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  CAREGIVER_SCOPES,
  CAREGIVER_STATUSES,
  CARE_RELATIONSHIP_STATUSES,
  CLINIC_STAFF_ROLES,
  CLINIC_STATUSES,
  LOCALES,
  PLATFORM_ROLES,
  STAFF_STATUSES,
  USER_STATUSES,
  VERIFICATION_STATUSES,
} from './enums';

// The SQL migrations are the source of truth for constraints, indexes and triggers.
// These definitions give queries their types; schema.test.ts fails if they drift.

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow();

export const clinics = pgTable('clinics', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  status: text('status', { enum: CLINIC_STATUSES }).notNull().default('ACTIVE'),
  settings: jsonb('settings').notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  telegramUserId: bigint('telegram_user_id', { mode: 'number' }).notNull().unique(),
  status: text('status', { enum: USER_STATUSES }).notNull().default('ACTIVE'),
  locale: text('locale', { enum: LOCALES }).notNull().default('ru'),
  timezone: text('timezone').notNull().default('Asia/Tashkent'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  /** When the person agreed to the proposed timezone; null while it is only a default. */
  timezoneConfirmedAt: timestamp('timezone_confirmed_at', { withTimezone: true }),
});

export const patientProfiles = pgTable('patient_profiles', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  firstName: text('first_name').notNull(),
  lastName: text('last_name').notNull(),
  /** Encrypted: see FieldCipher. Never read or written without it. */
  dateOfBirthEnc: text('date_of_birth_enc'),
  phoneEnc: text('phone_enc'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const clinicianProfiles = pgTable(
  'clinician_profiles',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id),
    clinicId: uuid('clinic_id')
      .notNull()
      .references(() => clinics.id),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    verificationStatus: text('verification_status', { enum: VERIFICATION_STATUSES })
      .notNull()
      .default('PENDING'),
    verifiedBy: uuid('verified_by').references(() => users.id),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verificationReference: text('verification_reference'),
    /** What the applicant wrote about themselves, for whoever verifies them. */
    applicantNote: text('applicant_note'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('clinician_profiles_clinic_idx').on(table.clinicId)],
);

export const clinicStaff = pgTable('clinic_staff', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id),
  clinicId: uuid('clinic_id')
    .notNull()
    .references(() => clinics.id),
  role: text('role', { enum: CLINIC_STAFF_ROLES }).notNull(),
  status: text('status', { enum: STAFF_STATUSES }).notNull().default('ACTIVE'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const platformStaff = pgTable('platform_staff', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id),
  role: text('role', { enum: PLATFORM_ROLES }).notNull(),
  status: text('status', { enum: STAFF_STATUSES }).notNull().default('ACTIVE'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const careRelationships = pgTable(
  'care_relationships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patientProfiles.userId),
    clinicianId: uuid('clinician_id')
      .notNull()
      .references(() => clinicianProfiles.userId),
    status: text('status', { enum: CARE_RELATIONSHIP_STATUSES }).notNull().default('PENDING'),
    consentAt: timestamp('consent_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** Set while the patient lets this doctor read the summaries of their earlier courses. */
    historySharedAt: timestamp('history_shared_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('care_relationships_open_pair_idx')
      .on(table.clinicianId, table.patientId)
      .where(sql`${table.status} in ('PENDING', 'ACTIVE')`),
    index('care_relationships_patient_idx').on(table.patientId),
  ],
);

export const caregiverRelationships = pgTable(
  'caregiver_relationships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    patientId: uuid('patient_id')
      .notNull()
      .references(() => patientProfiles.userId),
    caregiverUserId: uuid('caregiver_user_id')
      .notNull()
      .references(() => users.id),
    addedBy: uuid('added_by')
      .notNull()
      .references(() => users.id),
    scope: text('scope', { enum: CAREGIVER_SCOPES }).notNull().default('SCHEDULE'),
    status: text('status', { enum: CAREGIVER_STATUSES }).notNull().default('PENDING'),
    consentAt: timestamp('consent_at', { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    uniqueIndex('caregiver_relationships_open_idx')
      .on(table.patientId, table.caregiverUserId)
      .where(sql`${table.status} in ('PENDING', 'ACTIVE')`),
    index('caregiver_relationships_caregiver_idx').on(table.caregiverUserId),
  ],
);
