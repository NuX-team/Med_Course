import type { DoseStatus } from './types';

/**
 * Printed on every report (ARCHITECTURE §11, TZ §14.3). This is how well the schedule was
 * followed, not how well the treatment worked, and must never be called that.
 */
export const ADHERENCE_FORMULA = 'TAKEN / (TAKEN + TAKEN_LATE + SKIPPED + MISSED) × 100';

export interface Adherence {
  readonly taken: number;
  /** Confirmed after the deadline. Shown on its own and NOT counted as taken on time. */
  readonly takenLate: number;
  readonly skipped: number;
  readonly missed: number;
  /** Doses whose outcome is decided: taken, taken late, skipped, missed. */
  readonly occurred: number;
  /** `taken / occurred`, or null when nothing has occurred yet. */
  readonly ratio: number | null;
  /** The ratio as a percentage with one decimal, or null. */
  readonly percent: number | null;
}

export interface AdherenceDose {
  readonly status: DoseStatus;
}

/**
 * Scheduled doses only: as-needed (PRN) intake has no slot and is not passed in. Superseded
 * slots (a replaced plan, a pause) never happened as far as adherence goes, and neither do
 * doses still waiting for an answer, so none of them enter the denominator.
 */
export function summarizeAdherence(doses: readonly AdherenceDose[]): Adherence {
  let taken = 0;
  let takenLate = 0;
  let skipped = 0;
  let missed = 0;

  for (const { status } of doses) {
    if (status === 'TAKEN') taken += 1;
    else if (status === 'TAKEN_LATE') takenLate += 1;
    else if (status === 'SKIPPED') skipped += 1;
    else if (status === 'MISSED') missed += 1;
  }

  const occurred = taken + takenLate + skipped + missed;
  const ratio = occurred === 0 ? null : taken / occurred;
  return {
    taken,
    takenLate,
    skipped,
    missed,
    occurred,
    ratio,
    percent: ratio === null ? null : Math.round(ratio * 1000) / 10,
  };
}

/** The same summary per medication line, plus the overall figure. */
export function summarizeAdherenceByMedication(
  doses: readonly (AdherenceDose & { readonly medicationLineId: string })[],
): { readonly overall: Adherence; readonly byMedication: Readonly<Record<string, Adherence>> } {
  const groups = new Map<string, AdherenceDose[]>();
  for (const dose of doses) {
    const group = groups.get(dose.medicationLineId) ?? [];
    group.push(dose);
    groups.set(dose.medicationLineId, group);
  }

  return {
    overall: summarizeAdherence(doses),
    byMedication: Object.fromEntries(
      [...groups].map(([lineId, group]) => [lineId, summarizeAdherence(group)]),
    ),
  };
}
