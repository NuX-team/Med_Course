import { describe, expect, it } from 'vitest';
import { ADHERENCE_FORMULA, summarizeAdherence, summarizeAdherenceByMedication } from './adherence';
import { DOSE_STATUSES, type DoseStatus } from './types';

const doses = (...statuses: DoseStatus[]) => statuses.map((status) => ({ status }));

describe('summarizeAdherence', () => {
  it('is taken over everything that has happened, times a hundred', () => {
    expect(summarizeAdherence(doses('TAKEN', 'TAKEN', 'TAKEN', 'MISSED'))).toEqual({
      taken: 3,
      takenLate: 0,
      skipped: 0,
      missed: 1,
      occurred: 4,
      ratio: 0.75,
      percent: 75,
    });
  });

  it('counts a skipped dose and a missed dose against the patient, a late one too', () => {
    const result = summarizeAdherence(doses('TAKEN', 'SKIPPED', 'MISSED', 'TAKEN_LATE'));
    expect(result).toMatchObject({
      taken: 1,
      skipped: 1,
      missed: 1,
      takenLate: 1,
      occurred: 4,
      percent: 25,
    });
  });

  it('shows late confirmations on their own and keeps them out of the numerator', () => {
    const result = summarizeAdherence(doses('TAKEN_LATE', 'TAKEN_LATE'));
    expect(result).toMatchObject({ taken: 0, takenLate: 2, occurred: 2, ratio: 0, percent: 0 });
  });

  it('leaves out doses with no outcome yet and doses that were replaced', () => {
    const result = summarizeAdherence(
      doses('TAKEN', 'SCHEDULED', 'NOTIFIED', 'SNOOZED', 'SUPERSEDED', 'SUPERSEDED'),
    );
    expect(result).toMatchObject({ taken: 1, occurred: 1, ratio: 1, percent: 100 });
  });

  it('says nothing, rather than 0% or 100%, before anything has happened', () => {
    expect(summarizeAdherence([])).toMatchObject({ occurred: 0, ratio: null, percent: null });
    expect(summarizeAdherence(doses('SCHEDULED', 'NOTIFIED'))).toMatchObject({
      occurred: 0,
      ratio: null,
      percent: null,
    });
  });

  it('rounds the percentage to one decimal place', () => {
    expect(summarizeAdherence(doses('TAKEN', 'MISSED', 'MISSED')).percent).toBe(33.3);
    expect(summarizeAdherence(doses('TAKEN', 'TAKEN', 'MISSED')).percent).toBe(66.7);
    expect(
      summarizeAdherence(
        doses('TAKEN', 'TAKEN', 'TAKEN', 'TAKEN', 'TAKEN', 'TAKEN', 'TAKEN', 'MISSED'),
      ).percent,
    ).toBe(87.5);
  });

  it('counts every status exactly once', () => {
    const everyStatus = DOSE_STATUSES.map((status) => ({ status }));
    const result = summarizeAdherence(everyStatus);
    expect(result.taken + result.takenLate + result.skipped + result.missed).toBe(result.occurred);
    expect(result.occurred).toBe(4);
  });

  it('names its formula so every report can print it', () => {
    expect(ADHERENCE_FORMULA).toBe('TAKEN / (TAKEN + TAKEN_LATE + SKIPPED + MISSED) × 100');
  });
});

describe('summarizeAdherenceByMedication', () => {
  it('breaks the figures down per drug and keeps the overall one', () => {
    const result = summarizeAdherenceByMedication([
      { medicationLineId: 'a', status: 'TAKEN' },
      { medicationLineId: 'a', status: 'TAKEN' },
      { medicationLineId: 'b', status: 'MISSED' },
      { medicationLineId: 'b', status: 'TAKEN' },
      { medicationLineId: 'b', status: 'SCHEDULED' },
    ]);

    expect(result.overall).toMatchObject({ taken: 3, missed: 1, occurred: 4, percent: 75 });
    expect(result.byMedication.a).toMatchObject({ occurred: 2, percent: 100 });
    expect(result.byMedication.b).toMatchObject({ occurred: 2, percent: 50 });
    expect(Object.keys(result.byMedication).sort()).toEqual(['a', 'b']);
  });

  it('handles no doses at all', () => {
    expect(summarizeAdherenceByMedication([])).toEqual({
      overall: summarizeAdherence([]),
      byMedication: {},
    });
  });
});
