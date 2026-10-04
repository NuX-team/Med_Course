import { randomBytes } from 'node:crypto';
import {
  MAX_PANEL_LOGINS,
  createRepositories,
  createRepositoryDeps,
  systemActor,
  type Repositories,
  type RepositoryDeps,
} from '@medcourse/db';
import { createTestDatabase, insertClinic, type TestDatabase } from '@medcourse/db/testing';
import { t, type Locale } from '@medcourse/i18n';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeTelegram, PANEL_BASE_URL, createHarness, type Harness } from './test-harness';

/**
 * `/panel`: how a member of staff gets into the web panel. The bot is the only thing that knows
 * who a person is, so it hands out the one-time sign-in link; to everyone else the command does
 * not exist.
 */

let testDatabase: TestDatabase;
let repositoryDeps: RepositoryDeps;
let repos: Repositories;
let telegram: FakeTelegram;
let bot: Harness;

const sql = () => testDatabase.db.sql;
const orm = () => testDatabase.db.orm;
const NOW = new Date('2026-10-03T04:00:00Z');
const system = systemActor('panel command test');
const LINK = /https:\/\/panel\.medcourse\.test\/login\?t=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  repositoryDeps = createRepositoryDeps([{ id: 't', key: randomBytes(32) }]);
  repos = createRepositories(orm(), repositoryDeps);
});

afterAll(async () => {
  await testDatabase.drop();
});

beforeEach(() => {
  telegram = new FakeTelegram();
  bot = createHarness({ orm: orm(), repositoryDeps, telegram });
  bot.clock = NOW;
});

let nextId = 31_000_000;
const textOf = (id: number): string => telegram.lastTo(id)?.text ?? '(nothing was sent)';

async function userId(telegramId: number): Promise<string> {
  const [row] = await sql()<{ id: string }[]>`
    select id from users where telegram_user_id = ${telegramId}`;
  return row?.id ?? '';
}

async function register(locale: Locale = 'ru'): Promise<number> {
  nextId += 1;
  const id = nextId;
  await bot.say(id, '/start');
  await bot.press(id, `l:${locale}`);
  await bot.press(id, 'c:y');
  await bot.say(id, 'Malika');
  await bot.say(id, 'Usmanova');
  await bot.press(id, 'z:ok');
  return id;
}

async function techAdmin(locale: Locale = 'ru'): Promise<number> {
  const id = await register(locale);
  await repos.platform.grantTechAdmin(system, await userId(id));
  return id;
}

const linksOf = async (telegramId: number): Promise<number> =>
  (
    await sql()<{ n: number }[]>`
      select count(*)::int as n from panel_logins where user_id = ${await userId(telegramId)}`
  )[0]?.n ?? 0;

describe('/panel', () => {
  it('gives a member of staff a link that signs them in once, and keeps only its hash', async () => {
    const admin = await techAdmin();

    await bot.say(admin, '/panel');

    const text = textOf(admin);
    const token = LINK.exec(text)?.[1] ?? '';
    expect(token).not.toBe('');
    expect(text).toBe(t('ru', 'panel.link', { link: `${PANEL_BASE_URL}/login?t=${token}` }));
    expect(telegram.lastTo(admin)?.buttons ?? []).toEqual([]);
    const [stored] = await sql()<{ dump: string }[]>`
      select row_to_json(l)::text as dump from panel_logins l
      where user_id = ${await userId(admin)}`;
    expect(stored?.dump).not.toContain(token);

    const session = await repos.panel.redeemLogin({ token, now: NOW });
    expect(session).not.toBeNull();
    expect(
      (await repos.panel.session({ token: session?.sessionToken ?? '', now: NOW }))?.roles,
    ).toEqual([{ actor: { kind: 'TECH_ADMIN', userId: await userId(admin) } }]);
    expect(await repos.panel.redeemLogin({ token, now: NOW })).toBeNull();
  });

  it('works for a clinic’s front desk too, in the language they use the bot in', async () => {
    const desk = await register('uz');
    const clinicId = await insertClinic(sql());
    await repos.panel.addClinicStaff(system, { clinicId, telegramUserId: desk, role: 'RECEPTION' });

    await bot.say(desk, '/panel');

    const token = LINK.exec(textOf(desk))?.[1] ?? '';
    expect(textOf(desk)).toBe(
      t('uz', 'panel.link', { link: `${PANEL_BASE_URL}/login?t=${token}` }),
    );
  });

  it('does not exist for anyone who is not staff: they get what any unknown command gets', async () => {
    const patient = await register();
    await bot.say(patient, '/nosuchcommand');
    const unknown = telegram.lastTo(patient);

    await bot.say(patient, '/panel');

    expect(telegram.lastTo(patient)?.text).toBe(unknown?.text);
    expect(telegram.lastTo(patient)?.buttons).toEqual(unknown?.buttons);
    expect(textOf(patient)).not.toContain('login');
    expect(await linksOf(patient)).toBe(0);
  });

  it('stops working the moment the role is taken away', async () => {
    const admin = await techAdmin();
    await bot.say(admin, '/panel');
    const token = LINK.exec(textOf(admin))?.[1] ?? '';

    await sql()`
      update platform_staff set status = 'REVOKED' where user_id = ${await userId(admin)}`;

    expect(await repos.panel.redeemLogin({ token, now: NOW })).toBeNull();
    await bot.say(admin, '/panel');
    expect(textOf(admin)).not.toContain('login');
    expect(await linksOf(admin)).toBe(1);
  });

  it('sends a person who has not registered to registration, with no link', async () => {
    nextId += 1;
    await bot.say(nextId, '/panel');
    expect(textOf(nextId)).not.toContain('login');
    expect((telegram.lastTo(nextId)?.buttons ?? []).flat().map((button) => button.data)).toEqual([
      'l:ru',
      'l:uz',
    ]);
  });

  it('refuses a sixth link within a quarter of an hour, and gives one again after it', async () => {
    const admin = await techAdmin();
    for (let index = 0; index < MAX_PANEL_LOGINS; index += 1) {
      await bot.say(admin, '/panel');
      expect(textOf(admin)).toMatch(LINK);
    }

    await bot.say(admin, '/panel');
    expect(textOf(admin)).toBe(t('ru', 'panel.tooMany'));
    expect(await linksOf(admin)).toBe(MAX_PANEL_LOGINS);

    bot.clock = new Date(NOW.getTime() + 16 * 60_000);
    await bot.say(admin, '/panel');
    expect(textOf(admin)).toMatch(LINK);
  });

  it('says so when this server has no panel, and only to staff', async () => {
    const admin = await techAdmin();
    const patient = await register();
    const bare = createHarness({ orm: orm(), repositoryDeps, telegram, panelBaseUrl: null });
    bare.clock = NOW;

    await bare.say(admin, '/panel');
    expect(textOf(admin)).toBe(t('ru', 'panel.notConfigured'));

    await bare.say(patient, '/panel');
    expect(textOf(patient)).not.toBe(t('ru', 'panel.notConfigured'));
    expect(textOf(patient)).not.toContain('login');
  });
});
