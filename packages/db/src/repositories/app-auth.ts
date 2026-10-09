import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { ForbiddenError } from '../access/errors';
import type { Actor } from '../access/actor';
import type { Executor } from '../orm';
import {
  appLogins,
  authSessions,
  deviceTokens,
  patientProfiles,
  users,
  type AppPlatform,
} from '../schema';
import type { RepositoryDeps } from './context';

/** How long the person has to open the bot and press "Confirm". */
export const APP_LOGIN_TTL_MS = 10 * 60_000;
/** A phone stays signed in for a month; signing out or deleting the account ends it sooner. */
export const APP_SESSION_TTL_MS = 30 * 24 * 3_600_000;
/** Sign-ins begun across the whole service in one minute: a cap against filling the table. */
export const MAX_APP_LOGINS_PER_MINUTE = 120;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** The code that travels in `t.me/<bot>?start=a_<code>`: short enough for the 64-char payload. */
const LINK_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function looksLikeAppLinkCode(value: string): boolean {
  return LINK_CODE_PATTERN.test(value);
}

export type AppLoginStart =
  | {
      readonly status: 'STARTED';
      readonly linkCode: string;
      readonly pollToken: string;
      readonly expiresAt: Date;
    }
  | { readonly status: 'BUSY' };

/** What the bot shows when a sign-in link is opened. */
export type AppLoginCheck =
  | { readonly status: 'INVALID' }
  | { readonly status: 'OPEN'; readonly loginId: string; readonly expiresAt: Date };

export type AppLoginPoll =
  /** Not confirmed in the bot yet: ask again in a moment. */
  | { readonly status: 'PENDING'; readonly expiresAt: Date }
  /** Unknown, expired, or already exchanged for a session: start over. */
  | { readonly status: 'GONE' }
  | {
      readonly status: 'READY';
      readonly token: string;
      readonly expiresAt: Date;
      readonly userId: string;
    };

export interface AppSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly locale: 'ru' | 'uz';
  readonly timezone: string;
}

/**
 * Sign-in of the mobile app. The app has no password and no phone check of its own: the person
 * proves who they are by pressing a button in the bot, in the Telegram account they already use.
 * Every token is returned once and stored only as a SHA-256 hash.
 */
export function createAppAuthRepository(db: Executor, deps: RepositoryDeps) {
  const { audit, requestId } = deps;
  const context = requestId === undefined ? {} : { requestId };

  return {
    /** The app asks to sign in: a link for the bot and a token for the app to poll with. */
    async begin(input: { now: Date }): Promise<AppLoginStart> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('app_logins:begin'))`);
        const [recent] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(appLogins)
          .where(gt(appLogins.createdAt, new Date(input.now.getTime() - 60_000)));
        if ((recent?.n ?? 0) >= MAX_APP_LOGINS_PER_MINUTE) {
          return { status: 'BUSY' };
        }
        const linkCode = randomBytes(16).toString('base64url');
        const pollToken = randomBytes(32).toString('base64url');
        const expiresAt = new Date(input.now.getTime() + APP_LOGIN_TTL_MS);
        await tx.insert(appLogins).values({
          linkHash: hash(linkCode),
          pollHash: hash(pollToken),
          expiresAt,
          createdAt: input.now,
        });
        return { status: 'STARTED', linkCode, pollToken, expiresAt };
      });
    },

    /** The bot: is this a sign-in still waiting for someone to confirm it? */
    async inspect(input: { linkCode: string; now: Date }): Promise<AppLoginCheck> {
      if (!looksLikeAppLinkCode(input.linkCode)) {
        return { status: 'INVALID' };
      }
      const [found] = await db
        .select({ id: appLogins.id, expiresAt: appLogins.expiresAt })
        .from(appLogins)
        .where(
          and(
            eq(appLogins.linkHash, hash(input.linkCode)),
            isNull(appLogins.confirmedAt),
            gt(appLogins.expiresAt, input.now),
          ),
        );
      return found === undefined
        ? { status: 'INVALID' }
        : { status: 'OPEN', loginId: found.id, expiresAt: found.expiresAt };
    },

    /**
     * The person pressed "Confirm" in the bot. Only a registered patient may: the app shows a
     * patient's courses. False when the sign-in is gone, expired or already confirmed.
     */
    async confirm(actor: Actor, input: { loginId: string; now: Date }): Promise<boolean> {
      if (actor.kind !== 'PATIENT') {
        throw new ForbiddenError('only a patient signs in to the app');
      }
      return db.transaction(async (tx) => {
        const [profile] = await tx
          .select({ userId: patientProfiles.userId })
          .from(patientProfiles)
          .innerJoin(users, eq(users.id, patientProfiles.userId))
          .where(and(eq(patientProfiles.userId, actor.userId), eq(users.status, 'ACTIVE')));
        if (profile === undefined) {
          return false;
        }
        const [confirmed] = await tx
          .update(appLogins)
          .set({ userId: actor.userId, confirmedAt: input.now })
          .where(
            and(
              eq(appLogins.id, input.loginId),
              isNull(appLogins.confirmedAt),
              gt(appLogins.expiresAt, input.now),
            ),
          )
          .returning({ id: appLogins.id });
        if (confirmed === undefined) {
          return false;
        }
        await audit.record(tx, {
          actor,
          entityType: 'app_logins',
          entityId: confirmed.id,
          action: 'CONFIRM',
          changes: ['user_id', 'confirmed_at'],
          ...context,
        });
        return true;
      });
    },

    /** The app asks whether its sign-in was confirmed. The first answer "yes" spends it. */
    async poll(input: {
      pollToken: string;
      platform: AppPlatform;
      now: Date;
    }): Promise<AppLoginPoll> {
      if (!TOKEN_PATTERN.test(input.pollToken)) {
        return { status: 'GONE' };
      }
      return db.transaction(async (tx) => {
        const [login] = await tx
          .select()
          .from(appLogins)
          .where(
            and(
              eq(appLogins.pollHash, hash(input.pollToken)),
              isNull(appLogins.usedAt),
              gt(appLogins.expiresAt, input.now),
            ),
          )
          .for('update');
        if (login === undefined) {
          return { status: 'GONE' };
        }
        if (login.userId === null) {
          return { status: 'PENDING', expiresAt: login.expiresAt };
        }
        await tx.update(appLogins).set({ usedAt: input.now }).where(eq(appLogins.id, login.id));
        const [account] = await tx
          .select({ status: users.status })
          .from(users)
          .where(eq(users.id, login.userId));
        if (account?.status !== 'ACTIVE') {
          return { status: 'GONE' };
        }
        const token = randomBytes(32).toString('base64url');
        const expiresAt = new Date(input.now.getTime() + APP_SESSION_TTL_MS);
        const [session] = await tx
          .insert(authSessions)
          .values({
            userId: login.userId,
            tokenHash: hash(token),
            platform: input.platform,
            expiresAt,
            createdAt: input.now,
          })
          .returning({ id: authSessions.id });
        await audit.record(tx, {
          actor: { kind: 'SYSTEM', reason: 'app sign-in' },
          entityType: 'auth_sessions',
          entityId: session?.id ?? '',
          action: 'SIGN_IN',
          changes: [],
          ...context,
        });
        return { status: 'READY', token, expiresAt, userId: login.userId };
      });
    },

    /**
     * Who a bearer token belongs to. Null for an unknown, expired or revoked token, for a closed
     * account, and for a person who is no longer a patient (the profile is what the app shows).
     */
    async session(input: { token: string; now: Date }): Promise<AppSession | null> {
      if (!TOKEN_PATTERN.test(input.token)) {
        return null;
      }
      const [found] = await db
        .select({
          sessionId: authSessions.id,
          userId: authSessions.userId,
          locale: users.locale,
          timezone: users.timezone,
        })
        .from(authSessions)
        .innerJoin(users, eq(users.id, authSessions.userId))
        .innerJoin(patientProfiles, eq(patientProfiles.userId, authSessions.userId))
        .where(
          and(
            eq(authSessions.tokenHash, hash(input.token)),
            isNull(authSessions.revokedAt),
            gt(authSessions.expiresAt, input.now),
            eq(users.status, 'ACTIVE'),
          ),
        );
      return found ?? null;
    },

    /** Signs a phone out. Unknown tokens are ignored. */
    async signOut(input: { token: string; now: Date }): Promise<void> {
      if (!TOKEN_PATTERN.test(input.token)) {
        return;
      }
      await db
        .update(authSessions)
        .set({ revokedAt: input.now })
        .where(and(eq(authSessions.tokenHash, hash(input.token)), isNull(authSessions.revokedAt)));
    },

    /** Keeps a push token for later. The same token moving to another account moves with it. */
    async registerDevice(
      actor: Actor,
      input: { platform: AppPlatform; token: string },
    ): Promise<void> {
      if (actor.kind !== 'PATIENT') {
        throw new ForbiddenError('only a patient registers their own phone');
      }
      await db
        .insert(deviceTokens)
        .values({ userId: actor.userId, platform: input.platform, token: input.token })
        .onConflictDoUpdate({
          target: [deviceTokens.platform, deviceTokens.token],
          set: { userId: actor.userId },
        });
    },

    /** Forgets sign-ins and sessions that ran out before `before`. System housekeeping. */
    async prune(actor: Actor, before: Date): Promise<number> {
      if (actor.kind !== 'SYSTEM') {
        throw new ForbiddenError('only the system prunes sessions');
      }
      const logins = await db
        .delete(appLogins)
        .where(lt(appLogins.expiresAt, before))
        .returning({ id: appLogins.id });
      const sessions = await db
        .delete(authSessions)
        .where(or(lt(authSessions.expiresAt, before), lt(authSessions.revokedAt, before)))
        .returning({ id: authSessions.id });
      return logins.length + sessions.length;
    },
  };
}

export type AppAuthRepository = ReturnType<typeof createAppAuthRepository>;
