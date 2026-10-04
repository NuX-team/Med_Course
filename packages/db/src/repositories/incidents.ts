import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Actor } from '../access/actor';
import { ForbiddenError } from '../access/errors';
import { activeClinicStaff, activeTechAdmin, visiblePatients } from '../access/scopes';
import { fieldAad } from '../field-cipher';
import type { Executor } from '../orm';
import {
  clinicStaff,
  clinicianProfiles,
  clinics,
  doctorAlerts,
  incidents,
  notifications,
  patientProfiles,
  platformStaff,
  scheduledDoses,
  treatmentCourses,
  users,
  type CourseStatus,
} from '../schema';
import type { RepositoryDeps } from './context';

export type IncidentKind = (typeof incidents.$inferSelect)['kind'];
export type IncidentType = (typeof incidents.$inferSelect)['type'];
export type IncidentStatus = (typeof incidents.$inferSelect)['status'];

export const MAX_RESOLUTION_NOTE_LENGTH = 500;
/** How often a notice that could not be delivered to anyone is tried again, and how many times. */
export const NOTICE_RETRY_MS = 2 * 60_000;
export const MAX_NOTICE_TRIES = 6;

/** An incident to be announced, and the people to announce it to. Nothing about a patient. */
export interface IncidentNotice {
  readonly incidentId: string;
  readonly kind: IncidentKind;
  readonly type: IncidentType;
  readonly recipients: readonly {
    readonly telegramUserId: number;
    readonly locale: 'ru' | 'uz';
  }[];
  /** How many times this has been tried before (0 the first time). */
  readonly tries: number;
}
const LIST_LIMIT = 100;
/** How far behind a queue or a sweeper may fall before it is an incident rather than a moment. */
export const LATE_AFTER_MS = 10 * 60_000;

/** Staff of the panel: the only actors that see or close incidents. */
export type StaffActor = Extract<Actor, { kind: 'TECH_ADMIN' | 'CLINIC_STAFF' }>;

export interface IncidentView {
  readonly id: string;
  readonly kind: IncidentKind;
  readonly type: IncidentType;
  readonly status: IncidentStatus;
  readonly openedAt: Date;
  /** Counts and codes. Never free text. */
  readonly details: Readonly<Record<string, unknown>> | null;
  readonly resolvedAt: Date | null;
  /** What was done about it, as the person who closed it wrote. */
  readonly note: string | null;
  /**
   * OPERATIONAL only, and only for clinic staff: whose course it is. The patient's name is
   * given only while the clinic still treats them; nothing about the prescription ever is.
   */
  readonly course: {
    readonly status: CourseStatus;
    readonly patientName: string | null;
    readonly clinicianName: string;
  } | null;
}

/**
 * Records that something needs a person's attention, in the transaction of the fact itself.
 * Noticed again (the next undelivered reminder of the same day, the next reconciliation run),
 * it adds nothing.
 */
export async function noteIncident(
  tx: Executor,
  input:
    | {
        kind: 'OPERATIONAL';
        type: 'UNDELIVERED' | 'MISS_SERIES';
        courseId: string;
        dedupeKey: string;
        now: Date;
        details?: Record<string, unknown>;
      }
    | {
        kind: 'TECHNICAL';
        type: 'QUEUE_STUCK' | 'QUEUE_LATE' | 'SWEEP_LATE';
        dedupeKey: string;
        now: Date;
        details?: Record<string, unknown>;
      },
): Promise<boolean> {
  let clinicId: string | null = null;
  let courseId: string | null = null;
  if (input.kind === 'OPERATIONAL') {
    const [course] = await tx
      .select({ clinicId: treatmentCourses.clinicId })
      .from(treatmentCourses)
      .where(eq(treatmentCourses.id, input.courseId));
    if (course === undefined) {
      return false;
    }
    ({ clinicId } = course);
    ({ courseId } = input);
  }
  const inserted = await tx
    .insert(incidents)
    .values({
      kind: input.kind,
      type: input.type,
      clinicId,
      courseId,
      dedupeKey: input.dedupeKey.slice(0, 200),
      details: input.details ?? null,
      openedAt: input.now,
    })
    .onConflictDoNothing({ target: incidents.dedupeKey })
    .returning({ id: incidents.id });
  return inserted.length > 0;
}

function requireStaff(actor: Actor): StaffActor {
  if (actor.kind !== 'TECH_ADMIN' && actor.kind !== 'CLINIC_STAFF') {
    throw new ForbiddenError('incidents are for the staff who handle them');
  }
  return actor;
}

/**
 * Incidents as the staff panel shows them (TZ §14.1, §14.2). Two audiences that never overlap:
 * a clinic's staff see the OPERATIONAL incidents of their own clinic (a reminder that cannot be
 * delivered, a run of doses not taken: someone may need to call the patient); technical
 * administrators see the TECHNICAL ones (a queue that is stuck), which name no patient at all.
 * Every access is re-checked against the staff records at query time.
 */
export function createIncidentRepository(db: Executor, deps: RepositoryDeps) {
  const { audit, cipher, requestId } = deps;
  const context = requestId === undefined ? {} : { requestId };

  /** The rows this actor is entitled to, as a WHERE clause; false for a role that was revoked. */
  const scope = (actor: StaffActor) =>
    actor.kind === 'TECH_ADMIN'
      ? and(eq(incidents.kind, 'TECHNICAL'), activeTechAdmin(actor.userId))
      : and(
          eq(incidents.kind, 'OPERATIONAL'),
          eq(incidents.clinicId, actor.clinicId),
          activeClinicStaff(actor.userId, actor.clinicId),
        );

  return {
    /** Open (or already closed) incidents within the actor's remit, newest first. */
    async list(actor: Actor, status: IncidentStatus): Promise<IncidentView[]> {
      const staff = requireStaff(actor);
      return db.transaction(async (tx) => {
        const rows = await tx
          .select({
            incident: incidents,
            courseStatus: treatmentCourses.status,
            // A name only where this member of staff may know it (ARCHITECTURE §9).
            patientName: sql<string | null>`(
              select ${patientProfiles.firstName} || ' ' || ${patientProfiles.lastName}
              from ${patientProfiles}
              where ${patientProfiles.userId} = ${treatmentCourses.patientId}
                and ${visiblePatients(staff)}
            )`,
            clinicianFirst: clinicianProfiles.firstName,
            clinicianLast: clinicianProfiles.lastName,
          })
          .from(incidents)
          .leftJoin(treatmentCourses, eq(treatmentCourses.id, incidents.courseId))
          .leftJoin(clinicianProfiles, eq(clinicianProfiles.userId, treatmentCourses.clinicianId))
          .where(and(scope(staff), eq(incidents.status, status)))
          .orderBy(desc(incidents.openedAt), desc(incidents.id))
          .limit(LIST_LIMIT);
        if (staff.kind === 'CLINIC_STAFF' && rows.length > 0) {
          // Reading who needs a call is reading personal data: it is logged.
          await audit.record(tx, {
            actor: staff,
            entityType: 'incidents',
            entityId: staff.clinicId,
            action: 'READ',
            changes: [],
            ...context,
          });
        }
        return rows.map(
          ({ incident, courseStatus, patientName, clinicianFirst, clinicianLast }) => ({
            id: incident.id,
            kind: incident.kind,
            type: incident.type,
            status: incident.status,
            openedAt: incident.openedAt,
            details: incident.details as Record<string, unknown> | null,
            resolvedAt: incident.resolvedAt,
            note:
              incident.resolutionNoteEnc === null
                ? null
                : cipher.decrypt(
                    incident.resolutionNoteEnc,
                    fieldAad('incidents', 'resolution_note_enc', incident.id),
                  ),
            course:
              staff.kind === 'CLINIC_STAFF' && courseStatus !== null
                ? {
                    status: courseStatus,
                    patientName,
                    clinicianName: `${clinicianFirst ?? ''} ${clinicianLast ?? ''}`.trim(),
                  }
                : null,
          }),
        );
      });
    },

    /**
     * Closes an incident with a note of what was done ("called, will resume tomorrow"). The
     * note is stored encrypted. False if the incident is not this actor's, or already closed.
     */
    async resolve(
      actor: Actor,
      input: { incidentId: string; note: string | null; now: Date },
    ): Promise<boolean> {
      const staff = requireStaff(actor);
      const note = input.note?.trim() ?? '';
      if (Array.from(note).length > MAX_RESOLUTION_NOTE_LENGTH) {
        throw new RangeError('the note is too long');
      }
      return db.transaction(async (tx) => {
        const [found] = await tx
          .select()
          .from(incidents)
          .where(
            and(eq(incidents.id, input.incidentId), eq(incidents.status, 'OPEN'), scope(staff)),
          )
          .for('update');
        if (found === undefined) {
          return false;
        }
        await tx
          .update(incidents)
          .set({
            status: 'RESOLVED',
            resolvedAt: input.now,
            resolvedBy: staff.userId,
            resolutionNoteEnc:
              note.length === 0
                ? null
                : cipher.encrypt(note, fieldAad('incidents', 'resolution_note_enc', found.id)),
          })
          .where(eq(incidents.id, found.id));
        await audit.record(tx, {
          actor: staff,
          entityType: 'incidents',
          entityId: found.id,
          action: 'RESOLVE',
          // That it was closed and that a note exists; never the note.
          changes: note.length === 0 ? ['status'] : ['status', 'resolution_note_enc'],
          ...context,
        });
        return true;
      });
    },

    /**
     * Incidents nobody has been told about yet, with the people who handle each: technical
     * administrators for the service's own, the staff of the clinic for a clinic's. Taken in
     * order of age; an incident that could not be announced is offered again after a pause, up to
     * a few times. System only. Reads, and records the attempt, in one transaction, so two
     * workers do not announce the same incident twice.
     */
    async claimNotices(
      actor: Actor,
      input: { now: Date; limit: number },
    ): Promise<IncidentNotice[]> {
      if (actor.kind !== 'SYSTEM') {
        throw new ForbiddenError('only the system announces incidents');
      }
      return db.transaction(async (tx) => {
        const due = await tx
          .select()
          .from(incidents)
          .where(
            and(
              eq(incidents.status, 'OPEN'),
              isNull(incidents.notifiedAt),
              lt(incidents.noticeTries, MAX_NOTICE_TRIES),
              or(
                isNull(incidents.lastNoticeAt),
                lte(incidents.lastNoticeAt, new Date(input.now.getTime() - NOTICE_RETRY_MS)),
              ),
            ),
          )
          .orderBy(asc(incidents.openedAt), asc(incidents.id))
          .limit(input.limit)
          .for('update', { skipLocked: true });

        const notices: IncidentNotice[] = [];
        for (const incident of due) {
          const people =
            incident.kind === 'TECHNICAL'
              ? await tx
                  .select({ telegramUserId: users.telegramUserId, locale: users.locale })
                  .from(platformStaff)
                  .innerJoin(users, eq(users.id, platformStaff.userId))
                  .where(
                    and(
                      eq(platformStaff.role, 'TECH_ADMIN'),
                      eq(platformStaff.status, 'ACTIVE'),
                      eq(users.status, 'ACTIVE'),
                    ),
                  )
              : incident.clinicId === null
                ? []
                : await tx
                    .select({ telegramUserId: users.telegramUserId, locale: users.locale })
                    .from(clinicStaff)
                    .innerJoin(users, eq(users.id, clinicStaff.userId))
                    .innerJoin(clinics, eq(clinics.id, clinicStaff.clinicId))
                    .where(
                      and(
                        eq(clinicStaff.clinicId, incident.clinicId),
                        eq(clinicStaff.status, 'ACTIVE'),
                        eq(clinics.status, 'ACTIVE'),
                        eq(users.status, 'ACTIVE'),
                      ),
                    );
          await tx
            .update(incidents)
            .set({ noticeTries: incident.noticeTries + 1, lastNoticeAt: input.now })
            .where(eq(incidents.id, incident.id));
          notices.push({
            incidentId: incident.id,
            kind: incident.kind,
            type: incident.type,
            recipients: people,
            tries: incident.noticeTries,
          });
        }
        return notices;
      });
    },

    /**
     * Writes down how an announcement went. Done when it reached at least one person, when there
     * is nobody to tell (the panel is then the only place), or when it has been tried as often as
     * it will be; otherwise it is left to be offered again. System only.
     */
    async finishNotice(
      actor: Actor,
      input: { incidentId: string; reached: number; recipients: number; now: Date },
    ): Promise<boolean> {
      if (actor.kind !== 'SYSTEM') {
        throw new ForbiddenError('only the system announces incidents');
      }
      const [row] = await db
        .select({ tries: incidents.noticeTries })
        .from(incidents)
        .where(eq(incidents.id, input.incidentId));
      const done =
        input.reached > 0 || input.recipients === 0 || (row?.tries ?? 0) >= MAX_NOTICE_TRIES;
      if (done) {
        await db
          .update(incidents)
          .set({ notifiedAt: input.now })
          .where(and(eq(incidents.id, input.incidentId), isNull(incidents.notifiedAt)));
      }
      return done;
    },

    /**
     * Looks for signs that the service itself has fallen behind (ARCHITECTURE §8, "reconciliation")
     * and opens a TECHNICAL incident for each, at most one of a kind per day:
     * reminders or alerts that should have gone out ten minutes ago and are still waiting,
     * rows a worker took and never reported on, and doses past their deadline that nobody has
     * recorded as missed. Only counts are kept. System only; returns how many incidents it opened.
     */
    async reconcile(actor: Actor, now: Date): Promise<number> {
      if (actor.kind !== 'SYSTEM') {
        throw new ForbiddenError('only the system reconciles the queues');
      }
      const late = new Date(now.getTime() - LATE_AFTER_MS);
      const day = now.toISOString().slice(0, 10);
      return db.transaction(async (tx) => {
        const count = async (
          table: typeof notifications | typeof doctorAlerts,
          status: 'QUEUED' | 'SENDING',
        ) => {
          const [row] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(table)
            .where(
              and(
                eq(table.status, status),
                status === 'QUEUED' ? lt(table.dueAt, late) : lt(table.lockedUntil, late),
              ),
            );
          return row?.n ?? 0;
        };
        const lateReminders = await count(notifications, 'QUEUED');
        const lateAlerts = await count(doctorAlerts, 'QUEUED');
        const stuckReminders = await count(notifications, 'SENDING');
        const stuckAlerts = await count(doctorAlerts, 'SENDING');
        const [unswept] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(scheduledDoses)
          .innerJoin(treatmentCourses, eq(treatmentCourses.id, scheduledDoses.courseId))
          .where(
            and(
              eq(treatmentCourses.status, 'ACTIVE'),
              inArray(scheduledDoses.status, ['SCHEDULED', 'NOTIFIED', 'SNOOZED']),
              lt(scheduledDoses.deadlineAt, late),
            ),
          );

        let opened = 0;
        const open = async (
          type: 'QUEUE_STUCK' | 'QUEUE_LATE' | 'SWEEP_LATE',
          details: Record<string, number>,
        ): Promise<void> => {
          if (Object.values(details).some((value) => value > 0)) {
            const created = await noteIncident(tx, {
              kind: 'TECHNICAL',
              type,
              dedupeKey: `${type}:${day}`,
              now,
              details,
            });
            opened += created ? 1 : 0;
          }
        };
        await open('QUEUE_LATE', { reminders: lateReminders, alerts: lateAlerts });
        await open('QUEUE_STUCK', { reminders: stuckReminders, alerts: stuckAlerts });
        await open('SWEEP_LATE', { doses: unswept?.n ?? 0 });
        return opened;
      });
    },
  };
}

export type IncidentRepository = ReturnType<typeof createIncidentRepository>;
