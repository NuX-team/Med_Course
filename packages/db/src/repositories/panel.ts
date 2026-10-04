import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { resolveActors, type Actor } from '../access/actor';
import { ForbiddenError } from '../access/errors';
import {
  activeClinicStaff,
  activeTechAdmin,
  administrableCourses,
  visiblePatients,
} from '../access/scopes';
import type { Executor } from '../orm';
import {
  auditLog,
  clinicStaff,
  clinicianProfiles,
  clinics,
  doctorAlerts,
  notifications,
  panelLogins,
  panelSessions,
  patientProfiles,
  scheduledDoses,
  treatmentCourses,
  users,
  type CourseStatus,
} from '../schema';
import type { RepositoryDeps } from './context';
import type { StaffActor } from './incidents';

/** A sign-in link is for the next few minutes, not for the chat history. */
export const PANEL_LOGIN_TTL_MS = 5 * 60_000;
/** A working day: after this the person asks the bot for a new link. */
export const PANEL_SESSION_TTL_MS = 12 * 3_600_000;
/** Links one person may ask for in a quarter of an hour. */
export const MAX_PANEL_LOGINS = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LIST_LIMIT = 200;
const AUDIT_PAGE = 100;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A capacity a person holds in the panel, with what to call it on screen. */
export type PanelRole =
  | { readonly actor: Extract<StaffActor, { kind: 'TECH_ADMIN' }> }
  | { readonly actor: Extract<StaffActor, { kind: 'CLINIC_STAFF' }>; readonly clinicName: string };

export interface PanelSession {
  readonly userId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly locale: 'ru' | 'uz';
  /** The person's own time zone: times in the panel are shown on their clock. */
  readonly timezone: string;
  readonly csrfToken: string;
  /** What the person may act as right now; read from the staff records on every request. */
  readonly roles: readonly PanelRole[];
}

export type LoginIssue =
  /** The person holds no staff role: there is nothing for them to sign in to. */
  | { readonly status: 'NOT_STAFF' }
  | { readonly status: 'TOO_MANY' }
  | { readonly status: 'ISSUED'; readonly token: string; readonly expiresAt: Date };

export interface ClinicCourseRow {
  readonly courseId: string;
  readonly status: CourseStatus;
  readonly durationDays: number;
  readonly createdAt: Date;
  readonly startAt: Date | null;
  readonly endedAt: Date | null;
  /** Null when this clinic no longer treats the patient. */
  readonly patientName: string | null;
  readonly clinicianName: string;
}

export interface ClinicOverview {
  readonly clinicName: string;
  readonly doctors: readonly {
    readonly firstName: string;
    readonly lastName: string;
    readonly verificationStatus: 'PENDING' | 'VERIFIED' | 'REVOKED';
  }[];
}

/** One line of a queue: how many rows are in each state, and how late the oldest waiting one is. */
export interface QueueStats {
  readonly byStatus: Readonly<Record<string, number>>;
  /** Waiting rows whose time has passed. */
  readonly overdue: number;
  /** How long the most overdue waiting row has been due, in seconds; null when none is. */
  readonly oldestOverdueSeconds: number | null;
  /** Rows taken by a worker whose reservation has run out. */
  readonly stuck: number;
  /** Failures in the last 24 hours, by machine code. */
  readonly failures: Readonly<Record<string, number>>;
}

/** The technical panel: numbers and codes, nothing about any person or prescription. */
export interface TechStats {
  readonly reminders: QueueStats & {
    /** Seconds between "due" and "sent" over the last 24 hours. */
    readonly delaySecondsP50: number | null;
    readonly delaySecondsP95: number | null;
    readonly sentInDay: number;
  };
  readonly alerts: QueueStats;
  /** Doses of running courses past their deadline that the sweeper has not recorded yet. */
  readonly unsweptDoses: number;
  readonly courses: Readonly<Record<string, number>>;
  readonly doctors: Readonly<Record<string, number>>;
  readonly users: number;
}

export interface AuditRow {
  readonly id: number;
  readonly at: Date;
  readonly actorKind: string;
  /** A short, stable stand-in for the actor: the first characters of their id. */
  readonly actorRef: string | null;
  readonly entityType: string;
  readonly entityRef: string;
  readonly action: string;
  /** Names of changed fields. The log never holds values. */
  readonly changes: readonly string[];
}

export interface ClinicWithStaff {
  readonly clinicId: string;
  readonly name: string;
  readonly status: 'ACTIVE' | 'SUSPENDED';
  readonly staff: readonly {
    readonly staffId: string;
    readonly role: 'RECEPTION' | 'CLINIC_ADMIN';
    readonly status: 'ACTIVE' | 'REVOKED';
    readonly firstName: string;
    readonly lastName: string;
  }[];
}

export type AddStaffResult =
  /** No such clinic, or no active account with that Telegram id that has finished registering. */
  { readonly status: 'NOT_FOUND' } | { readonly status: 'ADDED' | 'UPDATED' };

function requireTechAdmin(actor: Actor): Extract<Actor, { kind: 'TECH_ADMIN' }> {
  if (actor.kind !== 'TECH_ADMIN') {
    throw new ForbiddenError('this part of the panel is for technical administrators');
  }
  return actor;
}

function requireClinicStaff(actor: Actor): Extract<Actor, { kind: 'CLINIC_STAFF' }> {
  if (actor.kind !== 'CLINIC_STAFF') {
    throw new ForbiddenError('this part of the panel is for clinic staff');
  }
  return actor;
}

/** A pseudonymous reference: enough to tell two rows apart, not enough to find the person. */
function shortRef(id: string): string {
  return id.slice(0, 8);
}

/**
 * The staff panel's own data (ARCHITECTURE §9, TZ §14): who may sign in, and what each kind of
 * staff may see. Nothing here returns what was prescribed. A technical administrator sees
 * queues, codes and the audit trail and no patient; a clinic's staff see their own clinic's
 * doctors and the state of its courses. Each call re-checks the role in the database.
 */
export function createPanelRepository(db: Executor, deps: RepositoryDeps) {
  const { audit, requestId } = deps;
  const context = requestId === undefined ? {} : { requestId };

  const rolesOf = async (executor: Executor, userId: string): Promise<PanelRole[]> => {
    const roles: PanelRole[] = [];
    for (const actor of await resolveActors(executor, userId)) {
      if (actor.kind === 'TECH_ADMIN') {
        roles.push({ actor });
      } else if (actor.kind === 'CLINIC_STAFF') {
        const [clinic] = await executor
          .select({ name: clinics.name })
          .from(clinics)
          .where(and(eq(clinics.id, actor.clinicId), eq(clinics.status, 'ACTIVE')));
        if (clinic !== undefined) {
          roles.push({ actor, clinicName: clinic.name });
        }
      }
    }
    return roles;
  };

  const assertTechAdmin = async (executor: Executor, userId: string): Promise<void> => {
    // Revocable, so checked now and said out loud: an empty page is never a silent refusal.
    const allowed = await executor.execute<{ ok: boolean }>(
      sql`select ${activeTechAdmin(userId)} as ok`,
    );
    if (allowed[0]?.ok !== true) {
      throw new ForbiddenError('the administrator is no longer active');
    }
  };

  const assertClinicStaff = async (
    executor: Executor,
    actor: Extract<Actor, { kind: 'CLINIC_STAFF' }>,
  ): Promise<void> => {
    const allowed = await executor.execute<{ ok: boolean }>(
      sql`select ${activeClinicStaff(actor.userId, actor.clinicId)} as ok`,
    );
    if (allowed[0]?.ok !== true) {
      throw new ForbiddenError('no longer a member of this clinic’s staff');
    }
  };

  const queueStats = async (
    executor: Executor,
    table: typeof notifications | typeof doctorAlerts,
    now: Date,
  ): Promise<QueueStats> => {
    const iso = now.toISOString();
    const byStatus = await executor
      .select({ status: table.status, n: sql<number>`count(*)::int` })
      .from(table)
      .groupBy(table.status);
    const [waiting] = await executor
      .select({
        overdue: sql<number>`count(*)::int`,
        oldest: sql<
          number | null
        >`extract(epoch from ${iso}::timestamptz - min(${table.dueAt}))::int`,
      })
      .from(table)
      .where(and(eq(table.status, 'QUEUED'), lt(table.dueAt, now)));
    const [stuck] = await executor
      .select({ n: sql<number>`count(*)::int` })
      .from(table)
      .where(and(eq(table.status, 'SENDING'), lt(table.lockedUntil, now)));
    const failures = await executor
      .select({ code: table.lastError, n: sql<number>`count(*)::int` })
      .from(table)
      .where(
        and(eq(table.status, 'FAILED'), gt(table.updatedAt, new Date(now.getTime() - 86_400_000))),
      )
      .groupBy(table.lastError);
    return {
      byStatus: Object.fromEntries(byStatus.map((row) => [row.status, row.n])),
      overdue: waiting?.overdue ?? 0,
      oldestOverdueSeconds: (waiting?.overdue ?? 0) > 0 ? (waiting?.oldest ?? null) : null,
      stuck: stuck?.n ?? 0,
      failures: Object.fromEntries(failures.map((row) => [row.code ?? 'UNKNOWN', row.n])),
    };
  };

  return {
    /**
     * A sign-in link for a member of staff who asked the bot for one. The token is returned
     * once and stored only as a hash. Nothing is issued to a person who holds no staff role.
     */
    async issueLogin(actor: Actor, input: { userId: string; now: Date }): Promise<LoginIssue> {
      if (actor.kind !== 'SYSTEM') {
        throw new ForbiddenError('only the system issues sign-in links');
      }
      return db.transaction(async (tx) => {
        if ((await rolesOf(tx, input.userId)).length === 0) {
          return { status: 'NOT_STAFF' };
        }
        const [recent] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(panelLogins)
          .where(
            and(
              eq(panelLogins.userId, input.userId),
              gt(panelLogins.createdAt, new Date(input.now.getTime() - LOGIN_WINDOW_MS)),
            ),
          );
        if ((recent?.n ?? 0) >= MAX_PANEL_LOGINS) {
          return { status: 'TOO_MANY' };
        }
        const token = newToken();
        const expiresAt = new Date(input.now.getTime() + PANEL_LOGIN_TTL_MS);
        await tx.insert(panelLogins).values({
          userId: input.userId,
          tokenHash: hashToken(token),
          expiresAt,
          createdAt: input.now,
        });
        return { status: 'ISSUED', token, expiresAt };
      });
    },

    /**
     * Exchanges a sign-in link for a session, once. The link is spent whether or not the person
     * is still staff; a person who no longer is gets no session. Returns the session token for
     * the cookie, or null.
     */
    async redeemLogin(input: {
      token: string;
      now: Date;
    }): Promise<{ sessionToken: string; expiresAt: Date } | null> {
      if (!TOKEN_PATTERN.test(input.token)) {
        return null;
      }
      return db.transaction(async (tx) => {
        const [login] = await tx
          .select()
          .from(panelLogins)
          .where(
            and(
              eq(panelLogins.tokenHash, hashToken(input.token)),
              isNull(panelLogins.usedAt),
              gt(panelLogins.expiresAt, input.now),
            ),
          )
          .for('update');
        if (login === undefined) {
          return null;
        }
        await tx.update(panelLogins).set({ usedAt: input.now }).where(eq(panelLogins.id, login.id));
        if ((await rolesOf(tx, login.userId)).length === 0) {
          return null;
        }
        const sessionToken = newToken();
        const expiresAt = new Date(input.now.getTime() + PANEL_SESSION_TTL_MS);
        const [session] = await tx
          .insert(panelSessions)
          .values({
            userId: login.userId,
            tokenHash: hashToken(sessionToken),
            csrfToken: newToken(),
            expiresAt,
            createdAt: input.now,
          })
          .returning({ id: panelSessions.id });
        await audit.record(tx, {
          actor: { kind: 'SYSTEM', reason: 'panel sign-in' },
          entityType: 'panel_sessions',
          entityId: session?.id ?? '',
          action: 'SIGN_IN',
          changes: [],
          ...context,
        });
        return { sessionToken, expiresAt };
      });
    },

    /**
     * Who a session cookie belongs to and what they may do right now. Null for a token that is
     * unknown, expired or signed out, for a closed account, and for a person with no staff role
     * left: losing the role ends the session's usefulness at the very next request.
     */
    async session(input: { token: string; now: Date }): Promise<PanelSession | null> {
      if (!TOKEN_PATTERN.test(input.token)) {
        return null;
      }
      const [found] = await db
        .select({
          userId: panelSessions.userId,
          csrfToken: panelSessions.csrfToken,
          locale: users.locale,
          timezone: users.timezone,
          firstName: patientProfiles.firstName,
          lastName: patientProfiles.lastName,
        })
        .from(panelSessions)
        .innerJoin(users, eq(users.id, panelSessions.userId))
        .innerJoin(patientProfiles, eq(patientProfiles.userId, panelSessions.userId))
        .where(
          and(
            eq(panelSessions.tokenHash, hashToken(input.token)),
            isNull(panelSessions.revokedAt),
            gt(panelSessions.expiresAt, input.now),
            eq(users.status, 'ACTIVE'),
          ),
        );
      if (found === undefined) {
        return null;
      }
      const roles = await rolesOf(db, found.userId);
      return roles.length === 0 ? null : { ...found, roles };
    },

    /** Signs a browser out. Unknown tokens are ignored. */
    async signOut(input: { token: string; now: Date }): Promise<void> {
      if (!TOKEN_PATTERN.test(input.token)) {
        return;
      }
      await db
        .update(panelSessions)
        .set({ revokedAt: input.now })
        .where(
          and(eq(panelSessions.tokenHash, hashToken(input.token)), isNull(panelSessions.revokedAt)),
        );
    },

    /** Forgets sign-in links and sessions that ran out before `before`. System housekeeping. */
    async prune(actor: Actor, before: Date): Promise<number> {
      if (actor.kind !== 'SYSTEM') {
        throw new ForbiddenError('only the system prunes sessions');
      }
      const logins = await db
        .delete(panelLogins)
        .where(lt(panelLogins.expiresAt, before))
        .returning({ id: panelLogins.id });
      const sessions = await db
        .delete(panelSessions)
        .where(lt(panelSessions.expiresAt, before))
        .returning({ id: panelSessions.id });
      return logins.length + sessions.length;
    },

    /** The clinic and its doctors, for its own staff. */
    async clinicOverview(actor: Actor): Promise<ClinicOverview> {
      const staff = requireClinicStaff(actor);
      return db.transaction(async (tx) => {
        await assertClinicStaff(tx, staff);
        const [clinic] = await tx
          .select({ name: clinics.name })
          .from(clinics)
          .where(eq(clinics.id, staff.clinicId));
        const doctors = await tx
          .select({
            firstName: clinicianProfiles.firstName,
            lastName: clinicianProfiles.lastName,
            verificationStatus: clinicianProfiles.verificationStatus,
          })
          .from(clinicianProfiles)
          .where(eq(clinicianProfiles.clinicId, staff.clinicId))
          .orderBy(asc(clinicianProfiles.lastName), asc(clinicianProfiles.firstName))
          .limit(LIST_LIMIT);
        return { clinicName: clinic?.name ?? '', doctors };
      });
    },

    /**
     * The clinic's courses as its staff may see them: whose, in what state, since when. Never
     * what was prescribed. The patient's name is given only while the clinic treats them.
     */
    async clinicCourses(actor: Actor): Promise<ClinicCourseRow[]> {
      const staff = requireClinicStaff(actor);
      return db.transaction(async (tx) => {
        await assertClinicStaff(tx, staff);
        const rows = await tx
          .select({
            courseId: treatmentCourses.id,
            status: treatmentCourses.status,
            durationDays: treatmentCourses.durationDays,
            createdAt: treatmentCourses.createdAt,
            startAt: treatmentCourses.startAt,
            endedAt: treatmentCourses.endedAt,
            patientName: sql<string | null>`(
              select ${patientProfiles.firstName} || ' ' || ${patientProfiles.lastName}
              from ${patientProfiles}
              where ${patientProfiles.userId} = ${treatmentCourses.patientId}
                and ${visiblePatients(staff)}
            )`,
            clinicianFirst: clinicianProfiles.firstName,
            clinicianLast: clinicianProfiles.lastName,
          })
          .from(treatmentCourses)
          .innerJoin(clinicianProfiles, eq(clinicianProfiles.userId, treatmentCourses.clinicianId))
          .where(administrableCourses(staff))
          .orderBy(desc(treatmentCourses.createdAt), desc(treatmentCourses.id))
          .limit(LIST_LIMIT);
        if (rows.length > 0) {
          // A list of who is being treated is personal data: reading it is logged.
          await audit.record(tx, {
            actor: staff,
            entityType: 'treatment_courses',
            entityId: staff.clinicId,
            action: 'READ',
            changes: [],
            ...context,
          });
        }
        return rows.map(({ clinicianFirst, clinicianLast, ...row }) => ({
          ...row,
          clinicianName: `${clinicianFirst} ${clinicianLast}`,
        }));
      });
    },

    /** The state of the queues and the service, in numbers. Technical administrators only. */
    async techStats(actor: Actor, now: Date): Promise<TechStats> {
      const admin = requireTechAdmin(actor);
      return db.transaction(async (tx) => {
        await assertTechAdmin(tx, admin.userId);
        const dayAgo = new Date(now.getTime() - 86_400_000);
        const [delay] = await tx
          .select({
            sent: sql<number>`count(*)::int`,
            p50: sql<number | string | null>`percentile_cont(0.5) within group (
              order by extract(epoch from ${notifications.sentAt} - ${notifications.dueAt}))`,
            p95: sql<number | string | null>`percentile_cont(0.95) within group (
              order by extract(epoch from ${notifications.sentAt} - ${notifications.dueAt}))`,
          })
          .from(notifications)
          .where(and(eq(notifications.status, 'SENT'), gt(notifications.sentAt, dayAgo)));
        const [unswept] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(scheduledDoses)
          .innerJoin(treatmentCourses, eq(treatmentCourses.id, scheduledDoses.courseId))
          .where(
            and(
              eq(treatmentCourses.status, 'ACTIVE'),
              sql`${scheduledDoses.status} in ('SCHEDULED', 'NOTIFIED', 'SNOOZED')`,
              lt(scheduledDoses.deadlineAt, now),
            ),
          );
        const courses = await tx
          .select({ status: treatmentCourses.status, n: sql<number>`count(*)::int` })
          .from(treatmentCourses)
          .groupBy(treatmentCourses.status);
        const doctors = await tx
          .select({
            status: clinicianProfiles.verificationStatus,
            n: sql<number>`count(*)::int`,
          })
          .from(clinicianProfiles)
          .groupBy(clinicianProfiles.verificationStatus);
        const [people] = await tx.select({ n: sql<number>`count(*)::int` }).from(users);
        const round = (value: number | string | null | undefined): number | null =>
          value === null || value === undefined ? null : Math.round(Number(value));
        return {
          reminders: {
            ...(await queueStats(tx, notifications, now)),
            delaySecondsP50: round(delay?.p50),
            delaySecondsP95: round(delay?.p95),
            sentInDay: delay?.sent ?? 0,
          },
          alerts: await queueStats(tx, doctorAlerts, now),
          unsweptDoses: unswept?.n ?? 0,
          courses: Object.fromEntries(courses.map((row) => [row.status, row.n])),
          doctors: Object.fromEntries(doctors.map((row) => [row.status, row.n])),
          users: people?.n ?? 0,
        };
      });
    },

    /**
     * The audit trail, newest first: who (as a short reference), what kind of record, what was
     * done, which fields. The log never holds values, so there are none to show.
     */
    async auditTrail(
      actor: Actor,
      input: { entityType?: string; beforeId?: number } = {},
    ): Promise<AuditRow[]> {
      const admin = requireTechAdmin(actor);
      return db.transaction(async (tx) => {
        await assertTechAdmin(tx, admin.userId);
        const rows = await tx
          .select()
          .from(auditLog)
          .where(
            and(
              input.entityType === undefined
                ? undefined
                : eq(auditLog.entityType, input.entityType),
              input.beforeId === undefined ? undefined : lt(auditLog.id, input.beforeId),
            ),
          )
          .orderBy(desc(auditLog.id))
          .limit(AUDIT_PAGE);
        return rows.map((row) => ({
          id: row.id,
          at: row.at,
          actorKind: row.actorKind,
          actorRef: row.actorUserId === null ? null : shortRef(row.actorUserId),
          entityType: row.entityType,
          entityRef: shortRef(row.entityId),
          action: row.action,
          changes: row.changes,
        }));
      });
    },

    /** Every clinic with its staff. Technical administrators only. */
    async clinics(actor: Actor): Promise<ClinicWithStaff[]> {
      const admin = requireTechAdmin(actor);
      return db.transaction(async (tx) => {
        await assertTechAdmin(tx, admin.userId);
        const all = await tx
          .select({ clinicId: clinics.id, name: clinics.name, status: clinics.status })
          .from(clinics)
          .orderBy(asc(clinics.name), asc(clinics.id))
          .limit(LIST_LIMIT);
        const staff = await tx
          .select({
            staffId: clinicStaff.id,
            clinicId: clinicStaff.clinicId,
            role: clinicStaff.role,
            status: clinicStaff.status,
            firstName: patientProfiles.firstName,
            lastName: patientProfiles.lastName,
          })
          .from(clinicStaff)
          .innerJoin(patientProfiles, eq(patientProfiles.userId, clinicStaff.userId))
          .orderBy(asc(patientProfiles.lastName), asc(patientProfiles.firstName));
        return all.map((clinic) => ({
          ...clinic,
          staff: staff
            .filter((member) => member.clinicId === clinic.clinicId)
            .map(({ clinicId: _clinic, ...member }) => member),
        }));
      });
    },

    /**
     * Makes a registered person a member of a clinic's staff (or changes their role, or restores
     * a revoked one). The person is named by their Telegram id, as they are in the doctor list.
     */
    async addClinicStaff(
      actor: Actor,
      input: { clinicId: string; telegramUserId: number; role: 'RECEPTION' | 'CLINIC_ADMIN' },
    ): Promise<AddStaffResult> {
      if (actor.kind !== 'TECH_ADMIN' && actor.kind !== 'SYSTEM') {
        throw new ForbiddenError('only an administrator appoints clinic staff');
      }
      return db.transaction(async (tx) => {
        if (actor.kind === 'TECH_ADMIN') {
          await assertTechAdmin(tx, actor.userId);
        }
        const [clinic] = await tx
          .select({ id: clinics.id })
          .from(clinics)
          .where(eq(clinics.id, input.clinicId));
        const [person] = await tx
          .select({ id: users.id })
          .from(users)
          .innerJoin(patientProfiles, eq(patientProfiles.userId, users.id))
          .where(and(eq(users.telegramUserId, input.telegramUserId), eq(users.status, 'ACTIVE')));
        if (clinic === undefined || person === undefined) {
          return { status: 'NOT_FOUND' };
        }
        const [before] = await tx
          .select()
          .from(clinicStaff)
          .where(and(eq(clinicStaff.userId, person.id), eq(clinicStaff.clinicId, input.clinicId)))
          .for('update');
        const [after] =
          before === undefined
            ? await tx
                .insert(clinicStaff)
                .values({ userId: person.id, clinicId: input.clinicId, role: input.role })
                .returning()
            : await tx
                .update(clinicStaff)
                .set({ role: input.role, status: 'ACTIVE' })
                .where(eq(clinicStaff.id, before.id))
                .returning();
        await audit.record(tx, {
          actor,
          entityType: 'clinic_staff',
          entityId: after?.id ?? '',
          action: before === undefined ? 'CREATE' : 'UPDATE',
          before: before ?? null,
          after: after ?? null,
          ...(before === undefined ? { changes: ['role', 'status'] } : {}),
          ...context,
        });
        return { status: before === undefined ? 'ADDED' : 'UPDATED' };
      });
    },

    /** Ends a staff membership. The person's sessions stop working at the next request. */
    async revokeClinicStaff(actor: Actor, staffId: string): Promise<boolean> {
      const admin = requireTechAdmin(actor);
      return db.transaction(async (tx) => {
        await assertTechAdmin(tx, admin.userId);
        const [before] = await tx
          .select()
          .from(clinicStaff)
          .where(and(eq(clinicStaff.id, staffId), eq(clinicStaff.status, 'ACTIVE')))
          .for('update');
        if (before === undefined) {
          return false;
        }
        const [after] = await tx
          .update(clinicStaff)
          .set({ status: 'REVOKED' })
          .where(eq(clinicStaff.id, staffId))
          .returning();
        await audit.record(tx, {
          actor,
          entityType: 'clinic_staff',
          entityId: staffId,
          action: 'REVOKE',
          before,
          after: after ?? null,
          ...context,
        });
        return true;
      });
    },
  };
}

export type PanelRepository = ReturnType<typeof createPanelRepository>;
