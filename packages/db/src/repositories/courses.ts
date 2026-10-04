import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Actor } from '../access/actor';
import { actorUserId } from '../access/actor';
import { ForbiddenError } from '../access/errors';
import { administrableCourses, clinicianCanTreat, visibleCourses } from '../access/scopes';
import type { Executor } from '../orm';
import {
  careRelationships,
  clinicianProfiles,
  courseRevisions,
  courseTransitions,
  reminderPolicies,
  treatmentCourses,
  type CourseStatus,
} from '../schema';
import type { RepositoryDeps } from './context';

export type Course = typeof treatmentCourses.$inferSelect;

/** What clinic staff see: the state of a course, never what was prescribed. */
export interface CourseAdminView {
  readonly id: string;
  readonly status: CourseStatus;
  readonly patientId: string;
  readonly clinicianId: string;
  readonly clinicId: string;
  readonly durationDays: number;
  readonly plannedStartAt: Date | null;
  readonly startAt: Date | null;
  readonly endedAt: Date | null;
}

export interface ListCoursesFilter {
  readonly statuses?: readonly CourseStatus[];
  readonly patientId?: string;
}

export interface CreateCourseDraftInput {
  readonly patientId: string;
  readonly durationDays: number;
  /** IANA zone the schedule is written in, normally the patient's. */
  readonly timezone: string;
  readonly plannedStartAt?: Date;
  readonly startWindow?: { readonly from: Date; readonly to: Date };
}

const LIST_LIMIT = 200;

export function createCourseRepository(db: Executor, deps: RepositoryDeps) {
  const { audit, requestId } = deps;
  const context = requestId === undefined ? {} : { requestId };

  return {
    async get(actor: Actor, courseId: string): Promise<Course | null> {
      const [course] = await db
        .select()
        .from(treatmentCourses)
        .where(and(eq(treatmentCourses.id, courseId), visibleCourses(actor)));
      return course ?? null;
    },

    async list(actor: Actor, filter: ListCoursesFilter = {}): Promise<Course[]> {
      return db
        .select()
        .from(treatmentCourses)
        .where(
          and(
            visibleCourses(actor),
            filter.statuses && filter.statuses.length > 0
              ? inArray(treatmentCourses.status, [...filter.statuses])
              : undefined,
            filter.patientId ? eq(treatmentCourses.patientId, filter.patientId) : undefined,
          ),
        )
        .orderBy(desc(treatmentCourses.createdAt))
        .limit(LIST_LIMIT);
    },

    /** The administrative projection for clinic staff. Carries no medical content. */
    async listForAdministration(
      actor: Actor,
      filter: Pick<ListCoursesFilter, 'statuses'> = {},
    ): Promise<CourseAdminView[]> {
      return db
        .select({
          id: treatmentCourses.id,
          status: treatmentCourses.status,
          patientId: treatmentCourses.patientId,
          clinicianId: treatmentCourses.clinicianId,
          clinicId: treatmentCourses.clinicId,
          durationDays: treatmentCourses.durationDays,
          plannedStartAt: treatmentCourses.plannedStartAt,
          startAt: treatmentCourses.startAt,
          endedAt: treatmentCourses.endedAt,
        })
        .from(treatmentCourses)
        .where(
          and(
            administrableCourses(actor),
            filter.statuses && filter.statuses.length > 0
              ? inArray(treatmentCourses.status, [...filter.statuses])
              : undefined,
          ),
        )
        .orderBy(desc(treatmentCourses.createdAt))
        .limit(LIST_LIMIT);
    },

    /**
     * Opens an empty draft: the course, its first (draft) revision, the default reminder
     * policy and the first state-history row, all or nothing. Only a clinician with an ACTIVE
     * relationship to the patient may do this. Filling in the plan is stage 6.
     */
    async createDraft(actor: Actor, input: CreateCourseDraftInput): Promise<Course> {
      if (actor.kind !== 'CLINICIAN') {
        throw new ForbiddenError('only a clinician can open a course');
      }
      const clinicianId = actor.userId;

      return db.transaction(async (tx) => {
        const [link] = await tx
          .select({ relationshipId: careRelationships.id, clinicId: clinicianProfiles.clinicId })
          .from(careRelationships)
          .innerJoin(clinicianProfiles, eq(clinicianProfiles.userId, careRelationships.clinicianId))
          .where(
            and(
              eq(careRelationships.clinicianId, clinicianId),
              eq(careRelationships.patientId, input.patientId),
              eq(careRelationships.status, 'ACTIVE'),
              clinicianCanTreat(clinicianId, input.patientId),
            ),
          );
        if (link === undefined) {
          throw new ForbiddenError('no active care relationship with this patient');
        }

        const courseId = randomUUID();
        const revisionId = randomUUID();

        await tx.insert(treatmentCourses).values({
          id: courseId,
          careRelationshipId: link.relationshipId,
          patientId: input.patientId,
          clinicianId,
          clinicId: link.clinicId,
          durationDays: input.durationDays,
          timezone: input.timezone,
          plannedStartAt: input.plannedStartAt ?? null,
          startWindowFrom: input.startWindow?.from ?? null,
          startWindowTo: input.startWindow?.to ?? null,
        });
        await tx.insert(courseRevisions).values({
          id: revisionId,
          courseId,
          revNo: 1,
          createdBy: clinicianId,
        });
        const [course] = await tx
          .update(treatmentCourses)
          .set({ currentRevisionId: revisionId })
          .where(eq(treatmentCourses.id, courseId))
          .returning();
        await tx.insert(reminderPolicies).values({ courseId });
        await tx.insert(courseTransitions).values({
          courseId,
          fromStatus: null,
          toStatus: 'DRAFT',
          actorKind: actor.kind,
          actorUserId: actorUserId(actor),
          requestId: requestId ?? null,
        });
        if (course === undefined) {
          throw new Error('course vanished inside its own transaction');
        }

        await audit.record(tx, {
          actor,
          entityType: 'treatment_courses',
          entityId: courseId,
          action: 'CREATE',
          after: course,
          changes: ['status'],
          ...context,
        });
        return course;
      });
    },
  };
}

export type CourseRepository = ReturnType<typeof createCourseRepository>;
