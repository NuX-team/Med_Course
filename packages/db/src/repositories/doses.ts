import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { actorUserId, type Actor } from '../access/actor';
import { ConflictError, ForbiddenError, NotFoundError } from '../access/errors';
import { readableReasonsOfCourse, visibleDoses } from '../access/scopes';
import { fieldAad } from '../field-cipher';
import type { Executor } from '../orm';
import {
  doseEvents,
  scheduledDoses,
  treatmentCourses,
  type ActorKind,
  type DoseEventType,
} from '../schema';
import type { RepositoryDeps } from './context';

export type ScheduledDose = typeof scheduledDoses.$inferSelect;
type DoseEventRow = typeof doseEvents.$inferSelect;

export interface DoseEventView extends Omit<DoseEventRow, 'reasonTextEnc'> {
  /** Null when there is no text, or when this actor may not read it (see reasonTextHidden). */
  readonly reasonText: string | null;
  readonly reasonTextHidden: boolean;
}

export interface AppendDoseEventInput {
  readonly scheduledDoseId: string;
  readonly eventType: DoseEventType;
  readonly occurredAt: Date;
  readonly source: 'TELEGRAM' | 'SYSTEM' | 'ADMIN';
  /** Same key, same event: a repeated Telegram callback adds nothing. */
  readonly idempotencyKey: string;
  readonly reasonCode?: 'FORGOT' | 'NO_MEDICATION' | 'OTHER';
  /** Only valid with reasonCode OTHER. Stored encrypted. */
  readonly reasonText?: string;
  /** Machine data only, never free text. */
  readonly details?: Record<string, unknown>;
}

/**
 * Who may write which event. The patient answers their reminders; a clinician corrects; the
 * system records what happens on its own. Anything else is refused outright.
 */
export const EVENT_WRITERS: Readonly<Record<ActorKind, readonly DoseEventType[]>> = {
  PATIENT: ['SNOOZED', 'TAKEN', 'SKIPPED', 'LATE_TAKEN'],
  CLINICIAN: ['CORRECTION'],
  SYSTEM: ['NOTIFIED', 'MISSED', 'SUPERSEDED'],
  CAREGIVER: [],
  CLINIC_STAFF: [],
  TECH_ADMIN: [],
};

export function createDoseRepository(db: Executor, deps: RepositoryDeps) {
  const { cipher } = deps;

  return {
    async get(actor: Actor, doseId: string): Promise<ScheduledDose | null> {
      const [dose] = await db
        .select()
        .from(scheduledDoses)
        .where(and(eq(scheduledDoses.id, doseId), visibleDoses(actor)));
      return dose ?? null;
    },

    /** Empty both when there are no doses and when the course is not the actor's to see. */
    async listForCourse(actor: Actor, courseId: string): Promise<ScheduledDose[]> {
      return db
        .select()
        .from(scheduledDoses)
        .where(and(eq(scheduledDoses.courseId, courseId), visibleDoses(actor)))
        .orderBy(asc(scheduledDoses.scheduledAt), asc(scheduledDoses.id));
    },

    async listEvents(actor: Actor, doseId: string): Promise<DoseEventView[]> {
      const rows = await db
        .select({
          event: doseEvents,
          reasonsReadable: sql<boolean>`${readableReasonsOfCourse(actor)}`,
        })
        .from(doseEvents)
        .innerJoin(scheduledDoses, eq(scheduledDoses.id, doseEvents.scheduledDoseId))
        .innerJoin(treatmentCourses, eq(treatmentCourses.id, scheduledDoses.courseId))
        .where(and(eq(doseEvents.scheduledDoseId, doseId), visibleDoses(actor)))
        .orderBy(asc(doseEvents.occurredAt), asc(doseEvents.recordedAt));

      return rows.map(({ event, reasonsReadable }) => {
        const { reasonTextEnc, ...rest } = event;
        const hidden = reasonTextEnc !== null && !reasonsReadable;
        return {
          ...rest,
          reasonText:
            reasonTextEnc !== null && reasonsReadable
              ? cipher.decrypt(reasonTextEnc, fieldAad('dose_events', 'reason_text_enc', event.id))
              : null,
          reasonTextHidden: hidden,
        };
      });
    },

    /**
     * Writes to the event log only. It does not move the dose to its next status; the use case
     * that does (stage 8) calls this and updates the dose in one transaction.
     * Idempotent on `idempotencyKey`: a replay returns the original row with `created: false`.
     */
    async appendEvent(
      actor: Actor,
      input: AppendDoseEventInput,
    ): Promise<{ event: DoseEventView; created: boolean }> {
      if (!EVENT_WRITERS[actor.kind].includes(input.eventType)) {
        throw new ForbiddenError(`a ${actor.kind} cannot record a ${input.eventType} event`);
      }

      return db.transaction(async (tx) => {
        const [dose] = await tx
          .select()
          .from(scheduledDoses)
          .where(and(eq(scheduledDoses.id, input.scheduledDoseId), visibleDoses(actor)));
        if (dose === undefined) {
          throw new NotFoundError('dose');
        }

        const id = randomUUID();
        const [inserted] = await tx
          .insert(doseEvents)
          .values({
            id,
            scheduledDoseId: dose.id,
            courseId: dose.courseId,
            eventType: input.eventType,
            actorKind: actor.kind,
            actorUserId: actorUserId(actor),
            reasonCode: input.reasonCode ?? null,
            reasonTextEnc:
              input.reasonText === undefined
                ? null
                : cipher.encrypt(input.reasonText, fieldAad('dose_events', 'reason_text_enc', id)),
            source: input.source,
            idempotencyKey: input.idempotencyKey,
            details: input.details ?? null,
            occurredAt: input.occurredAt,
          })
          .onConflictDoNothing({ target: doseEvents.idempotencyKey })
          .returning();

        if (inserted !== undefined) {
          return { event: toView(inserted, input.reasonText ?? null), created: true };
        }

        // A replay. It must be the same operation by the same actor, or the key is being reused.
        const [existing] = await tx
          .select()
          .from(doseEvents)
          .where(eq(doseEvents.idempotencyKey, input.idempotencyKey));
        if (
          existing?.scheduledDoseId !== dose.id ||
          existing.eventType !== input.eventType ||
          existing.actorUserId !== actorUserId(actor)
        ) {
          throw new ConflictError('idempotency key was already used for a different event');
        }
        const reason =
          existing.reasonTextEnc === null
            ? null
            : cipher.decrypt(
                existing.reasonTextEnc,
                fieldAad('dose_events', 'reason_text_enc', existing.id),
              );
        return { event: toView(existing, reason), created: false };
      });
    },
  };
}

function toView(row: DoseEventRow, reasonText: string | null): DoseEventView {
  const { reasonTextEnc: _stored, ...rest } = row;
  return { ...rest, reasonText, reasonTextHidden: false };
}

export type DoseRepository = ReturnType<typeof createDoseRepository>;
