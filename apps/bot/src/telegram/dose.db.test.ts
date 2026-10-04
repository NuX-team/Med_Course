import { randomBytes } from 'node:crypto';
import {
  createRepositories,
  createRepositoryDeps,
  systemActor,
  type Repositories,
  type RepositoryDeps,
} from '@medcourse/db';
import {
  afterFirstDose,
  createTestDatabase,
  startRunningCourse,
  type RunningCourse,
  type TestDatabase,
} from '@medcourse/db/testing';
import { t } from '@medcourse/i18n';
import { createLogger } from '@medcourse/logger';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// The worker's own code, so that this really is "slot, reminder, answer" end to end.
import { runMissedSweep, runOutbox } from '../../../worker/src/reminders';
import { FakeTelegram, createHarness, type Harness } from './test-harness';

/**
 * A dose from the reminder to the answer. The worker sends through the same fake Telegram the
 * bot answers through, on one real database. The first dose is at 08:00 in Tashkent
 * (`afterFirstDose(0)`), its deadline at 08:30.
 */

let testDatabase: TestDatabase;
let repositoryDeps: RepositoryDeps;
let repos: Repositories;
let telegram: FakeTelegram;
let bot: Harness;
const logger = createLogger({ service: 'dose-test', level: 'silent' });
const system = systemActor('dose test');

const sql = () => testDatabase.db.sql;
const orm = () => testDatabase.db.orm;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  repositoryDeps = createRepositoryDeps([{ id: 't', key: randomBytes(32) }]);
  repos = createRepositories(orm(), repositoryDeps);
});

afterAll(async () => {
  await testDatabase.drop();
});

beforeEach(async () => {
  telegram = new FakeTelegram();
  bot = createHarness({ orm: orm(), repositoryDeps, telegram });
  await sql()`update notifications set status = 'CANCELLED', locked_until = null where status in ('QUEUED', 'SENDING')`;
});

const running = (options: Parameters<typeof startRunningCourse>[2] = {}): Promise<RunningCourse> =>
  startRunningCourse(sql(), repos, options);

/** The worker's outbox round at the given moment. */
const remind = (minutes: number) =>
  runOutbox({
    orm: orm(),
    repositoryDeps,
    api: telegram,
    logger,
    now: () => afterFirstDose(minutes),
  });

/** The patient presses a button at the given moment. */
async function press(
  c: RunningCourse,
  minutes: number,
  data: string,
  messageId?: number,
): Promise<void> {
  bot.clock = afterFirstDose(minutes);
  await bot.press(c.patientTelegramId, data, messageId);
}

const textOf = (c: RunningCourse): string =>
  telegram.lastTo(c.patientTelegramId)?.text ?? '(nothing was sent)';
const dataOf = (c: RunningCourse): string[] =>
  (telegram.lastTo(c.patientTelegramId)?.buttons ?? []).flat().map((button) => button.data);
const sentTo = (c: RunningCourse): number => telegram.messagesTo(c.patientTelegramId).length;

async function doseRow(doseId: string) {
  const [row] = await sql()<
    { status: string; finalized_at: Date | null; missed_at: Date | null }[]
  >`
    select status, finalized_at, missed_at from scheduled_doses where id = ${doseId}`;
  return row;
}

async function eventTypes(doseId: string): Promise<string[]> {
  const rows = await sql()<{ event_type: string }[]>`
    select event_type from dose_events where scheduled_dose_id = ${doseId}
    order by occurred_at, recorded_at`;
  return rows.map((row) => row.event_type);
}

const HEADER = '08:00 — Testamol — 500 мг, после еды';

describe('slot, reminder, answer', () => {
  it('"took it": the reminder turns into the record of the answer, and the repeats never come', async () => {
    const c = await running();
    await remind(0);
    expect(textOf(c)).toContain(t('ru', 'reminder.title'));
    expect(dataOf(c)).toEqual([
      `xt:${c.firstDoseId}`,
      `xs:${c.firstDoseId}:5`,
      `xs:${c.firstDoseId}:10`,
      `xs:${c.firstDoseId}:15`,
      `xk:${c.firstDoseId}`,
    ]);

    await press(c, 3, `xt:${c.firstDoseId}`);

    expect(textOf(c)).toBe(`${HEADER}\n${t('ru', 'dose.state.taken', { time: '08:03' })}`);
    expect(dataOf(c)).toEqual([`xu:${c.firstDoseId}`, 'm:t']);
    expect(await doseRow(c.firstDoseId)).toMatchObject({
      status: 'TAKEN',
      finalized_at: afterFirstDose(3),
    });

    await remind(10);
    await remind(20);
    expect(sentTo(c)).toBe(1);
    expect(await eventTypes(c.firstDoseId)).toEqual(['NOTIFIED', 'TAKEN']);
  });

  it('no answer: three reminders, then a miss; a late "took it" is added to the miss, not instead of it', async () => {
    const c = await running();
    await remind(0);
    await remind(10);
    await remind(20);
    expect(sentTo(c)).toBe(3);

    await runMissedSweep({ orm: orm(), repositoryDeps, now: afterFirstDose(30), logger });
    expect(await doseRow(c.firstDoseId)).toMatchObject({
      status: 'MISSED',
      missed_at: afterFirstDose(30),
    });
    await remind(31);
    expect(sentTo(c)).toBe(3);

    // The old button still works, and says what really happened.
    await press(c, 40, `xt:${c.firstDoseId}`);
    expect(textOf(c)).toBe(`${HEADER}\n${t('ru', 'dose.state.takenLate', { time: '08:40' })}`);
    expect(await doseRow(c.firstDoseId)).toMatchObject({
      status: 'TAKEN_LATE',
      missed_at: afterFirstDose(30),
    });
    expect(await eventTypes(c.firstDoseId)).toEqual([
      'NOTIFIED',
      'NOTIFIED',
      'NOTIFIED',
      'MISSED',
      'LATE_TAKEN',
    ]);
  });

  it('"later": the reminder comes back at the chosen minute, not before, and then it can be answered', async () => {
    const c = await running();
    await remind(0);

    await press(c, 2, `xs:${c.firstDoseId}:10`);
    expect(textOf(c)).toBe(`${HEADER}\n${t('ru', 'dose.state.snoozed', { time: '08:12' })}`);
    expect(dataOf(c)).toEqual([`xt:${c.firstDoseId}`, `xk:${c.firstDoseId}`, 'm:t']);

    await remind(10);
    await remind(11);
    expect(sentTo(c)).toBe(1);
    await remind(12);
    expect(sentTo(c)).toBe(2);
    expect(textOf(c)).toContain(t('ru', 'reminder.again'));
    expect((await doseRow(c.firstDoseId))?.status).toBe('NOTIFIED');

    await press(c, 13, `xt:${c.firstDoseId}`);
    expect((await doseRow(c.firstDoseId))?.status).toBe('TAKEN');
    expect(await eventTypes(c.firstDoseId)).toEqual(['NOTIFIED', 'SNOOZED', 'NOTIFIED', 'TAKEN']);
  });

  it('reaches an Uzbek-speaking patient in Uzbek, start to finish', async () => {
    const c = await running({ locale: 'uz' });
    await remind(0);
    expect(textOf(c)).toContain(t('uz', 'reminder.title'));
    await press(c, 3, `xt:${c.firstDoseId}`);
    expect(textOf(c)).toContain(t('uz', 'dose.state.taken', { time: '08:03' }));
  });
});

describe('skipping', () => {
  it('asks why, and records the reason chosen', async () => {
    const c = await running();
    await remind(0);

    await press(c, 2, `xk:${c.firstDoseId}`);
    expect(textOf(c)).toBe(`${HEADER}\n\n${t('ru', 'dose.skipAsk')}`);
    expect(dataOf(c)).toEqual([
      `xr:${c.firstDoseId}:f`,
      `xr:${c.firstDoseId}:n`,
      `xr:${c.firstDoseId}:o`,
      `xv:${c.firstDoseId}`,
    ]);
    expect((await doseRow(c.firstDoseId))?.status).toBe('NOTIFIED');

    await press(c, 3, `xr:${c.firstDoseId}:n`);
    expect(textOf(c)).toBe(
      `${HEADER}\n${t('ru', 'dose.state.skipped', { reason: t('ru', 'dose.reason.NO_MEDICATION') })}`,
    );
    expect((await doseRow(c.firstDoseId))?.status).toBe('SKIPPED');
    await remind(10);
    expect(sentTo(c)).toBe(1);
  });

  it('lets the patient go back from the question without skipping', async () => {
    const c = await running();
    await remind(0);
    await press(c, 2, `xk:${c.firstDoseId}`);
    await press(c, 2, `xv:${c.firstDoseId}`);
    expect(textOf(c)).toBe(`${HEADER}\n${t('ru', 'dose.state.waiting', { time: '08:30' })}`);
    expect(dataOf(c)).toContain(`xt:${c.firstDoseId}`);
    expect((await doseRow(c.firstDoseId))?.status).toBe('NOTIFIED');
  });

  it('takes the patient’s own words for "another reason", warns about emergencies, and keeps them encrypted', async () => {
    const c = await running();
    await remind(0);
    await press(c, 2, `xk:${c.firstDoseId}`);

    await press(c, 2, `xr:${c.firstDoseId}:o`);
    expect(textOf(c)).toBe(`${HEADER}\n\n${t('ru', 'dose.reasonAsk')}`);
    expect(textOf(c)).toMatch(/экстренн/);
    expect((await doseRow(c.firstDoseId))?.status).toBe('NOTIFIED');

    bot.clock = afterFirstDose(4);
    await bot.say(c.patientTelegramId, 'После прошлой таблетки тошнило');

    expect(textOf(c)).toBe(
      `${HEADER}\n${t('ru', 'dose.state.skipped', { reason: t('ru', 'dose.reason.OTHER') })}`,
    );
    const [event] = await sql()<{ reason_code: string; reason_text_enc: string }[]>`
      select reason_code, reason_text_enc from dose_events
      where scheduled_dose_id = ${c.firstDoseId} and event_type = 'SKIPPED'`;
    expect(event?.reason_code).toBe('OTHER');
    expect(event?.reason_text_enc).not.toContain('тошнило');
    const [seen] = (await repos.doses.listEvents(c.doctor, c.firstDoseId)).filter(
      (entry) => entry.eventType === 'SKIPPED',
    );
    expect(seen?.reasonText).toBe('После прошлой таблетки тошнило');
    const [leaks] = await sql()<{ n: number }[]>`
      select (select count(*) from conversation_states s where s::text like '%тошнило%')::int
           + (select count(*) from audit_log a where a::text like '%тошнило%')::int as n`;
    expect(leaks?.n).toBe(0);
  });

  it('accepts "another reason" without a comment', async () => {
    const c = await running();
    await remind(0);
    await press(c, 2, `xr:${c.firstDoseId}:o`);
    expect(dataOf(c)).toEqual([`xr:${c.firstDoseId}:x`, `xv:${c.firstDoseId}`]);

    await press(c, 3, `xr:${c.firstDoseId}:x`);

    expect((await doseRow(c.firstDoseId))?.status).toBe('SKIPPED');
    const [event] = await sql()<{ reason_code: string; reason_text_enc: string | null }[]>`
      select reason_code, reason_text_enc from dose_events
      where scheduled_dose_id = ${c.firstDoseId} and event_type = 'SKIPPED'`;
    expect(event).toEqual({ reason_code: 'OTHER', reason_text_enc: null });
  });

  it('asks again for words it cannot use, and skips nothing meanwhile', async () => {
    const c = await running();
    await remind(0);
    await press(c, 2, `xr:${c.firstDoseId}:o`);
    bot.clock = afterFirstDose(3);
    for (const bad of ['x'.repeat(301), '12345', `x${String.fromCodePoint(0x202e)}y`]) {
      await bot.say(c.patientTelegramId, bad);
      expect(textOf(c)).toBe(t('ru', 'dose.reasonInvalid'));
    }
    expect((await doseRow(c.firstDoseId))?.status).toBe('NOTIFIED');
  });

  it('forgets the question when the patient goes elsewhere: later text is not taken as a reason', async () => {
    const c = await running();
    await remind(0);
    await press(c, 2, `xr:${c.firstDoseId}:o`);
    bot.clock = afterFirstDose(3);
    await bot.say(c.patientTelegramId, '/menu');
    await bot.say(c.patientTelegramId, 'просто сообщение');

    expect(textOf(c)).toContain(t('ru', 'menu.title'));
    expect((await doseRow(c.firstDoseId))?.status).toBe('NOTIFIED');
  });

  it('is not possible after the deadline: the dose is a miss', async () => {
    const c = await running();
    await remind(0);
    await press(c, 31, `xr:${c.firstDoseId}:f`);

    expect(textOf(c)).toBe(
      `${t('ru', 'dose.tooLate')}\n\n${HEADER}\n${t('ru', 'dose.state.missed')}`,
    );
    expect(dataOf(c)).toEqual([`xt:${c.firstDoseId}`, 'm:t']);
    expect((await doseRow(c.firstDoseId))?.status).toBe('MISSED');
  });
});

describe('answers that change nothing', () => {
  it('a second tap, a tap on an older reminder, two taps at once: one answer', async () => {
    const c = await running();
    await remind(0);
    const first = telegram.lastTo(c.patientTelegramId)?.messageId ?? 0;
    await remind(10);
    const second = telegram.lastTo(c.patientTelegramId)?.messageId ?? 0;

    bot.clock = afterFirstDose(11);
    await Promise.all([
      bot.press(c.patientTelegramId, `xt:${c.firstDoseId}`, second),
      bot.press(c.patientTelegramId, `xt:${c.firstDoseId}`, second),
    ]);
    await press(c, 12, `xt:${c.firstDoseId}`, first);
    await press(c, 12, `xk:${c.firstDoseId}`, first);
    await press(c, 12, `xs:${c.firstDoseId}:5`, first);

    expect(await eventTypes(c.firstDoseId)).toEqual(['NOTIFIED', 'NOTIFIED', 'TAKEN']);
    expect(await doseRow(c.firstDoseId)).toMatchObject({
      status: 'TAKEN',
      finalized_at: afterFirstDose(11),
    });
    // Both reminders now show the same record, with no answer buttons left on either.
    for (const message of telegram.messagesTo(c.patientTelegramId)) {
      expect(message.text).toContain(t('ru', 'dose.state.taken', { time: '08:11' }));
      expect(message.buttons.flat().some((button) => button.data.startsWith('xs:'))).toBe(false);
    }
  });

  it('a "later" that would come too late is refused, and says so', async () => {
    const c = await running();
    await remind(0);
    await press(c, 22, `xs:${c.firstDoseId}:15`);

    expect(textOf(c)).toContain(t('ru', 'dose.snoozeNotAllowed'));
    expect(textOf(c)).toContain(t('ru', 'dose.state.waiting', { time: '08:30' }));
    expect(dataOf(c).filter((data) => data.startsWith('xs:'))).toEqual([`xs:${c.firstDoseId}:5`]);
    expect((await doseRow(c.firstDoseId))?.status).toBe('NOTIFIED');
  });

  it('a "later" of a made-up length is refused', async () => {
    const c = await running();
    await remind(0);
    for (const data of [`xs:${c.firstDoseId}:240`, `xs:${c.firstDoseId}:7`]) {
      await press(c, 2, data);
      expect(textOf(c)).toContain(t('ru', 'dose.snoozeNotAllowed'));
    }
    await press(c, 2, `xs:${c.firstDoseId}:999`);
    await press(c, 2, `xs:${c.firstDoseId}:0`);
    expect(await eventTypes(c.firstDoseId)).toEqual(['NOTIFIED']);
  });
});

describe('taking an answer back', () => {
  it('returns the dose to waiting, with its buttons, and the patient answers again', async () => {
    const c = await running();
    await remind(0);
    await press(c, 3, `xt:${c.firstDoseId}`);

    await press(c, 5, `xu:${c.firstDoseId}`);

    expect(textOf(c)).toBe(
      `${t('ru', 'dose.undone')}\n\n${HEADER}\n${t('ru', 'dose.state.waiting', { time: '08:30' })}`,
    );
    expect(dataOf(c)).toContain(`xt:${c.firstDoseId}`);
    expect(dataOf(c)).toContain(`xk:${c.firstDoseId}`);
    expect((await doseRow(c.firstDoseId))?.status).toBe('NOTIFIED');

    await press(c, 6, `xr:${c.firstDoseId}:f`);
    expect((await doseRow(c.firstDoseId))?.status).toBe('SKIPPED');
    expect(await eventTypes(c.firstDoseId)).toEqual(['NOTIFIED', 'TAKEN', 'CORRECTION', 'SKIPPED']);
  });

  it('brings the remaining reminders back', async () => {
    const c = await running();
    await remind(0);
    await press(c, 3, `xt:${c.firstDoseId}`);
    await press(c, 5, `xu:${c.firstDoseId}`);

    await remind(10);
    expect(sentTo(c)).toBe(2);
    expect(textOf(c)).toContain(t('ru', 'reminder.again'));
  });

  it('is offered for an hour, and refused after it', async () => {
    const c = await running();
    await remind(0);
    await press(c, 3, `xt:${c.firstDoseId}`);
    expect(dataOf(c)).toContain(`xu:${c.firstDoseId}`);

    // 64 minutes after the answer: the old button is still on the message, but its time is up.
    await press(c, 67, `xu:${c.firstDoseId}`);

    expect(textOf(c)).toContain(t('ru', 'dose.notCorrectable'));
    expect(textOf(c)).toContain(t('ru', 'dose.state.taken', { time: '08:03' }));
    expect(dataOf(c)).toEqual(['m:t']);
    expect(await eventTypes(c.firstDoseId)).toEqual(['NOTIFIED', 'TAKEN']);
  });
});

describe('"today" as a way to answer', () => {
  async function openToday(c: RunningCourse, minutes: number): Promise<void> {
    bot.clock = afterFirstDose(minutes);
    await bot.say(c.patientTelegramId, '/menu');
    await bot.press(c.patientTelegramId, 'm:t');
  }

  it('opens a dose from an hour before its time, and not earlier', async () => {
    const c = await running();
    await openToday(c, -61);
    expect(dataOf(c)).toEqual(['m:h']);

    await openToday(c, -60);
    expect(dataOf(c)).toEqual([`xv:${c.firstDoseId}`, 'm:h']);
    expect(telegram.lastTo(c.patientTelegramId)?.buttons[0]?.[0]?.text).toBe('08:00 · Testamol');

    await press(c, -60, `xv:${c.firstDoseId}`);
    expect(textOf(c)).toBe(`${HEADER}\n${t('ru', 'dose.state.waiting', { time: '08:30' })}`);
    await press(c, -59, `xt:${c.firstDoseId}`);
    expect((await doseRow(c.firstDoseId))?.status).toBe('TAKEN');
    expect(await remind(0)).toMatchObject({ sent: 0 });
  });

  it('refuses a forged early "took it" as a mistap', async () => {
    const c = await running();
    await openToday(c, -90);
    await press(c, -90, `xt:${c.firstDoseId}`);
    expect(textOf(c)).toContain(t('ru', 'dose.tooEarly'));
    expect((await doseRow(c.firstDoseId))?.status).toBe('SCHEDULED');
  });

  it('shows what was answered, and lets a missed dose be marked as taken late', async () => {
    const c = await running();
    await remind(0);
    await runMissedSweep({ orm: orm(), repositoryDeps, now: afterFirstDose(30), logger });

    await openToday(c, 45);
    expect(textOf(c)).toContain(`08:00 — Testamol, 500 мг, после еды · ${t('ru', 'dose.MISSED')}`);
    expect(dataOf(c)).toContain(`xv:${c.firstDoseId}`);

    await press(c, 45, `xv:${c.firstDoseId}`);
    expect(textOf(c)).toBe(`${HEADER}\n${t('ru', 'dose.state.missed')}`);
    await press(c, 46, `xt:${c.firstDoseId}`);
    await openToday(c, 47);
    expect(textOf(c)).toContain(t('ru', 'dose.TAKEN_LATE'));
    expect(dataOf(c)).not.toContain(`xv:${c.firstDoseId}`);
  });

  it('treats a dose past its deadline as missed even before the sweeper has run', async () => {
    const c = await running();
    await remind(0);
    await press(c, 35, `xv:${c.firstDoseId}`);
    expect(textOf(c)).toBe(`${HEADER}\n${t('ru', 'dose.state.missed')}`);
    expect(dataOf(c)).toEqual([`xt:${c.firstDoseId}`, 'm:t']);
  });
});

describe('doses that are not this person’s to answer', () => {
  it('cannot be answered by another patient, by the doctor, or by a stranger', async () => {
    const c = await running();
    const other = await running();
    await remind(0);
    bot.clock = afterFirstDose(2);

    for (const data of [
      `xt:${c.firstDoseId}`,
      `xk:${c.firstDoseId}`,
      `xr:${c.firstDoseId}:f`,
      `xr:${c.firstDoseId}:o`,
      `xs:${c.firstDoseId}:5`,
      `xu:${c.firstDoseId}`,
      `xv:${c.firstDoseId}`,
    ]) {
      await bot.press(other.patientTelegramId, data);
      expect(telegram.lastTo(other.patientTelegramId)?.text, data).toBe(
        t('ru', 'dose.notAvailable'),
      );
    }
    const stranger = 99_000_001;
    await bot.press(stranger, `xt:${c.firstDoseId}`);
    expect(telegram.messagesTo(stranger)).toEqual([]);

    expect(JSON.stringify(telegram.messagesTo(other.patientTelegramId).slice(-1))).not.toContain(
      '08:00 —',
    );
    expect(await eventTypes(c.firstDoseId)).toEqual(['NOTIFIED']);
    expect((await doseRow(c.firstDoseId))?.status).toBe('NOTIFIED');
  });

  it('cannot be answered once the course is no longer running', async () => {
    const c = await running();
    await remind(0);
    await sql()`update treatment_courses set status = 'PAUSED' where id = ${c.courseId}`;

    await press(c, 2, `xt:${c.firstDoseId}`);

    expect(textOf(c)).toBe(t('ru', 'dose.notAvailable'));
    expect(dataOf(c)).toEqual([]);
    expect((await doseRow(c.firstDoseId))?.status).toBe('NOTIFIED');
  });

  it('ignores ids that are not ids', async () => {
    const c = await running();
    await remind(0);
    const before = sentTo(c);
    for (const data of [
      'xt:nope',
      "xt:' or 1=1",
      `xr:${c.firstDoseId}:z`,
      `xs:${c.firstDoseId}:abc`,
    ]) {
      await press(c, 2, data);
    }
    expect(sentTo(c)).toBe(before);
    expect(textOf(c)).toContain(t('ru', 'reminder.title'));
    expect(await repos.answers.get(c.patient, c.firstDoseId, afterFirstDose(2))).toMatchObject({
      status: 'NOTIFIED',
    });
    expect(await repos.answers.sweepMissed(system, afterFirstDose(2))).toBe(0);
  });
});
