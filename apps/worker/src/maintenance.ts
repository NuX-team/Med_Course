import { createRepositories, systemActor, type Executor, type RepositoryDeps } from '@medcourse/db';
import type { Logger } from '@medcourse/logger';

/** Telegram stops redelivering an update long before this; older ids are only clutter. */
export const UPDATE_RETENTION_MS = 7 * 24 * 3_600_000;
/** Failed invitation attempts only matter for the hour they count against; a day is plenty. */
export const ATTEMPT_RETENTION_MS = 24 * 3_600_000;
/** An invitation nobody used, this long after it ran out or was withdrawn. */
export const DEAD_INVITATION_RETENTION_MS = 30 * 24 * 3_600_000;
/** A panel sign-in link or session that ran out this long ago is of no use to anyone. */
export const PANEL_RETENTION_MS = 24 * 3_600_000;
export const MAINTENANCE_INTERVAL_MS = 3_600_000;

const system = systemActor('worker maintenance');

export function maintenanceDue(lastRunAt: Date | null, now: Date): boolean {
  return lastRunAt === null || now.getTime() - lastRunAt.getTime() >= MAINTENANCE_INTERVAL_MS;
}

export interface MaintenanceResult {
  readonly updatesPruned: number;
  readonly conversationsPurged: number;
  readonly attemptsPruned: number;
  readonly invitationsPruned: number;
  readonly panelPruned: number;
}

/**
 * Housekeeping that must happen but is never urgent: forget update ids Telegram will not resend,
 * conversations nobody came back to, old failed invitation attempts, invitations that died
 * unused, and the panel's spent sign-in links and sessions. Used invitations stay: they are the record of how a connection began.
 * Safe to run at any time and as often as you like.
 */
export async function runMaintenance(options: {
  readonly orm: Executor;
  readonly repositoryDeps: RepositoryDeps;
  readonly now: Date;
  readonly logger: Logger;
}): Promise<MaintenanceResult> {
  const { telegram, invitations, panel } = createRepositories(options.orm, options.repositoryDeps);
  const at = options.now.getTime();

  const updatesPruned = await telegram.pruneUpdates(new Date(at - UPDATE_RETENTION_MS));
  const conversationsPurged = await telegram.purgeExpiredConversations(options.now);
  const pruned = await invitations.prune(system, {
    attemptsBefore: new Date(at - ATTEMPT_RETENTION_MS),
    invitationsBefore: new Date(at - DEAD_INVITATION_RETENTION_MS),
  });

  const panelPruned = await panel.prune(system, new Date(at - PANEL_RETENTION_MS));

  const result = {
    updatesPruned,
    conversationsPurged,
    attemptsPruned: pruned.attempts,
    invitationsPruned: pruned.invitations,
    panelPruned,
  };
  if (Object.values(result).some((count) => count > 0)) {
    options.logger.info(result, 'maintenance done');
  }
  return result;
}

/** How often courses nobody started in time are closed. Their start is refused at once anyway. */
export const START_WINDOW_SWEEP_INTERVAL_MS = 5 * 60_000;

export function startWindowSweepDue(lastRunAt: Date | null, now: Date): boolean {
  return (
    lastRunAt === null || now.getTime() - lastRunAt.getTime() >= START_WINDOW_SWEEP_INTERVAL_MS
  );
}

/**
 * Courses sent to a patient and not started before their window ran out become
 * EXPIRED_NOT_STARTED. The window itself is enforced when the patient taps "start"; this only
 * makes the stored state say what is already true. Repeats until nothing is left to close.
 */
export async function runStartWindowSweep(options: {
  readonly orm: Executor;
  readonly repositoryDeps: RepositoryDeps;
  readonly now: Date;
  readonly logger: Logger;
}): Promise<number> {
  const { runs } = createRepositories(options.orm, options.repositoryDeps);
  let total = 0;
  for (;;) {
    const closed = await runs.expireUnstarted(system, options.now);
    total += closed;
    if (closed === 0) {
      break;
    }
  }
  if (total > 0) {
    options.logger.info({ coursesExpired: total }, 'start windows closed');
  }
  return total;
}
