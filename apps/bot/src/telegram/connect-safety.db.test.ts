import { randomBytes } from 'node:crypto';
import {
  INVITATION_TTL_MS,
  MAX_FAILED_ATTEMPTS,
  createRepositories,
  createRepositoryDeps,
  hashInviteCode,
  type Repositories,
  type RepositoryDeps,
} from '@medcourse/db';
import {
  createTestDatabase,
  insertClinic,
  insertClinician,
  insertPatient,
  insertRelationship,
  insertTechAdmin,
  type TestDatabase,
} from '@medcourse/db/testing';
import { t, type Locale } from '@medcourse/i18n';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeTelegram, createHarness, type Harness } from './test-harness';

/**
 * What must not work: guessed, forged, stale, replayed and raced invitations and answers.
 * The happy paths are in connect.db.test.ts.
 */

let testDatabase: TestDatabase;
let repositoryDeps: RepositoryDeps;
let repos: Repositories;
let telegram: FakeTelegram;
let bot: Harness;

const sql = () => testDatabase.db.sql;
const orm = () => testDatabase.db.orm;
const START_CLOCK = new Date('2026-10-02T10:00:00Z');
const HOUR = 3_600_000;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  repositoryDeps = createRepositoryDeps([{ id: 't', key: randomBytes(32) }]);
  repos = createRepositories(orm(), repositoryDeps);
  telegram = new FakeTelegram();
  bot = createHarness({ orm: orm(), repositoryDeps, telegram });
});

afterAll(async () => {
  await testDatabase.drop();
});

let nextId = 9_000_000;
const newPerson = (): number => (nextId += 1);

const textOf = (id: number): string => telegram.lastTo(id)?.text ?? '(nothing was sent)';
const dataOf = (id: number): string[] =>
  (telegram.lastTo(id)?.buttons ?? []).flat().map((button) => button.data);
const countOf = (id: number, fragment: string): number =>
  telegram.messagesTo(id).filter((message) => message.text.includes(fragment)).length;

async function userId(telegramId: number): Promise<string> {
  const [row] = await sql()<{ id: string }[]>`
    select id from users where telegram_user_id = ${telegramId}`;
  return row?.id ?? '';
}

async function register(id: number, options: { locale?: Locale; last?: string } = {}) {
  await bot.say(id, '/start');
  await bot.press(id, `l:${options.locale ?? 'ru'}`);
  await bot.press(id, 'c:y');
  await bot.say(id, 'Aziza');
  await bot.say(id, options.last ?? 'Karimova');
  await bot.press(id, 'z:ok');
}

async function doctor(last = 'Rahimov'): Promise<number> {
  const id = newPerson();
  await register(id, { last });
  await bot.press(id, 'm:d');
  await bot.press(id, 'd:r');
  await bot.say(id, 'Pediatrician, licence UZ-1');
  const admin = await insertTechAdmin(sql());
  await repos.clinicians.verify(
    { kind: 'TECH_ADMIN', userId: admin },
    { clinicianId: await userId(id), reference: 'test' },
  );
  return id;
}

async function invite(doctorId: number, label?: string): Promise<string> {
  await bot.press(doctorId, 'm:d');
  await bot.press(doctorId, 'd:i');
  if (label === undefined) {
    await bot.press(doctorId, 'd:s');
  } else {
    await bot.say(doctorId, label);
  }
  const match = /start=i_([A-Za-z0-9_-]{22})/.exec(textOf(doctorId));
  if (match?.[1] === undefined) {
    throw new Error(`no invitation link in: ${textOf(doctorId)}`);
  }
  return match[1];
}

async function relationshipsOf(doctorId: number) {
  return sql()<{ id: string; status: string }[]>`
    select id, status from care_relationships
    where clinician_id = ${await userId(doctorId)} order by created_at`;
}

async function registered(last = 'Karimova'): Promise<number> {
  const id = newPerson();
  await register(id, { last });
  return id;
}

/** A well-formed code that no doctor ever issued. */
const randomCode = (): string => randomBytes(16).toString('base64url');

describe('guessing links', () => {
  it('answers a wrong code with the same words as any other dead link', async () => {
    const doc = await doctor();
    const used = await invite(doc);
    const withdrawn = await invite(doc);
    const person = await registered();
    await bot.say(person, `/start i_${used}`);
    await bot.press(person, 'i:y');
    const another = await registered();
    const [row] = await sql()<
      { id: string }[]
    >`select id from invitations where code_hash = ${hashInviteCode(withdrawn)}`;
    await bot.press(doc, `dr:${row?.id ?? ''}`);

    for (const code of [randomCode(), used, withdrawn]) {
      await bot.say(another, `/start i_${code}`);
      expect(countOf(another, t('ru', 'invite.invalid'))).toBeGreaterThan(0);
    }
    expect(telegram.messagesTo(another).every((m) => !m.text.includes('Rahimov'))).toBe(true);
  });

  it('stops answering after five wrong links, even for the right one, and never for others', async () => {
    const doc = await doctor();
    const code = await invite(doc);
    const guesser = await registered();
    const honest = await registered();

    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await bot.say(guesser, `/start i_${randomCode()}`);
    }
    await bot.say(guesser, `/start i_${code}`);

    expect(countOf(guesser, t('ru', 'invite.throttled'))).toBe(1);
    expect(dataOf(guesser)).not.toContain('i:y');

    await bot.say(honest, `/start i_${code}`);
    expect(dataOf(honest)).toEqual(['i:y', 'i:n']);
  });

  it('counts links of the wrong shape as guesses, without touching the database for them', async () => {
    const person = await registered();
    for (const payload of [
      'i_',
      'i_short',
      `i_${'a'.repeat(23)}`,
      'i_%00%00',
      `i_${'a'.repeat(21)}!`,
    ]) {
      await bot.say(person, `/start ${payload}`);
    }
    const failures = async (): Promise<number | undefined> => {
      const [row] = await sql()<{ n: number }[]>`
        select count(*)::int as n from invitation_attempts where telegram_user_id = ${person}`;
      return row?.n;
    };
    expect(await failures()).toBe(MAX_FAILED_ATTEMPTS);
    expect(countOf(person, t('ru', 'invite.throttled'))).toBe(0);

    // The sixth is answered with the lockout, and does not extend it.
    await bot.say(person, '/start i_anything');
    expect(countOf(person, t('ru', 'invite.throttled'))).toBe(1);
    expect(await failures()).toBe(MAX_FAILED_ATTEMPTS);
  });

  it('forgives once the hour has passed', async () => {
    const doc = await doctor();
    const person = await registered();
    for (let attempt = 0; attempt < MAX_FAILED_ATTEMPTS; attempt += 1) {
      await bot.say(person, `/start i_${randomCode()}`);
    }
    const code = await invite(doc);

    bot.clock = new Date(START_CLOCK.getTime() + HOUR + 1000);
    await bot.say(person, `/start i_${code}`);
    expect(dataOf(person)).toEqual(['i:y', 'i:n']);
    bot.clock = START_CLOCK;
  });

  it('treats a plain /start with some other payload as an ordinary /start', async () => {
    const person = await registered();
    await bot.say(person, '/start promo');
    await bot.say(person, '/start i');
    await bot.say(person, '/start  ');
    expect(textOf(person)).toContain(t('ru', 'menu.title'));
    const [row] = await sql()<{ n: number }[]>`
      select count(*)::int as n from invitation_attempts where telegram_user_id = ${person}`;
    expect(row?.n).toBe(0);
  });

  it('tells a stranger the link is dead and still lets them register', async () => {
    const stranger = newPerson();
    await bot.say(stranger, `/start i_${randomCode()}`);
    expect(telegram.messagesTo(stranger)[0]?.text).toContain(t('ru', 'invite.invalid'));
    expect(telegram.messagesTo(stranger)[0]?.text).toContain(t('uz', 'invite.invalid'));
    expect(textOf(stranger)).toContain('Tilni tanlang');
  });
});

describe('links that stop working', () => {
  it('dies at the end of its 72 hours', async () => {
    const doc = await doctor();
    const code = await invite(doc);
    const person = await registered();

    bot.clock = new Date(START_CLOCK.getTime() + INVITATION_TTL_MS);
    await bot.say(person, `/start i_${code}`);
    bot.clock = START_CLOCK;

    expect(countOf(person, t('ru', 'invite.invalid'))).toBe(1);
    expect(await relationshipsOf(doc)).toEqual([]);
  });

  it('is refused at the moment of accepting if it expired while the offer was on screen', async () => {
    const doc = await doctor();
    const code = await invite(doc);
    const person = await registered();
    // Opened an hour before it runs out (the conversation itself lasts a day), answered just after.
    bot.clock = new Date(START_CLOCK.getTime() + INVITATION_TTL_MS - HOUR);
    await bot.say(person, `/start i_${code}`);
    expect(dataOf(person)).toEqual(['i:y', 'i:n']);

    bot.clock = new Date(START_CLOCK.getTime() + INVITATION_TTL_MS + 1);
    await bot.press(person, 'i:y');
    bot.clock = START_CLOCK;

    expect(textOf(person)).toBe(t('ru', 'invite.invalid'));
    expect(await relationshipsOf(doc)).toEqual([]);
    expect(countOf(doc, t('ru', 'doctor.confirmQuestion'))).toBe(0);
  });

  it('stops working when the doctor loses standing before the patient decides', async () => {
    const doc = await doctor();
    const code = await invite(doc);
    const person = await registered();
    await bot.say(person, `/start i_${code}`);

    await sql()`update clinician_profiles set verification_status = 'REVOKED' where user_id = ${await userId(doc)}`;
    await bot.press(person, 'i:y');

    expect(textOf(person)).toBe(t('ru', 'invite.invalid'));
    expect(await relationshipsOf(doc)).toEqual([]);
  });

  it('is not usable by a stranger who was carrying it if someone else used it first', async () => {
    const doc = await doctor();
    const code = await invite(doc);
    const slow = newPerson();
    await bot.say(slow, `/start i_${code}`);
    await bot.press(slow, 'l:ru');
    await bot.press(slow, 'c:y');
    await bot.say(slow, 'Slow');
    await bot.say(slow, 'Person');

    const quick = await registered('Quick');
    await bot.say(quick, `/start i_${code}`);
    await bot.press(quick, 'i:y');

    await bot.press(slow, 'z:ok');
    expect(countOf(slow, t('ru', 'invite.invalid'))).toBe(1);
    expect(textOf(slow)).toContain(t('ru', 'menu.title'));
    expect((await relationshipsOf(doc)).length).toBe(1);
  });

  it('shows the same message to everyone else who tries a used link', async () => {
    const doc = await doctor();
    const code = await invite(doc);
    const first = await registered();
    await bot.say(first, `/start i_${code}`);
    await bot.press(first, 'i:y');

    const second = await registered('Second');
    await bot.say(second, `/start i_${code}`);
    await bot.press(second, 'i:y');
    expect(countOf(second, t('ru', 'invite.invalid'))).toBe(1);
    expect(await relationshipsOf(doc)).toHaveLength(1);
  });
});

describe('links nobody should be able to use', () => {
  it('sends a doctor who opens their own link away, and leaves it usable', async () => {
    const doc = await doctor();
    const code = await invite(doc);
    await bot.say(doc, `/start i_${code}`);
    expect(countOf(doc, t('ru', 'invite.self'))).toBe(1);
    expect(dataOf(doc)).not.toContain('i:y');

    const person = await registered();
    await bot.say(person, `/start i_${code}`);
    expect(dataOf(person)).toEqual(['i:y', 'i:n']);
  });

  it('tells someone already connected, and does not use the link up', async () => {
    const doc = await doctor();
    const person = await registered();
    await insertRelationship(sql(), await userId(person), await userId(doc), 'ACTIVE');
    const code = await invite(doc);

    await bot.say(person, `/start i_${code}`);
    expect(countOf(person, t('ru', 'invite.alreadyConnected'))).toBe(1);

    const [row] = await sql()<{ used_at: Date | null }[]>`
      select used_at from invitations where code_hash = ${hashInviteCode(code)}`;
    expect(row?.used_at).toBeNull();
  });

  it('tells someone who accepted and is waiting that they are waiting', async () => {
    const doc = await doctor();
    const person = await registered();
    await bot.say(person, `/start i_${await invite(doc)}`);
    await bot.press(person, 'i:y');

    await bot.say(person, `/start i_${await invite(doc)}`);
    expect(countOf(person, t('ru', 'invite.alreadyPending'))).toBe(1);
    expect(await relationshipsOf(doc)).toHaveLength(1);
  });

  it('says nothing to a blocked person, who cannot connect', async () => {
    const doc = await doctor();
    const code = await invite(doc);
    const person = await registered();
    await sql()`update users set status = 'BLOCKED' where telegram_user_id = ${person}`;
    const before = telegram.messagesTo(person).length;

    await bot.say(person, `/start i_${code}`);
    await bot.press(person, 'i:y');

    expect(telegram.messagesTo(person)).toHaveLength(before);
    expect(await relationshipsOf(doc)).toEqual([]);
  });
});

describe('answers that are not the doctor’s to give', () => {
  async function waiting() {
    const doc = await doctor();
    const person = await registered();
    await bot.say(person, `/start i_${await invite(doc)}`);
    await bot.press(person, 'i:y');
    const [link] = await relationshipsOf(doc);
    return { doc, person, relationshipId: link?.id ?? '' };
  }

  it('is refused to another doctor, with nothing changed and nobody told', async () => {
    const { person, relationshipId } = await waiting();
    const intruder = await doctor('Intruder');

    await bot.press(intruder, `dc:${relationshipId}:y`);

    expect(textOf(intruder)).toBe(t('ru', 'doctor.decisionStale'));
    const [row] = await sql()<{ status: string }[]>`
      select status from care_relationships where id = ${relationshipId}`;
    expect(row?.status).toBe('PENDING');
    expect(countOf(person, t('ru', 'invite.connected', { doctor: 'Aziza Intruder' }))).toBe(0);
  });

  it('is refused to the patient themselves: nobody confirms their own connection', async () => {
    const { person, relationshipId } = await waiting();
    await bot.press(person, `dc:${relationshipId}:y`);
    const [row] = await sql()<{ status: string }[]>`
      select status from care_relationships where id = ${relationshipId}`;
    expect(row?.status).toBe('PENDING');
  });

  it('is refused to a doctor who has lost standing since', async () => {
    const { doc, relationshipId } = await waiting();
    await sql()`update clinician_profiles set verification_status = 'REVOKED' where user_id = ${await userId(doc)}`;

    await bot.press(doc, `dc:${relationshipId}:y`);

    const [row] = await sql()<{ status: string }[]>`
      select status from care_relationships where id = ${relationshipId}`;
    expect(row?.status).toBe('PENDING');
  });

  it('ignores ids that are not ids, and ids of things that do not exist', async () => {
    const doc = await doctor();
    const before = telegram.messagesTo(doc).length;
    await bot.press(doc, 'dc:not-an-id:y');
    await bot.press(doc, "dc:' or 1=1 --:y");
    expect(telegram.messagesTo(doc)).toHaveLength(before);

    await bot.press(doc, 'dc:00000000-0000-4000-8000-000000000000:y');
    expect(textOf(doc)).toBe(t('ru', 'doctor.decisionStale'));
  });

  it('is ignored from someone with no account at all', async () => {
    const { relationshipId } = await waiting();
    const stranger = newPerson();
    await bot.press(stranger, `dc:${relationshipId}:y`);
    await bot.press(stranger, `dr:${relationshipId}`);
    await bot.press(stranger, 'd:p');
    await bot.press(stranger, 'm:d');
    expect(telegram.messagesTo(stranger)).toEqual([]);
    expect(await userId(stranger)).toBe('');
  });
});

describe('the doctor’s lists', () => {
  it('cut a long list short instead of overflowing a Telegram message', async () => {
    const doc = await doctor();
    const doctorId = await userId(doc);
    for (let index = 0; index < 40; index += 1) {
      const person = await insertPatient(sql(), {
        firstName: `First${String(index)}`,
        lastName: `Last${'x'.repeat(90)}${String(index)}`,
      });
      await insertRelationship(sql(), person, doctorId, index % 2 === 0 ? 'ACTIVE' : 'PENDING');
    }

    await bot.press(doc, 'm:d');
    await bot.press(doc, 'd:p');

    expect(textOf(doc).length).toBeLessThan(4096);
    expect(textOf(doc)).toContain(t('ru', 'doctor.more', { count: 15 }));
    // Buttons: the waiting ones, each button short enough to read.
    for (const button of telegram.lastTo(doc)?.buttons.flat() ?? []) {
      expect(Array.from(button.text).length).toBeLessThanOrEqual(40);
      expect(Buffer.byteLength(button.data)).toBeLessThanOrEqual(64);
    }
  });

  it('show only the doctor’s own people, never another doctor’s', async () => {
    const mine = await doctor('Mine');
    const other = await doctor('Other');
    const hers = await insertPatient(sql(), { firstName: 'Secret', lastName: 'Patient' });
    await insertRelationship(sql(), hers, await userId(other), 'ACTIVE');

    await bot.press(mine, 'm:d');
    await bot.press(mine, 'd:p');
    expect(textOf(mine)).toBe(t('ru', 'doctor.patientsNone'));
    expect(JSON.stringify(telegram.messagesTo(mine))).not.toContain('Secret');
  });

  it('count the hours left up, never showing zero', async () => {
    const doc = await doctor();
    await invite(doc, 'Almost gone');
    bot.clock = new Date(START_CLOCK.getTime() + INVITATION_TTL_MS - 60_000);
    await bot.press(doc, 'm:d');
    await bot.press(doc, 'd:o');
    bot.clock = START_CLOCK;
    expect(textOf(doc)).toContain(
      t('ru', 'doctor.invitationLine', { label: 'Almost gone', hours: 1 }),
    );
  });
});

describe('what is written down', () => {
  it('never stores the link itself: not in the conversation, the audit log or the invitation', async () => {
    const doc = await doctor();
    const code = await invite(doc, 'Traceable');
    const stranger = newPerson();
    await bot.say(stranger, `/start i_${code}`);
    await bot.press(stranger, 'l:ru');
    await bot.press(stranger, 'c:y');
    await bot.say(stranger, 'Aziza');
    await bot.say(stranger, 'Karimova');
    await bot.press(stranger, 'z:ok');
    await bot.press(stranger, 'i:y');

    for (const [table, column] of [
      ['conversation_states', 'data'],
      ['audit_log', 'audit_log'],
      ['invitations', 'invitations'],
      ['care_relationships', 'care_relationships'],
      ['invitation_attempts', 'invitation_attempts'],
    ] as const) {
      const [row] = await sql().unsafe<{ n: number }[]>(
        `select count(*)::int as n from ${table} where ${column}::text like '%${code}%'`,
      );
      expect(row?.n, table).toBe(0);
    }
  });

  it('audits the whole connection by who did what', async () => {
    const doc = await doctor();
    const person = await registered();
    await bot.say(person, `/start i_${await invite(doc)}`);
    await bot.press(person, 'i:y');
    const [link] = await relationshipsOf(doc);
    await bot.press(doc, `dc:${link?.id ?? ''}:y`);

    const rows = await sql()<{ entity_type: string; action: string; actor_kind: string }[]>`
      select entity_type, action, actor_kind from audit_log
      where entity_type in ('invitations', 'care_relationships') and actor_user_id in (${await userId(doc)}, ${await userId(person)})
      order by id`;
    expect(rows).toEqual([
      { entity_type: 'invitations', action: 'CREATE', actor_kind: 'CLINICIAN' },
      { entity_type: 'care_relationships', action: 'CREATE', actor_kind: 'PATIENT' },
      { entity_type: 'invitations', action: 'USE', actor_kind: 'PATIENT' },
      { entity_type: 'care_relationships', action: 'CONFIRM', actor_kind: 'CLINICIAN' },
    ]);
  });
});

describe('the repositories behind it', () => {
  it('give the doctor nothing clinical about a patient who has only accepted', async () => {
    const doc = await doctor();
    const person = await registered();
    await bot.say(person, `/start i_${await invite(doc)}`);
    await bot.press(person, 'i:y');
    const actor = { kind: 'CLINICIAN', userId: await userId(doc) } as const;

    expect(await repos.patients.getSummary(actor, await userId(person))).toBeNull();
    expect(await repos.patients.getPii(actor, await userId(person))).toBeNull();
    expect(await repos.courses.list(actor)).toEqual([]);
  });

  it('keep an invitation from a doctor who never had standing from working at all', async () => {
    const clinicId = await insertClinic(sql());
    const pending = await insertClinician(sql(), clinicId, { verification: 'PENDING' });
    expect(
      await repos.invitations.create({ kind: 'CLINICIAN', userId: pending }, { now: START_CLOCK }),
    ).toEqual({ status: 'NOT_ALLOWED' });
  });
});
