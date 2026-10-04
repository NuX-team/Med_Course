import { randomBytes } from 'node:crypto';
import {
  createRepositories,
  createRepositoryDeps,
  systemActor,
  type Repositories,
} from '@medcourse/db';
import {
  createTestDatabase,
  startRunningCourse,
  type RunningCourse,
  type TestDatabase,
} from '@medcourse/db/testing';
import { t } from '@medcourse/i18n';
import { createLogger } from '@medcourse/logger';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { COMPLETION_SWEEP_INTERVAL_MS, completionSweepDue, runCompletionSweep } from './completion';
import { runMissedSweep } from './reminders';

/**
 * The worker closes courses whose last day is over. The course of these tests starts on
 * 3 October 2026 in Tashkent and lasts seven days: its last day is the 9th, and it is over at
 * midnight, 19:00 UTC.
 */

let testDatabase: TestDatabase;
let repos: Repositories;
const repositoryDeps = createRepositoryDeps([{ id: 't', key: randomBytes(32) }]);
const logger = createLogger({ service: 'completion-test', level: 'silent' });
const system = systemActor('completion test');
const END = new Date('2026-10-09T19:00:00Z');

class Recorder {
  readonly sent: { chatId: number; text: string }[] = [];
  failing = false;

  sendMessage(chatId: number, text: string): Promise<unknown> {
    if (this.failing) {
      return Promise.reject(Object.assign(new Error('blocked'), { error_code: 403 }));
    }
    this.sent.push({ chatId, text });
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

beforeEach(() => {
  telegram = new Recorder();
});

const sweep = (now: Date): Promise<number> =>
  runCompletionSweep({ orm: testDatabase.db.orm, repositoryDeps, api: telegram, now, logger });

const recordMisses = (now: Date): Promise<number> =>
  runMissedSweep({ orm: testDatabase.db.orm, repositoryDeps, now, logger });

async function statusOf(c: RunningCourse): Promise<string | undefined> {
  const [row] = await sql()<{ status: string }[]>`
    select status from treatment_courses where id = ${c.courseId}`;
  return row?.status;
}

describe('the completion sweep', () => {
  it('closes a finished course and tells the patient, once', async () => {
    const c = await startRunningCourse(sql(), repos);
    await recordMisses(END);

    expect(await sweep(new Date(END.getTime() - 1))).toBe(0);
    expect(await statusOf(c)).toBe('ACTIVE');

    expect(await sweep(END)).toBe(1);

    expect(await statusOf(c)).toBe('COMPLETED');
    expect(telegram.sent).toEqual([
      { chatId: c.patientTelegramId, text: t('ru', 'course.completed', { last: '09.10.2026' }) },
    ]);
    // The next round has nothing to close and says nothing.
    expect(await sweep(new Date(END.getTime() + 300_000))).toBe(0);
    expect(telegram.sent).toHaveLength(1);
  });

  it('writes to the patient in their own language', async () => {
    const c = await startRunningCourse(sql(), repos, { locale: 'uz' });
    await recordMisses(END);
    await sweep(END);
    expect(telegram.sent).toEqual([
      { chatId: c.patientTelegramId, text: t('uz', 'course.completed', { last: '09.10.2026' }) },
    ]);
  });

  it('closes the course even when the message cannot be delivered, and does not try again', async () => {
    const c = await startRunningCourse(sql(), repos);
    await recordMisses(END);
    telegram.failing = true;

    expect(await sweep(END)).toBe(1);
    expect(await statusOf(c)).toBe('COMPLETED');

    telegram.failing = false;
    expect(await sweep(new Date(END.getTime() + 300_000))).toBe(0);
    expect(telegram.sent).toEqual([]);
  });

  it('leaves alone a course that still has a dose waiting, a paused one and a cancelled one', async () => {
    const open = await startRunningCourse(sql(), repos);
    const paused = await startRunningCourse(sql(), repos);
    const cancelled = await startRunningCourse(sql(), repos);
    const early = new Date('2026-10-03T01:00:00Z');
    await repos.lifecycle.pause(paused.doctor, { courseId: paused.courseId, now: early, key: 'p' });
    await repos.lifecycle.cancel(cancelled.doctor, {
      courseId: cancelled.courseId,
      now: early,
      key: 'c',
    });

    // Nobody recorded the misses: the first course still has fourteen doses open.
    expect(await sweep(END)).toBe(0);
    expect(await statusOf(open)).toBe('ACTIVE');
    expect(await statusOf(paused)).toBe('PAUSED');
    expect(await statusOf(cancelled)).toBe('CANCELLED');
    expect(telegram.sent).toEqual([]);

    await recordMisses(END);
    expect(await sweep(END)).toBe(1);
    expect(await statusOf(open)).toBe('COMPLETED');
    expect(await statusOf(paused)).toBe('PAUSED');
  });

  it('does not write to a patient whose account is closed', async () => {
    const c = await startRunningCourse(sql(), repos);
    await recordMisses(END);
    await sql()`update users set status = 'BLOCKED' where id = ${c.patientId}`;
    expect(await sweep(END)).toBe(1);
    expect(await statusOf(c)).toBe('COMPLETED');
    expect(telegram.sent).toEqual([]);
  });

  it('is the system’s job only', async () => {
    const c = await startRunningCourse(sql(), repos);
    await expect(repos.lifecycle.completeDue(c.doctor, END)).rejects.toThrow();
    expect(system.kind).toBe('SYSTEM');
  });
});

describe('completionSweepDue', () => {
  it('runs at start and then every five minutes', () => {
    const now = new Date('2026-10-09T19:00:00Z');
    expect(completionSweepDue(null, now)).toBe(true);
    expect(
      completionSweepDue(new Date(now.getTime() - COMPLETION_SWEEP_INTERVAL_MS + 1), now),
    ).toBe(false);
    expect(completionSweepDue(new Date(now.getTime() - COMPLETION_SWEEP_INTERVAL_MS), now)).toBe(
      true,
    );
  });
});
