import { describe, expect, it } from 'vitest';
import { planPause, planRetire, planRevisionSwitch, type ExistingDose } from './revisions';
import type { Slot } from './slots';
import { at } from './test-helpers';
import { DOSE_STATUSES, isUnresolved, type DoseStatus } from './types';

const NOW = at('2026-10-02T10:00:00.000Z');
const HALF_HOUR = 30 * 60_000;

/** A dose with the default deadline: half an hour after its time. */
const dose = (id: string, scheduledAt: string, status: DoseStatus): ExistingDose => ({
  id,
  scheduledAt: at(scheduledAt),
  deadlineAt: new Date(at(scheduledAt).getTime() + HALF_HOUR),
  status,
});

const slot = (ruleId: string, scheduledAt: string): Slot => ({
  medicationId: 'a',
  medicationLineId: 'line-a',
  ruleId,
  scheduledAt: at(scheduledAt),
  courseDay: 1,
  localDate: '2026-10-02',
});

describe('which statuses are still open', () => {
  it('are exactly the ones before an outcome exists', () => {
    expect(DOSE_STATUSES.filter((status) => isUnresolved(status))).toEqual([
      'SCHEDULED',
      'NOTIFIED',
      'SNOOZED',
    ]);
  });
});

describe('planRetire: the cut made by a pause, a cancellation and a change of plan', () => {
  const existing: ExistingDose[] = [
    dose('answered', '2026-10-01T03:00:00Z', 'TAKEN'),
    dose('missed', '2026-10-02T03:00:00Z', 'MISSED'),
    dose('overdue-unswept', '2026-10-02T09:00:00Z', 'NOTIFIED'),
    dose('deadline-now', '2026-10-02T09:30:00Z', 'NOTIFIED'),
    dose('reminding', '2026-10-02T09:50:00Z', 'NOTIFIED'),
    dose('snoozed', '2026-10-02T09:55:00Z', 'SNOOZED'),
    dose('due-now', '2026-10-02T10:00:00Z', 'SCHEDULED'),
    dose('tomorrow', '2026-10-03T03:00:00Z', 'SCHEDULED'),
    dose('in-two-days', '2026-10-04T03:00:00Z', 'SCHEDULED'),
    dose('already-gone', '2026-10-05T03:00:00Z', 'SUPERSEDED'),
    dose('answered-early', '2026-10-06T03:00:00Z', 'TAKEN'),
  ];

  it('supersedes every open dose whose deadline is ahead, oldest first, whatever order they come in', () => {
    const plan = planRetire({ existing: [...existing].reverse(), now: NOW });
    expect(plan.supersede).toEqual(['reminding', 'snoozed', 'due-now', 'tomorrow', 'in-two-days']);
  });

  it('includes the dose being reminded right now: nothing of a stopped plan is asked again', () => {
    expect(planRetire({ existing, now: NOW }).supersede).toContain('reminding');
  });

  it('turns an open dose past its deadline into a miss instead, the deadline itself included', () => {
    expect(planRetire({ existing, now: NOW }).miss).toEqual(['overdue-unswept', 'deadline-now']);
  });

  it('never touches a dose that has an outcome, in the past or in the future', () => {
    const plan = planRetire({ existing, now: NOW });
    for (const untouched of ['answered', 'missed', 'already-gone', 'answered-early']) {
      expect([...plan.supersede, ...plan.miss]).not.toContain(untouched);
    }
  });

  it('puts each open dose on exactly one side, whatever its status and time', () => {
    for (const status of DOSE_STATUSES) {
      for (const when of [
        '2026-10-01T03:00:00Z',
        '2026-10-02T09:30:00Z',
        '2026-10-02T09:30:00.001Z',
        '2026-10-02T10:00:00Z',
        '2026-10-03T03:00:00Z',
      ]) {
        const one = dose('x', when, status);
        const plan = planRetire({ existing: [one], now: NOW });
        const label = `${status} at ${when}`;
        expect(plan.supersede.length + plan.miss.length, label).toBe(isUnresolved(status) ? 1 : 0);
        if (isUnresolved(status)) {
          expect(plan.miss.length === 1, label).toBe(one.deadlineAt <= NOW);
        }
      }
    }
  });

  it('does nothing when nothing is open', () => {
    expect(
      planRetire({ existing: [dose('answered', '2026-10-01T03:00:00Z', 'TAKEN')], now: NOW }),
    ).toEqual({ supersede: [], miss: [] });
  });
});

describe('planRevisionSwitch (ARCHITECTURE §5.4)', () => {
  it('creates only the new slots after now', () => {
    const newSlots = [
      slot('past', '2026-10-01T03:00:00Z'),
      slot('earlier-today', '2026-10-02T03:00:00Z'),
      slot('exactly-now', '2026-10-02T10:00:00.000Z'),
      slot('just-after', '2026-10-02T10:00:00.001Z'),
      slot('tomorrow', '2026-10-03T03:00:00Z'),
    ];
    const plan = planRevisionSwitch({ existing: [], newSlots, now: NOW });
    expect(plan.create.map((created) => created.ruleId)).toEqual(['just-after', 'tomorrow']);
  });

  it('retires the old plan by the same cut', () => {
    const existing = [
      dose('overdue', '2026-10-02T09:00:00Z', 'NOTIFIED'),
      dose('reminding', '2026-10-02T09:50:00Z', 'NOTIFIED'),
      dose('tomorrow', '2026-10-03T03:00:00Z', 'SCHEDULED'),
    ];
    const plan = planRevisionSwitch({ existing, newSlots: [], now: NOW });
    expect(plan).toEqual({ supersede: ['reminding', 'tomorrow'], miss: ['overdue'], create: [] });
  });

  it('does not fill the past in: a dose superseded at exactly now is not recreated', () => {
    const plan = planRevisionSwitch({
      existing: [dose('due-now', '2026-10-02T10:00:00.000Z', 'SCHEDULED')],
      newSlots: [slot('exactly-now', '2026-10-02T10:00:00.000Z')],
      now: NOW,
    });
    expect(plan.supersede).toEqual(['due-now']);
    expect(plan.create).toEqual([]);
  });

  it('recreates a slot that is identical in the new plan, since a superseded slot is free again', () => {
    const plan = planRevisionSwitch({
      existing: [dose('tomorrow', '2026-10-03T03:00:00Z', 'SCHEDULED')],
      newSlots: [slot('same-time', '2026-10-03T03:00:00Z')],
      now: NOW,
    });
    expect(plan.supersede).toEqual(['tomorrow']);
    expect(plan.create).toHaveLength(1);
  });

  it('does nothing when nothing changes in the future', () => {
    expect(
      planRevisionSwitch({
        existing: [dose('answered', '2026-10-01T03:00:00Z', 'TAKEN')],
        newSlots: [],
        now: NOW,
      }),
    ).toEqual({ supersede: [], miss: [], create: [] });
  });
});

describe('planPause', () => {
  it('makes the same cut and creates nothing', () => {
    const existing = [
      dose('past', '2026-10-01T03:00:00Z', 'MISSED'),
      dose('overdue', '2026-10-02T09:10:00Z', 'NOTIFIED'),
      dose('reminding', '2026-10-02T09:55:00Z', 'NOTIFIED'),
      dose('later-today', '2026-10-02T15:00:00Z', 'SCHEDULED'),
      dose('tomorrow', '2026-10-03T03:00:00Z', 'SCHEDULED'),
    ];
    expect(planPause({ existing, now: NOW })).toEqual({
      supersede: ['reminding', 'later-today', 'tomorrow'],
      miss: ['overdue'],
    });
  });
});
