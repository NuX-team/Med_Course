import { createHash, randomBytes } from 'node:crypto';
import { and, count, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { Actor } from '../access/actor';
import { ForbiddenError } from '../access/errors';
import { activeUser, usableClinician } from '../access/scopes';
import type { Executor } from '../orm';
import {
  careRelationships,
  clinicianProfiles,
  clinics,
  invitationAttempts,
  invitations,
  patientProfiles,
  users,
} from '../schema';
import type { RepositoryDeps } from './context';

/** How long a link works. Long enough to reach a patient who is not at their phone. */
export const INVITATION_TTL_MS = 72 * 3_600_000;
/** Unused links one doctor may have at a time: a leaked-link and flooding guard. */
export const MAX_OPEN_INVITATIONS = 20;
/** Wrong or unusable links one Telegram user may try per window. */
export const MAX_FAILED_ATTEMPTS = 5;
export const ATTEMPT_WINDOW_MS = 3_600_000;

/** 16 random bytes in base64url: exactly this many characters. */
export const INVITE_CODE_LENGTH = 22;
const INVITE_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** True if `value` has the shape of a code this service hands out. Says nothing about validity. */
export function looksLikeInviteCode(value: string): boolean {
  return INVITE_CODE_PATTERN.test(value);
}

/** What is stored and compared: the code itself never touches the database. */
export function hashInviteCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

export function generateInviteCode(): string {
  return randomBytes(16).toString('base64url');
}

export interface InvitedDoctor {
  readonly userId: string;
  readonly telegramUserId: number;
  readonly locale: 'ru' | 'uz';
  readonly firstName: string;
  readonly lastName: string;
}

/**
 * What a code turns out to be. `INVALID` covers unknown, used, withdrawn, expired and "its doctor
 * is no longer in good standing" alike: telling them apart would only help someone guessing.
 */
export type InviteCheck =
  | { readonly result: 'THROTTLED' }
  | { readonly result: 'INVALID' }
  | { readonly result: 'SELF' }
  | { readonly result: 'CONNECTED'; readonly status: 'ACTIVE' | 'PENDING' }
  | {
      readonly result: 'OPEN';
      readonly invitationId: string;
      readonly label: string | null;
      readonly doctor: InvitedDoctor;
    };

export type InviteRedemption =
  | Exclude<InviteCheck, { result: 'OPEN' }>
  | {
      readonly result: 'ACCEPTED';
      readonly relationshipId: string;
      readonly label: string | null;
      readonly doctor: InvitedDoctor;
      readonly patient: { readonly firstName: string; readonly lastName: string };
    };

export type CreatedInvitation =
  | {
      readonly status: 'CREATED';
      readonly invitation: {
        readonly id: string;
        readonly label: string | null;
        readonly expiresAt: Date;
      };
      /** Shown to the doctor once. Only its hash is stored, so it cannot be shown again. */
      readonly code: string;
    }
  /** Not a doctor in good standing (unverified, revoked, clinic suspended, account closed). */
  | { readonly status: 'NOT_ALLOWED' }
  | { readonly status: 'LIMIT' };

export interface OpenInvitation {
  readonly id: string;
  readonly label: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

const LIST_LIMIT = 50;

export function createInvitationRepository(db: Executor, deps: RepositoryDeps) {
  const { audit, requestId } = deps;
  const context = requestId === undefined ? {} : { requestId };

  const recentFailures = async (
    executor: Executor,
    telegramUserId: number,
    now: Date,
  ): Promise<number> => {
    const [row] = await executor
      .select({ failures: count() })
      .from(invitationAttempts)
      .where(
        and(
          eq(invitationAttempts.telegramUserId, telegramUserId),
          gt(invitationAttempts.at, new Date(now.getTime() - ATTEMPT_WINDOW_MS)),
        ),
      );
    return row?.failures ?? 0;
  };

  const noteFailure = async (
    executor: Executor,
    telegramUserId: number,
    now: Date,
  ): Promise<void> => {
    await executor.insert(invitationAttempts).values({ telegramUserId, at: now });
  };

  /**
   * Decides what a code is for this person. Records a failed attempt for anything that is not
   * a usable code (except being your own link, which is a mistake rather than a guess).
   * With `lock`, the invitation row stays locked until the transaction ends.
   */
  const evaluate = async (
    executor: Executor,
    input: {
      telegramUserId: number;
      codeHash: string;
      patientUserId: string | null;
      now: Date;
      lock: boolean;
    },
  ): Promise<InviteCheck> => {
    const { telegramUserId, patientUserId, now } = input;
    if ((await recentFailures(executor, telegramUserId, now)) >= MAX_FAILED_ATTEMPTS) {
      return { result: 'THROTTLED' };
    }
    const fail = async (): Promise<InviteCheck> => {
      await noteFailure(executor, telegramUserId, now);
      return { result: 'INVALID' };
    };

    const query = executor
      .select({
        invitation: invitations,
        verification: clinicianProfiles.verificationStatus,
        clinicStatus: clinics.status,
        userStatus: users.status,
        telegramUserId: users.telegramUserId,
        locale: users.locale,
        firstName: clinicianProfiles.firstName,
        lastName: clinicianProfiles.lastName,
      })
      .from(invitations)
      .innerJoin(clinicianProfiles, eq(clinicianProfiles.userId, invitations.clinicianId))
      .innerJoin(clinics, eq(clinics.id, clinicianProfiles.clinicId))
      .innerJoin(users, eq(users.id, invitations.clinicianId))
      .where(eq(invitations.codeHash, input.codeHash));
    const [row] = await (input.lock ? query.for('update', { of: invitations }) : query);
    if (row === undefined) {
      return fail();
    }
    const { invitation } = row;

    if (patientUserId !== null && invitation.clinicianId === patientUserId) {
      return { result: 'SELF' };
    }
    if (invitation.usedAt !== null) {
      // A double tap by the same person is not an error: it is the relationship they just made.
      if (
        patientUserId !== null &&
        invitation.usedBy === patientUserId &&
        invitation.careRelationshipId !== null
      ) {
        const [relationship] = await executor
          .select({ status: careRelationships.status })
          .from(careRelationships)
          .where(eq(careRelationships.id, invitation.careRelationshipId));
        if (relationship?.status === 'ACTIVE' || relationship?.status === 'PENDING') {
          return { result: 'CONNECTED', status: relationship.status };
        }
      }
      return fail();
    }
    const doctorInGoodStanding =
      row.verification === 'VERIFIED' &&
      row.clinicStatus === 'ACTIVE' &&
      row.userStatus === 'ACTIVE';
    if (invitation.revokedAt !== null || invitation.expiresAt <= now || !doctorInGoodStanding) {
      return fail();
    }

    if (patientUserId !== null) {
      const [existing] = await executor
        .select({ status: careRelationships.status })
        .from(careRelationships)
        .where(
          and(
            eq(careRelationships.clinicianId, invitation.clinicianId),
            eq(careRelationships.patientId, patientUserId),
            inArray(careRelationships.status, ['ACTIVE', 'PENDING']),
          ),
        );
      if (existing?.status === 'ACTIVE' || existing?.status === 'PENDING') {
        return { result: 'CONNECTED', status: existing.status };
      }
    }

    return {
      result: 'OPEN',
      invitationId: invitation.id,
      label: invitation.label,
      doctor: {
        userId: invitation.clinicianId,
        telegramUserId: row.telegramUserId,
        locale: row.locale,
        firstName: row.firstName,
        lastName: row.lastName,
      },
    };
  };

  const requireClinician = (actor: Actor): string => {
    if (actor.kind !== 'CLINICIAN') {
      throw new ForbiddenError('invitations belong to a doctor');
    }
    return actor.userId;
  };

  return {
    /** A doctor in good standing makes a one-time link for a patient. */
    async create(
      actor: Actor,
      input: { label?: string | null; now: Date },
    ): Promise<CreatedInvitation> {
      const clinicianId = requireClinician(actor);
      const label = input.label?.trim() ?? null;
      if (label !== null && (label.length === 0 || label.length > 100)) {
        throw new RangeError('the label must be 1-100 characters');
      }

      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`invitations:${clinicianId}`}))`,
        );

        const standing = await tx.execute<{ ok: boolean }>(
          sql`select (${activeUser(clinicianId)} and ${usableClinician(clinicianId)}) as ok`,
        );
        if (standing[0]?.ok !== true) {
          return { status: 'NOT_ALLOWED' };
        }
        const [open] = await tx
          .select({ open: count() })
          .from(invitations)
          .where(
            and(
              eq(invitations.clinicianId, clinicianId),
              isNull(invitations.usedAt),
              isNull(invitations.revokedAt),
              gt(invitations.expiresAt, input.now),
            ),
          );
        if ((open?.open ?? 0) >= MAX_OPEN_INVITATIONS) {
          return { status: 'LIMIT' };
        }

        const code = generateInviteCode();
        const [created] = await tx
          .insert(invitations)
          .values({
            clinicianId,
            codeHash: hashInviteCode(code),
            label,
            createdAt: input.now,
            expiresAt: new Date(input.now.getTime() + INVITATION_TTL_MS),
          })
          .returning();
        if (created === undefined) {
          throw new Error('invitation insert returned no row');
        }
        await audit.record(tx, {
          actor,
          entityType: 'invitations',
          entityId: created.id,
          action: 'CREATE',
          after: created,
          changes: [
            'clinician_id',
            'code_hash',
            'expires_at',
            ...(label === null ? [] : ['label']),
          ],
          ...context,
        });
        return {
          status: 'CREATED',
          invitation: { id: created.id, label: created.label, expiresAt: created.expiresAt },
          code,
        };
      });
    },

    /** The doctor's own links that can still be used, newest first. */
    async listOpen(actor: Actor, now: Date): Promise<OpenInvitation[]> {
      const clinicianId = requireClinician(actor);
      return db
        .select({
          id: invitations.id,
          label: invitations.label,
          createdAt: invitations.createdAt,
          expiresAt: invitations.expiresAt,
        })
        .from(invitations)
        .where(
          and(
            eq(invitations.clinicianId, clinicianId),
            isNull(invitations.usedAt),
            isNull(invitations.revokedAt),
            gt(invitations.expiresAt, now),
            activeUser(clinicianId),
            usableClinician(clinicianId),
          ),
        )
        .orderBy(desc(invitations.createdAt), desc(invitations.id))
        .limit(LIST_LIMIT);
    },

    /** Withdraws one of the doctor's own unused links. False if there is nothing to withdraw. */
    async revoke(actor: Actor, invitationId: string, now: Date): Promise<boolean> {
      const clinicianId = requireClinician(actor);
      return db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(invitations)
          .where(
            and(
              eq(invitations.id, invitationId),
              eq(invitations.clinicianId, clinicianId),
              isNull(invitations.usedAt),
              isNull(invitations.revokedAt),
              activeUser(clinicianId),
              usableClinician(clinicianId),
            ),
          )
          .for('update');
        if (before === undefined) {
          return false;
        }
        const [after] = await tx
          .update(invitations)
          .set({ revokedAt: now })
          .where(eq(invitations.id, invitationId))
          .returning();
        await audit.record(tx, {
          actor,
          entityType: 'invitations',
          entityId: invitationId,
          action: 'REVOKE',
          before,
          after: after ?? null,
          changes: ['revoked_at'],
          ...context,
        });
        return true;
      });
    },

    /** Has this Telegram user used up their wrong guesses for now? */
    async throttled(actor: Actor, telegramUserId: number, now: Date): Promise<boolean> {
      if (actor.kind !== 'SYSTEM') {
        throw new ForbiddenError('only the system limits attempts');
      }
      return (await recentFailures(db, telegramUserId, now)) >= MAX_FAILED_ATTEMPTS;
    },

    /** A link that cannot be real (wrong shape) still counts as a guess. */
    async noteFailure(actor: Actor, telegramUserId: number, now: Date): Promise<void> {
      if (actor.kind !== 'SYSTEM') {
        throw new ForbiddenError('only the system limits attempts');
      }
      await noteFailure(db, telegramUserId, now);
    },

    /**
     * What the code is, without using it up: so a person can be told who is inviting them
     * before they decide. `patientUserId` is null while the person has no account yet.
     */
    async inspect(
      actor: Actor,
      input: { telegramUserId: number; codeHash: string; patientUserId: string | null; now: Date },
    ): Promise<InviteCheck> {
      if (actor.kind !== 'SYSTEM') {
        throw new ForbiddenError('only the system inspects invitations');
      }
      return db.transaction((tx) => evaluate(tx, { ...input, lock: false }));
    },

    /**
     * The patient accepts. Uses the code up and creates the care relationship in one step,
     * unconfirmed (PENDING): the doctor still has to say "yes, that is the person I meant".
     * The patient's agreement is stamped on the relationship as `consent_at`.
     */
    async redeem(
      actor: Actor,
      input: { telegramUserId: number; codeHash: string; now: Date },
    ): Promise<InviteRedemption> {
      if (actor.kind !== 'PATIENT') {
        throw new ForbiddenError('only a patient accepts an invitation');
      }
      const patientUserId = actor.userId;

      return db.transaction(async (tx) => {
        const check = await evaluate(tx, { ...input, patientUserId, lock: true });
        if (check.result !== 'OPEN') {
          return check;
        }

        // Two links from one doctor to one person must not both turn into a relationship.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`care:${check.doctor.userId}:${patientUserId}`}))`,
        );
        const [open] = await tx
          .select({ status: careRelationships.status })
          .from(careRelationships)
          .where(
            and(
              eq(careRelationships.clinicianId, check.doctor.userId),
              eq(careRelationships.patientId, patientUserId),
              inArray(careRelationships.status, ['ACTIVE', 'PENDING']),
            ),
          );
        if (open?.status === 'ACTIVE' || open?.status === 'PENDING') {
          return { result: 'CONNECTED', status: open.status };
        }

        const [patient] = await tx
          .select({ firstName: patientProfiles.firstName, lastName: patientProfiles.lastName })
          .from(patientProfiles)
          .innerJoin(users, eq(users.id, patientProfiles.userId))
          .where(and(eq(patientProfiles.userId, patientUserId), eq(users.status, 'ACTIVE')));
        if (patient === undefined) {
          return { result: 'INVALID' };
        }

        const [relationship] = await tx
          .insert(careRelationships)
          .values({
            patientId: patientUserId,
            clinicianId: check.doctor.userId,
            status: 'PENDING',
            consentAt: input.now,
          })
          .returning();
        if (relationship === undefined) {
          throw new Error('relationship insert returned no row');
        }
        await audit.record(tx, {
          actor,
          entityType: 'care_relationships',
          entityId: relationship.id,
          action: 'CREATE',
          after: relationship,
          changes: ['patient_id', 'clinician_id', 'status', 'consent_at'],
          ...context,
        });

        const [before] = await tx
          .select()
          .from(invitations)
          .where(eq(invitations.id, check.invitationId));
        const [after] = await tx
          .update(invitations)
          .set({ usedAt: input.now, usedBy: patientUserId, careRelationshipId: relationship.id })
          .where(eq(invitations.id, check.invitationId))
          .returning();
        await audit.record(tx, {
          actor,
          entityType: 'invitations',
          entityId: check.invitationId,
          action: 'USE',
          before: before ?? null,
          after: after ?? null,
          changes: ['used_at', 'used_by', 'care_relationship_id'],
          ...context,
        });

        return {
          result: 'ACCEPTED',
          relationshipId: relationship.id,
          label: check.label,
          doctor: check.doctor,
          patient,
        };
      });
    },

    /**
     * Forgets what has no use any more: failed attempts older than `attemptsBefore`, and links
     * that were never used and ran out (or were withdrawn) before `invitationsBefore`.
     */
    async prune(
      actor: Actor,
      cutoffs: { attemptsBefore: Date; invitationsBefore: Date },
    ): Promise<{ attempts: number; invitations: number }> {
      if (actor.kind !== 'SYSTEM') {
        throw new ForbiddenError('only the system cleans up');
      }
      const attempts = await db
        .delete(invitationAttempts)
        .where(lt(invitationAttempts.at, cutoffs.attemptsBefore))
        .returning({ id: invitationAttempts.id });
      const stale = await db
        .delete(invitations)
        .where(
          and(
            isNull(invitations.usedAt),
            or(
              lt(invitations.expiresAt, cutoffs.invitationsBefore),
              lt(invitations.revokedAt, cutoffs.invitationsBefore),
            ),
          ),
        )
        .returning({ id: invitations.id });
      return { attempts: attempts.length, invitations: stale.length };
    },
  };
}

export type InvitationRepository = ReturnType<typeof createInvitationRepository>;
