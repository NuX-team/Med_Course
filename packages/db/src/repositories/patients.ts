import { eq, and } from 'drizzle-orm';
import type { Actor } from '../access/actor';
import { ForbiddenError } from '../access/errors';
import { patientsWithVisiblePii, visiblePatients } from '../access/scopes';
import { fieldAad } from '../field-cipher';
import type { Executor } from '../orm';
import { patientProfiles } from '../schema';
import type { RepositoryDeps } from './context';

export interface PatientSummary {
  readonly userId: string;
  readonly firstName: string;
  readonly lastName: string;
}

export interface PatientPii {
  readonly userId: string;
  readonly phone: string | null;
  /** ISO date, YYYY-MM-DD. */
  readonly dateOfBirth: string | null;
}

export interface UpsertPatientProfileInput {
  readonly userId: string;
  readonly firstName: string;
  readonly lastName: string;
  /** undefined leaves the stored value alone; null clears it. */
  readonly phone?: string | null;
  readonly dateOfBirth?: string | null;
}

const PHONE = 'phone_enc';
const DATE_OF_BIRTH = 'date_of_birth_enc';
const TABLE = 'patient_profiles';

export function createPatientRepository(db: Executor, deps: RepositoryDeps) {
  const { cipher, audit, requestId } = deps;
  const context = requestId === undefined ? {} : { requestId };

  const decrypt = (value: string | null, column: string, userId: string): string | null =>
    value === null ? null : cipher.decrypt(value, fieldAad(TABLE, column, userId));

  return {
    /** Name only. Visible to the patient, their clinician, caregivers and their clinic's staff. */
    async getSummary(actor: Actor, patientId: string): Promise<PatientSummary | null> {
      const [row] = await db
        .select({
          userId: patientProfiles.userId,
          firstName: patientProfiles.firstName,
          lastName: patientProfiles.lastName,
        })
        .from(patientProfiles)
        .where(and(eq(patientProfiles.userId, patientId), visiblePatients(actor)));
      return row ?? null;
    },

    /**
     * Phone and date of birth: the patient, their own clinician, and the system. Anyone other
     * than the patient is written to the audit log, and if that write fails nothing is returned.
     */
    async getPii(actor: Actor, patientId: string): Promise<PatientPii | null> {
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            userId: patientProfiles.userId,
            phoneEnc: patientProfiles.phoneEnc,
            dateOfBirthEnc: patientProfiles.dateOfBirthEnc,
          })
          .from(patientProfiles)
          .where(and(eq(patientProfiles.userId, patientId), patientsWithVisiblePii(actor)));
        if (row === undefined) {
          return null;
        }

        const isSelf = actor.kind === 'PATIENT' && actor.userId === patientId;
        if (!isSelf) {
          await audit.record(tx, {
            actor,
            entityType: TABLE,
            entityId: patientId,
            action: 'READ_PII',
            changes: [],
            ...context,
          });
        }
        return {
          userId: row.userId,
          phone: decrypt(row.phoneEnc, PHONE, row.userId),
          dateOfBirth: decrypt(row.dateOfBirthEnc, DATE_OF_BIRTH, row.userId),
        };
      });
    },

    /** A patient writes their own profile; the system may on their behalf. Nobody else. */
    async upsertProfile(actor: Actor, input: UpsertPatientProfileInput): Promise<PatientSummary> {
      const isSelf = actor.kind === 'PATIENT' && actor.userId === input.userId;
      if (!isSelf && actor.kind !== 'SYSTEM') {
        throw new ForbiddenError('a profile can only be written by its patient or the system');
      }

      return db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(patientProfiles)
          .where(eq(patientProfiles.userId, input.userId))
          .for('update');

        const encrypt = (value: string, column: string): string =>
          cipher.encrypt(value, fieldAad(TABLE, column, input.userId));
        const next = (
          given: string | null | undefined,
          stored: string | null | undefined,
          column: string,
        ): string | null =>
          given === undefined ? (stored ?? null) : given === null ? null : encrypt(given, column);

        const values = {
          userId: input.userId,
          firstName: input.firstName,
          lastName: input.lastName,
          phoneEnc: next(input.phone, before?.phoneEnc, PHONE),
          dateOfBirthEnc: next(input.dateOfBirth, before?.dateOfBirthEnc, DATE_OF_BIRTH),
        };

        const [after] = await tx
          .insert(patientProfiles)
          .values(values)
          .onConflictDoUpdate({
            target: patientProfiles.userId,
            set: {
              firstName: values.firstName,
              lastName: values.lastName,
              phoneEnc: values.phoneEnc,
              dateOfBirthEnc: values.dateOfBirthEnc,
            },
          })
          .returning();
        if (after === undefined) {
          throw new Error('upsert returned no row');
        }

        // Ciphertext differs on every write, so compare plaintext to say what really changed.
        const changes: string[] = [];
        if (before?.firstName !== input.firstName) changes.push('first_name');
        if (before?.lastName !== input.lastName) changes.push('last_name');
        if (
          input.phone !== undefined &&
          decrypt(before?.phoneEnc ?? null, PHONE, input.userId) !== input.phone
        ) {
          changes.push('phone');
        }
        if (
          input.dateOfBirth !== undefined &&
          decrypt(before?.dateOfBirthEnc ?? null, DATE_OF_BIRTH, input.userId) !== input.dateOfBirth
        ) {
          changes.push('date_of_birth');
        }

        await audit.record(tx, {
          actor,
          entityType: TABLE,
          entityId: input.userId,
          action: before === undefined ? 'CREATE' : 'UPDATE',
          before: before ?? null,
          after,
          changes,
          ...context,
        });

        return { userId: after.userId, firstName: after.firstName, lastName: after.lastName };
      });
    },
  };
}

export type PatientRepository = ReturnType<typeof createPatientRepository>;
