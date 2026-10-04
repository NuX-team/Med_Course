import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { actorUserId, type Actor } from '../access/actor';
import { ForbiddenError } from '../access/errors';
import { activeUser, usableClinician } from '../access/scopes';
import type { Executor } from '../orm';
import {
  careRelationships,
  caregiverInvitations,
  caregiverRelationships,
  clinicStaff,
  clinicianProfiles,
  consentRecords,
  conversationStates,
  courseMedications,
  courseRevisions,
  courseSummaries,
  courseTransitions,
  deletionRequests,
  doseEvents,
  incidents,
  invitationAttempts,
  invitations,
  panelLogins,
  panelSessions,
  patientProfiles,
  platformStaff,
  treatmentCourses,
  users,
} from '../schema';
import { closePendingChange } from './changes';
import type { RepositoryDeps } from './context';
import type { Course } from './courses';
import { createHistoryRepository } from './history';
import { recipientOf, retireOpenDoses, type Recipient } from './layout';
import type { DoseUnit } from './plans';

/** `cancellation_reason_code` of a course that ended because its patient left. */
export const PATIENT_LEFT = 'PATIENT_LEFT';
/** How long a request for deletion waits, and can be taken back, before it is carried out. */
export const DELETION_GRACE_MS = 30 * 86_400_000;
/** How long after a course ends its summary for a later doctor is drawn up (TZ §12.1). */
export const SUMMARY_AFTER_MS = 3 * 86_400_000;
/** What is put in place of a name once a person's data has been anonymised. */
export const ERASED_NAME = '—';
const SWEEP_BATCH = 50;
const CONSENT_KIND = 'PERSONAL_DATA';

type ConsentDecision = (typeof consentRecords.$inferSelect)['decision'];
type Locale = (typeof users.$inferSelect)['locale'];

/** Where a person stands, read on every update before anything else is done for them. */
export interface PrivacyStanding {
  /** NONE: they have never decided (an account opened and abandoned). */
  readonly consent: ConsentDecision | 'NONE';
  /** Set while a request to delete their data is waiting. */
  readonly deletionDueAt: Date | null;
}

export interface PrivacyOverview {
  readonly consent: { readonly version: string; readonly at: Date } | null;
  readonly doctors: readonly {
    readonly relationshipId: string;
    readonly firstName: string;
    readonly lastName: string;
    readonly status: 'PENDING' | 'ACTIVE';
    /** The patient lets this doctor read the summaries of their earlier courses. */
    readonly sharesHistory: boolean;
  }[];
  /**
   * A doctor or a member of staff cannot simply leave: other people's care hangs on them. They
   * are told to have the role taken away first.
   */
  readonly heldRole: 'CLINICIAN' | 'STAFF' | null;
}

/** A doctor to be told that a patient has left, with the name they knew the patient by. */
export interface LeftDoctor extends Recipient {
  readonly coursesStopped: number;
}

export type LeaveResult =
  | { readonly status: 'NOT_AVAILABLE' }
  | {
      readonly status: 'LEFT';
      readonly doctor: LeftDoctor | null;
      readonly coursesStopped: number;
    };

export type WithdrawResult =
  | { readonly status: 'HAS_ROLE' }
  /** Already withdrawn: nothing more to do. */
  | { readonly status: 'ALREADY' }
  | {
      readonly status: 'WITHDRAWN';
      readonly doctors: readonly LeftDoctor[];
      readonly coursesStopped: number;
    };

export type DeletionRequestResult =
  | { readonly status: 'HAS_ROLE' }
  | { readonly status: 'ALREADY'; readonly dueAt: Date }
  | {
      readonly status: 'REQUESTED';
      readonly dueAt: Date;
      readonly doctors: readonly LeftDoctor[];
      readonly coursesStopped: number;
    };

/** What a later doctor may know of an earlier course: no instructions, no reasons, no free text. */
export interface CourseSummaryContent {
  readonly status: Course['status'];
  /** The first day, on the patient's calendar: "2026-10-03". */
  readonly startedOn: string | null;
  readonly endedAt: string;
  readonly durationDays: number;
  readonly taken: number;
  readonly takenLate: number;
  readonly skipped: number;
  readonly missed: number;
  readonly occurred: number;
  readonly percent: number | null;
  readonly medications: readonly {
    readonly name: string;
    readonly doseValue: string | null;
    readonly doseDisplay: string | null;
    readonly doseUnit: DoseUnit | null;
    readonly taken: number;
    readonly occurred: number;
    readonly percent: number | null;
  }[];
  readonly asNeeded: readonly { readonly name: string; readonly count: number }[];
}

export interface SharedSummary {
  readonly courseId: string;
  readonly clinicianName: string;
  readonly content: CourseSummaryContent;
}

function requirePatient(actor: Actor): string {
  if (actor.kind !== 'PATIENT') {
    throw new ForbiddenError('only the person themselves decides about their own data');
  }
  return actor.userId;
}

function requireSystem(actor: Actor, what: string): void {
  if (actor.kind !== 'SYSTEM') {
    throw new ForbiddenError(`only the system ${what}`);
  }
}

/**
 * A person's say over their own data (TZ §12, §12.1): leaving a doctor, withdrawing consent,
 * asking for deletion and taking that back, and letting a new doctor see how earlier courses
 * went. Leaving always does the same three things at once, in one transaction: the courses that
 * doctor prescribed stop (nothing more is reminded), the doctor loses sight of the patient, and
 * the fact is recorded. Nothing is erased until a deletion request falls due.
 */
export function createPrivacyRepository(db: Executor, deps: RepositoryDeps) {
  const { audit, requestId } = deps;
  const context = requestId === undefined ? {} : { requestId };

  const heldRoleOf = async (
    tx: Executor,
    userId: string,
  ): Promise<'CLINICIAN' | 'STAFF' | null> => {
    const [doctor] = await tx
      .select({ id: clinicianProfiles.userId })
      .from(clinicianProfiles)
      .where(eq(clinicianProfiles.userId, userId));
    if (doctor !== undefined) {
      return 'CLINICIAN';
    }
    const [desk] = await tx
      .select({ id: clinicStaff.id })
      .from(clinicStaff)
      .where(and(eq(clinicStaff.userId, userId), eq(clinicStaff.status, 'ACTIVE')));
    const [admin] = await tx
      .select({ id: platformStaff.userId })
      .from(platformStaff)
      .where(and(eq(platformStaff.userId, userId), eq(platformStaff.status, 'ACTIVE')));
    return desk !== undefined || admin !== undefined ? 'STAFF' : null;
  };

  const latestConsent = async (tx: Executor, userId: string) => {
    const [row] = await tx
      .select()
      .from(consentRecords)
      .where(and(eq(consentRecords.userId, userId), eq(consentRecords.kind, CONSENT_KIND)))
      .orderBy(desc(consentRecords.at), desc(consentRecords.id))
      .limit(1);
    return row ?? null;
  };

  const pendingDeletion = async (tx: Executor, userId: string) => {
    const [row] = await tx
      .select()
      .from(deletionRequests)
      .where(and(eq(deletionRequests.userId, userId), eq(deletionRequests.status, 'PENDING')));
    return row ?? null;
  };

  /**
   * Ends the patient's care by one doctor, or by all of them: every course of theirs that is
   * not over yet is stopped (the course row is locked first, as every other change of a course
   * does), then the relationship is ended. Returns the doctors to tell.
   */
  const leave = async (
    tx: Executor,
    actor: Actor,
    input: { patientId: string; clinicianId?: string; now: Date; key: string },
  ): Promise<{ doctors: LeftDoctor[]; coursesStopped: number }> => {
    const { patientId, now } = input;
    const ofDoctor =
      input.clinicianId === undefined
        ? undefined
        : eq(treatmentCourses.clinicianId, input.clinicianId);
    const open = await tx
      .select()
      .from(treatmentCourses)
      .where(
        and(
          eq(treatmentCourses.patientId, patientId),
          ofDoctor,
          inArray(treatmentCourses.status, ['DRAFT', 'PENDING_PATIENT', 'ACTIVE', 'PAUSED']),
        ),
      )
      .orderBy(asc(treatmentCourses.id))
      .for('update');

    const stopped = new Map<string, number>();
    for (const course of open) {
      const [after] = await tx
        .update(treatmentCourses)
        .set({ status: 'CANCELLED', endedAt: now, cancellationReasonCode: PATIENT_LEFT })
        .where(eq(treatmentCourses.id, course.id))
        .returning();
      if (after === undefined) {
        throw new Error('a course vanished while being stopped');
      }
      if (course.status === 'ACTIVE' || course.status === 'PAUSED') {
        await retireOpenDoses(tx, {
          courseId: course.id,
          now,
          reason: 'cancelled',
          actor,
          key: `${input.key}:${course.id}`,
        });
        await closePendingChange(tx, deps, actor, course);
      }
      await tx.insert(courseTransitions).values({
        courseId: course.id,
        fromStatus: course.status,
        toStatus: 'CANCELLED',
        actorKind: actor.kind,
        actorUserId: actorUserId(actor),
        reason: PATIENT_LEFT,
        requestId: requestId ?? null,
        at: now,
      });
      await audit.record(tx, {
        actor,
        entityType: 'treatment_courses',
        entityId: course.id,
        action: 'CANCEL',
        before: course,
        after,
        changes: ['status', 'ended_at', 'cancellation_reason_code'],
        ...context,
      });
      // A draft was never shown to the patient: the doctor is not told it "stopped".
      if (course.status !== 'DRAFT') {
        stopped.set(course.clinicianId, (stopped.get(course.clinicianId) ?? 0) + 1);
      }
    }

    const ended = await tx
      .update(careRelationships)
      .set({ status: 'ENDED', endedAt: now, historySharedAt: null })
      .where(
        and(
          eq(careRelationships.patientId, patientId),
          input.clinicianId === undefined
            ? undefined
            : eq(careRelationships.clinicianId, input.clinicianId),
          inArray(careRelationships.status, ['PENDING', 'ACTIVE']),
        ),
      )
      .returning();
    const doctors: LeftDoctor[] = [];
    for (const relationship of ended) {
      await audit.record(tx, {
        actor,
        entityType: 'care_relationships',
        entityId: relationship.id,
        action: 'END',
        changes: ['status', 'ended_at'],
        ...context,
      });
      // Links for a caregiver that were issued under this relationship die with it.
      await tx
        .update(caregiverInvitations)
        .set({ revokedAt: now })
        .where(
          and(
            eq(caregiverInvitations.careRelationshipId, relationship.id),
            isNull(caregiverInvitations.usedAt),
            isNull(caregiverInvitations.revokedAt),
          ),
        );
      const doctor = await recipientOf(tx, relationship.clinicianId);
      if (doctor !== null) {
        doctors.push({ ...doctor, coursesStopped: stopped.get(relationship.clinicianId) ?? 0 });
      }
    }
    return {
      doctors,
      coursesStopped: [...stopped.values()].reduce((sum, count) => sum + count, 0),
    };
  };

  /** Leaving everyone: every doctor, and everyone who watches or is watched as a caregiver. */
  const leaveAll = async (
    tx: Executor,
    actor: Actor,
    input: { userId: string; now: Date; key: string },
  ): Promise<{ doctors: LeftDoctor[]; coursesStopped: number }> => {
    const left = await leave(tx, actor, {
      patientId: input.userId,
      now: input.now,
      key: input.key,
    });
    await tx
      .update(caregiverRelationships)
      .set({ status: 'REVOKED' })
      .where(
        and(
          or(
            eq(caregiverRelationships.patientId, input.userId),
            eq(caregiverRelationships.caregiverUserId, input.userId),
          ),
          inArray(caregiverRelationships.status, ['PENDING', 'ACTIVE']),
        ),
      );
    return left;
  };

  const revokeConsent = async (
    tx: Executor,
    userId: string,
    fallback: Locale,
  ): Promise<boolean> => {
    const latest = await latestConsent(tx, userId);
    if (latest?.decision === 'REVOKED') {
      return false;
    }
    await tx.insert(consentRecords).values({
      userId,
      kind: CONSENT_KIND,
      version: latest?.version ?? 'unknown',
      decision: 'REVOKED',
      locale: latest?.locale ?? fallback,
      context: 'SETTINGS',
    });
    return true;
  };

  /** One person's decisions about consent are taken one at a time. */
  const serialise = (tx: Executor, userId: string) =>
    tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`consent:${userId}:${CONSENT_KIND}`}))`);

  /**
   * Takes the person out of the data: the name, the Telegram id, and every piece of free text
   * written by or about them. What is left is a course without a person: rows that keep the
   * books consistent and say nothing about anyone.
   */
  const erase = async (tx: Executor, userId: string, now: Date): Promise<void> => {
    const system: Actor = { kind: 'SYSTEM', reason: 'data deletion request' };
    await leaveAll(tx, system, { userId, now, key: `erase:${userId}` });
    await tx.execute(sql`select set_config('medcourse.erasure', 'on', true)`);

    const courses = tx
      .select({ id: treatmentCourses.id })
      .from(treatmentCourses)
      .where(eq(treatmentCourses.patientId, userId));
    await tx
      .update(doseEvents)
      .set({ reasonTextEnc: null })
      .where(and(inArray(doseEvents.courseId, courses), isNotNull(doseEvents.reasonTextEnc)));
    await tx
      .update(courseMedications)
      .set({ instructionsEnc: null })
      .where(
        and(
          inArray(
            courseMedications.revisionId,
            tx
              .select({ id: courseRevisions.id })
              .from(courseRevisions)
              .where(inArray(courseRevisions.courseId, courses)),
          ),
          isNotNull(courseMedications.instructionsEnc),
        ),
      );
    await tx
      .update(incidents)
      .set({ resolutionNoteEnc: null })
      .where(and(inArray(incidents.courseId, courses), isNotNull(incidents.resolutionNoteEnc)));
    await tx
      .update(invitations)
      .set({ label: null })
      .where(and(eq(invitations.usedBy, userId), isNotNull(invitations.label)));
    await tx.delete(courseSummaries).where(eq(courseSummaries.patientId, userId));
    await tx.delete(panelSessions).where(eq(panelSessions.userId, userId));
    await tx.delete(panelLogins).where(eq(panelLogins.userId, userId));

    const [account] = await tx
      .select({ telegramUserId: users.telegramUserId })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    if (account !== undefined && account.telegramUserId > 0) {
      await tx
        .delete(conversationStates)
        .where(eq(conversationStates.telegramUserId, account.telegramUserId));
      await tx
        .delete(invitationAttempts)
        .where(eq(invitationAttempts.telegramUserId, account.telegramUserId));
    }
    await tx
      .update(patientProfiles)
      .set({
        firstName: ERASED_NAME,
        lastName: ERASED_NAME,
        dateOfBirthEnc: null,
        phoneEnc: null,
      })
      .where(eq(patientProfiles.userId, userId));
    await tx
      .update(users)
      .set({
        status: 'DELETED',
        deletedAt: now,
        telegramUserId: sql`-nextval('erased_users_seq')`,
      })
      .where(eq(users.id, userId));
    await audit.record(tx, {
      actor: system,
      entityType: 'users',
      entityId: userId,
      action: 'ERASE',
      // Names of what was removed; the audit trail never held the values.
      changes: [
        'telegram_user_id',
        'first_name',
        'last_name',
        'date_of_birth',
        'phone',
        'free_text',
      ],
      ...context,
    });
  };

  return {
    /** Where the person stands. The bot asks before doing anything else for them. */
    async standing(actor: Actor, userId: string): Promise<PrivacyStanding> {
      if (actor.kind !== 'SYSTEM' && actorUserId(actor) !== userId) {
        throw new ForbiddenError('a person’s standing is theirs and the system’s to read');
      }
      const consent = await latestConsent(db, userId);
      const deletion = await pendingDeletion(db, userId);
      return { consent: consent?.decision ?? 'NONE', deletionDueAt: deletion?.dueAt ?? null };
    },

    /** What the "consent and data" screen shows: the consent in force and the person's doctors. */
    async overview(actor: Actor): Promise<PrivacyOverview> {
      const userId = requirePatient(actor);
      const consent = await latestConsent(db, userId);
      const doctors = await db
        .select({
          relationshipId: careRelationships.id,
          firstName: clinicianProfiles.firstName,
          lastName: clinicianProfiles.lastName,
          status: careRelationships.status,
          sharedAt: careRelationships.historySharedAt,
        })
        .from(careRelationships)
        .innerJoin(clinicianProfiles, eq(clinicianProfiles.userId, careRelationships.clinicianId))
        .where(
          and(
            eq(careRelationships.patientId, userId),
            inArray(careRelationships.status, ['PENDING', 'ACTIVE']),
          ),
        )
        .orderBy(asc(careRelationships.createdAt), asc(careRelationships.id));
      return {
        consent:
          consent?.decision === 'GRANTED' ? { version: consent.version, at: consent.at } : null,
        doctors: doctors.flatMap(({ sharedAt, status, ...doctor }) =>
          status === 'ENDED' ? [] : [{ ...doctor, status, sharesHistory: sharedAt !== null }],
        ),
        heldRole: await heldRoleOf(db, userId),
      };
    },

    /**
     * The patient leaves one doctor. The courses that doctor prescribed stop at once, the doctor
     * no longer sees the patient, and is told. Other doctors and their courses are untouched.
     */
    async leaveDoctor(
      actor: Actor,
      input: { relationshipId: string; now: Date; key: string },
    ): Promise<LeaveResult> {
      const userId = requirePatient(actor);
      return db.transaction(async (tx) => {
        const [relationship] = await tx
          .select()
          .from(careRelationships)
          .where(
            and(
              eq(careRelationships.id, input.relationshipId),
              eq(careRelationships.patientId, userId),
              inArray(careRelationships.status, ['PENDING', 'ACTIVE']),
            ),
          );
        if (relationship === undefined) {
          return { status: 'NOT_AVAILABLE' };
        }
        const left = await leave(tx, actor, {
          patientId: userId,
          clinicianId: relationship.clinicianId,
          now: input.now,
          key: input.key,
        });
        return {
          status: 'LEFT',
          doctor: left.doctors[0] ?? null,
          coursesStopped: left.coursesStopped,
        };
      });
    },

    /** The patient lets a doctor who treats them read the summaries of earlier courses, or stops. */
    async shareHistory(
      actor: Actor,
      input: { relationshipId: string; share: boolean; now: Date },
    ): Promise<boolean> {
      const userId = requirePatient(actor);
      return db.transaction(async (tx) => {
        const [updated] = await tx
          .update(careRelationships)
          .set({ historySharedAt: input.share ? input.now : null })
          .where(
            and(
              eq(careRelationships.id, input.relationshipId),
              eq(careRelationships.patientId, userId),
              eq(careRelationships.status, 'ACTIVE'),
            ),
          )
          .returning({ id: careRelationships.id });
        if (updated === undefined) {
          return false;
        }
        await audit.record(tx, {
          actor,
          entityType: 'care_relationships',
          entityId: updated.id,
          action: input.share ? 'SHARE_HISTORY' : 'UNSHARE_HISTORY',
          changes: ['history_shared_at'],
          ...context,
        });
        return true;
      });
    },

    /**
     * The person withdraws their consent to the processing of their data. The service stops for
     * them: every course is stopped, every doctor and caregiver loses sight of them. Nothing is
     * deleted (that is a separate request), and giving consent again brings the account back,
     * without the doctors and the courses.
     */
    async withdrawConsent(
      actor: Actor,
      input: { now: Date; key: string },
    ): Promise<WithdrawResult> {
      const userId = requirePatient(actor);
      return db.transaction(async (tx) => {
        await serialise(tx, userId);
        if ((await heldRoleOf(tx, userId)) !== null) {
          return { status: 'HAS_ROLE' };
        }
        const [account] = await tx
          .select({ locale: users.locale })
          .from(users)
          .where(and(eq(users.id, userId), eq(users.status, 'ACTIVE')));
        if (account === undefined || !(await revokeConsent(tx, userId, account.locale))) {
          return { status: 'ALREADY' };
        }
        const left = await leaveAll(tx, actor, { userId, now: input.now, key: input.key });
        await audit.record(tx, {
          actor,
          entityType: 'users',
          entityId: userId,
          action: 'WITHDRAW_CONSENT',
          changes: [],
          ...context,
        });
        return { status: 'WITHDRAWN', ...left };
      });
    },

    /** Consent given again after it was withdrawn. Refused while a deletion is waiting. */
    async grantConsentAgain(
      actor: Actor,
      input: { version: string; locale: Locale },
    ): Promise<boolean> {
      const userId = requirePatient(actor);
      return db.transaction(async (tx) => {
        await serialise(tx, userId);
        const latest = await latestConsent(tx, userId);
        if (latest?.decision !== 'REVOKED' || (await pendingDeletion(tx, userId)) !== null) {
          return false;
        }
        await tx.insert(consentRecords).values({
          userId,
          kind: CONSENT_KIND,
          version: input.version,
          decision: 'GRANTED',
          locale: input.locale,
          context: 'SETTINGS',
        });
        return true;
      });
    },

    /**
     * The person asks for their data to be deleted. Access ends now, exactly as when consent is
     * withdrawn; the data is anonymised when the request falls due, and until then the request
     * can be taken back.
     */
    async requestDeletion(
      actor: Actor,
      input: { now: Date; key: string },
    ): Promise<DeletionRequestResult> {
      const userId = requirePatient(actor);
      return db.transaction(async (tx) => {
        await serialise(tx, userId);
        if ((await heldRoleOf(tx, userId)) !== null) {
          return { status: 'HAS_ROLE' };
        }
        const waiting = await pendingDeletion(tx, userId);
        if (waiting !== null) {
          return { status: 'ALREADY', dueAt: waiting.dueAt };
        }
        const [account] = await tx
          .select({ locale: users.locale })
          .from(users)
          .where(and(eq(users.id, userId), eq(users.status, 'ACTIVE')));
        if (account === undefined) {
          throw new ForbiddenError('the account is closed');
        }
        await revokeConsent(tx, userId, account.locale);
        const left = await leaveAll(tx, actor, { userId, now: input.now, key: input.key });
        const dueAt = new Date(input.now.getTime() + DELETION_GRACE_MS);
        const [request] = await tx
          .insert(deletionRequests)
          .values({ userId, requestedAt: input.now, dueAt })
          .returning({ id: deletionRequests.id });
        await audit.record(tx, {
          actor,
          entityType: 'deletion_requests',
          entityId: request?.id ?? '',
          action: 'REQUEST',
          changes: ['due_at'],
          ...context,
        });
        return { status: 'REQUESTED', dueAt, ...left };
      });
    },

    /** The person takes their request back before it falls due. Consent stays withdrawn. */
    async cancelDeletion(actor: Actor, input: { now: Date }): Promise<boolean> {
      const userId = requirePatient(actor);
      return db.transaction(async (tx) => {
        await serialise(tx, userId);
        const [cancelled] = await tx
          .update(deletionRequests)
          .set({ status: 'CANCELLED', closedAt: input.now })
          .where(and(eq(deletionRequests.userId, userId), eq(deletionRequests.status, 'PENDING')))
          .returning({ id: deletionRequests.id });
        if (cancelled === undefined) {
          return false;
        }
        await audit.record(tx, {
          actor,
          entityType: 'deletion_requests',
          entityId: cancelled.id,
          action: 'CANCEL',
          changes: ['status'],
          ...context,
        });
        return true;
      });
    },

    /**
     * Carries out the deletion requests that have fallen due: each in its own transaction, so one
     * that fails does not hold the others back. System only; returns the accounts anonymised.
     */
    async eraseDue(actor: Actor, now: Date): Promise<string[]> {
      requireSystem(actor, 'carries out deletion requests');
      const erased: string[] = [];
      for (let round = 0; round < SWEEP_BATCH; round += 1) {
        const userId = await db.transaction(async (tx) => {
          const [request] = await tx
            .select()
            .from(deletionRequests)
            .where(and(eq(deletionRequests.status, 'PENDING'), lte(deletionRequests.dueAt, now)))
            .orderBy(asc(deletionRequests.dueAt), asc(deletionRequests.id))
            .limit(1)
            .for('update', { skipLocked: true });
          if (request === undefined) {
            return null;
          }
          await serialise(tx, request.userId);
          await erase(tx, request.userId, now);
          await tx
            .update(deletionRequests)
            .set({ status: 'DONE', closedAt: now })
            .where(eq(deletionRequests.id, request.id));
          return request.userId;
        });
        if (userId === null) {
          break;
        }
        erased.push(userId);
      }
      return erased;
    },

    /**
     * Draws up the summary of each course that ended three days ago or more and has none yet
     * (TZ §12.1). System only; returns how many were written.
     */
    async summariseDue(actor: Actor, now: Date): Promise<number> {
      requireSystem(actor, 'draws up course summaries');
      const due = await db
        .select({ course: treatmentCourses })
        .from(treatmentCourses)
        .innerJoin(users, eq(users.id, treatmentCourses.patientId))
        .where(
          and(
            inArray(treatmentCourses.status, ['COMPLETED', 'CANCELLED']),
            // A course nobody started has nothing to summarise.
            isNotNull(treatmentCourses.startAt),
            lte(treatmentCourses.endedAt, new Date(now.getTime() - SUMMARY_AFTER_MS)),
            eq(users.status, 'ACTIVE'),
            sql`not exists (
              select 1 from ${courseSummaries} where ${courseSummaries.courseId} = ${treatmentCourses.id}
            )`,
            // Nothing new is made of the data of a person who has withdrawn their consent: the
            // summary is drawn up if and when they give it again.
            sql`not exists (
              select 1 from consent_records c
              where c.user_id = ${treatmentCourses.patientId} and c.kind = ${CONSENT_KIND}
                and c.decision = 'REVOKED'
                and not exists (
                  select 1 from consent_records later
                  where later.user_id = c.user_id and later.kind = c.kind
                    and (later.at, later.id) > (c.at, c.id)
                )
            )`,
          ),
        )
        .orderBy(asc(treatmentCourses.endedAt), asc(treatmentCourses.id))
        .limit(SWEEP_BATCH);

      let written = 0;
      for (const { course } of due) {
        written += await db.transaction(async (tx) => {
          const report = await createHistoryRepository(tx, deps).report(
            { kind: 'PATIENT', userId: course.patientId },
            course.id,
          );
          if (report === null || course.endedAt === null) {
            return 0;
          }
          const doses = new Map(
            report.plan.medications.map((medication) => [medication.lineId, medication]),
          );
          const content: CourseSummaryContent = {
            status: course.status,
            startedOn: course.effectiveStartDate,
            endedAt: course.endedAt.toISOString(),
            durationDays: course.durationDays,
            taken: report.adherence.taken,
            takenLate: report.adherence.takenLate,
            skipped: report.adherence.skipped,
            missed: report.adherence.missed,
            occurred: report.adherence.occurred,
            percent: report.adherence.percent,
            medications: report.byMedication.map((line) => {
              const dose = doses.get(line.lineId);
              return {
                name: line.displayName,
                doseValue: dose?.doseValue ?? null,
                doseDisplay: dose?.doseDisplay ?? null,
                doseUnit: dose?.doseUnit ?? null,
                taken: line.adherence.taken,
                occurred: line.adherence.occurred,
                percent: line.adherence.percent,
              };
            }),
            asNeeded: report.prn.map((drug) => ({ name: drug.displayName, count: drug.count })),
          };
          const inserted = await tx
            .insert(courseSummaries)
            .values({
              courseId: course.id,
              patientId: course.patientId,
              clinicianId: course.clinicianId,
              content,
              createdAt: now,
            })
            .onConflictDoNothing({ target: courseSummaries.courseId })
            .returning({ courseId: courseSummaries.courseId });
          return inserted.length;
        });
      }
      return written;
    },

    /**
     * The summaries of a patient's earlier courses, for a doctor who treats them now and whom
     * the patient has let see them. Null without that permission (or without the patient): the
     * doctor cannot tell which. The doctor's own courses are left out: they have those in full.
     */
    async sharedSummaries(actor: Actor, relationshipId: string): Promise<SharedSummary[] | null> {
      if (actor.kind !== 'CLINICIAN') {
        throw new ForbiddenError('summaries of earlier courses are for the treating doctor');
      }
      return db.transaction(async (tx) => {
        const [relationship] = await tx
          .select({ patientId: careRelationships.patientId })
          .from(careRelationships)
          .where(
            and(
              eq(careRelationships.id, relationshipId),
              eq(careRelationships.clinicianId, actor.userId),
              eq(careRelationships.status, 'ACTIVE'),
              isNotNull(careRelationships.historySharedAt),
              usableClinician(actor.userId),
              activeUser(actor.userId),
            ),
          );
        if (relationship === undefined) {
          return null;
        }
        const rows = await tx
          .select({
            courseId: courseSummaries.courseId,
            content: courseSummaries.content,
            firstName: clinicianProfiles.firstName,
            lastName: clinicianProfiles.lastName,
          })
          .from(courseSummaries)
          .innerJoin(clinicianProfiles, eq(clinicianProfiles.userId, courseSummaries.clinicianId))
          .where(
            and(
              eq(courseSummaries.patientId, relationship.patientId),
              ne(courseSummaries.clinicianId, actor.userId),
            ),
          )
          .orderBy(desc(courseSummaries.createdAt), desc(courseSummaries.courseId))
          .limit(SWEEP_BATCH);
        // Reading another doctor's patient's history is reading medical data: it is logged.
        await audit.record(tx, {
          actor,
          entityType: 'course_summaries',
          entityId: relationshipId,
          action: 'READ',
          changes: [],
          ...context,
        });
        return rows.map((row) => ({
          courseId: row.courseId,
          clinicianName: `${row.firstName} ${row.lastName}`,
          content: row.content as CourseSummaryContent,
        }));
      });
    },
  };
}

export type PrivacyRepository = ReturnType<typeof createPrivacyRepository>;
