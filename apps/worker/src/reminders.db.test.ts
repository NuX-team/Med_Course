import { randomBytes } from 'node:crypto';
import {
  createRepositories,
  createRepositoryDeps,
  systemActor,
  type DueReminder,
  type Repositories,
} from '@medcourse/db';
import {
  MINUTE,
  afterFirstDose,
  createTestDatabase,
  startRunningCourse,
  type RunningCourse,
  type TestDatabase,
} from '@medcourse/db/testing';
import { t } from '@medcourse/i18n';
import { createLogger } from '@medcourse/logger';
import { Pacer } from './pacer';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MISSED_SWEEP_INTERVAL_MS,
  decide,
  missedSweepDue,
  outcomeOfFailure,
  runMissedSweep,
  runOutbox,
} from './reminders';

/** The worker sends reminders. Telegram is replaced by a recorder that can be told to fail. */

let testDatabase: TestDatabase;
let repos: Repositories;
const repositoryDeps = createRepositoryDeps([{ id: 't', key: randomBytes(32) }]);
const logger = createLogger({ service: 'reminder-test', level: 'silent' });
const system = systemActor('reminder test');

interface Sent {
  readonly chatId: number;
  readonly text: string;
  readonly buttons: string[];
}

class Recorder {
  readonly sent: Sent[] = [];
  /** Errors to throw, one per call, before any message gets through. */
  failures: unknown[] = [];
  /** Runs once, just before the next message goes out: what happens "in the meantime". */
  meanwhile: ((chatId: number) => Promise<void>) | undefined;

  async sendMessage(
    chatId: number,
    text: string,
    other?: { reply_markup?: { inline_keyboard: { text: string; callback_data?: string }[][] } },
  ): Promise<unknown> {
    if (this.meanwhile !== undefined) {
      const hook = this.meanwhile;
      this.meanwhile = undefined;
      await hook(chatId);
    }
    const failure = this.failures.shift();
    if (failure !== undefined) {
      return Promise.reject(
        failure instanceof Error ? failure : Object.assign(new Error('x'), failure),
      );
    }
    this.sent.push({
      chatId,
      text,
      buttons: (other?.reply_markup?.inline_keyboard ?? [])
        .flat()
        .map((button) => button.callback_data ?? ''),
    });
    return Promise.resolve({ message_id: this.sent.length });
  }
}

let telegram: Recorder;
const sql = () => testDatabase.db.sql;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  repos = createRepositories(testDatabase.db.orm, repositoryDeps);
});

afterAll(async () => {
  await testDatabase.drop();
});

beforeEach(async () => {
  telegram = new Recorder();
  // Each test sees only the reminders of the course it starts.
  await sql()`update notifications set status = 'CANCELLED', locked_until = null where status in ('QUEUED', 'SENDING')`;
});

const running = (options: Parameters<typeof startRunningCourse>[2] = {}): Promise<RunningCourse> =>
  startRunningCourse(sql(), repos, options);

const outbox = (now: Date, random = () => 0.5) =>
  runOutbox({
    orm: testDatabase.db.orm,
    repositoryDeps,
    api: telegram,
    logger,
    now: () => now,
    random,
    concurrency: 1,
  });

async function remindersOf(doseId: string) {
  return sql()<
    { attempt_no: number; status: string; due_at: Date; tries: number; last_error: string | null }[]
  >`
    select attempt_no, status, due_at, tries, last_error from notifications
    where scheduled_dose_id = ${doseId} order by attempt_no`;
}

async function doseStatus(doseId: string): Promise<string | undefined> {
  const [row] = await sql()<
    { status: string }[]
  >`select status from scheduled_doses where id = ${doseId}`;
  return row?.status;
}

describe('a reminder that is due', () => {
  it('reaches the patient with what to take and the three answers, and the dose is announced', async () => {
    const c = await running();

    const result = await outbox(afterFirstDose(0));

    expect(result).toEqual({ sent: 1, cancelled: 0, retried: 0, failed: 0 });
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0]).toMatchObject({ chatId: c.patientTelegramId });
    expect(telegram.sent[0]?.text).toContain(t('ru', 'reminder.title'));
    expect(telegram.sent[0]?.text).toContain('Testamol — 500 мг, после еды');
    expect(telegram.sent[0]?.text).toContain(t('ru', 'reminder.time', { time: '08:00' }));
    expect(telegram.sent[0]?.buttons).toEqual([
      `xt:${c.firstDoseId}`,
      `xs:${c.firstDoseId}:5`,
      `xs:${c.firstDoseId}:10`,
      `xs:${c.firstDoseId}:15`,
      `xk:${c.firstDoseId}`,
    ]);
    expect(await doseStatus(c.firstDoseId)).toBe('NOTIFIED');
    expect((await remindersOf(c.firstDoseId)).map((r) => r.status)).toEqual([
      'SENT',
      'QUEUED',
      'QUEUED',
    ]);
  });

  it('is not sent before its time, and is sent once however often the worker runs', async () => {
    await running();
    await outbox(new Date(afterFirstDose(0).getTime() - 1000));
    expect(telegram.sent).toEqual([]);

    await outbox(afterFirstDose(0));
    await outbox(afterFirstDose(0));
    await outbox(afterFirstDose(1));
    expect(telegram.sent).toHaveLength(1);
  });

  it('is repeated ten and twenty minutes later, worded as a repeat', async () => {
    await running();
    await outbox(afterFirstDose(0));
    await outbox(afterFirstDose(10));
    await outbox(afterFirstDose(20));

    expect(telegram.sent.map((message) => message.text.split('\n')[0])).toEqual([
      t('ru', 'reminder.title'),
      t('ru', 'reminder.again'),
      t('ru', 'reminder.again'),
    ]);
    // The last one leaves room for only the shortest "later".
    expect(telegram.sent[2]?.buttons.filter((data) => data.startsWith('xs:'))).toHaveLength(1);
  });

  it('is written in the patient’s language', async () => {
    await running({ locale: 'uz' });
    await outbox(afterFirstDose(0));
    expect(telegram.sent[0]?.text).toContain(t('uz', 'reminder.title'));
    expect(telegram.sent[0]?.text).toContain('Testamol — 500 mg, ovqatdan keyin');
  });

  it('goes to each patient: one failing does not hold up the next', async () => {
    const first = await running();
    const second = await running();
    telegram.failures = [
      { error_code: 403, description: 'Forbidden: bot was blocked by the user' },
    ];

    const result = await outbox(afterFirstDose(0));

    expect(result).toEqual({ sent: 1, cancelled: 0, retried: 0, failed: 1 });
    expect(telegram.sent.map((message) => message.chatId)).toEqual([second.patientTelegramId]);
    expect((await remindersOf(first.firstDoseId))[0]).toMatchObject({
      status: 'FAILED',
      last_error: 'HTTP_403',
    });
  });
});

describe('a reminder that is no longer true is not sent', () => {
  it('stops the moment the patient answers', async () => {
    const c = await running();
    await outbox(afterFirstDose(0));
    await repos.answers.take(c.patient, {
      doseId: c.firstDoseId,
      now: afterFirstDose(3),
      key: 'k1',
    });

    await outbox(afterFirstDose(10));
    await outbox(afterFirstDose(20));

    expect(telegram.sent).toHaveLength(1);
  });

  it.each<[string, (c: RunningCourse) => PromiseLike<unknown>]>([
    [
      'the course is paused',
      (c) => sql()`update treatment_courses set status = 'PAUSED' where id = ${c.courseId}`,
    ],
    [
      'the patient’s account is closed',
      (c) => sql()`update users set status = 'BLOCKED' where id = ${c.patientId}`,
    ],
    [
      'the dose was answered behind the queue’s back',
      (c) =>
        sql()`update scheduled_doses set status = 'TAKEN', finalized_at = now() where id = ${c.firstDoseId}`,
    ],
    [
      'the dose was taken off the schedule',
      (c) => sql()`update scheduled_doses set status = 'SUPERSEDED' where id = ${c.firstDoseId}`,
    ],
  ])('when %s', async (_label, change) => {
    const c = await running();
    await change(c);

    const result = await outbox(afterFirstDose(0));

    expect(result).toMatchObject({ sent: 0, cancelled: 1 });
    expect(telegram.sent).toEqual([]);
    expect((await remindersOf(c.firstDoseId))[0]?.status).toBe('CANCELLED');
  });

  it('when the worker was down past the deadline: no reminder for a dose that is already missed', async () => {
    const c = await running();

    for (let round = 0; round < 4; round += 1) {
      await outbox(afterFirstDose(30));
    }

    expect(telegram.sent).toEqual([]);
    expect((await remindersOf(c.firstDoseId)).map((r) => r.status)).toEqual([
      'CANCELLED',
      'CANCELLED',
      'CANCELLED',
    ]);
  });

  it('when the worker was down for a while but the deadline is still ahead, the patient is told now', async () => {
    const c = await running();
    await outbox(afterFirstDose(12));
    expect(telegram.sent).toHaveLength(1);
    expect(await doseStatus(c.firstDoseId)).toBe('NOTIFIED');
  });

  const proposeChange = async (c: RunningCourse): Promise<void> => {
    await repos.changes.open(c.doctor, c.courseId);
    await repos.plans.addMedication(c.doctor, c.courseId, {
      displayName: 'Betadrug',
      doseValue: 1,
      doseUnit: 'TABLET',
      foodRule: 'ANY',
      activeFromDay: 1,
      activeToDay: 7,
      schedule: { kind: 'TIMES', times: ['12:00'] },
    });
    await repos.changes.send(c.doctor, c.courseId, afterFirstDose(-60));
  };
  const at = afterFirstDose(0);

  // The worker takes two reminders from the queue in one round. While it is sending the first,
  // something happens to the other course: its reminder, already in the worker's hands, must
  // not go out.
  it.each<[string, (c: RunningCourse) => Promise<unknown>]>([
    [
      'the doctor pauses the course',
      (c) => repos.lifecycle.pause(c.doctor, { courseId: c.courseId, now: at, key: 'pause' }),
    ],
    [
      'the doctor cancels the course',
      (c) => repos.lifecycle.cancel(c.doctor, { courseId: c.courseId, now: at, key: 'cancel' }),
    ],
    [
      'the patient accepts a new plan',
      (c) => repos.changes.accept(c.patient, { courseId: c.courseId, now: at, key: 'accept' }),
    ],
  ])('when %s after the worker has already taken the reminder', async (_label, change) => {
    const first = await running();
    const second = await running();
    await proposeChange(first);
    await proposeChange(second);
    let victim: RunningCourse | undefined;
    telegram.meanwhile = async (chatId) => {
      victim = chatId === first.patientTelegramId ? second : first;
      await change(victim);
    };

    const result = await outbox(at);

    expect(victim).toBeDefined();
    const spared = victim === first ? second : first;
    expect(result).toEqual({ sent: 1, cancelled: 1, retried: 0, failed: 0 });
    expect(telegram.sent.map((message) => message.chatId)).toEqual([spared.patientTelegramId]);
    expect(await doseStatus(victim?.firstDoseId ?? '')).toBe('SUPERSEDED');
    expect((await remindersOf(victim?.firstDoseId ?? ''))[0]?.status).toBe('CANCELLED');
    expect(await doseStatus(spared.firstDoseId)).toBe('NOTIFIED');
  });

  it('during a pause nothing is sent; after the course resumes, the reminders come again', async () => {
    const c = await running();
    await repos.lifecycle.pause(c.doctor, {
      courseId: c.courseId,
      now: afterFirstDose(-30),
      key: 'pause',
    });
    await outbox(afterFirstDose(0));
    await outbox(afterFirstDose(10));
    expect(telegram.sent).toEqual([]);

    // Resumed at 09:00: the 08:00 dose is not made up, the 20:00 one is reminded as planned.
    await repos.lifecycle.resume(c.doctor, {
      courseId: c.courseId,
      now: afterFirstDose(60),
      key: 'resume',
    });
    await outbox(afterFirstDose(61));
    expect(telegram.sent).toEqual([]);
    await outbox(afterFirstDose(12 * 60));
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0]?.text).toContain(t('ru', 'reminder.time', { time: '20:00' }));
    expect(await doseStatus(c.firstDoseId)).toBe('SUPERSEDED');
  });

  it('after a change of plan, reminders follow the new plan only', async () => {
    const c = await running();
    await proposeChange(c);
    await repos.changes.accept(c.patient, {
      courseId: c.courseId,
      now: afterFirstDose(-30),
      key: 'accept',
    });

    await outbox(afterFirstDose(0));
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0]?.text).toContain('Testamol');
    // The dose reminded is the new plan's own, not the superseded one of the old plan.
    expect(await doseStatus(c.firstDoseId)).toBe('SUPERSEDED');
    expect(telegram.sent[0]?.buttons[0]).not.toBe(`xt:${c.firstDoseId}`);

    // One reminder per person per round: the two stale repeats of 08:00 are dropped first.
    for (let round = 0; round < 3; round += 1) {
      await outbox(afterFirstDose(4 * 60));
    }
    expect(telegram.sent).toHaveLength(2);
    expect(telegram.sent[1]?.text).toContain('Betadrug');
  });
});

describe('when Telegram does not take the message', () => {
  it('holds every sender back for as long as a rate limit says, not just the one that was refused', async () => {
    await running();
    await running();
    let at = 1_000_000;
    const waited: number[] = [];
    const pacer = new Pacer(10, {
      now: () => at,
      sleep: (ms) => {
        waited.push(ms);
        return Promise.resolve();
      },
    });
    telegram.failures = [{ error_code: 429, parameters: { retry_after: 7 } }];

    const result = await runOutbox({
      orm: testDatabase.db.orm,
      repositoryDeps,
      api: telegram,
      logger,
      now: () => afterFirstDose(0),
      concurrency: 1,
      pacer,
    });

    // One was refused and will be retried, one went out; and the next place in line is seven
    // seconds away, whoever asks for it.
    expect(result).toMatchObject({ sent: 1, retried: 1 });
    waited.length = 0;
    await pacer.take();
    expect(waited).toHaveLength(1);
    expect(waited[0]).toBeGreaterThanOrEqual(6_900);
    // The second reminder waited out the pause and took the place after it, a tenth of a second on.
    expect(waited[0]).toBeLessThanOrEqual(7_100);
    at += 7_100;
    waited.length = 0;
    await pacer.take();
    expect(waited[0]).toBeLessThanOrEqual(100);
  });

  it('is told five seconds to wait when Telegram does not say how long', async () => {
    await running();
    let at = 1_000_000;
    const waited: number[] = [];
    const pacer = new Pacer(10, {
      now: () => at,
      sleep: (ms) => {
        waited.push(ms);
        at += ms;
        return Promise.resolve();
      },
    });
    telegram.failures = [{ error_code: 429 }];

    await runOutbox({
      orm: testDatabase.db.orm,
      repositoryDeps,
      api: telegram,
      logger,
      now: () => afterFirstDose(0),
      pacer,
    });
    await pacer.take();

    expect(waited).toEqual([5_000]);
  });

  it('waits as long as a rate limit says, then delivers', async () => {
    const c = await running();
    telegram.failures = [{ error_code: 429, parameters: { retry_after: 7 } }];

    expect(await outbox(afterFirstDose(0))).toMatchObject({ sent: 0, retried: 1 });
    expect((await remindersOf(c.firstDoseId))[0]).toMatchObject({
      status: 'QUEUED',
      due_at: new Date(afterFirstDose(0).getTime() + 7000),
      tries: 1,
      last_error: 'HTTP_429',
    });
    expect(await doseStatus(c.firstDoseId)).toBe('SCHEDULED');

    await outbox(new Date(afterFirstDose(0).getTime() + 6999));
    expect(telegram.sent).toEqual([]);
    await outbox(new Date(afterFirstDose(0).getTime() + 7000));
    expect(telegram.sent).toHaveLength(1);
    expect(await doseStatus(c.firstDoseId)).toBe('NOTIFIED');
  });

  it('retries a network failure with a growing pause', async () => {
    const c = await running();
    telegram.failures = [new Error('fetch failed'), new Error('fetch failed')];

    await outbox(afterFirstDose(0));
    const first = (await remindersOf(c.firstDoseId))[0];
    expect(first).toMatchObject({ status: 'QUEUED', tries: 1, last_error: 'NETWORK' });
    expect((first?.due_at.getTime() ?? 0) - afterFirstDose(0).getTime()).toBe(2500);

    await outbox(first?.due_at ?? afterFirstDose(1));
    const second = (await remindersOf(c.firstDoseId))[0];
    expect(second).toMatchObject({ status: 'QUEUED', tries: 2 });
    expect((second?.due_at.getTime() ?? 0) - (first?.due_at.getTime() ?? 0)).toBe(4500);

    await outbox(second?.due_at ?? afterFirstDose(1));
    expect(telegram.sent).toHaveLength(1);
  });

  it('gives up on a blocked bot at once, and never stores what Telegram said', async () => {
    const c = await running();
    telegram.failures = [
      {
        error_code: 403,
        description: 'Forbidden: bot was blocked by the user https://api.telegram.org/botSECRET',
      },
    ];

    expect(await outbox(afterFirstDose(0))).toMatchObject({ failed: 1, retried: 0 });

    const [row] = await sql()<{ blob: string }[]>`
      select n::text as blob from notifications n
      where scheduled_dose_id = ${c.firstDoseId} and attempt_no = 1`;
    expect(row?.blob).toContain('HTTP_403');
    expect(row?.blob).not.toContain('SECRET');
    expect(row?.blob).not.toContain('blocked');
    await outbox(afterFirstDose(1));
    expect(telegram.sent).toEqual([]);
  });

  it('stops retrying when the next try would come too late to matter', async () => {
    const c = await running();
    await sql()`update notifications set status = 'CANCELLED' where scheduled_dose_id = ${c.firstDoseId} and attempt_no < 3`;
    telegram.failures = [{ error_code: 429, parameters: { retry_after: 900 } }];

    // The third reminder, ten minutes before the deadline; Telegram says "wait fifteen".
    expect(await outbox(afterFirstDose(20))).toMatchObject({ cancelled: 1, retried: 0 });
    expect((await remindersOf(c.firstDoseId))[2]?.status).toBe('CANCELLED');
  });
});

describe('a worker that dies in the middle', () => {
  it('after taking a reminder but before sending it: the reminder is sent later, not lost', async () => {
    const c = await running();
    // The worker reserves the reminder and is killed.
    await repos.outbox.claimDue(system, { now: afterFirstDose(0), limit: 25, lockMs: MINUTE });

    await outbox(new Date(afterFirstDose(0).getTime() + 30_000));
    expect(telegram.sent).toEqual([]);

    await outbox(new Date(afterFirstDose(0).getTime() + MINUTE + 1));
    expect(telegram.sent).toHaveLength(1);
    expect(await doseStatus(c.firstDoseId)).toBe('NOTIFIED');
  });

  it('after sending but before recording it: the patient may get it twice, and one answer settles both', async () => {
    const c = await running();
    await repos.outbox.claimDue(system, { now: afterFirstDose(0), limit: 25, lockMs: MINUTE });
    await telegram.sendMessage(c.patientTelegramId, 'the message that did go out');

    await outbox(new Date(afterFirstDose(0).getTime() + MINUTE + 1));
    expect(telegram.sent).toHaveLength(2);

    const first = await repos.answers.take(c.patient, {
      doseId: c.firstDoseId,
      now: afterFirstDose(3),
      key: 'a',
    });
    const second = await repos.answers.take(c.patient, {
      doseId: c.firstDoseId,
      now: afterFirstDose(4),
      key: 'b',
    });
    expect([first.result, second.result]).toEqual(['DONE', 'ALREADY']);
    const [events] = await sql()<{ n: number }[]>`
      select count(*)::int as n from dose_events
      where scheduled_dose_id = ${c.firstDoseId} and event_type = 'TAKEN'`;
    expect(events?.n).toBe(1);
  });
});

describe('the sweeper of missed doses', () => {
  it('records every dose past its deadline, in as many rounds as it takes', async () => {
    const c = await running();
    const later = new Date(afterFirstDose(0).getTime() + 3 * 24 * 60 * MINUTE);

    const missed = await runMissedSweep({
      orm: testDatabase.db.orm,
      repositoryDeps,
      now: later,
      logger,
    });

    expect(missed).toBeGreaterThanOrEqual(6);
    const [counts] = await sql()<{ missed: number; waiting: number }[]>`
      select count(*) filter (where status = 'MISSED')::int as missed,
             count(*) filter (where status = 'SCHEDULED')::int as waiting
      from scheduled_doses where course_id = ${c.courseId}`;
    expect(counts).toEqual({ missed: 6, waiting: 8 });
    expect(
      await runMissedSweep({ orm: testDatabase.db.orm, repositoryDeps, now: later, logger }),
    ).toBe(0);
  });

  it('is due the first time, then every half minute', () => {
    const now = afterFirstDose(0);
    expect(missedSweepDue(null, now)).toBe(true);
    expect(missedSweepDue(now, new Date(now.getTime() + MISSED_SWEEP_INTERVAL_MS - 1))).toBe(false);
    expect(missedSweepDue(now, new Date(now.getTime() + MISSED_SWEEP_INTERVAL_MS))).toBe(true);
  });
});

describe('the decision to send', () => {
  const base: DueReminder = {
    notificationId: 'n',
    kind: 'DOSE_REMINDER',
    attemptNo: 1,
    dueAt: afterFirstDose(0),
    tries: 0,
    doseId: 'd',
    doseStatus: 'SCHEDULED',
    scheduledAt: afterFirstDose(0),
    deadlineAt: afterFirstDose(30),
    courseId: 'c',
    courseStatus: 'ACTIVE',
    timezone: 'Asia/Tashkent',
    revisionCurrent: true,
    medication: {
      displayName: 'x',
      doseValue: '1.000',
      doseDisplay: null,
      doseUnit: 'MG',
      foodRule: 'ANY',
      instructions: null,
    },
    recipient: { userId: 'u', telegramUserId: 1, locale: 'ru', active: true },
    snoozeOptions: [],
  };

  it('is yes for a waiting dose of a running course before its deadline', () => {
    for (const doseStatus of ['SCHEDULED', 'NOTIFIED', 'SNOOZED'] as const) {
      expect(decide({ ...base, doseStatus }, afterFirstDose(29))).toEqual({ send: true });
    }
  });

  it.each<[string, Partial<DueReminder>, Date]>([
    ['the deadline has come', {}, afterFirstDose(30)],
    ['the course is not running', { courseStatus: 'PAUSED' }, afterFirstDose(0)],
    ['the course is cancelled', { courseStatus: 'CANCELLED' }, afterFirstDose(0)],
    ['the plan was replaced', { revisionCurrent: false }, afterFirstDose(0)],
    ['the dose is taken', { doseStatus: 'TAKEN' }, afterFirstDose(0)],
    ['the dose is skipped', { doseStatus: 'SKIPPED' }, afterFirstDose(0)],
    ['the dose is missed', { doseStatus: 'MISSED' }, afterFirstDose(0)],
    ['the dose is off the schedule', { doseStatus: 'SUPERSEDED' }, afterFirstDose(0)],
    [
      'the account is closed',
      { recipient: { ...base.recipient, active: false } },
      afterFirstDose(0),
    ],
    ['a heads-up after the dose time', { kind: 'DOSE_LEAD' }, afterFirstDose(0)],
    [
      'a heads-up for a dose already announced',
      { kind: 'DOSE_LEAD', doseStatus: 'NOTIFIED' },
      afterFirstDose(-5),
    ],
  ])('is no when %s', (_label, change, now) => {
    expect(decide({ ...base, ...change }, now).send).toBe(false);
  });

  it('is yes for a heads-up before the dose time', () => {
    expect(decide({ ...base, kind: 'DOSE_LEAD' }, afterFirstDose(-15))).toEqual({ send: true });
  });
});

describe('what to do after a failure', () => {
  const reminder = {
    tries: 0,
    kind: 'DOSE_REMINDER' as const,
    scheduledAt: afterFirstDose(0),
    deadlineAt: afterFirstDose(30),
  };
  const now = afterFirstDose(0);
  const fixed = () => 0;

  it('never retries what cannot arrive', () => {
    for (const code of [400, 403]) {
      expect(outcomeOfFailure({ error_code: code }, reminder, now, fixed)).toEqual({
        status: 'FAILED',
        error: `HTTP_${String(code)}`,
        at: now,
      });
    }
  });

  it('retries everything else, doubling the pause up to a minute', () => {
    const pauses = [0, 1, 2, 3, 4, 5, 6, 10].map((tries) => {
      const outcome = outcomeOfFailure({ error_code: 502 }, { ...reminder, tries }, now, fixed);
      return outcome.status === 'RETRY' ? outcome.at.getTime() - now.getTime() : -1;
    });
    expect(pauses).toEqual([2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
    expect(outcomeOfFailure(new Error('socket hang up'), reminder, now, fixed)).toMatchObject({
      status: 'RETRY',
      error: 'NETWORK',
    });
    expect(outcomeOfFailure({ error_code: 401 }, reminder, now, fixed)).toMatchObject({
      status: 'RETRY',
      error: 'HTTP_401',
    });
  });

  it('adds up to a second of jitter, so workers do not retry in step', () => {
    const outcome = outcomeOfFailure({ error_code: 500 }, reminder, now, () => 0.999);
    expect(outcome.status === 'RETRY' ? outcome.at.getTime() - now.getTime() : 0).toBe(2999);
  });

  it('obeys a rate limit exactly, and falls back to five seconds when none is given', () => {
    expect(
      outcomeOfFailure({ error_code: 429, parameters: { retry_after: 12 } }, reminder, now, fixed),
    ).toEqual({
      status: 'RETRY',
      at: new Date(now.getTime() + 12_000),
      error: 'HTTP_429',
    });
    for (const parameters of [undefined, {}, { retry_after: 'soon' }, { retry_after: -1 }]) {
      expect(outcomeOfFailure({ error_code: 429, parameters }, reminder, now, fixed)).toMatchObject(
        {
          at: new Date(now.getTime() + 5000),
        },
      );
    }
  });

  it('gives up when the retry would land at or after the deadline (or, for a heads-up, the dose time)', () => {
    const nearDeadline = new Date(afterFirstDose(30).getTime() - 2000);
    expect(outcomeOfFailure({ error_code: 500 }, reminder, nearDeadline, fixed).status).toBe(
      'CANCELLED',
    );
    expect(
      outcomeOfFailure({ error_code: 500 }, reminder, new Date(nearDeadline.getTime() - 1), fixed)
        .status,
    ).toBe('RETRY');
    expect(
      outcomeOfFailure(
        { error_code: 500 },
        { ...reminder, kind: 'DOSE_LEAD' },
        new Date(afterFirstDose(0).getTime() - 1000),
        fixed,
      ).status,
    ).toBe('CANCELLED');
  });

  it('copes with errors of any shape', () => {
    for (const odd of [
      null,
      undefined,
      'boom',
      42,
      { error_code: 'x' },
      { error_code: Number.NaN },
    ]) {
      expect(outcomeOfFailure(odd, reminder, now, fixed)).toMatchObject({
        status: 'RETRY',
        error: 'NETWORK',
      });
    }
  });
});
