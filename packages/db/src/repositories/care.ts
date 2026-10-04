import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Actor } from '../access/actor';
import { ForbiddenError } from '../access/errors';
import { activeUser, usableClinician } from '../access/scopes';
import type { Executor } from '../orm';
import { careRelationships, clinicianProfiles, patientProfiles, users } from '../schema';
import type { RepositoryDeps } from './context';

export interface CareParticipant {
  readonly userId: string;
  readonly telegramUserId: number;
  readonly locale: 'ru' | 'uz';
  readonly firstName: string;
  readonly lastName: string;
}

export interface DoctorsPatient {
  readonly relationshipId: string;
  readonly status: 'PENDING' | 'ACTIVE';
  readonly firstName: string;
  readonly lastName: string;
  readonly since: Date;
  /** The patient lets this doctor read the summaries of their earlier courses. */
  readonly sharesHistory: boolean;
}

export interface PatientsDoctor {
  readonly relationshipId: string;
  readonly status: 'PENDING' | 'ACTIVE';
  readonly firstName: string;
  readonly lastName: string;
}

export interface CareDecision {
  /** Where the relationship stands now. */
  readonly status: 'PENDING' | 'ACTIVE' | 'ENDED';
  /** False if it had already been decided: a repeated tap changes nothing. */
  readonly changed: boolean;
  readonly patient: CareParticipant;
}

const LIST_LIMIT = 100;

function requireActor(actor: Actor, kind: 'CLINICIAN' | 'PATIENT'): string {
  if (actor.kind !== kind) {
    throw new ForbiddenError(`only a ${kind.toLowerCase()} can do this`);
  }
  return actor.userId;
}

/** The doctor-patient link: who may see whom starts here (ARCHITECTURE §9). */
export function createCareRepository(db: Executor, deps: RepositoryDeps) {
  const { audit, requestId } = deps;
  const context = requestId === undefined ? {} : { requestId };

  return {
    /**
     * The doctor answers "is this the person I invited?". Yes makes the relationship ACTIVE (the
     * patient's own agreement is already stamped on it); no ends it. Only the relationship's own
     * doctor, in good standing, can answer, and only while it is still PENDING: a relationship
     * that is already decided is reported as it is and left alone. Null if it is not theirs.
     */
    async decide(
      actor: Actor,
      input: { relationshipId: string; accept: boolean; now: Date },
    ): Promise<CareDecision | null> {
      const clinicianId = requireActor(actor, 'CLINICIAN');
      return db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(careRelationships)
          .where(
            and(
              eq(careRelationships.id, input.relationshipId),
              eq(careRelationships.clinicianId, clinicianId),
              activeUser(clinicianId),
              usableClinician(clinicianId),
            ),
          )
          .for('update');
        if (before === undefined) {
          return null;
        }
        const [patient] = await tx
          .select({
            userId: patientProfiles.userId,
            telegramUserId: users.telegramUserId,
            locale: users.locale,
            firstName: patientProfiles.firstName,
            lastName: patientProfiles.lastName,
          })
          .from(patientProfiles)
          .innerJoin(users, eq(users.id, patientProfiles.userId))
          .where(eq(patientProfiles.userId, before.patientId));
        if (patient === undefined) {
          return null;
        }

        if (before.status !== 'PENDING') {
          return { status: before.status, changed: false, patient };
        }
        const [after] = await tx
          .update(careRelationships)
          .set(input.accept ? { status: 'ACTIVE' } : { status: 'ENDED', endedAt: input.now })
          .where(eq(careRelationships.id, input.relationshipId))
          .returning();
        await audit.record(tx, {
          actor,
          entityType: 'care_relationships',
          entityId: input.relationshipId,
          action: input.accept ? 'CONFIRM' : 'DECLINE',
          before,
          after: after ?? null,
          changes: input.accept ? ['status'] : ['status', 'ended_at'],
          ...context,
        });
        return { status: input.accept ? 'ACTIVE' : 'ENDED', changed: true, patient };
      });
    },

    /**
     * The doctor's people: confirmed patients, and those who accepted an invitation and wait to
     * be confirmed. Names only. A waiting patient's name is shown because the doctor cannot
     * answer "is this who I invited?" without it.
     */
    async listForClinician(actor: Actor): Promise<DoctorsPatient[]> {
      const clinicianId = requireActor(actor, 'CLINICIAN');
      const rows = await db
        .select({
          relationshipId: careRelationships.id,
          status: careRelationships.status,
          firstName: patientProfiles.firstName,
          lastName: patientProfiles.lastName,
          since: careRelationships.createdAt,
          sharedAt: careRelationships.historySharedAt,
        })
        .from(careRelationships)
        .innerJoin(patientProfiles, eq(patientProfiles.userId, careRelationships.patientId))
        .where(
          and(
            eq(careRelationships.clinicianId, clinicianId),
            inArray(careRelationships.status, ['PENDING', 'ACTIVE']),
            activeUser(clinicianId),
            usableClinician(clinicianId),
          ),
        )
        .orderBy(
          // Those waiting for an answer first.
          sql`(${careRelationships.status} = 'PENDING') desc`,
          asc(patientProfiles.lastName),
          asc(patientProfiles.firstName),
          asc(careRelationships.id),
        )
        .limit(LIST_LIMIT);
      return rows.flatMap(({ sharedAt, ...row }) =>
        row.status === 'PENDING' || row.status === 'ACTIVE'
          ? [{ ...row, status: row.status, sharesHistory: sharedAt !== null }]
          : [],
      );
    },

    /** The patient's own doctors, by name. Only doctors still in good standing. */
    async listForPatient(actor: Actor): Promise<PatientsDoctor[]> {
      const patientId = requireActor(actor, 'PATIENT');
      const rows = await db
        .select({
          relationshipId: careRelationships.id,
          status: careRelationships.status,
          firstName: clinicianProfiles.firstName,
          lastName: clinicianProfiles.lastName,
        })
        .from(careRelationships)
        .innerJoin(clinicianProfiles, eq(clinicianProfiles.userId, careRelationships.clinicianId))
        .where(
          and(
            eq(careRelationships.patientId, patientId),
            inArray(careRelationships.status, ['PENDING', 'ACTIVE']),
            activeUser(patientId),
            usableClinician(careRelationships.clinicianId),
          ),
        )
        .orderBy(asc(clinicianProfiles.lastName), asc(clinicianProfiles.firstName))
        .limit(LIST_LIMIT);
      return rows.flatMap((row) =>
        row.status === 'PENDING' || row.status === 'ACTIVE' ? [{ ...row, status: row.status }] : [],
      );
    },
  };
}

export type CareRepository = ReturnType<typeof createCareRepository>;
