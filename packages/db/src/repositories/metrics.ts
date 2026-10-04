import type { Actor } from '../access/actor';
import { ForbiddenError } from '../access/errors';
import type { Executor } from '../orm';
import { collectStats, openIncidents, type OpenIncidents, type TechStats } from './stats';

/** What the metrics page reports: the technical panel's numbers, and the incidents still open. */
export interface MetricsSnapshot extends TechStats {
  readonly incidentsOpen: OpenIncidents;
}

/**
 * The numbers behind the metrics page (ARCHITECTURE §12). Read by the worker for whoever holds
 * the page's token, so the only actor is the system; what is returned is counts, ages and codes.
 */
export function createMetricsRepository(db: Executor) {
  return {
    async snapshot(actor: Actor, now: Date): Promise<MetricsSnapshot> {
      if (actor.kind !== 'SYSTEM') {
        throw new ForbiddenError('only the system reads the metrics');
      }
      return db.transaction(async (tx) => ({
        ...(await collectStats(tx, now)),
        incidentsOpen: await openIncidents(tx),
      }));
    },
  };
}

export type MetricsRepository = ReturnType<typeof createMetricsRepository>;
