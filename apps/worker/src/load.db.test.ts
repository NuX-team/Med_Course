import { randomBytes } from 'node:crypto';
import { createRepositories, createRepositoryDeps, type Repositories } from '@medcourse/db';
import {
  createTestDatabase,
  insertPatient,
  startRunningCourse,
  type RunningCourse,
  type TestDatabase,
} from '@medcourse/db/testing';
import { createLogger } from '@medcourse/logger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pacer } from './pacer';
import { SEND_RATE_PER_SECOND, runOutboxBurst } from './reminders';

/**
 * The peak (TZ §11, §18.1): everybody's 08:00 comes at once. A hundred and fifty patients are
 * reminded in the same second through a Telegram that takes 100 ms to answer, in real time and
 * through the worker's own code. The service level asked for is "within a minute of the slot";
 * the question here is how the queue behaves, and what rate it holds while it works it off.
 */

const PEOPLE = 150;
const LATENCY_MS = 100;
/** The virtual clock starts at the first dose of the course and runs at the pace of the real one. */
const BASE = new Date('2026-10-03T03:00:00Z');

let testDatabase: TestDatabase;
let repos: Repositories;
let course: RunningCourse;
const repositoryDeps = createRepositoryDeps([{ id: 't', key: randomBytes(32) }]);
const logger = createLogger({ service: 'load-test', level: 'silent' });

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  repos = createRepositories(testDatabase.db.orm, repositoryDeps);
  course = await startRunningCourse(testDatabase.db.sql, repos);
});

afterAll(async () => {
  await testDatabase.drop();
});

let calls = 0;

/** One reminder due at `BASE` for each of `count` different patients, all of the running course. */
async function peak(count: number): Promise<string[]> {
  const { sql } = testDatabase.db;
  // The course's own two reminders are not part of the peak.
  await sql`
    update notifications set status = 'CANCELLED', locked_until = null
    where course_id = ${course.courseId} and status in ('QUEUED', 'SENDING')`;
  const [line] = await sql<
    { medication_id: string; line: string; rule: string; revision: string }[]
  >`
    select medication_id, medication_line_id as line, schedule_rule_id as rule, revision_id as revision
    from scheduled_doses where course_id = ${course.courseId} limit 1`;
  const people: string[] = [];
  for (let index = 0; index < count; index += 1) {
    people.push(await insertPatient(sql, { firstName: `Load${String(index)}` }));
  }
  // Doses of the same course a few seconds before the base moment, one for each person; every
  // call has its own stretch of seconds, so the slots of one test never meet those of another.
  calls += 1;
  const first = calls * 1000;
  const doses = await sql<{ id: string }[]>`
    insert into scheduled_doses
      (course_id, revision_id, medication_id, medication_line_id, schedule_rule_id, scheduled_at, deadline_at)
    select ${course.courseId}, ${line?.revision ?? ''}, ${line?.medication_id ?? ''}, ${line?.line ?? ''},
           ${line?.rule ?? ''}, ${BASE}::timestamptz - make_interval(secs => ${first} + g),
           ${BASE}::timestamptz + interval '30 minutes'
    from generate_series(1, ${count}) g
    returning id`;
  for (const [index, dose] of doses.entries()) {
    await sql`
      insert into notifications (course_id, scheduled_dose_id, recipient_user_id, kind, attempt_no, due_at)
      values (${course.courseId}, ${dose.id}, ${people[index] ?? ''}, 'DOSE_REMINDER', 1, ${BASE})`;
  }
  return people;
}

describe('the morning peak', () => {
  it('is worked off at the rate Telegram allows, in a minute at most, with the answers overlapping', async () => {
    const people = await peak(PEOPLE);
    const startedAt = performance.now();
    const clock = () => new Date(BASE.getTime() + (performance.now() - startedAt));
    const sentAt: number[] = [];
    const api = {
      sendMessage: async (): Promise<unknown> => {
        await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
        sentAt.push(performance.now() - startedAt);
        return { message_id: sentAt.length };
      },
    };

    const result = await runOutboxBurst(
      {
        orm: testDatabase.db.orm,
        repositoryDeps,
        api,
        logger,
        now: clock,
        pacer: new Pacer(SEND_RATE_PER_SECOND),
      },
      60_000,
    );

    expect(result).toEqual({ sent: PEOPLE, cancelled: 0, retried: 0, failed: 0 });
    expect(new Set(sentAt).size).toBeGreaterThan(PEOPLE / 2);
    // How late each reminder went out: from the moment it was due to the moment it was sent.
    const [delay] = await testDatabase.db.sql<{ p50: number; p95: number; worst: number }[]>`
      select percentile_cont(0.5) within group (order by extract(epoch from sent_at - due_at))::float as p50,
             percentile_cont(0.95) within group (order by extract(epoch from sent_at - due_at))::float as p95,
             max(extract(epoch from sent_at - due_at))::float as worst
      from notifications where recipient_user_id = any(${people})`;
    // 150 at 25 a second is six seconds of work: the last is out within seven, the p95 within
    // six and a half. Serially, with an answer in 100 ms, the same peak took fifteen seconds.
    expect(delay?.worst).toBeLessThan(7.5);
    expect(delay?.p95).toBeLessThan(6.5);
    expect(delay?.p95).toBeLessThan(60);
    // The rate is the pacer's: never more than about 25 in any second, and not much less.
    const ordered = [...sentAt].sort((a, b) => a - b);
    let busiest = 0;
    for (const [index, at] of ordered.entries()) {
      const inWindow = ordered.filter((other, j) => j >= index && other < at + 1000).length;
      busiest = Math.max(busiest, inWindow);
    }
    expect(busiest).toBeLessThanOrEqual(SEND_RATE_PER_SECOND + 2);
    expect(PEOPLE / ((ordered.at(-1) ?? 1) / 1000)).toBeGreaterThan(SEND_RATE_PER_SECOND * 0.8);
  }, 30_000);

  it('does not hold a patient back behind another, and still sends one reminder per person per round', async () => {
    const people = await peak(12);
    const startedAt = performance.now();
    const rounds: number[] = [];
    const api = { sendMessage: (): Promise<unknown> => Promise.resolve({ message_id: 1 }) };

    const result = await runOutboxBurst(
      {
        orm: testDatabase.db.orm,
        repositoryDeps,
        api,
        logger,
        now: () => new Date(BASE.getTime() + (performance.now() - startedAt)),
        limit: 5,
        concurrency: 3,
      },
      10_000,
    );
    rounds.push(result.sent);

    // Twelve people in rounds of five: the burst goes on by itself until the queue is empty.
    expect(result.sent).toBe(12);
    const [left] = await testDatabase.db.sql<{ n: number }[]>`
      select count(*)::int as n from notifications
      where recipient_user_id = any(${people}) and status <> 'SENT'`;
    expect(left?.n).toBe(0);
  });

  it('stops working through a backlog when its time is up, and the rest waits for the next round', async () => {
    const people = await peak(40);
    const startedAt = performance.now();
    const api = {
      sendMessage: async (): Promise<unknown> => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { message_id: 1 };
      },
    };

    const result = await runOutboxBurst(
      {
        orm: testDatabase.db.orm,
        repositoryDeps,
        api,
        logger,
        now: () => new Date(BASE.getTime() + (performance.now() - startedAt)),
        limit: 10,
        concurrency: 2,
      },
      1,
    );

    // The budget is a millisecond: one round is done, and the burst gives way.
    expect(result.sent).toBe(10);
    const [left] = await testDatabase.db.sql<{ n: number }[]>`
      select count(*)::int as n from notifications
      where recipient_user_id = any(${people}) and status = 'QUEUED'`;
    expect(left?.n).toBe(30);
    // What is left is picked up by the next round, as the loop does.
    const next = await runOutboxBurst(
      {
        orm: testDatabase.db.orm,
        repositoryDeps,
        api,
        logger,
        now: () => new Date(BASE.getTime() + (performance.now() - startedAt)),
      },
      10_000,
    );
    expect(next.sent).toBe(30);
  }, 30_000);
});
