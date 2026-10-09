import { randomBytes, randomUUID } from 'node:crypto';
import {
  createRepositories,
  createRepositoryDeps,
  type Repositories,
  type RepositoryDeps,
} from '@medcourse/db';
import {
  FIRST_DOSE_AT,
  STARTED_AT,
  afterFirstDose,
  createTestDatabase,
  insertPatient,
  startRunningCourse,
  type RunningCourse,
  type TestDatabase,
} from '@medcourse/db/testing';
import { createLogger } from '@medcourse/logger';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApi } from './app';

/**
 * The mobile API over HTTP against a real database. The sign-in goes through the same
 * repository the bot uses to confirm it; every other call must see and do exactly what the bot
 * lets the same patient see and do, and nothing of anyone else's.
 */

let testDatabase: TestDatabase;
let repos: Repositories;
let repositoryDeps: RepositoryDeps;
let app: FastifyInstance;
let clock: Date;
let told: [number, string][];
let lines: string[];

const sql = () => testDatabase.db.sql;
let telegramId = 90_000_000;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  repositoryDeps = createRepositoryDeps([{ id: 't', key: randomBytes(32) }]);
  repos = createRepositories(testDatabase.db.orm, repositoryDeps);
  app = buildApi({
    logger: createLogger({
      service: 'api-test',
      level: 'info',
      stream: { write: (line: string) => void lines.push(line) },
    }),
    db: testDatabase.db,
    orm: testDatabase.db.orm,
    repositoryDeps,
    botUsername: 'medcourse_test_bot',
    limits: { requestsPerMinute: 1_000_000, signInsPerMinute: 1_000_000 },
    notify: (id, text) => {
      told.push([id, text]);
      return Promise.resolve();
    },
    now: () => clock,
  });
});

afterAll(async () => {
  await app.close();
  await testDatabase.drop();
});

beforeEach(() => {
  clock = STARTED_AT;
  told = [];
  lines = [];
});

/** Signs a patient in the way the app does: start, confirm in the bot, poll. */
async function signIn(patientId: string): Promise<string> {
  const started = await app.inject({ method: 'POST', url: '/v1/auth/start' });
  expect(started.statusCode).toBe(200);
  const { botUrl, pollToken } = started.json<{ botUrl: string; pollToken: string }>();
  const code = /\?start=a_([A-Za-z0-9_-]+)$/.exec(botUrl)?.[1] ?? '';
  const check = await repos.appAuth.inspect({ linkCode: code, now: clock });
  if (check.status !== 'OPEN') throw new Error('sign-in not open');
  expect(
    await repos.appAuth.confirm(
      { kind: 'PATIENT', userId: patientId },
      { loginId: check.loginId, now: clock },
    ),
  ).toBe(true);
  const polled = await app.inject({ method: 'POST', url: '/v1/auth/poll', payload: { pollToken } });
  expect(polled.statusCode).toBe(200);
  return polled.json<{ accessToken: string }>().accessToken;
}

const get = (token: string, url: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

const post = (token: string, url: string, payload: object = {}, key: string = randomUUID()) =>
  app.inject({
    method: 'POST',
    url,
    payload,
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key },
  });

describe('sign-in through the bot', () => {
  it('waits for the confirmation, then gives one session, once', async () => {
    telegramId += 1;
    const patientId = await insertPatient(sql(), { telegramId, firstName: 'Aziza', lastName: 'K' });
    const started = await app.inject({ method: 'POST', url: '/v1/auth/start' });
    const { botUrl, pollToken } = started.json<{ botUrl: string; pollToken: string }>();
    expect(botUrl).toMatch(/^https:\/\/t\.me\/medcourse_test_bot\?start=a_[A-Za-z0-9_-]{22}$/);
    // The start payload of Telegram is at most 64 characters.
    expect(`a_${botUrl.split('a_')[1] ?? ''}`.length).toBeLessThanOrEqual(64);

    const waiting = await app.inject({
      method: 'POST',
      url: '/v1/auth/poll',
      payload: { pollToken },
    });
    expect(waiting.statusCode).toBe(202);

    const code = botUrl.split('a_')[1] ?? '';
    const check = await repos.appAuth.inspect({ linkCode: code, now: clock });
    expect(check.status).toBe('OPEN');
    if (check.status !== 'OPEN') return;
    await repos.appAuth.confirm(
      { kind: 'PATIENT', userId: patientId },
      { loginId: check.loginId, now: clock },
    );
    // A second confirmation of the same link changes nothing.
    expect(
      await repos.appAuth.confirm(
        { kind: 'PATIENT', userId: patientId },
        { loginId: check.loginId, now: clock },
      ),
    ).toBe(false);

    const ready = await app.inject({
      method: 'POST',
      url: '/v1/auth/poll',
      payload: { pollToken },
    });
    expect(ready.statusCode).toBe(200);
    const { accessToken } = ready.json<{ accessToken: string }>();
    const again = await app.inject({
      method: 'POST',
      url: '/v1/auth/poll',
      payload: { pollToken },
    });
    expect(again.statusCode).toBe(410);

    const me = await get(accessToken, '/v1/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ id: patientId, firstName: 'Aziza', locale: 'ru' });

    // Only hashes are stored.
    const [stored] = await sql()<{ n: number }[]>`
      select count(*)::int as n from auth_sessions where token_hash = ${accessToken}`;
    expect(stored?.n).toBe(0);

    await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect((await get(accessToken, '/v1/me')).statusCode).toBe(401);
  });

  it('expires: a link not confirmed in ten minutes is gone', async () => {
    const started = await app.inject({ method: 'POST', url: '/v1/auth/start' });
    const { botUrl, pollToken } = started.json<{ botUrl: string; pollToken: string }>();
    clock = new Date(clock.getTime() + 10 * 60_000 + 1);
    expect(
      (await repos.appAuth.inspect({ linkCode: botUrl.split('a_')[1] ?? '', now: clock })).status,
    ).toBe('INVALID');
    const polled = await app.inject({
      method: 'POST',
      url: '/v1/auth/poll',
      payload: { pollToken },
    });
    expect(polled.statusCode).toBe(410);
  });

  it('refuses without a token, with a made-up token, and for a person who is not a patient', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/me' })).statusCode).toBe(401);
    expect((await get('x'.repeat(43), '/v1/me')).statusCode).toBe(401);
    const loose = await sql()<{ id: string }[]>`
      insert into users (telegram_user_id) values (${(telegramId += 1)}) returning id`;
    const started = await app.inject({ method: 'POST', url: '/v1/auth/start' });
    const code = started.json<{ botUrl: string }>().botUrl.split('a_')[1] ?? '';
    const check = await repos.appAuth.inspect({ linkCode: code, now: clock });
    if (check.status !== 'OPEN') throw new Error('not open');
    expect(
      await repos.appAuth.confirm(
        { kind: 'PATIENT', userId: loose[0]?.id ?? '' },
        { loginId: check.loginId, now: clock },
      ),
    ).toBe(false);
  });
});

describe('a running course in the app', () => {
  let c: RunningCourse;
  let token: string;

  beforeAll(async () => {
    c = await startRunningCourse(sql(), repos);
    token = await signIn(c.patientId);
  });

  it('lists the course, shows it in full, and nothing of another patient', async () => {
    const list = await get(token, '/v1/courses');
    expect(list.statusCode).toBe(200);
    const courses = list.json<{
      courses: { id: string; status: string; medications: { times: string[] }[] }[];
    }>().courses;
    expect(courses.map((course) => course.id)).toEqual([c.courseId]);
    expect(courses[0]?.status).toBe('ACTIVE');
    expect(courses[0]?.medications[0]?.times).toEqual(['08:00', '20:00']);

    const one = await get(token, `/v1/courses/${c.courseId}`);
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ id: c.courseId, doctor: { firstName: 'Rustam' } });

    const other = await startRunningCourse(sql(), repos);
    expect((await get(token, `/v1/courses/${other.courseId}`)).statusCode).toBe(404);
    expect((await get(token, `/v1/doses/${other.firstDoseId}`)).statusCode).toBe(404);
    expect((await post(token, `/v1/doses/${other.firstDoseId}/take`)).statusCode).toBe(404);
    expect((await get(token, '/v1/courses/not-a-uuid')).statusCode).toBe(404);
  });

  it('shows today and records "taken" once for a repeated tap', async () => {
    clock = afterFirstDose(5);
    const today = await get(token, '/v1/today');
    expect(today.statusCode).toBe(200);
    const doses = today.json<{ doses: { id: string; status: string; canAnswer: boolean }[] }>()
      .doses;
    expect(doses.length).toBe(2);
    expect(doses[0]).toMatchObject({ id: c.firstDoseId, canAnswer: true });

    const key = randomUUID();
    const first = await post(token, `/v1/doses/${c.firstDoseId}/take`, {}, key);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ result: 'DONE', dose: { status: 'TAKEN' } });
    const repeated = await post(token, `/v1/doses/${c.firstDoseId}/take`, {}, key);
    expect(repeated.json()).toMatchObject({ dose: { status: 'TAKEN' } });
    const [events] = await sql()<{ n: number }[]>`
      select count(*)::int as n from dose_events
      where scheduled_dose_id = ${c.firstDoseId} and event_type = 'TAKEN'`;
    expect(events?.n).toBe(1);

    const undone = await post(token, `/v1/doses/${c.firstDoseId}/undo`);
    expect(undone.json()).toMatchObject({ result: 'DONE' });
  });

  it('asks for an idempotency key and checks what it is given', async () => {
    clock = afterFirstDose(5);
    const bare = await app.inject({
      method: 'POST',
      url: `/v1/doses/${c.firstDoseId}/take`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(bare.statusCode).toBe(400);
    expect(bare.json()).toEqual({ error: 'idempotency_key_required' });
    expect(
      (await post(token, `/v1/doses/${c.firstDoseId}/skip`, { reason: 'NOPE' })).statusCode,
    ).toBe(400);
    expect(
      (await post(token, `/v1/doses/${c.firstDoseId}/snooze`, { minutes: 'ten' })).statusCode,
    ).toBe(400);
  });

  it('refuses a "taken" more than an hour early as a mistap, with the dose', async () => {
    clock = new Date(FIRST_DOSE_AT.getTime() - 2 * 3_600_000);
    const today = await get(token, '/v1/today');
    const evening = today.json<{ doses: { id: string }[] }>().doses[1]?.id ?? '';
    const early = await post(token, `/v1/doses/${evening}/take`);
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ error: 'too_early', dose: { id: evening } });
  });

  it('writes no ids, tokens or addresses into the log', async () => {
    clock = afterFirstDose(5);
    await get(token, `/v1/courses/${c.courseId}`);
    const log = lines.join('\n');
    expect(log).not.toContain(token);
    expect(log).not.toContain(c.courseId);
    expect(log).toContain('/v1/courses/:id');
  });
});

describe('consent withdrawn', () => {
  it('closes everything but the privacy screen, and tells the doctor', async () => {
    const c = await startRunningCourse(sql(), repos);
    const token = await signIn(c.patientId);
    clock = afterFirstDose(5);
    const withdrawn = await post(token, '/v1/privacy/withdraw');
    expect(withdrawn.statusCode).toBe(200);
    expect(told.length).toBe(1);
    expect(told[0]?.[1]).toContain('Aziza Karimova');
    expect((await get(token, '/v1/today')).statusCode).toBe(403);
    expect((await get(token, '/v1/privacy')).statusCode).toBe(200);
    expect((await get(token, '/v1/me')).json()).toMatchObject({ consent: 'REVOKED' });
  });
});
