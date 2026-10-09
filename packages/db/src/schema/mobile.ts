import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { APP_PLATFORMS } from './enums';
import { users } from './people';

// Constraints and triggers live in the SQL migration 0018.

/** A sign-in of the mobile app, confirmed by the person in the bot. Only hashes are stored. */
export const appLogins = pgTable(
  'app_logins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    linkHash: text('link_hash').notNull().unique(),
    pollHash: text('poll_hash').notNull().unique(),
    userId: uuid('user_id').references(() => users.id),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    usedAt: timestamp('used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('app_logins_created_idx').on(table.createdAt)],
);

/** A signed-in device. Carries no rights of its own: the actor is re-checked on every query. */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    tokenHash: text('token_hash').notNull().unique(),
    platform: text('platform', { enum: APP_PLATFORMS }).notNull().default('ios'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('auth_sessions_user_idx').on(table.userId)],
);

/** Push tokens, kept for a future second reminder channel; reminders stay in Telegram. */
export const deviceTokens = pgTable(
  'device_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    platform: text('platform', { enum: APP_PLATFORMS }).notNull(),
    token: text('token').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('device_tokens_user_idx').on(table.userId)],
);
