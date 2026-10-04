import { RUN_REPORT_LIMIT, type DueAlert } from '@medcourse/db';
import { t } from '@medcourse/i18n';
import { describe, expect, it } from 'vitest';
import { alertMessage } from './alert';

const COURSE = '3f2b8c1e-9d4a-4b6e-8a1f-0c5d7e9a2b31';

const base: DueAlert = {
  alertId: 'a',
  kind: 'MISSED',
  tries: 0,
  dueAt: new Date('2026-10-03T03:30:00Z'),
  courseId: COURSE,
  courseStatus: 'ACTIVE',
  timezone: 'Asia/Tashkent',
  patient: { firstName: 'Aziza', lastName: 'Karimova' },
  recipient: { telegramUserId: 1, locale: 'ru', entitled: true },
  slotAt: new Date('2026-10-03T03:00:00Z'),
  doses: [
    {
      scheduledAt: new Date('2026-10-03T03:00:00Z'),
      status: 'MISSED',
      displayName: 'Testamol',
      doseValue: '500.000',
      doseDisplay: null,
      doseUnit: 'MG',
      foodRule: 'AFTER_MEAL',
      skipReason: null,
    },
    {
      scheduledAt: new Date('2026-10-03T03:00:00Z'),
      status: 'MISSED',
      displayName: 'Secondol',
      doseValue: '0.500',
      doseDisplay: '1/2',
      doseUnit: 'TABLET',
      foodRule: 'ANY',
      skipReason: null,
    },
  ],
  run: 0,
  runSince: null,
  prn: null,
};
const patient = 'Aziza Karimova';

describe('what a doctor reads', () => {
  it('about a missed moment: the patient, the time on the patient’s clock, each drug', () => {
    expect(alertMessage('ru', base).text).toBe(
      [
        t('ru', 'alert.missed', { patient, time: '03.10.2026 08:00' }),
        '• Testamol — 500 мг, после еды',
        `• Secondol — 1/2 табл., ${t('ru', 'food.ANY')}`,
      ].join('\n'),
    );
  });

  it('about a skip: the reason as the patient chose it', () => {
    const [dose] = base.doses;
    const alert: DueAlert = {
      ...base,
      kind: 'SKIPPED',
      slotAt: null,
      doses:
        dose === undefined ? [] : [{ ...dose, status: 'SKIPPED', skipReason: 'NO_MEDICATION' }],
    };
    expect(alertMessage('ru', alert).text).toBe(
      [
        t('ru', 'alert.skipped', {
          patient,
          time: '03.10.2026 08:00',
          reason: t('ru', 'dose.reason.NO_MEDICATION'),
        }),
        '• Testamol — 500 мг, после еды',
      ].join('\n'),
    );
  });

  it('about a run: how many in a row and since when', () => {
    const since = new Date('2026-10-02T15:00:00Z');
    expect(
      alertMessage('ru', { ...base, kind: 'SERIES', doses: [], run: 3, runSince: since }).text,
    ).toBe(t('ru', 'alert.series', { patient, run: '3', since: '02.10.2026 20:00' }));
    expect(
      alertMessage('ru', { ...base, kind: 'DIGEST', doses: [], run: 9, runSince: since }).text,
    ).toBe(t('ru', 'alert.digest', { patient, run: '9', since: '02.10.2026 20:00' }));
  });

  it('never claims to know a run longer than it measured', () => {
    const text = alertMessage('ru', {
      ...base,
      kind: 'DIGEST',
      doses: [],
      run: RUN_REPORT_LIMIT,
      runSince: base.slotAt,
    }).text;
    expect(text).toContain(`${String(RUN_REPORT_LIMIT)}+`);
  });

  it('about an undelivered reminder, a request for a pause, and an as-needed intake beyond the limits', () => {
    expect(alertMessage('ru', { ...base, kind: 'UNDELIVERED', doses: [] }).text).toBe(
      t('ru', 'alert.undelivered', { patient }),
    );
    expect(alertMessage('ru', { ...base, kind: 'PAUSE_REQUEST', doses: [] }).text).toBe(
      t('ru', 'alert.pauseRequest', { patient }),
    );
    expect(
      alertMessage('ru', {
        ...base,
        kind: 'PRN_OVER',
        doses: [],
        prn: {
          displayName: 'Painaway',
          maxDailyDoses: 3,
          minimumIntervalMinutes: 90,
          takenInDay: 4,
          stillOver: true,
        },
      }).text,
    ).toBe(
      t('ru', 'alert.prnOver', {
        patient,
        name: 'Painaway',
        max: 3,
        interval: t('ru', 'cw.minutes', { n: 90 }),
        count: 4,
      }),
    );
  });

  it('is written in the doctor’s language', () => {
    const text = alertMessage('uz', base).text;
    expect(text).toContain(t('uz', 'alert.missed', { patient, time: '03.10.2026 08:00' }));
    expect(text).toContain(`Testamol — 500 ${t('uz', 'unit.MG')}, ${t('uz', 'food.AFTER_MEAL')}`);
  });

  it('always comes with the way to the course and to its history', () => {
    for (const kind of ['MISSED', 'SERIES', 'UNDELIVERED', 'PAUSE_REQUEST'] as const) {
      const { buttons } = alertMessage('ru', { ...base, kind, run: 3, runSince: base.slotAt });
      expect(buttons.flat().map((button) => button.data)).toEqual([`kv:${COURSE}`, `hr:${COURSE}`]);
      for (const button of buttons.flat()) {
        expect(Buffer.byteLength(button.data)).toBeLessThanOrEqual(64);
      }
    }
  });
});
