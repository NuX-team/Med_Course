import { and, asc, eq, sql } from 'drizzle-orm';
import type { Actor } from '../access/actor';
import { ForbiddenError } from '../access/errors';
import { activeTechAdmin } from '../access/scopes';
import type { Executor } from '../orm';
import { patientProfiles, platformStaff, users } from '../schema';
import type { RepositoryDeps } from './context';

/** One technical administrator, as the administrators' list shows them. */
export interface TechAdminRow {
  readonly userId: string;
  readonly telegramUserId: number;
  /** The language they use the bot in: what to tell them in. */
  readonly locale: 'ru' | 'uz';
  /** Null for an account that never finished registering. */
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly since: Date;
}

/** Why an administrator's rights were or were not taken away. */
export type RevokeAdminResult = 'REVOKED' | 'NOT_ADMIN' | 'SELF' | 'LAST';

/** The few people who run the service itself (not a clinic). */
export function createPlatformRepository(db: Executor, deps: RepositoryDeps) {
  const { audit, requestId } = deps;
  const context = requestId === undefined ? {} : { requestId };

  /** Only the system, or an administrator who is still one right now (revocable, so asked each time). */
  const assertMayManageAdmins = async (
    tx: Pick<Executor, 'execute'>,
    actor: Actor,
  ): Promise<void> => {
    if (actor.kind === 'SYSTEM') {
      return;
    }
    if (actor.kind !== 'TECH_ADMIN') {
      throw new ForbiddenError('only an administrator or the system manages administrators');
    }
    const allowed = await tx.execute<{ ok: boolean }>(
      sql`select ${activeTechAdmin(actor.userId)} as ok`,
    );
    if (allowed[0]?.ok !== true) {
      throw new ForbiddenError('the administrator is no longer active');
    }
  };

  return {
    /**
     * Whether this account is an active technical administrator right now: what the menu uses
     * to decide whether to offer the administrator's section. The section itself re-checks on
     * every call, so this only chooses what to show.
     */
    async isTechAdmin(userId: string): Promise<boolean> {
      const rows = await db.execute<{ ok: boolean }>(sql`select ${activeTechAdmin(userId)} as ok`);
      return rows[0]?.ok === true;
    },

    /**
     * Makes an existing, active account a technical administrator (or restores a revoked one).
     * The system does it (from the server's command line), and so does an administrator who is
     * still active (from the bot, with the person's Telegram id: ARCHITECTURE D-128).
     * Returns false if there is no such active account.
     */
    async grantTechAdmin(actor: Actor, userId: string): Promise<boolean> {
      if (actor.kind !== 'SYSTEM' && actor.kind !== 'TECH_ADMIN') {
        throw new ForbiddenError('only the system or an administrator grants administrator rights');
      }
      return db.transaction(async (tx) => {
        await assertMayManageAdmins(tx, actor);
        const [account] = await tx
          .select({ status: users.status })
          .from(users)
          .where(eq(users.id, userId));
        if (account?.status !== 'ACTIVE') {
          return false;
        }
        const [before] = await tx
          .select()
          .from(platformStaff)
          .where(eq(platformStaff.userId, userId))
          .for('update');
        if (before?.status === 'ACTIVE') {
          return true;
        }
        const [after] = await tx
          .insert(platformStaff)
          .values({ userId, role: 'TECH_ADMIN' })
          .onConflictDoUpdate({ target: platformStaff.userId, set: { status: 'ACTIVE' } })
          .returning();
        await audit.record(tx, {
          actor,
          entityType: 'platform_staff',
          entityId: userId,
          action: before === undefined ? 'CREATE' : 'UPDATE',
          before: before ?? null,
          after: after ?? null,
          changes: before === undefined ? ['role', 'status'] : ['status'],
          ...context,
        });
        return true;
      });
    },

    /** Everyone who is an administrator now, oldest first. Administrators only. */
    async listTechAdmins(actor: Actor): Promise<TechAdminRow[]> {
      if (actor.kind !== 'TECH_ADMIN') {
        throw new ForbiddenError('only an administrator sees the administrators');
      }
      return db.transaction(async (tx) => {
        await assertMayManageAdmins(tx, actor);
        return tx
          .select({
            userId: platformStaff.userId,
            telegramUserId: users.telegramUserId,
            locale: users.locale,
            firstName: patientProfiles.firstName,
            lastName: patientProfiles.lastName,
            since: platformStaff.createdAt,
          })
          .from(platformStaff)
          .innerJoin(users, eq(users.id, platformStaff.userId))
          .leftJoin(patientProfiles, eq(patientProfiles.userId, platformStaff.userId))
          .where(and(eq(platformStaff.status, 'ACTIVE'), eq(platformStaff.role, 'TECH_ADMIN')))
          .orderBy(asc(platformStaff.createdAt), asc(platformStaff.userId));
      });
    },

    /**
     * Takes an administrator's rights away. Never one's own (somebody else does it), and never
     * the last one: a service nobody can run is not a safe state to leave behind.
     */
    async revokeTechAdmin(actor: Actor, userId: string): Promise<RevokeAdminResult> {
      if (actor.kind !== 'TECH_ADMIN') {
        throw new ForbiddenError('only an administrator takes administrator rights away');
      }
      return db.transaction(async (tx) => {
        await assertMayManageAdmins(tx, actor);
        if (actor.userId === userId) {
          return 'SELF';
        }
        // Locks every active administrator, so two revocations at once cannot leave none.
        const active = await tx
          .select({ userId: platformStaff.userId })
          .from(platformStaff)
          .where(and(eq(platformStaff.status, 'ACTIVE'), eq(platformStaff.role, 'TECH_ADMIN')))
          .for('update');
        const target = active.find((row) => row.userId === userId);
        if (target === undefined) {
          return 'NOT_ADMIN';
        }
        if (active.length <= 1) {
          return 'LAST';
        }
        const [before] = await tx
          .select()
          .from(platformStaff)
          .where(eq(platformStaff.userId, userId));
        const [after] = await tx
          .update(platformStaff)
          .set({ status: 'REVOKED' })
          .where(eq(platformStaff.userId, userId))
          .returning();
        await audit.record(tx, {
          actor,
          entityType: 'platform_staff',
          entityId: userId,
          action: 'REVOKE',
          before: before ?? null,
          after: after ?? null,
          changes: ['status'],
          ...context,
        });
        return 'REVOKED';
      });
    },
  };
}

export type PlatformRepository = ReturnType<typeof createPlatformRepository>;
