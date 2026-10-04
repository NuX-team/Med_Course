import type { CourseExport, ExportEntry } from '@medcourse/db';

/**
 * A course's export made by hand, for tests of how a report reads. Tashkent time (UTC+5).
 * "Амоксициллин" twice a day and "Vitamin D₃" once, started 3 October 2026; the vitamin was
 * taken off the plan later, and "Парацетамол" is taken as needed. Five days are on record:
 * eleven scheduled doses and two as-needed marks.
 */

const at = (day: number, time: string): Date => {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, day, (hours ?? 0) - 5, minutes ?? 0));
};

const AMOX = '11111111-1111-4111-8111-111111111111';
const VITAMIN = '22222222-2222-4222-8222-222222222222';
const PARACETAMOL = '33333333-3333-4333-8333-333333333333';

const amox = {
  lineId: AMOX,
  displayName: 'Амоксициллин',
  doseValue: '500.000',
  doseDisplay: null,
  doseUnit: 'MG',
} as const;
const vitamin = {
  lineId: VITAMIN,
  displayName: 'Vitamin D₃',
  doseValue: '0.500',
  doseDisplay: '1/2',
  doseUnit: 'TABLET',
} as const;
const paracetamol = {
  lineId: PARACETAMOL,
  displayName: 'Парацетамол',
  doseValue: '1.000',
  doseDisplay: null,
  doseUnit: 'TABLET',
} as const;

const scheduled = (
  drug: typeof amox | typeof vitamin,
  due: Date,
  status: NonNullable<ExportEntry['status']>,
  extra: Partial<ExportEntry> = {},
): ExportEntry => ({
  ...drug,
  at: due,
  status,
  skipReason: null,
  answeredAt: null,
  skipText: null,
  ...extra,
});

export const SAMPLE_ENTRIES: readonly ExportEntry[] = [
  scheduled(amox, at(3, '08:00'), 'TAKEN', { answeredAt: at(3, '08:04') }),
  scheduled(vitamin, at(3, '09:00'), 'TAKEN', { answeredAt: at(3, '08:40') }),
  scheduled(amox, at(3, '20:00'), 'MISSED'),
  scheduled(amox, at(4, '08:00'), 'TAKEN_LATE', { answeredAt: at(4, '09:15') }),
  scheduled(vitamin, at(4, '09:00'), 'SKIPPED', {
    answeredAt: at(4, '09:02'),
    skipReason: 'NO_MEDICATION',
  }),
  {
    ...paracetamol,
    at: at(4, '13:30'),
    status: null,
    skipReason: null,
    answeredAt: at(4, '13:30'),
    skipText: null,
  },
  scheduled(amox, at(4, '20:00'), 'TAKEN', { answeredAt: at(4, '20:10') }),
  scheduled(amox, at(5, '08:00'), 'SKIPPED', {
    answeredAt: at(5, '08:01'),
    skipReason: 'OTHER',
    skipText: 'Тошнило с утра; решила подождать до вечера',
  }),
  scheduled(amox, at(5, '20:00'), 'TAKEN', { answeredAt: at(6, '00:10') }),
  {
    ...paracetamol,
    at: at(5, '22:15'),
    status: null,
    skipReason: null,
    answeredAt: at(5, '22:15'),
    skipText: null,
  },
  scheduled(amox, at(7, '08:00'), 'TAKEN', { answeredAt: at(7, '08:00') }),
  scheduled(amox, at(7, '20:00'), 'TAKEN', { answeredAt: at(7, '20:20') }),
  // Its time has come and the patient has not answered yet: listed, and not counted.
  scheduled(amox, at(8, '08:00'), 'NOTIFIED'),
];

const adherence = (taken: number, takenLate: number, skipped: number, missed: number) => {
  const occurred = taken + takenLate + skipped + missed;
  return {
    taken,
    takenLate,
    skipped,
    missed,
    occurred,
    ratio: occurred === 0 ? null : taken / occurred,
    percent: occurred === 0 ? null : Math.round((taken / occurred) * 1000) / 10,
  };
};

export const SAMPLE_EXPORT = {
  exportId: '44444444-4444-4444-8444-444444444444',
  format: 'PDF',
  requestedAt: at(8, '08:10'),
  entries: SAMPLE_ENTRIES,
  report: {
    plan: {
      course: {
        id: '55555555-5555-4555-8555-555555555555',
        status: 'ACTIVE',
        durationDays: 7,
        timezone: 'Asia/Tashkent',
        effectiveStartDate: '2026-10-03',
      },
      patient: { firstName: 'Азиза', lastName: 'Каримова' },
      clinician: { firstName: 'Rustam', lastName: 'Gʻulomov' },
      // The vitamin was taken off the plan: it is in the report, and no longer in the plan.
      medications: [
        { ...amox, prn: false },
        { ...paracetamol, prn: true },
      ],
      // A whole day on hold (6 October), so the course ends a day later.
      pauses: [{ from: at(5, '23:00'), to: at(7, '06:00') }],
      change: null,
    },
    adherence: adherence(6, 1, 2, 1),
    byMedication: [
      { lineId: AMOX, displayName: 'Амоксициллин', adherence: adherence(5, 1, 1, 1) },
      { lineId: VITAMIN, displayName: 'Vitamin D₃', adherence: adherence(1, 0, 1, 0) },
    ],
    prn: [{ displayName: 'Парацетамол', count: 2 }],
    skipReasons: { FORGOT: 0, NO_MEDICATION: 1, OTHER: 1 },
    otherReasons: [],
  },
} as unknown as CourseExport;
