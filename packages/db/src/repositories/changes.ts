import { generateSlots } from '@medcourse/schedule';
import { and, eq, inArray, max, ne } from 'drizzle-orm';
import type { Actor } from '../access/actor';
import { ForbiddenError } from '../access/errors';
import { visibleCourses } from '../access/scopes';
import type { Executor } from '../orm';
import {
  courseMedications,
  courseRevisions,
  scheduleRules,
  treatmentCourses,
  type CourseStatus,
} from '../schema';
import type { RepositoryDeps } from './context';
import type { Course } from './courses';
import {
  layOutDoses,
  pausesOf,
  prescriberInStanding,
  recipientOf,
  retireOpenDoses,
  timelineOf,
  toMedicationInputs,
  type Recipient,
} from './layout';
import {
  copyMedications,
  createPlanReader,
  planProblems,
  type CoursePlan,
  type PlanMedication,
  type PlanProblemView,
} from './plans';

/** The states in which a course has a plan in force that can be replaced. */
const RUNNING: readonly CourseStatus[] = ['ACTIVE', 'PAUSED'];

/** A proposed plan next to the one in force. */
export interface ChangeView {
  readonly status: 'DRAFT' | 'CONFIRMED';
  /** The course as it is, with the medications of the proposed plan. */
  readonly proposed: CoursePlan;
  /** Medications the proposed plan adds. One replaced by a new entry shows as removed and added. */
  readonly added: readonly PlanMedication[];
  readonly removed: readonly PlanMedication[];
}

export type OpenChangeResult =
  | { readonly status: 'NOT_AVAILABLE' }
  /** A change was already sent and the patient has not answered: take it back first. */
  | { readonly status: 'WAITING_FOR_PATIENT'; readonly change: ChangeView }
  | { readonly status: 'OPENED' | 'CONTINUED'; readonly change: ChangeView };

export type SendChangeResult =
  | { readonly status: 'NOT_AVAILABLE' }
  /** The proposed plan is the plan in force: there is nothing to ask the patient about. */
  | { readonly status: 'UNCHANGED' }
  | { readonly status: 'INVALID'; readonly problems: readonly PlanProblemView[] }
  | {
      readonly status: 'SENT';
      readonly change: ChangeView;
      readonly patient: Recipient | null;
    };

export type DropChangeResult =
  | { readonly status: 'NOT_AVAILABLE' }
  | {
      readonly status: 'DROPPED';
      /** True if the patient had already been asked: they are told the question is withdrawn. */
      readonly wasSent: boolean;
      readonly plan: CoursePlan;
      readonly patient: Recipient | null;
    };

export type AcceptChangeResult =
  | { readonly status: 'NOT_AVAILABLE' }
  /** Nothing is waiting: already accepted (a second tap), or the doctor took it back. */
  | { readonly status: 'NOTHING_PENDING'; readonly plan: CoursePlan }
  | { readonly status: 'DOCTOR_UNAVAILABLE'; readonly plan: CoursePlan }
  | {
      readonly status: 'APPLIED';
      /** The course with the new plan in force. */
      readonly plan: CoursePlan;
      readonly doctor: Recipient | null;
      /** The next dose under the new plan; null while paused or when none is left. */
      readonly firstSlotAt: Date | null;
    };

function requireClinician(actor: Actor): string {
  if (actor.kind !== 'CLINICIAN') {
    throw new ForbiddenError('only the doctor changes the plan of a course');
  }
  return actor.userId;
}

/**
 * Removes whatever plan of a course is still in the making: a draft is deleted (nobody but its
 * author ever saw it), a plan already shown to the patient is kept as superseded. Called when a
 * change is taken back, and when the course itself ends.
 */
export async function closePendingChange(
  tx: Executor,
  deps: RepositoryDeps,
  actor: Actor,
  course: Pick<Course, 'id' | 'currentRevisionId'>,
): Promise<{ wasSent: boolean } | null> {
  const [pending] = await tx
    .select()
    .from(courseRevisions)
    .where(
      and(
        eq(courseRevisions.courseId, course.id),
        inArray(courseRevisions.status, ['DRAFT', 'CONFIRMED']),
        course.currentRevisionId === null
          ? undefined
          : ne(courseRevisions.id, course.currentRevisionId),
      ),
    )
    .for('update');
  if (pending === undefined) {
    return null;
  }
  const context = deps.requestId === undefined ? {} : { requestId: deps.requestId };
  if (pending.status === 'DRAFT') {
    const medications = await tx
      .select({ id: courseMedications.id })
      .from(courseMedications)
      .where(eq(courseMedications.revisionId, pending.id));
    if (medications.length > 0) {
      await tx.delete(scheduleRules).where(
        inArray(
          scheduleRules.medicationId,
          medications.map((medication) => medication.id),
        ),
      );
      await tx.delete(courseMedications).where(eq(courseMedications.revisionId, pending.id));
    }
    await tx.delete(courseRevisions).where(eq(courseRevisions.id, pending.id));
  } else {
    await tx
      .update(courseRevisions)
      .set({ status: 'SUPERSEDED' })
      .where(eq(courseRevisions.id, pending.id));
  }
  await deps.audit.record(tx, {
    actor,
    entityType: 'course_revisions',
    entityId: pending.id,
    action: pending.status === 'DRAFT' ? 'DISCARD' : 'WITHDRAW',
    changes: ['status'],
    ...context,
  });
  return { wasSent: pending.status === 'CONFIRMED' };
}

/**
 * Changing the plan of a course that is already running (ARCHITECTURE §5.4, TZ §17.4). The plan
 * in force is never edited: the doctor writes a new revision next to it, signs it off, and the
 * patient accepts it. Only then does it take effect, and only for what is still ahead: every
 * answer already given, and every miss, stays exactly as it was recorded.
 */
export function createChangeRepository(db: Executor, deps: RepositoryDeps) {
  const { audit, requestId } = deps;
  const context = requestId === undefined ? {} : { requestId };
  const { medicationsOf, planOf } = createPlanReader(deps);

  /** The doctor's own running course, locked for the length of the transaction. */
  const ownCourse = async (
    tx: Executor,
    actor: Actor,
    courseId: string,
  ): Promise<Course | null> => {
    const [course] = await tx
      .select()
      .from(treatmentCourses)
      .where(
        and(
          eq(treatmentCourses.id, courseId),
          eq(treatmentCourses.clinicianId, requireClinician(actor)),
          inArray(treatmentCourses.status, [...RUNNING]),
          visibleCourses(actor),
        ),
      )
      .for('update');
    return course ?? null;
  };

  const pendingOf = async (
    executor: Executor,
    course: Course,
  ): Promise<{ id: string; status: 'DRAFT' | 'CONFIRMED' } | null> => {
    const rows = await executor
      .select({ id: courseRevisions.id, status: courseRevisions.status })
      .from(courseRevisions)
      .where(
        and(
          eq(courseRevisions.courseId, course.id),
          inArray(courseRevisions.status, ['DRAFT', 'CONFIRMED']),
        ),
      );
    const [pending] = rows.flatMap((row) =>
      row.id !== course.currentRevisionId && (row.status === 'DRAFT' || row.status === 'CONFIRMED')
        ? [{ id: row.id, status: row.status }]
        : [],
    );
    return pending ?? null;
  };

  const viewOf = async (
    executor: Executor,
    course: Course,
    pending: { id: string; status: 'DRAFT' | 'CONFIRMED' },
    viewer: 'CLINICIAN' | 'PATIENT',
  ): Promise<ChangeView | null> => {
    const current = await planOf(executor, course, viewer);
    const proposed = await planOf(executor, course, viewer, pending.id);
    if (current === null || proposed === null) {
      return null;
    }
    const before = new Set(current.medications.map((medication) => medication.lineId));
    const after = new Set(proposed.medications.map((medication) => medication.lineId));
    return {
      status: pending.status,
      proposed,
      added: proposed.medications.filter((medication) => !before.has(medication.lineId)),
      removed: current.medications.filter((medication) => !after.has(medication.lineId)),
    };
  };

  return {
    /**
     * The change waiting on this course, for whoever may see it: the doctor sees it from the
     * first keystroke, the patient only once the doctor has signed it off. Null otherwise.
     */
    async get(actor: Actor, courseId: string): Promise<ChangeView | null> {
      if (actor.kind !== 'CLINICIAN' && actor.kind !== 'PATIENT') {
        return null;
      }
      const [course] = await db
        .select()
        .from(treatmentCourses)
        .where(
          and(
            eq(treatmentCourses.id, courseId),
            inArray(treatmentCourses.status, [...RUNNING]),
            visibleCourses(actor),
          ),
        );
      const pending = course === undefined ? null : await pendingOf(db, course);
      if (course === undefined || pending === null) {
        return null;
      }
      if (actor.kind === 'PATIENT' && pending.status !== 'CONFIRMED') {
        return null;
      }
      return viewOf(db, course, pending, actor.kind);
    },

    /**
     * Starts a change: a new draft revision holding a copy of the plan in force, for the doctor
     * to add to and take from. A course has one change in the making at a time, so asking again
     * returns the same one; while a sent change waits for the patient, no other can be started.
     */
    async open(actor: Actor, courseId: string): Promise<OpenChangeResult> {
      const clinicianId = requireClinician(actor);
      return db.transaction(async (tx) => {
        const course = await ownCourse(tx, actor, courseId);
        if (course?.currentRevisionId == null) {
          return { status: 'NOT_AVAILABLE' };
        }
        const existing = await pendingOf(tx, course);
        if (existing !== null) {
          const change = await viewOf(tx, course, existing, 'CLINICIAN');
          if (change === null) {
            return { status: 'NOT_AVAILABLE' };
          }
          return {
            status: existing.status === 'CONFIRMED' ? 'WAITING_FOR_PATIENT' : 'CONTINUED',
            change,
          };
        }

        const [last] = await tx
          .select({ revNo: max(courseRevisions.revNo) })
          .from(courseRevisions)
          .where(eq(courseRevisions.courseId, courseId));
        const [revision] = await tx
          .insert(courseRevisions)
          .values({ courseId, revNo: (last?.revNo ?? 0) + 1, createdBy: clinicianId })
          .returning();
        if (revision === undefined) {
          throw new Error('a revision vanished inside its own transaction');
        }
        await copyMedications(deps, tx, actor, {
          fromRevisionId: course.currentRevisionId,
          toRevisionId: revision.id,
          // What the doctor does not touch stays the same drug of the same course.
          keepLines: true,
        });
        await audit.record(tx, {
          actor,
          entityType: 'course_revisions',
          entityId: revision.id,
          action: 'CREATE',
          after: revision,
          changes: ['status', 'rev_no'],
          ...context,
        });
        const change = await viewOf(tx, course, { id: revision.id, status: 'DRAFT' }, 'CLINICIAN');
        return change === null ? { status: 'NOT_AVAILABLE' } : { status: 'OPENED', change };
      });
    },

    /**
     * The doctor signs the change off and it goes to the patient to accept. The new plan is
     * checked by the same rules as a first prescription. Nothing takes effect yet: the plan in
     * force keeps running until the patient accepts.
     */
    async send(actor: Actor, courseId: string, now: Date): Promise<SendChangeResult> {
      requireClinician(actor);
      return db.transaction(async (tx) => {
        const course = await ownCourse(tx, actor, courseId);
        const pending = course === null ? null : await pendingOf(tx, course);
        if (course === null || pending?.status !== 'DRAFT') {
          return { status: 'NOT_AVAILABLE' };
        }
        const draft = await viewOf(tx, course, pending, 'CLINICIAN');
        if (draft === null) {
          return { status: 'NOT_AVAILABLE' };
        }
        if (draft.added.length === 0 && draft.removed.length === 0) {
          return { status: 'UNCHANGED' };
        }
        const problems = planProblems(course, await medicationsOf(tx, pending.id));
        if (problems.length > 0) {
          return { status: 'INVALID', problems };
        }

        await tx
          .update(courseRevisions)
          .set({ status: 'CONFIRMED', confirmedByClinicianAt: now })
          .where(eq(courseRevisions.id, pending.id));
        await audit.record(tx, {
          actor,
          entityType: 'course_revisions',
          entityId: pending.id,
          action: 'CONFIRM',
          changes: ['status', 'confirmed_by_clinician_at'],
          ...context,
        });
        return {
          status: 'SENT',
          change: { ...draft, status: 'CONFIRMED' },
          patient: await recipientOf(tx, course.patientId),
        };
      });
    },

    /** The doctor takes the change back, whether or not the patient has been asked yet. */
    async drop(actor: Actor, courseId: string): Promise<DropChangeResult> {
      requireClinician(actor);
      return db.transaction(async (tx) => {
        const course = await ownCourse(tx, actor, courseId);
        const closed = course === null ? null : await closePendingChange(tx, deps, actor, course);
        const plan = course === null ? null : await planOf(tx, course, 'CLINICIAN');
        if (course === null || closed === null || plan === null) {
          return { status: 'NOT_AVAILABLE' };
        }
        return {
          status: 'DROPPED',
          wasSent: closed.wasSent,
          plan,
          patient: await recipientOf(tx, course.patientId),
        };
      });
    },

    /**
     * The patient accepts the change and it takes effect, in one transaction: the new revision
     * becomes the plan in force, everything of the old plan still open is retired, and the new
     * plan is laid out strictly after `now`. While the course is on hold nothing is laid out;
     * resuming will use the new plan. The course row is locked throughout, so a second tap, a
     * pause or a cancellation arriving at the same moment waits and then sees the result.
     */
    async accept(
      actor: Actor,
      input: { courseId: string; now: Date; key: string },
    ): Promise<AcceptChangeResult> {
      if (actor.kind !== 'PATIENT') {
        throw new ForbiddenError('only the patient accepts a change to their own course');
      }
      const { courseId, now } = input;
      return db.transaction(async (tx) => {
        const [course] = await tx
          .select()
          .from(treatmentCourses)
          .where(
            and(
              eq(treatmentCourses.id, courseId),
              eq(treatmentCourses.patientId, actor.userId),
              visibleCourses(actor),
            ),
          )
          .for('update');
        const current = course === undefined ? null : await planOf(tx, course, 'PATIENT');
        if (course === undefined || current === null) {
          return { status: 'NOT_AVAILABLE' };
        }
        const pending = RUNNING.includes(course.status) ? await pendingOf(tx, course) : null;
        if (pending?.status !== 'CONFIRMED' || course.currentRevisionId === null) {
          return { status: 'NOTHING_PENDING', plan: current };
        }
        if (!(await prescriberInStanding(tx, course))) {
          return { status: 'DOCTOR_UNAVAILABLE', plan: current };
        }

        // The old plan steps down first: a course has one plan in force at any moment.
        await tx
          .update(courseRevisions)
          .set({ status: 'SUPERSEDED' })
          .where(eq(courseRevisions.id, course.currentRevisionId));
        await tx
          .update(courseRevisions)
          .set({ status: 'APPLIED', appliedAt: now, confirmedByPatientAt: now })
          .where(eq(courseRevisions.id, pending.id));
        const [switched] = await tx
          .update(treatmentCourses)
          .set({ currentRevisionId: pending.id })
          .where(eq(treatmentCourses.id, courseId))
          .returning();
        if (switched === undefined) {
          throw new Error('a course vanished while its plan was being changed');
        }

        let firstSlotAt: Date | null = null;
        if (course.status === 'ACTIVE') {
          await retireOpenDoses(tx, {
            courseId,
            now,
            reason: 'plan changed',
            actor,
            key: input.key,
          });
          const timeline = timelineOf(switched, await pausesOf(tx, courseId));
          if (timeline === null) {
            throw new Error('a running course has no start date');
          }
          const slots = generateSlots({
            medications: toMedicationInputs(await medicationsOf(tx, pending.id)),
            timeline,
            after: now,
          });
          await layOutDoses(tx, {
            courseId,
            revisionId: pending.id,
            patientId: course.patientId,
            slots,
            now,
          });
          firstSlotAt = slots[0]?.scheduledAt ?? null;
        }

        await audit.record(tx, {
          actor,
          entityType: 'treatment_courses',
          entityId: courseId,
          action: 'CHANGE_PLAN',
          before: course,
          after: switched,
          changes: ['current_revision_id'],
          ...context,
        });
        const plan = await planOf(tx, switched, 'PATIENT');
        if (plan === null) {
          throw new Error('a course lost its patient or doctor while its plan was being changed');
        }
        return {
          status: 'APPLIED',
          plan,
          doctor: await recipientOf(tx, course.clinicianId),
          firstSlotAt,
        };
      });
    },
  };
}

export type ChangeRepository = ReturnType<typeof createChangeRepository>;
