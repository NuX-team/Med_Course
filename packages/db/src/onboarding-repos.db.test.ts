import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertPatient, insertUser } from '../test/fixtures';
import { createTestDatabase, type TestDatabase } from '../test/helpers';
import { systemActor, type Actor } from './access/actor';
import { createRepositories, createRepositoryDeps, type Repositories } from './repositories';

let testDatabase: TestDatabase;
let repos: Repositories;

const sql = () => testDatabase.db.sql;
const system = systemActor('onboarding test');
const patient = (userId: string): Actor => ({ kind: 'PATIENT', userId });
const at = (iso: string): Date => new Date(iso);

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  repos = createRepositories(
    testDatabase.db.orm,
    createRepositoryDeps([{ id: 't', key: randomBytes(32) }]),
  );
});

afterAll(async () => {
  await testDatabase.drop();
});

let telegramId = 5_000_000;
const nextTelegramId = (): number => (telegramId += 1);

async function violation(statement: PromiseLike<unknown>): Promise<string | undefined> {
  try {
    await statement;
  } catch (error) {
    if (error instanceof postgres.PostgresError) {
      return error.constraint_name ?? error.code;
    }
    throw error;
  }
  return undefined;
}

describe('update deduplication', () => {
  it('lets an update through once and refuses every redelivery', async () => {
    expect(await repos.telegram.claimUpdate(900_001)).toBe(true);
    expect(await repos.telegram.claimUpdate(900_001)).toBe(false);
    expect(await repos.telegram.claimUpdate(900_001)).toBe(false);
    expect(await repos.telegram.claimUpdate(900_002)).toBe(true);
  });

  it('lets exactly one of many simultaneous deliveries win', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => repos.telegram.claimUpdate(900_100)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('accepts Telegram-sized ids', async () => {
    expect(await repos.telegram.claimUpdate(9_007_199_254_740)).toBe(true);
  });

  it('forgets old updates and keeps recent ones', async () => {
    await sql()`insert into tg_updates (update_id, received_at) values (910_001, '2026-09-01T00:00:00Z')`;
    await repos.telegram.claimUpdate(910_002);

    expect(await repos.telegram.pruneUpdates(at('2026-10-01T00:00:00Z'))).toBe(1);
    expect(await repos.telegram.claimUpdate(910_001)).toBe(true);
    expect(await repos.telegram.claimUpdate(910_002)).toBe(false);
  });
});

describe('unfinished conversations', () => {
  const now = at('2026-10-02T10:00:00Z');
  const hour = 3_600_000;

  it('remembers where a person was, and replaces it on the next step', async () => {
    const id = nextTelegramId();
    await repos.telegram.setConversation(
      id,
      { flow: 'ONBOARDING', step: 'LANGUAGE', data: {} },
      now,
      hour,
    );
    expect(await repos.telegram.getConversation(id, now)).toEqual({
      flow: 'ONBOARDING',
      step: 'LANGUAGE',
      data: {},
    });

    await repos.telegram.setConversation(
      id,
      { flow: 'ONBOARDING', step: 'CONSENT', data: { locale: 'uz' } },
      now,
      hour,
    );
    expect(await repos.telegram.getConversation(id, now)).toEqual({
      flow: 'ONBOARDING',
      step: 'CONSENT',
      data: { locale: 'uz' },
    });
  });

  it('treats an expired conversation as none, exactly at the expiry moment', async () => {
    const id = nextTelegramId();
    await repos.telegram.setConversation(
      id,
      { flow: 'ONBOARDING', step: 'FIRST_NAME', data: {} },
      now,
      hour,
    );

    expect(await repos.telegram.getConversation(id, at('2026-10-02T10:59:59.999Z'))).not.toBeNull();
    expect(await repos.telegram.getConversation(id, at('2026-10-02T11:00:00.000Z'))).toBeNull();
  });

  it('extends the deadline whenever the person takes a step', async () => {
    const id = nextTelegramId();
    await repos.telegram.setConversation(
      id,
      { flow: 'ONBOARDING', step: 'FIRST_NAME', data: {} },
      now,
      hour,
    );
    await repos.telegram.setConversation(
      id,
      { flow: 'ONBOARDING', step: 'LAST_NAME', data: {} },
      at('2026-10-02T10:50:00Z'),
      hour,
    );

    expect(await repos.telegram.getConversation(id, at('2026-10-02T11:30:00Z'))).not.toBeNull();
  });

  it('keeps people apart and can clear one', async () => {
    const a = nextTelegramId();
    const b = nextTelegramId();
    await repos.telegram.setConversation(
      a,
      { flow: 'ONBOARDING', step: 'LANGUAGE', data: {} },
      now,
      hour,
    );
    await repos.telegram.setConversation(
      b,
      { flow: 'SETTINGS', step: 'TIMEZONE', data: {} },
      now,
      hour,
    );

    await repos.telegram.clearConversation(a);
    expect(await repos.telegram.getConversation(a, now)).toBeNull();
    expect(await repos.telegram.getConversation(b, now)).toMatchObject({ flow: 'SETTINGS' });
  });

  it('purges only what has expired', async () => {
    const stale = nextTelegramId();
    const fresh = nextTelegramId();
    await repos.telegram.setConversation(
      stale,
      { flow: 'ONBOARDING', step: 'LANGUAGE', data: {} },
      at('2026-09-01T00:00:00Z'),
      hour,
    );
    await repos.telegram.setConversation(
      fresh,
      { flow: 'ONBOARDING', step: 'LANGUAGE', data: {} },
      now,
      hour,
    );

    expect(await repos.telegram.purgeExpiredConversations(now)).toBeGreaterThanOrEqual(1);
    expect(await repos.telegram.getConversation(fresh, now)).not.toBeNull();
    const rows = await sql()`select 1 from conversation_states where telegram_user_id = ${stale}`;
    expect(rows).toHaveLength(0);
  });

  it('survives awkward data and refuses unknown flows', async () => {
    const id = nextTelegramId();
    const data = { name: 'O\'Brien "Ж" 🙂', nested: { a: [1, 2, 3] }, nothing: null };
    await repos.telegram.setConversation(
      id,
      { flow: 'ONBOARDING', step: 'LAST_NAME', data },
      now,
      hour,
    );
    expect((await repos.telegram.getConversation(id, now))?.data).toEqual(data);

    expect(
      await violation(
        sql()`insert into conversation_states (telegram_user_id, flow, step, expires_at) values (${nextTelegramId()}, 'TICKETS', 'X', now())`,
      ),
    ).toBe('conversation_states_flow_chk');
  });
});

describe('accounts', () => {
  it('opens an account once per Telegram id, however many times it is asked', async () => {
    const id = nextTelegramId();
    const first = await repos.users.create(system, { telegramUserId: id, locale: 'uz' });
    const again = await repos.users.create(system, { telegramUserId: id, locale: 'ru' });

    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.user.id).toBe(first.user.id);
    expect(again.user.locale).toBe('uz');
    const audit = await sql()`select action from audit_log where entity_id = ${first.user.id}`;
    expect(audit).toEqual([{ action: 'CREATE' }]);
  });

  it('survives a burst of simultaneous creations', async () => {
    const id = nextTelegramId();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        repos.users.create(system, { telegramUserId: id, locale: 'ru' }),
      ),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.user.id)).size).toBe(1);
  });

  it('starts with the Tashkent default, unconfirmed', async () => {
    const { user } = await repos.users.create(system, {
      telegramUserId: nextTelegramId(),
      locale: 'ru',
    });
    expect(user).toMatchObject({
      timezone: 'Asia/Tashkent',
      timezoneConfirmedAt: null,
      status: 'ACTIVE',
    });
  });

  it('finds an account by Telegram id, for the system alone', async () => {
    const id = nextTelegramId();
    const { user } = await repos.users.create(system, { telegramUserId: id, locale: 'ru' });

    expect((await repos.users.findByTelegramId(system, id))?.id).toBe(user.id);
    expect(await repos.users.findByTelegramId(system, nextTelegramId())).toBeNull();
    await expect(repos.users.findByTelegramId(patient(user.id), id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('opens accounts only for the system', async () => {
    const other = await insertUser(sql());
    await expect(
      repos.users.create(patient(other), { telegramUserId: nextTelegramId(), locale: 'ru' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('lets a person change their language and audits it; a repeat is not a change', async () => {
    const { user } = await repos.users.create(system, {
      telegramUserId: nextTelegramId(),
      locale: 'ru',
    });
    const self = patient(user.id);

    expect((await repos.users.setLocale(self, user.id, 'uz'))?.locale).toBe('uz');
    await repos.users.setLocale(self, user.id, 'uz');

    const audit = await sql()<{ changes: string[] }[]>`
      select changes from audit_log where entity_id = ${user.id} and action = 'UPDATE'`;
    expect(audit).toEqual([{ changes: ['locale'] }]);
  });

  it('records a confirmed timezone with the moment, and says what changed', async () => {
    const { user } = await repos.users.create(system, {
      telegramUserId: nextTelegramId(),
      locale: 'ru',
    });
    const self = patient(user.id);

    const sameZone = await repos.users.confirmTimezone(
      self,
      user.id,
      'Asia/Tashkent',
      at('2026-10-02T10:00:00Z'),
    );
    expect(sameZone).toMatchObject({
      timezone: 'Asia/Tashkent',
      timezoneConfirmedAt: at('2026-10-02T10:00:00Z'),
    });
    await repos.users.confirmTimezone(self, user.id, 'Asia/Almaty', at('2026-10-03T10:00:00Z'));

    const audit = await sql()<{ changes: string[] }[]>`
      select changes from audit_log where entity_id = ${user.id} and action = 'UPDATE' order by id`;
    expect(audit.map((row) => row.changes)).toEqual([
      ['timezone_confirmed_at'],
      ['timezone', 'timezone_confirmed_at'],
    ]);
  });

  it('lets nobody change another person’s account, and nothing happens to a blocked one', async () => {
    const a = await repos.users.create(system, { telegramUserId: nextTelegramId(), locale: 'ru' });
    const b = await repos.users.create(system, { telegramUserId: nextTelegramId(), locale: 'ru' });

    await expect(repos.users.setLocale(patient(b.user.id), a.user.id, 'uz')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      repos.users.confirmTimezone(
        patient(b.user.id),
        a.user.id,
        'Asia/Dubai',
        at('2026-10-02T00:00:00Z'),
      ),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await sql()`update users set status = 'BLOCKED' where id = ${a.user.id}`;
    expect(await repos.users.setLocale(patient(a.user.id), a.user.id, 'uz')).toBeNull();
    expect(
      await repos.users.confirmTimezone(
        patient(a.user.id),
        a.user.id,
        'Asia/Dubai',
        at('2026-10-02T00:00:00Z'),
      ),
    ).toBeNull();
    expect((await repos.users.getOwn(system, a.user.id))?.locale).toBe('ru');
  });

  it('shows an account only to its owner and the system', async () => {
    const a = await repos.users.create(system, { telegramUserId: nextTelegramId(), locale: 'ru' });
    const b = await repos.users.create(system, { telegramUserId: nextTelegramId(), locale: 'ru' });

    expect((await repos.users.getOwn(patient(a.user.id), a.user.id))?.id).toBe(a.user.id);
    expect((await repos.users.getOwn(system, a.user.id))?.id).toBe(a.user.id);
    expect(await repos.users.getOwn(patient(b.user.id), a.user.id)).toBeNull();
    expect(
      await repos.users.getOwn({ kind: 'TECH_ADMIN', userId: b.user.id }, a.user.id),
    ).toBeNull();
  });
});

describe('consent', () => {
  const input = (
    userId: string,
    extra: Partial<Parameters<Repositories['consents']['record']>[1]> = {},
  ) => ({
    userId,
    kind: 'PERSONAL_DATA' as const,
    version: 'v1',
    decision: 'GRANTED' as const,
    locale: 'ru' as const,
    context: 'ONBOARDING' as const,
    ...extra,
  });

  it('records a decision and reports a repeat as nothing new', async () => {
    const userId = await insertUser(sql());
    const first = await repos.consents.record(patient(userId), input(userId));
    const again = await repos.consents.record(patient(userId), input(userId));

    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.record.id).toBe(first.record.id);
    expect(await sql()`select 1 from consent_records where user_id = ${userId}`).toHaveLength(1);
  });

  it('writes one row when the same person taps ten times at once', async () => {
    const userId = await insertUser(sql());
    const results = await Promise.all(
      Array.from({ length: 10 }, () => repos.consents.record(patient(userId), input(userId))),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(await sql()`select 1 from consent_records where user_id = ${userId}`).toHaveLength(1);
  });

  it('keeps the whole history: withdrawing and granting again are new rows', async () => {
    const userId = await insertUser(sql());
    const self = patient(userId);
    await repos.consents.record(self, input(userId));
    await repos.consents.record(self, input(userId, { decision: 'REVOKED', context: 'SETTINGS' }));
    await repos.consents.record(self, input(userId));

    const rows = await sql()<
      { decision: string }[]
    >`select decision from consent_records where user_id = ${userId} order by at, id`;
    expect(rows.map((row) => row.decision)).toEqual(['GRANTED', 'REVOKED', 'GRANTED']);
  });

  it('counts consent only for the exact version of the text, and only while the latest decision is a grant', async () => {
    const userId = await insertUser(sql());
    const self = patient(userId);
    expect(await repos.consents.isGranted(self, userId, 'PERSONAL_DATA', 'v1')).toBe(false);

    await repos.consents.record(self, input(userId));
    expect(await repos.consents.isGranted(self, userId, 'PERSONAL_DATA', 'v1')).toBe(true);
    expect(await repos.consents.isGranted(self, userId, 'PERSONAL_DATA', 'v2')).toBe(false);

    await repos.consents.record(self, input(userId, { decision: 'REVOKED' }));
    expect(await repos.consents.isGranted(self, userId, 'PERSONAL_DATA', 'v1')).toBe(false);

    await repos.consents.record(self, input(userId, { version: 'v2' }));
    expect((await repos.consents.latest(self, userId, 'PERSONAL_DATA'))?.version).toBe('v2');
  });

  it('is a person’s own business: others see and write nothing', async () => {
    const owner = await insertPatient(sql());
    const other = await insertPatient(sql());
    await repos.consents.record(patient(owner), input(owner));

    await expect(repos.consents.record(patient(other), input(owner))).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(await repos.consents.latest(patient(other), owner, 'PERSONAL_DATA')).toBeNull();
    expect(await repos.consents.isGranted(patient(other), owner, 'PERSONAL_DATA', 'v1')).toBe(
      false,
    );
    expect(await repos.consents.latest(system, owner, 'PERSONAL_DATA')).not.toBeNull();
  });

  it('can never be edited or deleted', async () => {
    const userId = await insertUser(sql());
    await repos.consents.record(patient(userId), input(userId));

    expect(
      await violation(
        sql()`update consent_records set decision = 'REVOKED' where user_id = ${userId}`,
      ),
    ).toBe('23001');
    expect(await violation(sql()`delete from consent_records where user_id = ${userId}`)).toBe(
      '23001',
    );
    expect(await violation(sql()`truncate consent_records`)).toBe('23001');
  });
});
