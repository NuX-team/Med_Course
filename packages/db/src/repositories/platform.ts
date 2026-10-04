import { eq } from 'drizzle-orm';
import type { Actor } from '../access/actor';
import { ForbiddenError } from '../access/errors';
import type { Executor } from '../orm';
import { platformStaff, users } from '../schema';
import type { RepositoryDeps } from './context';

/** The few people who run the service itself (not a clinic). */
export function createPlatformRepository(db: Executor, deps: RepositoryDeps) {
  const { audit, requestId } = deps;
  const context = requestId === undefined ? {} : { requestId };

  return {
    /**
     * Makes an existing, active account a technical administrator (or restores a revoked one).
     * System only: this is done from the server's command line, never from a chat.
     * Returns false if there is no such active account.
     */
    async grantTechAdmin(actor: Actor, userId: string): Promise<boolean> {
      if (actor.kind !== 'SYSTEM') {
        throw new ForbiddenError('only the system grants administrator rights');
      }
      return db.transaction(async (tx) => {
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
  };
}

export type PlatformRepository = ReturnType<typeof createPlatformRepository>;
