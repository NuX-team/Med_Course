import {
  addDays,
  localDateOf,
  startOfLocalDay,
  summarizeAdherence,
  type Adherence,
} from '@medcourse/schedule';
import { and, asc, count, desc, eq, gt, inArray, isNull, ne } from 'drizzle-orm';
import { systemActor, type Actor } from '../access/actor';
import { ForbiddenError } from '../access/errors';
import { activeUser, usableClinician, visibleCourses } from '../access/scopes';
import type { Executor } from '../orm';
import {
  careRelationships,
  caregiverInvitations,
  caregiverRelationships,
  clinicianProfiles,
  courseMedications,
  patientProfiles,
  scheduledDoses,
  treatmentCourses,
  users,
  type CourseStatus,
} from '../schema';
import type { RepositoryDeps } from './context';
import {
  INVITATION_TTL_MS,
  createInvitationRepository,
  generateInviteCode,
  hashInviteCode,
} from './invitations';
import { recipientOf, type Recipient } from './layout';
import type { TodayDose } from './runs';

/** Unused caregiver links a doctor may have open for one patient at a time. */
export const MAX_OPEN_CAREGIVER_INVITATIONS = 3;
const LIST_LIMIT = 20;

const guard = systemActor('caregiver link attempts');

interface Name {
  readonly firstName: string;
  readonly lastName: string;
}

export type CaregiverInviteResult =
  /** Not this doctor's confirmed patient, or the doctor is not in good standing. */
  | { readonly status: 'NOT_ALLOWED' }
  | { readonly status: 'LIMIT' }
  | {
      readonly status: 'CREATED';
      /** Shown once, to the doctor, to pass on. Never stored. */
      readonly code: string;
      readonly expiresAt: Date;
      readonly patient: Name;
    };

export type CaregiverLinkCheck =
  /** No such link, used up, withdrawn, expired, or the doctor behind it has lost standing. */
  | { readonly status: 'INVALID' }
  /** Too many wrong links tried from this Telegram account for now. */
  | { readonly status: 'THROTTLED' }
  /** The link is to watch over the very person who opened it. */
  | { readonly status: 'OWN' }
  /** This person already watches, or has already asked to watch, this patient. */
  | { readonly status: 'ALREADY'; readonly patient: Name }
  | { readonly status: 'OK'; readonly patient: Name; readonly clinician: Name };

export type CaregiverRedemption =
  | Exclude<CaregiverLinkCheck, { status: 'OK' }>
  | {
      readonly status: 'REQUESTED';
      readonly relationshipId: string;
      readonly patientName: Name;
      readonly clinician: Name;
      readonly caregiver: Name;
      /** To ask the patient whether they allow it. */
      readonly patient: Recipient | null;
    };

export type CaregiverDecision =
  | { readonly status: 'NOT_AVAILABLE' }
  | {
      readonly status: 'ALLOWED' | 'REFUSED';
      /** False if it had already been decided this way: a repeated tap changes nothing. */
      readonly changed: boolean;
      readonly patientName: Name;
      readonly caregiverName: Name;
      readonly caregiver: Recipient | null;
    };

export interface PatientsCaregiver extends Name {
  readonly relationshipId: string;
  readonly status: 'PENDING' | 'ACTIVE';
}

export interface Ward extends Name {
  readonly patientId: string;
}

/** What a caregiver sees of one course: where it stands, today's doses, and the figure. */
export interface WardCourse {
  readonly courseId: string;
  readonly status: CourseStatus;
  readonly timezone: string;
  readonly doses: readonly TodayDose[];
  readonly adherence: Adherence;
}

export interface WardDay {
  readonly patient: Name;
  readonly courses: readonly WardCourse[];
}

/**
 * Caregivers (TZ §5.6, D-14): a person the doctor adds to watch over a patient's course. The
 * doctor issues a one-time link, the caregiver opens it, and nothing is visible to them until
 * the patient allows it. What they then see is the schedule and what became of each dose: no
 * instructions, no reasons, nothing they can change. The patient can end it at any time.
 */
export function createCaregiverRepository(db: Executor, deps: RepositoryDeps) {
  const { audit, requestId } = deps;
  const context = requestId === undefined ? {} : { requestId };

  const nameOf = async (executor: Executor, userId: string): Promise<Name | null> => {
    const [row] = await executor
      .select({ firstName: patientProfiles.firstName, lastName: patientProfiles.lastName })
      .from(patientProfiles)
      .where(eq(patientProfiles.userId, userId));
    return row ?? null;
  };

  /**
   * What the link stands for, for the person holding it. With `lock`, the invitation row is
   * held so that two people (or two taps) cannot both use it.
   */
  const evaluate = async (
    tx: Executor,
    input: { telegramUserId: number; userId: string; codeHash: string; now: Date; lock: boolean },
  ): Promise<
    | Exclude<CaregiverLinkCheck, { status: 'OK' }>
    | {
        status: 'OK';
        invitation: typeof caregiverInvitations.$inferSelect;
        patient: Name;
        clinician: Name;
      }
  > => {
    const attempts = createInvitationRepository(tx, deps);
    if (await attempts.throttled(guard, input.telegramUserId, input.now)) {
      return { status: 'THROTTLED' };
    }
    const query = tx
      .select()
      .from(caregiverInvitations)
      .where(
        and(
          eq(caregiverInvitations.codeHash, input.codeHash),
          isNull(caregiverInvitations.usedAt),
          isNull(caregiverInvitations.revokedAt),
          gt(caregiverInvitations.expiresAt, input.now),
        ),
      );
    const [invitation] = await (input.lock ? query.for('update') : query);
    // The doctor who issued it must still be this patient's doctor, in good standing.
    const [standing] =
      invitation === undefined
        ? []
        : await tx
            .select({
              firstName: clinicianProfiles.firstName,
              lastName: clinicianProfiles.lastName,
            })
            .from(careRelationships)
            .innerJoin(
              clinicianProfiles,
              eq(clinicianProfiles.userId, careRelationships.clinicianId),
            )
            .where(
              and(
                eq(careRelationships.id, invitation.careRelationshipId),
                eq(careRelationships.status, 'ACTIVE'),
                activeUser(invitation.clinicianId),
                usableClinician(invitation.clinicianId),
                activeUser(invitation.patientId),
              ),
            );
    const patient = invitation === undefined ? null : await nameOf(tx, invitation.patientId);
    if (invitation === undefined || standing === undefined || patient === null) {
      await attempts.noteFailure(guard, input.telegramUserId, input.now);
      return { status: 'INVALID' };
    }
    if (invitation.patientId === input.userId) {
      return { status: 'OWN' };
    }
    const [existing] = await tx
      .select({ id: caregiverRelationships.id })
      .from(caregiverRelationships)
      .where(
        and(
          eq(caregiverRelationships.patientId, invitation.patientId),
          eq(caregiverRelationships.caregiverUserId, input.userId),
          inArray(caregiverRelationships.status, ['PENDING', 'ACTIVE']),
        ),
      );
    if (existing !== undefined) {
      return { status: 'ALREADY', patient };
    }
    return { status: 'OK', invitation, patient, clinician: standing };
  };

  return {
    /**
     * The doctor issues a link for someone to watch over one of their confirmed patients. The
     * code is returned once and stored only as a hash; it lasts as long as a patient invitation.
     */
    async invite(
      actor: Actor,
      input: { relationshipId: string; now: Date },
    ): Promise<CaregiverInviteResult> {
      if (actor.kind !== 'CLINICIAN') {
        throw new ForbiddenError('only a doctor adds a caregiver');
      }
      return db.transaction(async (tx) => {
        const [link] = await tx
          .select({ patientId: careRelationships.patientId })
          .from(careRelationships)
          .where(
            and(
              eq(careRelationships.id, input.relationshipId),
              eq(careRelationships.clinicianId, actor.userId),
              eq(careRelationships.status, 'ACTIVE'),
              activeUser(actor.userId),
              usableClinician(actor.userId),
            ),
          )
          .for('update');
        const patient = link === undefined ? null : await nameOf(tx, link.patientId);
        if (link === undefined || patient === null) {
          return { status: 'NOT_ALLOWED' };
        }
        const [open] = await tx
          .select({ open: count() })
          .from(caregiverInvitations)
          .where(
            and(
              eq(caregiverInvitations.careRelationshipId, input.relationshipId),
              isNull(caregiverInvitations.usedAt),
              isNull(caregiverInvitations.revokedAt),
              gt(caregiverInvitations.expiresAt, input.now),
            ),
          );
        if ((open?.open ?? 0) >= MAX_OPEN_CAREGIVER_INVITATIONS) {
          return { status: 'LIMIT' };
        }
        const code = generateInviteCode();
        const expiresAt = new Date(input.now.getTime() + INVITATION_TTL_MS);
        const [row] = await tx
          .insert(caregiverInvitations)
          .values({
            careRelationshipId: input.relationshipId,
            patientId: link.patientId,
            clinicianId: actor.userId,
            codeHash: hashInviteCode(code),
            expiresAt,
            createdAt: input.now,
          })
          .returning({ id: caregiverInvitations.id });
        await audit.record(tx, {
          actor,
          entityType: 'caregiver_invitations',
          entityId: row?.id ?? '',
          action: 'CREATE',
          // Who it is for and until when; never the code or its hash.
          changes: ['patient_id', 'expires_at'],
          ...context,
        });
        return { status: 'CREATED', code, expiresAt, patient };
      });
    },

    /** What the link is, without using it up: so the person can be told what they are agreeing to. */
    async inspect(
      actor: Actor,
      input: { telegramUserId: number; codeHash: string; now: Date },
    ): Promise<CaregiverLinkCheck> {
      if (actor.kind !== 'CAREGIVER') {
        throw new ForbiddenError('a caregiver link is opened by the person it is for');
      }
      return db.transaction(async (tx) => {
        const checked = await evaluate(tx, { ...input, userId: actor.userId, lock: false });
        return checked.status === 'OK'
          ? { status: 'OK', patient: checked.patient, clinician: checked.clinician }
          : checked;
      });
    },

    /**
     * The caregiver agrees. The link is used up and the relationship is created, not yet
     * allowed (PENDING): the patient still has to say yes before anything can be seen.
     */
    async redeem(
      actor: Actor,
      input: { telegramUserId: number; codeHash: string; now: Date },
    ): Promise<CaregiverRedemption> {
      if (actor.kind !== 'CAREGIVER') {
        throw new ForbiddenError('a caregiver link is used by the person it is for');
      }
      return db.transaction(async (tx) => {
        const checked = await evaluate(tx, { ...input, userId: actor.userId, lock: true });
        const caregiver = await nameOf(tx, actor.userId);
        if (checked.status !== 'OK') {
          return checked;
        }
        if (caregiver === null) {
          return { status: 'INVALID' };
        }
        const { invitation } = checked;
        const [relationship] = await tx
          .insert(caregiverRelationships)
          .values({
            patientId: invitation.patientId,
            caregiverUserId: actor.userId,
            addedBy: invitation.clinicianId,
            scope: 'SCHEDULE',
          })
          .returning();
        if (relationship === undefined) {
          throw new Error('a caregiver relationship vanished inside its own transaction');
        }
        await tx
          .update(caregiverInvitations)
          .set({ usedAt: input.now, usedBy: actor.userId })
          .where(eq(caregiverInvitations.id, invitation.id));
        await audit.record(tx, {
          actor,
          entityType: 'caregiver_relationships',
          entityId: relationship.id,
          action: 'CREATE',
          after: relationship,
          changes: ['status', 'scope'],
          ...context,
        });
        return {
          status: 'REQUESTED',
          relationshipId: relationship.id,
          patientName: checked.patient,
          clinician: checked.clinician,
          caregiver,
          patient: await recipientOf(tx, invitation.patientId),
        };
      });
    },

    /**
     * The patient allows or refuses a caregiver who is waiting. Only the patient's own word
     * opens their schedule to anyone (TZ §3.2). A relationship already decided is left as it is.
     */
    async decide(
      actor: Actor,
      input: { relationshipId: string; allow: boolean; now: Date },
    ): Promise<CaregiverDecision> {
      if (actor.kind !== 'PATIENT') {
        throw new ForbiddenError('only the patient allows a caregiver');
      }
      return db.transaction(async (tx) => {
        const [found] = await tx
          .select()
          .from(caregiverRelationships)
          .where(
            and(
              eq(caregiverRelationships.id, input.relationshipId),
              eq(caregiverRelationships.patientId, actor.userId),
              activeUser(actor.userId),
            ),
          )
          .for('update');
        const patientName = await nameOf(tx, actor.userId);
        const caregiverName = found === undefined ? null : await nameOf(tx, found.caregiverUserId);
        if (found === undefined || patientName === null || caregiverName === null) {
          return { status: 'NOT_AVAILABLE' };
        }
        const wanted = input.allow ? 'ACTIVE' : 'REVOKED';
        const outcome = input.allow ? 'ALLOWED' : 'REFUSED';
        const reply = {
          patientName,
          caregiverName,
          caregiver: await recipientOf(tx, found.caregiverUserId),
        };
        if (found.status !== 'PENDING') {
          // Decided before: say so only if this tap asks for what already is.
          return found.status === wanted
            ? { status: outcome, changed: false, ...reply }
            : { status: 'NOT_AVAILABLE' };
        }
        const [after] = await tx
          .update(caregiverRelationships)
          .set(input.allow ? { status: 'ACTIVE', consentAt: input.now } : { status: 'REVOKED' })
          .where(eq(caregiverRelationships.id, found.id))
          .returning();
        await audit.record(tx, {
          actor,
          entityType: 'caregiver_relationships',
          entityId: found.id,
          action: input.allow ? 'ALLOW' : 'REFUSE',
          before: found,
          after: after ?? null,
          changes: input.allow ? ['status', 'consent_at'] : ['status'],
          ...context,
        });
        return { status: outcome, changed: true, ...reply };
      });
    },

    /** Who watches, or has asked to watch, this patient. */
    async listForPatient(actor: Actor): Promise<PatientsCaregiver[]> {
      if (actor.kind !== 'PATIENT') {
        throw new ForbiddenError('only the patient lists their own caregivers');
      }
      const rows = await db
        .select({
          relationshipId: caregiverRelationships.id,
          status: caregiverRelationships.status,
          firstName: patientProfiles.firstName,
          lastName: patientProfiles.lastName,
        })
        .from(caregiverRelationships)
        .innerJoin(
          patientProfiles,
          eq(patientProfiles.userId, caregiverRelationships.caregiverUserId),
        )
        .where(
          and(
            eq(caregiverRelationships.patientId, actor.userId),
            inArray(caregiverRelationships.status, ['PENDING', 'ACTIVE']),
            activeUser(actor.userId),
          ),
        )
        .orderBy(asc(caregiverRelationships.createdAt))
        .limit(LIST_LIMIT);
      return rows.flatMap((row) =>
        row.status === 'REVOKED' ? [] : [{ ...row, status: row.status }],
      );
    },

    /**
     * The patient ends a caregiver's access, at once and for good: from this moment the
     * caregiver sees nothing. To watch again they need a new link and a new yes.
     */
    async revoke(actor: Actor, input: { relationshipId: string }): Promise<CaregiverDecision> {
      if (actor.kind !== 'PATIENT') {
        throw new ForbiddenError('only the patient ends a caregiver’s access');
      }
      return db.transaction(async (tx) => {
        const [found] = await tx
          .select()
          .from(caregiverRelationships)
          .where(
            and(
              eq(caregiverRelationships.id, input.relationshipId),
              eq(caregiverRelationships.patientId, actor.userId),
              ne(caregiverRelationships.status, 'REVOKED'),
              activeUser(actor.userId),
            ),
          )
          .for('update');
        const patientName = await nameOf(tx, actor.userId);
        const caregiverName = found === undefined ? null : await nameOf(tx, found.caregiverUserId);
        if (found === undefined || patientName === null || caregiverName === null) {
          return { status: 'NOT_AVAILABLE' };
        }
        const [after] = await tx
          .update(caregiverRelationships)
          .set({ status: 'REVOKED' })
          .where(eq(caregiverRelationships.id, found.id))
          .returning();
        await audit.record(tx, {
          actor,
          entityType: 'caregiver_relationships',
          entityId: found.id,
          action: 'REVOKE',
          before: found,
          after: after ?? null,
          changes: ['status'],
          ...context,
        });
        return {
          status: 'REFUSED',
          changed: true,
          patientName,
          caregiverName,
          caregiver: await recipientOf(tx, found.caregiverUserId),
        };
      });
    },

    /** The patients this person is allowed to watch over. */
    async wards(actor: Actor): Promise<Ward[]> {
      if (actor.kind !== 'CAREGIVER') {
        throw new ForbiddenError('only a caregiver has wards');
      }
      return db
        .select({
          patientId: caregiverRelationships.patientId,
          firstName: patientProfiles.firstName,
          lastName: patientProfiles.lastName,
        })
        .from(caregiverRelationships)
        .innerJoin(patientProfiles, eq(patientProfiles.userId, caregiverRelationships.patientId))
        .innerJoin(users, eq(users.id, caregiverRelationships.patientId))
        .where(
          and(
            eq(caregiverRelationships.caregiverUserId, actor.userId),
            eq(caregiverRelationships.status, 'ACTIVE'),
            eq(users.status, 'ACTIVE'),
            activeUser(actor.userId),
          ),
        )
        .orderBy(asc(patientProfiles.lastName), asc(patientProfiles.firstName))
        .limit(LIST_LIMIT);
    },

    /**
     * One ward's running and paused courses as the caregiver may see them: today's doses with
     * what became of each, and how the schedule has been followed. Null if the patient has not
     * allowed this person (or no longer does).
     */
    async wardDay(actor: Actor, input: { patientId: string; now: Date }): Promise<WardDay | null> {
      if (actor.kind !== 'CAREGIVER') {
        throw new ForbiddenError('only a caregiver looks at a ward’s day');
      }
      const [allowed] = await db
        .select({ id: caregiverRelationships.id })
        .from(caregiverRelationships)
        .where(
          and(
            eq(caregiverRelationships.patientId, input.patientId),
            eq(caregiverRelationships.caregiverUserId, actor.userId),
            eq(caregiverRelationships.status, 'ACTIVE'),
            activeUser(actor.userId),
            activeUser(input.patientId),
          ),
        );
      const patient = allowed === undefined ? null : await nameOf(db, input.patientId);
      if (allowed === undefined || patient === null) {
        return null;
      }
      const courses = await db
        .select({
          id: treatmentCourses.id,
          status: treatmentCourses.status,
          timezone: treatmentCourses.timezone,
        })
        .from(treatmentCourses)
        .where(
          and(
            eq(treatmentCourses.patientId, input.patientId),
            inArray(treatmentCourses.status, ['ACTIVE', 'PAUSED']),
            visibleCourses(actor),
          ),
        )
        .orderBy(desc(treatmentCourses.startAt), asc(treatmentCourses.id))
        .limit(LIST_LIMIT);

      const result: WardCourse[] = [];
      for (const course of courses) {
        const today = localDateOf(input.now, course.timezone);
        const doses = await db
          .select({
            doseId: scheduledDoses.id,
            scheduledAt: scheduledDoses.scheduledAt,
            status: scheduledDoses.status,
            displayName: courseMedications.displayName,
            doseValue: courseMedications.doseValue,
            doseDisplay: courseMedications.doseDisplay,
            doseUnit: courseMedications.doseUnit,
            foodRule: courseMedications.foodRule,
          })
          .from(scheduledDoses)
          .innerJoin(courseMedications, eq(courseMedications.id, scheduledDoses.medicationId))
          .where(
            and(eq(scheduledDoses.courseId, course.id), ne(scheduledDoses.status, 'SUPERSEDED')),
          )
          .orderBy(asc(scheduledDoses.scheduledAt), asc(courseMedications.displayName));
        const from = startOfLocalDay(today, course.timezone);
        const to = startOfLocalDay(addDays(today, 1), course.timezone);
        result.push({
          courseId: course.id,
          status: course.status,
          timezone: course.timezone,
          doses: doses.filter((dose) => dose.scheduledAt >= from && dose.scheduledAt < to),
          adherence: summarizeAdherence(doses),
        });
      }
      return { patient, courses: result };
    },
  };
}

export type CaregiverRepository = ReturnType<typeof createCaregiverRepository>;
