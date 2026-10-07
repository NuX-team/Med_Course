import { randomBytes } from 'node:crypto';
import {
  createRepositories,
  createRepositoryDeps,
  systemActor,
  type Repositories,
  type RepositoryDeps,
} from '@medcourse/db';
import { createTestDatabase, type TestDatabase } from '@medcourse/db/testing';
import { t, type Locale } from '@medcourse/i18n';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeTelegram, createHarness, type Harness } from './test-harness';

/**
 * The administrator's section in the chat (stage 16): offered to an administrator and to nobody
 * else; doctors are confirmed with a written note of what was checked, withdrawn after a second
 * question; other administrators are made and unmade by Telegram id. What the person is allowed
 * to do is the database's decision on every press, so the tests also press buttons of a section
 * the person was never offered, or no longer has.
 */

let testDatabase: TestDatabase;
let repositoryDeps: RepositoryDeps;
let repos: Repositories;
let telegram: FakeTelegram;
let bot: Harness;

const sql = () => testDatabase.db.sql;
const NOW = new Date('2026-10-05T07:00:00Z');
const system = systemActor('admin section test');

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  repositoryDeps = createRepositoryDeps([{ id: 't', key: randomBytes(32) }]);
  repos = createRepositories(testDatabase.db.orm, repositoryDeps);
  telegram = new FakeTelegram();
  bot = createHarness({ orm: testDatabase.db.orm, repositoryDeps, telegram });
  bot.clock = NOW;
});

afterAll(async () => {
  await testDatabase.drop();
});

let nextId = 52_000_000;
const textOf = (id: number): string => telegram.lastTo(id)?.text ?? '(nothing was sent)';
const dataOf = (id: number): string[] =>
  (telegram.lastTo(id)?.buttons ?? []).flat().map((button) => button.data);
const labelsOf = (id: number): string[] =>
  (telegram.lastTo(id)?.buttons ?? []).flat().map((button) => button.text);
const sentCount = (id: number): number => telegram.messagesTo(id).length;

async function userId(telegramId: number): Promise<string> {
  const [row] = await sql()<{ id: string }[]>`
    select id from users where telegram_user_id = ${telegramId}`;
  return row?.id ?? '';
}

async function register(
  options: { locale?: Locale; first?: string; last?: string } = {},
): Promise<number> {
  nextId += 1;
  const id = nextId;
  await bot.say(id, '/start');
  await bot.press(id, `l:${options.locale ?? 'ru'}`);
  await bot.press(id, 'c:y');
  await bot.say(id, options.first ?? 'Malika');
  await bot.say(id, options.last ?? 'Usmanova');
  await bot.press(id, 'z:ok');
  return id;
}

async function techAdmin(
  options: { locale?: Locale; first?: string; last?: string } = {},
): Promise<number> {
  const id = await register(options);
  await repos.platform.grantTechAdmin(system, await userId(id));
  return id;
}

/** Registers, then applies to be a doctor, and stops there: PENDING. */
async function applicant(
  first: string,
  options: { locale?: Locale; note?: string } = {},
): Promise<number> {
  const id = await register({ first, last: 'Tester', ...options });
  await bot.press(id, 'm:d');
  await bot.press(id, 'd:r');
  await bot.say(id, options.note ?? 'Pediatrician, City Clinic No. 5, licence UZ-1');
  return id;
}

const statusOf = async (telegramId: number): Promise<string> =>
  (
    await sql()<{ verification_status: string }[]>`
      select verification_status from clinician_profiles where user_id = ${await userId(telegramId)}`
  )[0]?.verification_status ?? 'none';

const referenceOf = async (telegramId: number): Promise<string | null> =>
  (
    await sql()<{ verification_reference: string | null }[]>`
      select verification_reference from clinician_profiles where user_id = ${await userId(telegramId)}`
  )[0]?.verification_reference ?? null;

const isAdmin = async (telegramId: number): Promise<boolean> =>
  repos.platform.isTechAdmin(await userId(telegramId));

/** Opens the section and walks to one doctor's card, the way a person would. */
async function openCard(admin: number, name: string): Promise<void> {
  await bot.say(admin, '/admin');
  await bot.press(admin, 'a:a');
  await bot.press(admin, bot.buttonLabelled(admin, name).data);
}

describe('who is offered the section', () => {
  it('shows an administrator the button, and nobody else', async () => {
    const admin = await techAdmin();
    const patient = await register();

    await bot.say(admin, '/menu');
    await bot.say(patient, '/menu');

    expect(labelsOf(admin)).toContain(t('ru', 'admin.menu'));
    expect(dataOf(admin)).toContain('m:a');
    expect(labelsOf(patient)).not.toContain(t('ru', 'admin.menu'));
    expect(dataOf(patient)).not.toContain('m:a');
  });

  it('has /admin open it for an administrator, in their language, and not exist for others', async () => {
    const admin = await techAdmin({ locale: 'uz' });
    const patient = await register();

    await bot.say(admin, '/admin');
    expect(textOf(admin)).toBe(t('uz', 'admin.title'));

    const before = sentCount(patient);
    await bot.say(patient, '/nosuchcommand');
    const unknown = telegram.lastTo(patient);
    await bot.say(patient, '/admin');
    expect(sentCount(patient)).toBe(before + 2);
    expect(telegram.lastTo(patient)?.text).toBe(unknown?.text);
    expect(telegram.lastTo(patient)?.buttons).toEqual(unknown?.buttons);
  });

  it('does nothing for a button pressed by someone who is not an administrator', async () => {
    const admin = await techAdmin();
    const stranger = await register();
    const who = await applicant('Nodira');
    await openCard(admin, 'Nodira Tester');
    const buttons = dataOf(admin);
    expect(buttons.length).toBeGreaterThan(0);
    const before = sentCount(stranger);

    for (const data of ['m:a', 'a:a', 'a:d', 'a:s', 'a:i', 'a:m', 'a:n', ...buttons]) {
      await bot.press(stranger, data);
    }

    expect(sentCount(stranger)).toBe(before);
    expect(await statusOf(who)).toBe('PENDING');
    expect(await isAdmin(stranger)).toBe(false);
  });
});

describe('applications', () => {
  it('lists who is waiting, and opens one with what they wrote about themselves', async () => {
    const admin = await techAdmin();
    await applicant('Zilola', { note: 'Therapist, licence UZ-77' });

    await bot.say(admin, '/admin');
    await bot.press(admin, 'a:a');

    expect(textOf(admin)).toMatch(/^Заявки врачей, ждут проверки: \d+\./);
    await bot.press(admin, bot.buttonLabelled(admin, 'Zilola Tester').data);
    const card = textOf(admin);
    expect(card).toContain('Zilola Tester');
    expect(card).toContain('Статус: ждёт проверки');
    expect(card).toContain('Написал(а): Therapist, licence UZ-77');
    expect(card).toContain('Telegram id: ');
    expect(card).not.toContain('Что проверено');
    expect(labelsOf(admin)).toContain(t('ru', 'admin.verifyButton'));
    expect(labelsOf(admin)).not.toContain(t('ru', 'admin.revokeButton'));
    expect(dataOf(admin)).toContain('a:a');
    expect(dataOf(admin)).not.toContain('a:d');
  });

  it('shows the number waiting on the section’s own button', async () => {
    const admin = await techAdmin();
    await applicant('Kamola');
    await bot.say(admin, '/admin');
    const [row] = await sql()<{ n: number }[]>`
      select count(*)::int as n from clinician_profiles where verification_status = 'PENDING'`;
    expect(labelsOf(admin)).toContain(t('ru', 'admin.applicationsButton', { n: row?.n ?? -1 }));
  });

  it('says so when nobody is waiting', async () => {
    const admin = await techAdmin();
    await sql()`update clinician_profiles set verification_status = 'REVOKED' where verification_status = 'PENDING'`;
    await bot.say(admin, '/admin');
    await bot.press(admin, 'a:a');
    expect(textOf(admin)).toBe(t('ru', 'admin.noApplications'));
  });
});

describe('confirming a doctor', () => {
  it('asks what was checked, keeps the answer, and tells the doctor in their language', async () => {
    const admin = await techAdmin();
    const doctor = await applicant('Dilfuza', { locale: 'uz' });
    await openCard(admin, 'Dilfuza Tester');

    await bot.press(admin, bot.buttonLabelled(admin, t('ru', 'admin.verifyButton')).data);
    expect(textOf(admin)).toContain('Подтвердить врача Dilfuza Tester?');
    expect(await statusOf(doctor)).toBe('PENDING');

    await bot.say(admin, 'лицензия UZ-123 проверена по реестру');

    expect(await statusOf(doctor)).toBe('VERIFIED');
    expect(await referenceOf(doctor)).toBe('лицензия UZ-123 проверена по реестру');
    expect(textOf(admin)).toBe(t('ru', 'admin.verified', { name: 'Dilfuza Tester' }));
    expect(textOf(doctor)).toBe(t('uz', 'doctor.verified'));
    const [audit] = await sql()<{ n: number }[]>`
      select count(*)::int as n from audit_log
      where entity_type = 'clinician_profiles' and entity_id = ${await userId(doctor)}
        and action = 'VERIFY'`;
    expect(audit?.n).toBe(1);
  });

  it('does not accept a note of a word or two, and goes on waiting for a real one', async () => {
    const admin = await techAdmin();
    const doctor = await applicant('Gulnora');
    await openCard(admin, 'Gulnora Tester');
    await bot.press(admin, bot.buttonLabelled(admin, t('ru', 'admin.verifyButton')).data);

    await bot.say(admin, 'ok');
    expect(textOf(admin)).toBe(t('ru', 'admin.referenceShort'));
    expect(await statusOf(doctor)).toBe('PENDING');

    await bot.say(admin, 'проверено лично');
    expect(await statusOf(doctor)).toBe('VERIFIED');
  });

  it('does not take what is typed after "Cancel" for a note', async () => {
    const admin = await techAdmin();
    const doctor = await applicant('Shahlo');
    await openCard(admin, 'Shahlo Tester');
    await bot.press(admin, bot.buttonLabelled(admin, t('ru', 'admin.verifyButton')).data);

    await bot.press(admin, bot.buttonLabelled(admin, t('ru', 'admin.cancelButton')).data);
    expect(textOf(admin)).toBe(t('ru', 'admin.cancelled'));
    await bot.say(admin, 'лицензия проверена');

    expect(await statusOf(doctor)).toBe('PENDING');
    expect(await referenceOf(doctor)).toBeNull();
  });

  it('says "already" and changes nothing for a doctor who is confirmed', async () => {
    const admin = await techAdmin();
    const doctor = await applicant('Barno');
    await openCard(admin, 'Barno Tester');
    const confirm = bot.buttonLabelled(admin, t('ru', 'admin.verifyButton')).data;
    await bot.press(admin, confirm);
    await bot.say(admin, 'первая проверка');

    await bot.press(admin, confirm);

    expect(textOf(admin)).toBe(t('ru', 'admin.alreadyVerified', { name: 'Barno Tester' }));
    expect(await referenceOf(doctor)).toBe('первая проверка');
  });

  it('forgets the question when the administrator is no longer one: what they type confirms nobody', async () => {
    const admin = await techAdmin();
    const doctor = await applicant('Mohira');
    await openCard(admin, 'Mohira Tester');
    await bot.press(admin, bot.buttonLabelled(admin, t('ru', 'admin.verifyButton')).data);

    await sql()`update platform_staff set status = 'REVOKED' where user_id = ${await userId(admin)}`;
    await bot.say(admin, 'лицензия проверена');

    expect(await statusOf(doctor)).toBe('PENDING');
    const [stored] = await sql()<{ n: number }[]>`
      select count(*)::int as n from conversation_states where telegram_user_id = ${admin}`;
    expect(stored?.n).toBe(0);
  });

  it('keeps the long note to a size the card can show', async () => {
    const admin = await techAdmin();
    const doctor = await applicant('Sevara');
    await openCard(admin, 'Sevara Tester');
    await bot.press(admin, bot.buttonLabelled(admin, t('ru', 'admin.verifyButton')).data);

    await bot.say(admin, 'я'.repeat(500));

    expect(Array.from((await referenceOf(doctor)) ?? '').length).toBe(200);
  });
});

describe('withdrawing a doctor', () => {
  it('asks twice, then closes their access at once', async () => {
    const admin = await techAdmin();
    const doctor = await applicant('Lola');
    await openCard(admin, 'Lola Tester');
    await bot.press(admin, bot.buttonLabelled(admin, t('ru', 'admin.verifyButton')).data);
    await bot.say(admin, 'проверено');
    expect(await statusOf(doctor)).toBe('VERIFIED');

    await bot.press(admin, 'a:d');
    await bot.press(admin, bot.buttonLabelled(admin, 'Lola Tester').data);
    expect(textOf(admin)).toContain('Статус: подтверждён');
    expect(textOf(admin)).toContain('Что проверено: проверено');
    expect(dataOf(admin)).toContain('a:d');
    expect(dataOf(admin)).not.toContain('a:a');
    await bot.press(admin, bot.buttonLabelled(admin, t('ru', 'admin.revokeButton')).data);
    expect(textOf(admin)).toBe(t('ru', 'admin.revokeAsk', { name: 'Lola Tester' }));
    expect(labelsOf(admin)).toContain(t('ru', 'admin.cancelButton'));
    expect(await statusOf(doctor)).toBe('VERIFIED');
    expect(dataOf(admin)).not.toContain('a:d');

    await bot.press(admin, bot.buttonLabelled(admin, t('ru', 'admin.revokeYesButton')).data);

    expect(textOf(admin)).toBe(t('ru', 'admin.revoked', { name: 'Lola Tester' }));
    expect(await statusOf(doctor)).toBe('REVOKED');
    expect(
      await repos.clinicians.getOwn(
        { kind: 'PATIENT', userId: await userId(doctor) },
        await userId(doctor),
      ),
    ).toMatchObject({ verificationStatus: 'REVOKED' });
  });

  it('does not withdraw on the first press, and says "already" the second time', async () => {
    const admin = await techAdmin();
    const doctor = await applicant('Nigora');
    await openCard(admin, 'Nigora Tester');
    await bot.press(admin, bot.buttonLabelled(admin, t('ru', 'admin.verifyButton')).data);
    await bot.say(admin, 'проверено');
    const id = await userId(doctor);

    await bot.press(admin, `ap:r:${id}`);
    expect(await statusOf(doctor)).toBe('VERIFIED');
    await bot.press(admin, `ap:y:${id}`);
    await bot.press(admin, `ap:y:${id}`);

    expect(textOf(admin)).toBe(t('ru', 'admin.alreadyRevoked', { name: 'Nigora Tester' }));
  });

  it('offers a withdrawn doctor reinstatement under that name, with the same question about what was checked', async () => {
    const admin = await techAdmin();
    const doctor = await applicant('Umida');
    const id = await userId(doctor);
    await openCard(admin, 'Umida Tester');
    await bot.press(admin, bot.buttonLabelled(admin, t('ru', 'admin.verifyButton')).data);
    await bot.say(admin, 'проверено');
    await bot.press(admin, `ap:r:${id}`);
    await bot.press(admin, `ap:y:${id}`);
    expect(await statusOf(doctor)).toBe('REVOKED');

    await bot.press(admin, `ap:o:${id}`);

    expect(textOf(admin)).toContain('Статус: статус отозван');
    expect(labelsOf(admin)).toContain(t('ru', 'admin.reinstateButton'));
    expect(labelsOf(admin)).not.toContain(t('ru', 'admin.verifyButton'));
    expect(labelsOf(admin)).not.toContain(t('ru', 'admin.revokeButton'));
    await bot.press(admin, bot.buttonLabelled(admin, t('ru', 'admin.reinstateButton')).data);
    expect(textOf(admin)).toContain('Подтвердить врача Umida Tester?');
    await bot.say(admin, 'восстановлено после разбирательства');
    expect(await statusOf(doctor)).toBe('VERIFIED');
    expect(await referenceOf(doctor)).toBe('восстановлено после разбирательства');
  });

  it('says there is no such doctor for an id that belongs to nobody', async () => {
    const admin = await techAdmin();
    await bot.say(admin, '/admin');
    const nobody = '00000000-0000-4000-8000-000000000000';

    for (const code of ['o', 'v', 'r', 'y']) {
      await bot.press(admin, `ap:${code}:${nobody}`);
      expect(textOf(admin), code).toBe(t('ru', 'admin.noDoctor'));
    }
  });
});

describe('the state of the service', () => {
  it('shows the queues, the doctors and the open incidents in numbers, and no names', async () => {
    const admin = await techAdmin();
    await applicant('Rayhona');
    await sql()`
      insert into incidents (kind, type, dedupe_key, details, opened_at)
      values ('TECHNICAL', 'QUEUE_LATE', 'admin-test-stats', '{"reminders": 4}'::jsonb, ${NOW})`;
    const stats = await repos.panel.techStats(
      { kind: 'TECH_ADMIN', userId: await userId(admin) },
      NOW,
    );

    await bot.say(admin, '/admin');
    await bot.press(admin, 'a:s');

    const text = textOf(admin);
    expect(text).toContain(t('ru', 'admin.statsTitle'));
    expect(text).toContain(
      t('ru', 'admin.statsPeople', {
        users: stats.users,
        verified: stats.doctors.VERIFIED ?? 0,
        pending: stats.doctors.PENDING ?? 0,
      }),
    );
    expect(text).toContain(
      t('ru', 'admin.statsQueue', {
        title: t('ru', 'pn.tech.reminders'),
        overdue: stats.reminders.overdue,
        stuck: stats.reminders.stuck,
      }),
    );
    expect(text).toMatch(/Открытых инцидентов: [1-9]/);
    expect(text).not.toContain('Rayhona');
  });

  it('lists the open incidents by kind and time, and says so when there are none', async () => {
    const admin = await techAdmin();
    await sql()`delete from incidents`;
    await bot.say(admin, '/admin');
    await bot.press(admin, 'a:i');
    expect(textOf(admin)).toBe(t('ru', 'admin.noIncidents'));

    await sql()`
      insert into incidents (kind, type, dedupe_key, details, opened_at)
      values ('TECHNICAL', 'QUEUE_STUCK', 'admin-test-list', '{"reminders": 2}'::jsonb, ${NOW})`;
    await bot.press(admin, 'a:i');

    expect(textOf(admin)).toBe(
      [
        t('ru', 'admin.incidentsTitle', { n: 1 }),
        t('ru', 'admin.incidentLine', {
          type: t('ru', 'pn.inc.type.QUEUE_STUCK'),
          date: '05.10.2026 12:00',
        }),
      ].join('\n'),
    );
  });
});

describe('administrators', () => {
  // Each test starts with only the administrators it makes itself: the list is short, and what it shows is exact.
  beforeEach(async () => {
    await sql()`update platform_staff set status = 'REVOKED'`;
  });

  it('makes another administrator by Telegram id, tells them, and shows them the section', async () => {
    const admin = await techAdmin();
    const newcomer = await register({ first: 'Jasur', last: 'Karimov', locale: 'uz' });
    await bot.say(newcomer, '/admin');
    expect(textOf(newcomer)).not.toBe(t('uz', 'admin.title'));

    await bot.say(admin, '/admin');
    await bot.press(admin, 'a:m');
    expect(textOf(admin)).toMatch(/^Администраторы: \d+/);
    await bot.press(admin, bot.buttonLabelled(admin, t('ru', 'admin.addAdminButton')).data);
    expect(textOf(admin)).toBe(t('ru', 'admin.askAdminId'));
    await bot.say(admin, String(newcomer));

    expect(await isAdmin(newcomer)).toBe(true);
    expect(textOf(admin)).toBe(t('ru', 'admin.adminAdded', { name: 'Jasur Karimov' }));
    expect(textOf(newcomer)).toBe(t('uz', 'admin.youAreAdmin'));
    await bot.say(newcomer, '/menu');
    expect(labelsOf(newcomer)).toContain(t('uz', 'admin.menu'));
    await bot.say(newcomer, '/admin');
    expect(textOf(newcomer)).toBe(t('uz', 'admin.title'));
    const [audit] = await sql()<{ n: number }[]>`
      select count(*)::int as n from audit_log
      where entity_type = 'platform_staff' and entity_id = ${await userId(newcomer)}`;
    expect(audit?.n).toBe(1);
  });

  it('refuses what is not an id, and an id nobody has, and goes on waiting for a good one', async () => {
    const admin = await techAdmin();
    const person = await register();
    await bot.say(admin, '/admin');
    await bot.press(admin, 'a:m');
    await bot.press(admin, bot.buttonLabelled(admin, t('ru', 'admin.addAdminButton')).data);

    for (const typed of ['Jasur', '12 34', '-5', '0', '1234567890123456', '']) {
      await bot.say(admin, typed.length === 0 ? ' ' : typed);
      expect(textOf(admin), typed).toBe(t('ru', 'admin.badId'));
    }
    await bot.say(admin, '999999999');
    expect(textOf(admin)).toBe(t('ru', 'admin.noAccount'));
    expect(await isAdmin(person)).toBe(false);

    await bot.say(admin, String(person));
    expect(await isAdmin(person)).toBe(true);
  });

  it('says "already" for an administrator, and does not tell them again', async () => {
    const admin = await techAdmin();
    const other = await techAdmin({ first: 'Anvar', last: 'Salimov' });
    const told = sentCount(other);
    await bot.say(admin, '/admin');
    await bot.press(admin, 'a:m');
    await bot.press(admin, bot.buttonLabelled(admin, t('ru', 'admin.addAdminButton')).data);

    await bot.say(admin, String(other));

    expect(textOf(admin)).toBe(t('ru', 'admin.adminAlready', { name: 'Anvar Salimov' }));
    expect(sentCount(other)).toBe(told);
  });

  it('takes rights away after a second question, tells the person, and closes the section for them', async () => {
    const admin = await techAdmin();
    const other = await techAdmin({ first: 'Botir', last: 'Ergashev', locale: 'uz' });
    await bot.say(other, '/admin');
    const stale = dataOf(other);

    await bot.say(admin, '/admin');
    await bot.press(admin, 'a:m');
    await bot.press(admin, bot.buttonLabelled(admin, 'Botir Ergashev').data);
    expect(textOf(admin)).toBe(t('ru', 'admin.removeAdminAsk', { name: 'Botir Ergashev' }));
    expect(await isAdmin(other)).toBe(true);
    await bot.press(admin, bot.buttonLabelled(admin, t('ru', 'admin.removeAdminYesButton')).data);

    expect(await isAdmin(other)).toBe(false);
    expect(textOf(admin)).toBe(t('ru', 'admin.adminRemoved', { name: 'Botir Ergashev' }));
    expect(
      telegram.messagesTo(other).some((message) => message.text === t('uz', 'admin.youRemoved')),
    ).toBe(true);
    // Buttons from the section they used to have do nothing now.
    const before = sentCount(other);
    for (const data of stale) {
      await bot.press(other, data);
    }
    expect(sentCount(other)).toBe(before);
    await bot.say(other, '/menu');
    expect(labelsOf(other)).not.toContain(t('uz', 'admin.menu'));
  });

  it('does not offer to remove oneself, and refuses when asked to anyway', async () => {
    const admin = await techAdmin({ first: 'Ozoda', last: 'Yusupova' });
    const id = await userId(admin);
    await bot.say(admin, '/admin');
    await bot.press(admin, 'a:m');
    expect(labelsOf(admin).some((label) => label.includes('Ozoda'))).toBe(false);

    await bot.press(admin, `ap:x:${id}`);
    await bot.press(admin, `ap:z:${id}`);

    expect(await isAdmin(admin)).toBe(true);
    expect(textOf(admin)).toBe(t('ru', 'admin.removeSelf'));
  });

  it('says the person is no longer an administrator when they already were removed', async () => {
    const admin = await techAdmin();
    const other = await techAdmin({ first: 'Temur', last: 'Aliyev' });
    await bot.say(admin, '/admin');
    await bot.press(admin, 'a:m');
    await bot.press(admin, bot.buttonLabelled(admin, 'Temur Aliyev').data);
    await sql()`update platform_staff set status = 'REVOKED' where user_id = ${await userId(other)}`;

    await bot.press(admin, bot.buttonLabelled(admin, t('ru', 'admin.removeAdminYesButton')).data);

    expect(textOf(admin)).toBe(t('ru', 'admin.notAdmin'));
  });

  it('cuts a long list and says so, instead of quietly leaving people off it', async () => {
    const admin = await techAdmin({ first: 'Asal', last: 'Boss' });
    for (let index = 0; index < 22; index += 1) {
      await techAdmin({ first: `Person${String(index).padStart(2, '0')}`, last: 'Many' });
    }

    await bot.say(admin, '/admin');
    await bot.press(admin, 'a:m');

    expect(dataOf(admin).filter((data) => data.startsWith('ap:x:'))).toHaveLength(20);
    expect(textOf(admin)).toBe(
      `${t('ru', 'admin.adminsTitle', { n: 23 })}

${t('ru', 'admin.listMore', { n: 20 })}`,
    );
  });
});

describe('what is left open, and what is not', () => {
  it('stops waiting for a note once the doctor is confirmed: what is typed next is nothing', async () => {
    const admin = await techAdmin();
    const doctor = await applicant('Hilola');
    await openCard(admin, 'Hilola Tester');
    await bot.press(admin, bot.buttonLabelled(admin, t('ru', 'admin.verifyButton')).data);
    await bot.say(admin, 'первая проверка');
    const before = sentCount(admin);

    await bot.say(admin, 'вторая проверка, которая никому не нужна');

    expect(await referenceOf(doctor)).toBe('первая проверка');
    expect(sentCount(admin)).toBe(before + 1);
    expect(textOf(admin)).not.toBe(t('ru', 'admin.alreadyVerified', { name: 'Hilola Tester' }));
    const [stored] = await sql()<{ n: number }[]>`
      select count(*)::int as n from conversation_states where telegram_user_id = ${admin}`;
    expect(stored?.n).toBe(0);
  });

  it('says "already" when somebody else confirmed the doctor while the note was being written', async () => {
    const admin = await techAdmin();
    const other = await techAdmin({ first: 'Other', last: 'Admin' });
    const doctor = await applicant('Latofat');
    await openCard(admin, 'Latofat Tester');
    await bot.press(admin, bot.buttonLabelled(admin, t('ru', 'admin.verifyButton')).data);

    await repos.clinicians.verify(
      { kind: 'TECH_ADMIN', userId: await userId(other) },
      { clinicianId: await userId(doctor), reference: 'проверил другой администратор' },
    );
    const told = sentCount(doctor);
    await bot.say(admin, 'моя проверка, опоздавшая');

    expect(textOf(admin)).toBe(t('ru', 'admin.alreadyVerified', { name: 'Latofat Tester' }));
    expect(await referenceOf(doctor)).toBe('проверил другой администратор');
    expect(sentCount(doctor)).toBe(told);
  });

  it('drops an exchange this version does not know, and takes the text for nothing', async () => {
    const admin = await techAdmin();
    await bot.say(admin, '/menu');
    await sql()`
      insert into conversation_states (telegram_user_id, flow, step, data, expires_at)
      values (${admin}, 'ADMIN', 'FROM_THE_FUTURE', '{}'::jsonb, ${new Date(NOW.getTime() + 3_600_000)})
      on conflict (telegram_user_id) do update set flow = 'ADMIN', step = 'FROM_THE_FUTURE'`;

    await bot.say(admin, '4242');

    const [stored] = await sql()<{ n: number }[]>`
      select count(*)::int as n from conversation_states where telegram_user_id = ${admin}`;
    expect(stored?.n).toBe(0);
    expect(labelsOf(admin)).toContain(t('ru', 'admin.menu'));
  });

  it('stops waiting for an id once an administrator was made: the next number makes nobody', async () => {
    const admin = await techAdmin();
    const first = await register();
    const second = await register();
    await bot.say(admin, '/admin');
    await bot.press(admin, 'a:m');
    await bot.press(admin, bot.buttonLabelled(admin, t('ru', 'admin.addAdminButton')).data);
    await bot.say(admin, String(first));
    expect(await isAdmin(first)).toBe(true);

    await bot.say(admin, String(second));

    expect(await isAdmin(second)).toBe(false);
    const [stored] = await sql()<{ n: number }[]>`
      select count(*)::int as n from conversation_states where telegram_user_id = ${admin}`;
    expect(stored?.n).toBe(0);
  });

  it('cuts a long list of applicants and says so', async () => {
    const admin = await techAdmin();
    await sql()`update clinician_profiles set verification_status = 'REVOKED' where verification_status = 'PENDING'`;
    for (let index = 0; index < 21; index += 1) {
      await applicant(`Applicant${String(index).padStart(2, '0')}`);
    }

    await bot.say(admin, '/admin');
    await bot.press(admin, 'a:a');

    expect(dataOf(admin).filter((data) => data.startsWith('ap:o:'))).toHaveLength(20);
    expect(textOf(admin)).toBe(
      `${t('ru', 'admin.applicationsTitle', { n: 21 })}\n\n${t('ru', 'admin.listMore', { n: 20 })}`,
    );
  });

  it('cuts a long list of incidents and says so', async () => {
    const admin = await techAdmin();
    await sql()`delete from incidents`;
    for (let index = 0; index < 21; index += 1) {
      await sql()`
        insert into incidents (kind, type, dedupe_key, details, opened_at)
        values ('TECHNICAL', 'QUEUE_LATE', ${`many-${String(index)}`}, '{"reminders": 1}'::jsonb, ${NOW})`;
    }

    await bot.say(admin, '/admin');
    await bot.press(admin, 'a:i');

    const lines = textOf(admin).split('\n');
    expect(lines[0]).toBe(t('ru', 'admin.incidentsTitle', { n: 21 }));
    expect(lines.filter((line) => line.startsWith('• '))).toHaveLength(20);
    expect(lines.at(-1)).toBe(t('ru', 'admin.listMore', { n: 20 }));
  });
});
