import { asc, eq, sql } from 'drizzle-orm';
import { isHuman, type Actor } from '../access/actor';
import { ForbiddenError } from '../access/errors';
import { activeTechAdmin } from '../access/scopes';
import type { Executor } from '../orm';
import { clinicianProfiles, clinics, patientProfiles, users } from '../schema';
import type { RepositoryDeps } from './context';

export type VerificationStatus = (typeof clinicianProfiles.$inferSelect)['verificationStatus'];
export type ClinicStatus = (typeof clinics.$inferSelect)['status'];

export interface ClinicianSummary {
  readonly userId: string;
  readonly clinicId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly verificationStatus: VerificationStatus;
  readonly clinicStatus: ClinicStatus;
}

/** What the person who verifies applicants sees about one of them. */
export interface ClinicianApplication extends ClinicianSummary {
  readonly telegramUserId: number;
  readonly locale: 'ru' | 'uz';
  readonly note: string | null;
  readonly appliedAt: Date;
  readonly verifiedAt: Date | null;
  readonly verificationReference: string | null;
}

export interface VerificationOutcome {
  readonly clinician: ClinicianSummary;
  /** To tell the doctor. */
  readonly telegramUserId: number;
  readonly locale: 'ru' | 'uz';
  /** False if the doctor was already in the requested state: nothing was written. */
  readonly changed: boolean;
}

const LIST_LIMIT = 200;
const MAX_REFERENCE_LENGTH = 500;
const MAX_CLINIC_NAME_LENGTH = 200;

/** Whoever is acting may look at their own record; the system may look at anyone's. */
function mayActFor(actor: Actor, userId: string): boolean {
  return actor.kind === 'SYSTEM' || (isHuman(actor) && actor.userId === userId);
}

export function createClinicianRepository(db: Executor, deps: RepositoryDeps) {
  const { audit, requestId } = deps;
  const context = requestId === undefined ? {} : { requestId };

  const selection = {
    userId: clinicianProfiles.userId,
    clinicId: clinicianProfiles.clinicId,
    firstName: clinicianProfiles.firstName,
    lastName: clinicianProfiles.lastName,
    verificationStatus: clinicianProfiles.verificationStatus,
    clinicStatus: clinics.status,
  };

  const summaryOf = async (
    executor: Executor,
    userId: string,
  ): Promise<ClinicianSummary | null> => {
    const [row] = await executor
      .select(selection)
      .from(clinicianProfiles)
      .innerJoin(clinics, eq(clinics.id, clinicianProfiles.clinicId))
      .where(eq(clinicianProfiles.userId, userId));
    return row ?? null;
  };

  /** The caller must already have checked that the actor is an active administrator. */
  const changeVerification = async (
    actor: Actor,
    input: { clinicianId: string; to: 'VERIFIED' | 'REVOKED'; reference: string | null },
  ): Promise<VerificationOutcome | null> => {
    if (actor.kind !== 'TECH_ADMIN') {
      throw new ForbiddenError('only an administrator verifies doctors');
    }
    const reference = input.reference?.trim() ?? null;
    if (reference !== null && (reference.length === 0 || reference.length > MAX_REFERENCE_LENGTH)) {
      throw new RangeError(`the reference must be 1-${String(MAX_REFERENCE_LENGTH)} characters`);
    }
    const admin = actor;

    return db.transaction(async (tx) => {
      // Revocable, so checked now and not taken from the actor value.
      const allowed = await tx.execute<{ ok: boolean }>(
        sql`select ${activeTechAdmin(admin.userId)} as ok`,
      );
      if (allowed[0]?.ok !== true) {
        throw new ForbiddenError('the administrator is no longer active');
      }

      const [before] = await tx
        .select()
        .from(clinicianProfiles)
        .where(eq(clinicianProfiles.userId, input.clinicianId))
        .for('update');
      if (before === undefined) {
        return null;
      }
      const [owner] = await tx
        .select({ telegramUserId: users.telegramUserId, locale: users.locale })
        .from(users)
        .where(eq(users.id, input.clinicianId));
      if (owner === undefined) {
        return null;
      }

      let changed = before.verificationStatus !== input.to;
      if (changed) {
        const now = new Date();
        const verifying = input.to === 'VERIFIED';
        const [after] = await tx
          .update(clinicianProfiles)
          .set(
            verifying
              ? {
                  verificationStatus: 'VERIFIED',
                  verifiedBy: admin.userId,
                  verifiedAt: now,
                  verificationReference: reference,
                }
              : {
                  verificationStatus: 'REVOKED',
                  ...(reference === null ? {} : { verificationReference: reference }),
                },
          )
          .where(eq(clinicianProfiles.userId, input.clinicianId))
          .returning();
        changed = after !== undefined;
        await audit.record(tx, {
          actor,
          entityType: 'clinician_profiles',
          entityId: input.clinicianId,
          action: verifying ? 'VERIFY' : 'REVOKE',
          before,
          after: after ?? null,
          ...context,
        });
      }

      const summary = await summaryOf(tx, input.clinicianId);
      if (summary === null) {
        return null;
      }
      return {
        clinician: summary,
        telegramUserId: owner.telegramUserId,
        locale: owner.locale,
        changed,
      };
    });
  };

  return {
    /**
     * A person asks to be a doctor. Creates a private practice (a clinic of one) and an
     * unverified profile under the name they gave when they registered. Nothing about patients
     * is reachable until an administrator verifies them. Idempotent: asking again changes nothing.
     * Null if the account is not active or has no name yet.
     */
    async register(
      actor: Actor,
      input: { userId: string; note: string },
    ): Promise<{ clinician: ClinicianSummary; created: boolean } | null> {
      const isSelf = actor.kind === 'PATIENT' && actor.userId === input.userId;
      if (!isSelf && actor.kind !== 'SYSTEM') {
        throw new ForbiddenError('only the person themselves can apply to be a doctor');
      }
      const note = input.note.trim();
      if (note.length === 0 || note.length > 500) {
        throw new RangeError('the note must be 1-500 characters');
      }

      return db.transaction(async (tx) => {
        // Two taps at once must not open two practices.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`clinician:${input.userId}`}))`,
        );

        const existing = await summaryOf(tx, input.userId);
        if (existing !== null) {
          return { clinician: existing, created: false };
        }
        const [account] = await tx
          .select({ status: users.status })
          .from(users)
          .where(eq(users.id, input.userId));
        const [name] = await tx
          .select({ firstName: patientProfiles.firstName, lastName: patientProfiles.lastName })
          .from(patientProfiles)
          .where(eq(patientProfiles.userId, input.userId));
        if (account?.status !== 'ACTIVE' || name === undefined) {
          return null;
        }

        const [clinic] = await tx
          .insert(clinics)
          .values({
            name: `Private practice: ${name.lastName} ${name.firstName}`.slice(
              0,
              MAX_CLINIC_NAME_LENGTH,
            ),
          })
          .returning();
        if (clinic === undefined) {
          throw new Error('clinic insert returned no row');
        }
        await audit.record(tx, {
          actor,
          entityType: 'clinics',
          entityId: clinic.id,
          action: 'CREATE',
          after: clinic,
          changes: ['name'],
          ...context,
        });

        const [profile] = await tx
          .insert(clinicianProfiles)
          .values({
            userId: input.userId,
            clinicId: clinic.id,
            firstName: name.firstName,
            lastName: name.lastName,
            applicantNote: note,
          })
          .returning();
        if (profile === undefined) {
          throw new Error('clinician insert returned no row');
        }
        await audit.record(tx, {
          actor,
          entityType: 'clinician_profiles',
          entityId: input.userId,
          action: 'CREATE',
          after: profile,
          changes: ['clinic_id', 'first_name', 'last_name', 'applicant_note'],
          ...context,
        });

        const created = await summaryOf(tx, input.userId);
        if (created === null) {
          throw new Error('clinician vanished after insert');
        }
        return { clinician: created, created: true };
      });
    },

    /** The person's own doctor profile, whatever its state (they may always see their own). */
    async getOwn(actor: Actor, userId: string): Promise<ClinicianSummary | null> {
      return mayActFor(actor, userId) ? summaryOf(db, userId) : null;
    },

    /** Applicants in a given state, oldest first. Administrators only. */
    async listByStatus(actor: Actor, status: VerificationStatus): Promise<ClinicianApplication[]> {
      if (actor.kind !== 'TECH_ADMIN') {
        throw new ForbiddenError('only an administrator reviews doctors');
      }
      const admin = actor;
      return db.transaction(async (tx) => {
        // Revocable, so checked now; and said out loud, so an empty list is never a silent refusal.
        const allowed = await tx.execute<{ ok: boolean }>(
          sql`select ${activeTechAdmin(admin.userId)} as ok`,
        );
        if (allowed[0]?.ok !== true) {
          throw new ForbiddenError('the administrator is no longer active');
        }
        return tx
          .select({
            ...selection,
            telegramUserId: users.telegramUserId,
            locale: users.locale,
            note: clinicianProfiles.applicantNote,
            appliedAt: clinicianProfiles.createdAt,
            verifiedAt: clinicianProfiles.verifiedAt,
            verificationReference: clinicianProfiles.verificationReference,
          })
          .from(clinicianProfiles)
          .innerJoin(clinics, eq(clinics.id, clinicianProfiles.clinicId))
          .innerJoin(users, eq(users.id, clinicianProfiles.userId))
          .where(eq(clinicianProfiles.verificationStatus, status))
          .orderBy(asc(clinicianProfiles.createdAt))
          .limit(LIST_LIMIT);
      });
    },

    /** Accepts a doctor. Administrators only; the reference says what was checked. */
    async verify(
      actor: Actor,
      input: { clinicianId: string; reference: string },
    ): Promise<VerificationOutcome | null> {
      return changeVerification(actor, { ...input, to: 'VERIFIED' });
    },

    /** Withdraws a doctor's standing. Their access ends at once: it is checked on every query. */
    async revoke(
      actor: Actor,
      input: { clinicianId: string; reference?: string },
    ): Promise<VerificationOutcome | null> {
      return changeVerification(actor, {
        clinicianId: input.clinicianId,
        to: 'REVOKED',
        reference: input.reference ?? null,
      });
    },
  };
}

export type ClinicianRepository = ReturnType<typeof createClinicianRepository>;
