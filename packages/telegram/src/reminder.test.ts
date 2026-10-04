import { t } from '@medcourse/i18n';
import { describe, expect, it } from 'vitest';
import { decodeCallback } from './callbacks';
import { reminderMessage, type ReminderContent } from './reminder';

const DOSE_ID = '3f2b8c1e-9d4a-4b6e-8a1f-0c5d7e9a2b31';

/** 08:00 in Tashkent, deadline 08:30. */
const base: ReminderContent = {
  kind: 'DOSE_REMINDER',
  attemptNo: 1,
  doseId: DOSE_ID,
  scheduledAt: new Date('2026-10-03T03:00:00Z'),
  deadlineAt: new Date('2026-10-03T03:30:00Z'),
  timezone: 'Asia/Tashkent',
  medication: {
    displayName: 'Amoxicillin',
    doseValue: '500.000',
    doseDisplay: null,
    doseUnit: 'MG',
    foodRule: 'AFTER_MEAL',
    instructions: null,
  },
  snoozeOptions: [5, 10, 15],
};

describe('a reminder', () => {
  it('says what to take, how much, when by the patient’s clock, and until when it is on time', () => {
    const { text } = reminderMessage('ru', base);
    expect(text).toBe(
      [
        t('ru', 'reminder.title'),
        'Amoxicillin — 500 мг, после еды',
        t('ru', 'reminder.time', { time: '08:00' }),
        '',
        t('ru', 'reminder.until', { time: '08:30' }),
      ].join('\n'),
    );
  });

  it('carries the three answers, each naming this very dose', () => {
    const { buttons } = reminderMessage('ru', base);
    expect(buttons?.map((row) => row.map((button) => button.text))).toEqual([
      [t('ru', 'dose.take')],
      [5, 10, 15].map((n) => t('ru', 'dose.later', { n })),
      [t('ru', 'dose.skip')],
    ]);
    expect(buttons?.flat().map((button) => decodeCallback(button.data))).toEqual([
      { kind: 'dose', action: 'take', doseId: DOSE_ID },
      { kind: 'doseSnooze', doseId: DOSE_ID, minutes: 5 },
      { kind: 'doseSnooze', doseId: DOSE_ID, minutes: 10 },
      { kind: 'doseSnooze', doseId: DOSE_ID, minutes: 15 },
      { kind: 'dose', action: 'skipAsk', doseId: DOSE_ID },
    ]);
    for (const button of buttons?.flat() ?? []) {
      expect(Buffer.byteLength(button.data)).toBeLessThanOrEqual(64);
    }
  });

  it('offers only the "later" choices it was given, and none when there are none', () => {
    const some = reminderMessage('ru', { ...base, snoozeOptions: [5] });
    expect(some.buttons?.[1]?.map((button) => button.text)).toEqual([
      t('ru', 'dose.later', { n: 5 }),
    ]);
    const none = reminderMessage('ru', { ...base, snoozeOptions: [] });
    expect(none.buttons?.map((row) => row.length)).toEqual([1, 1]);
  });

  it('is worded as a repeat from the second attempt on', () => {
    expect(reminderMessage('ru', { ...base, attemptNo: 2 }).text).toContain(
      t('ru', 'reminder.again'),
    );
    expect(reminderMessage('ru', { ...base, attemptNo: 4 }).text).not.toContain(
      t('ru', 'reminder.title'),
    );
  });

  it('includes the doctor’s instruction and the doctor’s own wording of the dose', () => {
    const { text } = reminderMessage('ru', {
      ...base,
      medication: {
        ...base.medication,
        doseValue: '0.500',
        doseDisplay: '1/2',
        doseUnit: 'TABLET',
        instructions: 'Запивать водой',
      },
    });
    expect(text).toContain('Amoxicillin — 1/2 табл., после еды');
    expect(text).toContain(t('ru', 'card.note', { text: 'Запивать водой' }));
  });

  it('speaks the patient’s language and uses the course’s time zone', () => {
    const { text, buttons } = reminderMessage('uz', { ...base, timezone: 'Europe/Moscow' });
    expect(text).toContain(t('uz', 'reminder.title'));
    expect(text).toContain('Amoxicillin — 500 mg, ovqatdan keyin');
    expect(text).toContain(t('uz', 'reminder.time', { time: '06:00' }));
    expect(buttons?.[0]?.[0]?.text).toBe(t('uz', 'dose.take'));
  });

  it('never carries anything but plain text, whatever the doctor typed', () => {
    const { text } = reminderMessage('ru', {
      ...base,
      medication: { ...base.medication, displayName: '<b>Bold</b> *star* _under_ [link](x)' },
    });
    expect(text).toContain('<b>Bold</b> *star* _under_ [link](x) — 500 мг');
  });

  it('as a heads-up before the dose has no buttons and no deadline', () => {
    const { text, buttons } = reminderMessage('ru', { ...base, kind: 'DOSE_LEAD' });
    expect(buttons).toBeUndefined();
    expect(text).toBe(
      [
        t('ru', 'reminder.lead'),
        'Amoxicillin — 500 мг, после еды',
        t('ru', 'reminder.time', { time: '08:00' }),
      ].join('\n'),
    );
  });
});
