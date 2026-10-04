import { describe, expect, it } from 'vitest';
import { generateSlots } from './slots';
import { previewStart, startWindowState } from './start';
import { at } from './test-helpers';
import type { MedicationInput } from './types';

const TASHKENT = 'Asia/Tashkent';

const twiceDaily: MedicationInput = {
  id: 'a',
  lineId: 'line-a',
  prn: false,
  activeFromDay: 1,
  activeToDay: 7,
  rules: [
    { id: 'morning', localTime: '08:00' },
    { id: 'evening', localTime: '20:00' },
  ],
};

const preview = (now: string, medications: readonly MedicationInput[] = [twiceDaily]) =>
  previewStart({ now: at(now), timezone: TASHKENT, durationDays: 7, medications });

describe('startWindowState (D-5)', () => {
  const window = { from: at('2026-10-05T00:00:00Z'), to: at('2026-10-07T00:00:00Z') };

  it('has no opinion without a window', () => {
    expect(startWindowState(at('2026-10-01T00:00:00Z'), null)).toBe('NO_WINDOW');
  });

  it('is before, within or after, with both ends inclusive', () => {
    expect(startWindowState(at('2026-10-04T23:59:59.999Z'), window)).toBe('BEFORE');
    expect(startWindowState(at('2026-10-05T00:00:00.000Z'), window)).toBe('WITHIN');
    expect(startWindowState(at('2026-10-06T00:00:00.000Z'), window)).toBe('WITHIN');
    expect(startWindowState(at('2026-10-07T00:00:00.000Z'), window)).toBe('WITHIN');
    expect(startWindowState(at('2026-10-07T00:00:00.001Z'), window)).toBe('AFTER');
  });

  it('accepts a window that is a single moment', () => {
    const moment = { from: at('2026-10-05T00:00:00Z'), to: at('2026-10-05T00:00:00Z') };
    expect(startWindowState(at('2026-10-05T00:00:00Z'), moment)).toBe('WITHIN');
    expect(startWindowState(at('2026-10-05T00:00:00.001Z'), moment)).toBe('AFTER');
  });
});

describe('previewStart: what the second confirmation step shows (D-7)', () => {
  it('counts both of today’s doses when starting before the first', () => {
    expect(preview('2026-10-02T02:00:00Z')).toEqual({
      effectiveStartDate: '2026-10-02',
      lastDay: '2026-10-08',
      slotsToday: 2,
      slotsTotal: 14,
      firstSlotAt: at('2026-10-02T03:00:00Z'),
    });
  });

  it('counts only what is still to come', () => {
    const afterMorning = preview('2026-10-02T04:00:00Z');
    expect(afterMorning).toMatchObject({ slotsToday: 1, slotsTotal: 13 });
    expect(afterMorning.firstSlotAt).toEqual(at('2026-10-02T15:00:00Z'));
  });

  it('does not count a dose due at the very moment of the tap', () => {
    expect(preview('2026-10-02T03:00:00.000Z')).toMatchObject({ slotsToday: 1, slotsTotal: 13 });
    expect(preview('2026-10-02T02:59:59.999Z')).toMatchObject({ slotsToday: 2, slotsTotal: 14 });
  });

  it('shows day 1 passing without a single reminder when the tap comes at 23:50', () => {
    const late = preview('2026-10-02T18:50:00Z'); // 23:50 in Tashkent
    expect(late).toMatchObject({
      effectiveStartDate: '2026-10-02',
      slotsToday: 0,
      slotsTotal: 12,
      lastDay: '2026-10-08',
    });
    expect(late.firstSlotAt).toEqual(at('2026-10-03T03:00:00Z'));
  });

  it('uses the patient’s calendar date, not UTC’s', () => {
    // 20:00 UTC on 2 October is already 01:00 on 3 October in Tashkent.
    expect(preview('2026-10-02T20:00:00Z')).toMatchObject({
      effectiveStartDate: '2026-10-03',
      lastDay: '2026-10-09',
      slotsToday: 2,
      slotsTotal: 14,
    });
  });

  it('describes a course of as-needed drugs only: no doses at all', () => {
    const asNeeded: MedicationInput = {
      ...twiceDaily,
      id: 'p',
      lineId: 'line-p',
      prn: true,
      maxDailyDoses: 3,
      minimumIntervalMinutes: 240,
      rules: [],
    };
    expect(preview('2026-10-02T02:00:00Z', [asNeeded])).toEqual({
      effectiveStartDate: '2026-10-02',
      lastDay: '2026-10-08',
      slotsToday: 0,
      slotsTotal: 0,
      firstSlotAt: null,
    });
  });

  it('is exactly what materialising at the same moment produces', () => {
    for (const now of [
      '2026-10-02T02:00:00Z',
      '2026-10-02T04:00:00Z',
      '2026-10-02T18:50:00Z',
      '2026-10-02T20:00:00Z',
    ]) {
      const shown = preview(now);
      const slots = generateSlots({
        medications: [twiceDaily],
        timeline: {
          effectiveStartDate: shown.effectiveStartDate,
          timezone: TASHKENT,
          durationDays: 7,
        },
        after: at(now),
      });
      expect(shown.slotsTotal, now).toBe(slots.length);
      expect(shown.firstSlotAt, now).toEqual(slots[0]?.scheduledAt ?? null);
      expect(shown.slotsToday, now).toBe(
        slots.filter((slot) => slot.localDate === shown.effectiveStartDate).length,
      );
    }
  });
});
