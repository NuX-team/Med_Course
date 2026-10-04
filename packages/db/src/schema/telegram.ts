import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import {
  CONSENT_CONTEXTS,
  CONSENT_DECISIONS,
  CONSENT_KINDS,
  CONVERSATION_FLOWS,
  LOCALES,
} from './enums';
import { users } from './people';

// Constraints and triggers live in the SQL migrations.

export const tgUpdates = pgTable(
  'tg_updates',
  {
    updateId: bigint('update_id', { mode: 'number' }).primaryKey(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('tg_updates_received_idx').on(table.receivedAt)],
);

export const conversationStates = pgTable(
  'conversation_states',
  {
    telegramUserId: bigint('telegram_user_id', { mode: 'number' }).primaryKey(),
    flow: text('flow', { enum: CONVERSATION_FLOWS }).notNull(),
    step: text('step').notNull(),
    data: jsonb('data').notNull().default({}),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('conversation_states_expires_idx').on(table.expiresAt)],
);

export const consentRecords = pgTable(
  'consent_records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    kind: text('kind', { enum: CONSENT_KINDS }).notNull(),
    version: text('version').notNull(),
    decision: text('decision', { enum: CONSENT_DECISIONS }).notNull(),
    locale: text('locale', { enum: LOCALES }).notNull(),
    context: text('context', { enum: CONSENT_CONTEXTS }).notNull().default('ONBOARDING'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('consent_records_user_idx').on(table.userId, table.kind, table.at)],
);
