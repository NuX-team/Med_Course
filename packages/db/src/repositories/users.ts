import { and, eq, sql } from 'drizzle-orm';
import { isHuman, type Actor } from '../access/actor';
import { ForbiddenError } from '../access/errors';
import type { Executor } from '../orm';
import { activeTechAdmin, activeUser } from '../access/scopes';
import { caregiverRelationships, patientProfiles, users } from '../schema';
import type { RepositoryDeps } from './context';

export type UserRow = typeof users.$inferSelect;
export type Locale = UserRow['locale'];

/** Whoever is acting may change their own account; the system may change anyone's. */
function mayActFor(actor: Actor, userId: string): boolean {
  return actor.kind === 'SYSTEM' || (isHuman(actor) && actor.userId === userId);
}

export function createUserRepository(db: Executor, deps: RepositoryDeps) {
  const { audit, requestId } = deps;
  const context = requestId === undefined ? {} : { requestId };

  return {
    /**
     * How an incoming Telegram update is tied to an account, before there is any actor to speak
     * of. System only: nobody else has a reason to look a person up by Telegram id.
     */
    async findByTelegramId(actor: Actor, telegramUserId: number): Promise<UserRow | null> {
      if (actor.kind !== 'SYSTEM') {
        throw new ForbiddenError('only the system looks accounts up by Telegram id');
      }
      const [user] = await db.select().from(users).where(eq(users.telegramUserId, telegramUserId));
      return user ?? null;
    },

    /**
     * What the main menu needs to know about a registered person, in one query: whether some
     * patient lets them watch over a course (the "wards" button), and whether they are an active
     * technical administrator (the "admin" button). Both only decide what to show; every section
     * re-checks in the database when opened. System only, or the person themself.
     */
    async menuFlags(
      actor: Actor,
      userId: string,
    ): Promise<{ readonly watching: boolean; readonly admin: boolean }> {
      if (!mayActFor(actor, userId)) {
        throw new ForbiddenError('only the system reads another person’s menu flags');
      }
      const [row] = await db.execute<{ watching: boolean; admin: boolean }>(sql`
        select
          (${activeUser(userId)} and exists (
            select 1 from ${caregiverRelationships}
            where ${caregiverRelationships.caregiverUserId} = ${userId}
              and ${caregiverRelationships.status} = 'ACTIVE'
              and exists (
                select 1 from ${users}
                where ${users.id} = ${caregiverRelationships.patientId} and ${users.status} = 'ACTIVE'
              )
              and exists (
                select 1 from ${patientProfiles}
                where ${patientProfiles.userId} = ${caregiverRelationships.patientId}
              )
          )) as watching,
          ${activeTechAdmin(userId)} as admin`);
      return { watching: row?.watching === true, admin: row?.admin === true };
    },

    /** The account behind an actor, or null if it is not theirs. */
    async getOwn(actor: Actor, userId: string): Promise<UserRow | null> {
      if (!mayActFor(actor, userId)) {
        return null;
      }
      const [user] = await db.select().from(users).where(eq(users.id, userId));
      return user ?? null;
    },

    /**
     * Opens an account for a Telegram user. Idempotent: a second call for the same Telegram id
     * returns the existing account and changes nothing, so a repeated update is harmless.
     */
    async create(
      actor: Actor,
      input: { telegramUserId: number; locale: Locale },
    ): Promise<{ user: UserRow; created: boolean }> {
      if (actor.kind !== 'SYSTEM') {
        throw new ForbiddenError('only the system opens accounts');
      }
      return db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(users)
          .values({ telegramUserId: input.telegramUserId, locale: input.locale })
          .onConflictDoNothing({ target: users.telegramUserId })
          .returning();
        if (inserted !== undefined) {
          await audit.record(tx, {
            actor,
            entityType: 'users',
            entityId: inserted.id,
            action: 'CREATE',
            after: inserted,
            changes: ['telegram_user_id', 'locale'],
            ...context,
          });
          return { user: inserted, created: true };
        }
        const [existing] = await tx
          .select()
          .from(users)
          .where(eq(users.telegramUserId, input.telegramUserId));
        if (existing === undefined) {
          throw new Error('account vanished between conflict and read');
        }
        return { user: existing, created: false };
      });
    },

    /** Null if the account does not exist or is not active. */
    async setLocale(actor: Actor, userId: string, locale: Locale): Promise<UserRow | null> {
      if (!mayActFor(actor, userId)) {
        throw new ForbiddenError('an account can only be changed by its owner');
      }
      return db.transaction(async (tx) => {
        const [before] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
        if (before?.status !== 'ACTIVE') {
          return null;
        }
        if (before.locale === locale) {
          return before;
        }
        const [after] = await tx
          .update(users)
          .set({ locale })
          .where(and(eq(users.id, userId), eq(users.status, 'ACTIVE')))
          .returning();
        await audit.record(tx, {
          actor,
          entityType: 'users',
          entityId: userId,
          action: 'UPDATE',
          before,
          after: after ?? null,
          changes: ['locale'],
          ...context,
        });
        return after ?? null;
      });
    },

    /**
     * Records a timezone the person has agreed to (an IANA name; the caller checks it against
     * the zone database). Stamps `timezone_confirmed_at` every time, so it always means
     * "last agreed". Null if the account does not exist or is not active.
     */
    async confirmTimezone(
      actor: Actor,
      userId: string,
      timezone: string,
      at: Date,
    ): Promise<UserRow | null> {
      if (!mayActFor(actor, userId)) {
        throw new ForbiddenError('an account can only be changed by its owner');
      }
      return db.transaction(async (tx) => {
        const [before] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
        if (before?.status !== 'ACTIVE') {
          return null;
        }
        const [after] = await tx
          .update(users)
          .set({ timezone, timezoneConfirmedAt: at })
          .where(and(eq(users.id, userId), eq(users.status, 'ACTIVE')))
          .returning();
        await audit.record(tx, {
          actor,
          entityType: 'users',
          entityId: userId,
          action: 'UPDATE',
          before,
          after: after ?? null,
          changes:
            before.timezone === timezone
              ? ['timezone_confirmed_at']
              : ['timezone', 'timezone_confirmed_at'],
          ...context,
        });
        return after ?? null;
      });
    },
  };
}

export type UserRepository = ReturnType<typeof createUserRepository>;
