import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { Executor } from '../orm';
import {
  clinicianProfiles,
  doctorAlerts,
  incidents,
  notifications,
  scheduledDoses,
  treatmentCourses,
  users,
} from '../schema';

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

/** Open incidents by kind: how many need somebody's attention right now. */
export type OpenIncidents = Readonly<Record<string, number>>;

async function queueStats(
  executor: Executor,
  table: typeof notifications | typeof doctorAlerts,
  now: Date,
): Promise<QueueStats> {
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
}

/**
 * The state of the queues and the service as numbers (the technical panel, the metrics page):
 * how many rows wait, how late they are, how long a reminder takes from "due" to "sent". No
 * caller of this decides who may look: that is for the one that calls it. Nothing in the result
 * is about any person or any prescription.
 */
export async function collectStats(executor: Executor, now: Date): Promise<TechStats> {
  const dayAgo = new Date(now.getTime() - 86_400_000);
  const [delay] = await executor
    .select({
      sent: sql<number>`count(*)::int`,
      p50: sql<number | string | null>`percentile_cont(0.5) within group (
        order by extract(epoch from ${notifications.sentAt} - ${notifications.dueAt}))`,
      p95: sql<number | string | null>`percentile_cont(0.95) within group (
        order by extract(epoch from ${notifications.sentAt} - ${notifications.dueAt}))`,
    })
    .from(notifications)
    .where(and(eq(notifications.status, 'SENT'), gt(notifications.sentAt, dayAgo)));
  const [unswept] = await executor
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
  const courses = await executor
    .select({ status: treatmentCourses.status, n: sql<number>`count(*)::int` })
    .from(treatmentCourses)
    .groupBy(treatmentCourses.status);
  const doctors = await executor
    .select({ status: clinicianProfiles.verificationStatus, n: sql<number>`count(*)::int` })
    .from(clinicianProfiles)
    .groupBy(clinicianProfiles.verificationStatus);
  const [people] = await executor.select({ n: sql<number>`count(*)::int` }).from(users);
  const round = (value: number | string | null | undefined): number | null =>
    value === null || value === undefined ? null : Math.round(Number(value));
  return {
    reminders: {
      ...(await queueStats(executor, notifications, now)),
      delaySecondsP50: round(delay?.p50),
      delaySecondsP95: round(delay?.p95),
      sentInDay: delay?.sent ?? 0,
    },
    alerts: await queueStats(executor, doctorAlerts, now),
    unsweptDoses: unswept?.n ?? 0,
    courses: Object.fromEntries(courses.map((row) => [row.status, row.n])),
    doctors: Object.fromEntries(doctors.map((row) => [row.status, row.n])),
    users: people?.n ?? 0,
  };
}

/** How many incidents are open, by kind. */
export async function openIncidents(executor: Executor): Promise<OpenIncidents> {
  const rows = await executor
    .select({ kind: incidents.kind, n: sql<number>`count(*)::int` })
    .from(incidents)
    .where(eq(incidents.status, 'OPEN'))
    .groupBy(incidents.kind);
  return Object.fromEntries(rows.map((row) => [row.kind, row.n]));
}
