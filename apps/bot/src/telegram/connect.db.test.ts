import { randomBytes } from 'node:crypto';
import {
  MAX_OPEN_INVITATIONS,
  createRepositories,
  createRepositoryDeps,
  hashInviteCode,
  type Repositories,
  type RepositoryDeps,
} from '@medcourse/db';
import { createTestDatabase, insertTechAdmin, type TestDatabase } from '@medcourse/db/testing';
import { t, type Locale } from '@medcourse/i18n';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOT_USERNAME, FakeTelegram, createHarness, type Harness } from './test-harness';

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

let nextId = 8_000_000;
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

async function conversationOf(id: number) {
  const [row] = await sql()<{ flow: string; step: string; data: unknown }[]>`
    select flow, step, data from conversation_states where telegram_user_id = ${id}`;
  return row;
}

async function register(
  id: number,
  options: { locale?: Locale; first?: string; last?: string } = {},
): Promise<void> {
  await bot.say(id, '/start');
  await bot.press(id, `l:${options.locale ?? 'ru'}`);
  await bot.press(id, 'c:y');
  await bot.say(id, options.first ?? 'Aziza');
  await bot.say(id, options.last ?? 'Karimova');
  await bot.press(id, 'z:ok');
}

/** Registers, then applies to be a doctor, and stops there: PENDING. */
async function applicant(
  options: { locale?: Locale; first?: string; last?: string; note?: string } = {},
): Promise<number> {
  const id = newPerson();
  await register(id, options);
  await bot.press(id, 'm:d');
  await bot.press(id, 'd:r');
  await bot.say(id, options.note ?? 'Pediatrician, City Clinic No. 5, licence UZ-1');
  return id;
}

async function verify(id: number): Promise<void> {
  const admin = await insertTechAdmin(sql());
  const done = await repos.clinicians.verify(
    { kind: 'TECH_ADMIN', userId: admin },
    { clinicianId: await userId(id), reference: 'checked in the test' },
  );
  expect(done?.clinician.verificationStatus).toBe('VERIFIED');
}

async function doctor(
  options: { locale?: Locale; first?: string; last?: string } = {},
): Promise<number> {
  const id = await applicant({ first: 'Rustam', last: 'Rahimov', ...options });
  await verify(id);
  return id;
}

/** A doctor makes an invitation and the link is read out of their chat. */
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
  return sql()<{ id: string; status: string; consent_at: Date | null; patient: string }[]>`
    select r.id, r.status, r.consent_at, p.last_name as patient
    from care_relationships r
    join patient_profiles p on p.user_id = r.patient_id
    where r.clinician_id = ${await userId(doctorId)} order by r.created_at`;
}

/** The patient registers (if they have not), opens the link and accepts. */
async function connect(
  doctorId: number,
  code: string,
  options: { patient?: number; locale?: Locale; last?: string } = {},
): Promise<{ patientId: number; relationshipId: string }> {
  const patientId = options.patient ?? newPerson();
  if (options.patient === undefined) {
    await bot.say(patientId, `/start i_${code}`);
    await bot.press(patientId, `l:${options.locale ?? 'ru'}`);
    await bot.press(patientId, 'c:y');
    await bot.say(patientId, 'Aziza');
    await bot.say(patientId, options.last ?? 'Karimova');
    await bot.press(patientId, 'z:ok');
  } else {
    await bot.say(patientId, `/start i_${code}`);
  }
  await bot.press(patientId, 'i:y');
  const [relationship] = (await relationshipsOf(doctorId)).slice(-1);
  return { patientId, relationshipId: relationship?.id ?? '' };
}

describe('the doctor section, for someone who is not a doctor yet', () => {
  it('is one button away in the main menu and explains what it is for', async () => {
    const id = newPerson();
    await register(id);
    expect(dataOf(id)).toContain('m:d');

    await bot.press(id, 'm:d');
    expect(textOf(id)).toBe(t('ru', 'doctor.intro'));
    expect(dataOf(id)).toEqual(['d:r', 'm:h']);
  });

  it('opens with /doctor too, and in the person’s own language', async () => {
    const id = newPerson();
    await register(id, { locale: 'uz' });
    await bot.say(id, '/doctor');
    expect(textOf(id)).toBe(t('uz', 'doctor.intro'));
    expect(dataOf(id)).toEqual(['d:r', 'm:h']);
  });

  it('sends a stranger to registration first: nobody applies to be a doctor without an account', async () => {
    const id = newPerson();
    await bot.say(id, '/doctor');
    expect(textOf(id)).toContain('Tilni tanlang');
    await bot.press(id, 'd:r');
    await bot.press(id, 'm:d');
    expect(await userId(id)).toBe('');
  });
});

describe('applying to be a doctor', () => {
  it('asks what to write, then records an unverified profile and a private practice', async () => {
    const id = newPerson();
    await register(id, { first: 'Dilnoza', last: 'Yusupova' });
    await bot.press(id, 'm:d');
    await bot.press(id, 'd:r');
    expect(textOf(id)).toBe(t('ru', 'doctor.askNote'));
    expect(await conversationOf(id)).toMatchObject({ flow: 'DOCTOR', step: 'NOTE' });

    await bot.say(id, 'Cardiologist, Heart Centre, licence UZ-777');

    expect(textOf(id)).toBe(t('ru', 'doctor.applied'));
    expect(await conversationOf(id)).toBeUndefined();
    const [row] = await sql()<
      { verification_status: string; applicant_note: string; first_name: string; clinic: string }[]
    >`select p.verification_status, p.applicant_note, p.first_name, c.name as clinic
      from clinician_profiles p join clinics c on c.id = p.clinic_id
      where p.user_id = ${await userId(id)}`;
    expect(row).toEqual({
      verification_status: 'PENDING',
      applicant_note: 'Cardiologist, Heart Centre, licence UZ-777',
      first_name: 'Dilnoza',
      clinic: 'Private practice: Yusupova Dilnoza',
    });
  });

  it('keeps asking until the note is usable, and creates nothing meanwhile', async () => {
    const id = newPerson();
    await register(id);
    await bot.press(id, 'm:d');
    await bot.press(id, 'd:r');
    for (const bad of ['12345', '🙂', 'x'.repeat(501), `Dr${String.fromCodePoint(0x202e)}`]) {
      await bot.say(id, bad);
      expect(textOf(id), bad.slice(0, 10)).toBe(t('ru', 'doctor.invalidNote'));
    }
    expect(await conversationOf(id)).toMatchObject({ flow: 'DOCTOR', step: 'NOTE' });
    const [row] = await sql()<{ n: number }[]>`
      select count(*)::int as n from clinician_profiles where user_id = ${await userId(id)}`;
    expect(row?.n).toBe(0);
  });

  it('can be abandoned: after /menu the next message is not taken for the note', async () => {
    const id = newPerson();
    await register(id);
    await bot.press(id, 'm:d');
    await bot.press(id, 'd:r');
    await bot.say(id, '/menu');
    expect(await conversationOf(id)).toBeUndefined();

    await bot.say(id, 'Pediatrician, licence 1');
    expect(textOf(id)).toContain(t('ru', 'menu.title'));
    const [row] = await sql()<{ n: number }[]>`
      select count(*)::int as n from clinician_profiles where user_id = ${await userId(id)}`;
    expect(row?.n).toBe(0);
  });

  it('shows "under review" afterwards, and applying again opens no second practice', async () => {
    const id = await applicant();
    await bot.press(id, 'm:d');
    expect(textOf(id)).toBe(t('ru', 'doctor.pending'));
    await bot.press(id, 'd:r');
    expect(textOf(id)).toBe(t('ru', 'doctor.pending'));
    const [row] = await sql()<{ n: number }[]>`
      select count(*)::int as n from clinics where id in
        (select clinic_id from clinician_profiles where user_id = ${await userId(id)})`;
    expect(row?.n).toBe(1);
  });

  it('keeps an unverified doctor away from everything that needs standing', async () => {
    const id = await applicant();
    for (const data of ['d:i', 'd:p', 'd:o']) {
      await bot.press(id, data);
      expect(textOf(id), data).toBe(t('ru', 'doctor.notAllowed'));
    }
    await bot.say(id, 'Somebody');
    const [row] = await sql()<{ n: number }[]>`select count(*)::int as n from invitations`;
    expect(row?.n).toBe(0);
  });

  it('speaks the doctor’s language throughout', async () => {
    const id = newPerson();
    await register(id, { locale: 'uz' });
    await bot.press(id, 'm:d');
    await bot.press(id, 'd:r');
    expect(textOf(id)).toBe(t('uz', 'doctor.askNote'));
    await bot.say(id, 'Pediatr, 5-poliklinika, litsenziya UZ-1');
    expect(textOf(id)).toBe(t('uz', 'doctor.applied'));
  });
});

describe('a doctor’s standing, as the doctor sees it', () => {
  it('opens the doctor’s menu once verified', async () => {
    const id = await doctor();
    await bot.press(id, 'm:d');
    expect(textOf(id)).toBe(t('ru', 'doctor.menuTitle'));
    expect(dataOf(id)).toEqual(['d:c', 'd:l', 'd:i', 'd:p', 'd:o', 'm:h']);
  });

  it('explains a revoked doctor’s position, and a stale invite button no longer works', async () => {
    const id = await doctor();
    await bot.press(id, 'm:d'); // the menu, with its buttons, stays on screen
    await sql()`update clinician_profiles set verification_status = 'REVOKED' where user_id = ${await userId(id)}`;

    await bot.press(id, 'd:i');
    expect(textOf(id)).toBe(t('ru', 'doctor.notAllowed'));
    await bot.press(id, 'm:d');
    expect(textOf(id)).toBe(t('ru', 'doctor.revoked'));
  });

  it('explains a suspended practice', async () => {
    const id = await doctor();
    await sql()`
      update clinics set status = 'SUSPENDED'
      where id = (select clinic_id from clinician_profiles where user_id = ${await userId(id)})`;
    await bot.press(id, 'm:d');
    expect(textOf(id)).toBe(t('ru', 'doctor.suspended'));
  });
});

describe('inviting a patient', () => {
  it('asks for a private label, then hands over a one-time link and stores only its hash', async () => {
    const id = await doctor();
    await bot.press(id, 'm:d');
    await bot.press(id, 'd:i');
    expect(textOf(id)).toBe(t('ru', 'doctor.askLabel'));
    expect(dataOf(id)).toEqual(['d:s', 'm:d']);

    await bot.say(id, 'Karimova A.');

    const match = /^(.*)https:\/\/t\.me\/(\w+)\?start=i_([A-Za-z0-9_-]{22})/s.exec(textOf(id));
    expect(match?.[2]).toBe(BOT_USERNAME);
    const code = match?.[3] ?? '';
    expect(textOf(id)).toContain('72');
    expect(await conversationOf(id)).toBeUndefined();

    const [row] = await sql()<{ code_hash: string; label: string; everything: string }[]>`
      select code_hash, label, i::text as everything from invitations i
      where clinician_id = ${await userId(id)}`;
    expect(row).toMatchObject({ code_hash: hashInviteCode(code), label: 'Karimova A.' });
    expect(row?.everything).not.toContain(code);
    const [elsewhere] = await sql()<{ n: number }[]>`
      select count(*)::int as n from audit_log a where a::text like ${`%${code}%`}`;
    expect(elsewhere?.n).toBe(0);
  });

  it('can skip the label', async () => {
    const id = await doctor();
    await invite(id);
    const [row] = await sql()<{ label: string | null }[]>`
      select label from invitations where clinician_id = ${await userId(id)}`;
    expect(row?.label).toBeNull();
  });

  it('asks again for a label that cannot be used, and offers to skip', async () => {
    const id = await doctor();
    await bot.press(id, 'm:d');
    await bot.press(id, 'd:i');
    await bot.say(id, '12345');
    expect(textOf(id)).toBe(t('ru', 'doctor.invalidLabel'));
    expect(dataOf(id)).toEqual(['d:s']);
    const [row] = await sql()<
      { n: number }[]
    >`select count(*)::int as n from invitations where clinician_id = ${await userId(id)}`;
    expect(row?.n).toBe(0);
  });

  it('ignores "skip" when no invitation is being made, and ordinary text creates nothing', async () => {
    const id = await doctor();
    await bot.press(id, 'm:d');
    await bot.press(id, 'd:s');
    await bot.say(id, 'Karimova A.');
    const [row] = await sql()<
      { n: number }[]
    >`select count(*)::int as n from invitations where clinician_id = ${await userId(id)}`;
    expect(row?.n).toBe(0);
    expect(textOf(id)).toContain(t('ru', 'menu.title'));
  });

  it('forgets a half-made invitation when the doctor goes elsewhere', async () => {
    const id = await doctor();
    await bot.press(id, 'm:d');
    await bot.press(id, 'd:i');
    await bot.press(id, 'm:h');
    await bot.say(id, 'Not a label');
    const [row] = await sql()<
      { n: number }[]
    >`select count(*)::int as n from invitations where clinician_id = ${await userId(id)}`;
    expect(row?.n).toBe(0);
  });

  it('stops at the limit and says so', async () => {
    const id = await doctor();
    for (let index = 0; index < MAX_OPEN_INVITATIONS; index += 1) {
      await invite(id);
    }
    await bot.press(id, 'm:d');
    await bot.press(id, 'd:i');
    await bot.press(id, 'd:s');
    expect(textOf(id)).toBe(t('ru', 'doctor.inviteLimit'));
  });

  it('lists open invitations with the time left, and withdrawing one kills its link', async () => {
    const id = await doctor();
    const first = await invite(id, 'Alpha');
    await invite(id);

    bot.clock = new Date(START_CLOCK.getTime() + 30 * HOUR);
    await bot.press(id, 'm:d');
    await bot.press(id, 'd:o');
    expect(textOf(id)).toContain(t('ru', 'doctor.invitationLine', { label: 'Alpha', hours: 42 }));
    expect(textOf(id)).toContain(t('ru', 'doctor.noLabel'));
    const revoke = dataOf(id).filter((data) => data.startsWith('dr:'));
    expect(revoke).toHaveLength(2);

    const alpha = telegram
      .lastTo(id)
      ?.buttons.flat()
      .find((button) => button.text.includes('Alpha'));
    await bot.press(id, alpha?.data ?? '');
    expect(textOf(id)).toBe(t('ru', 'doctor.invitationRevoked'));
    await bot.press(id, alpha?.data ?? '');
    expect(textOf(id)).toBe(t('ru', 'doctor.invitationGone'));

    const stranger = newPerson();
    await register(stranger);
    await bot.say(stranger, `/start i_${first}`);
    expect(countOf(stranger, t('ru', 'invite.invalid'))).toBe(1);
    bot.clock = START_CLOCK;
  });

  it('says there is nothing to list when there is nothing', async () => {
    const id = await doctor();
    await bot.press(id, 'm:d');
    await bot.press(id, 'd:o');
    expect(textOf(id)).toBe(t('ru', 'doctor.invitationsNone'));
    await bot.press(id, 'd:p');
    expect(textOf(id)).toBe(t('ru', 'doctor.patientsNone'));
  });

  it('will not let one doctor withdraw another doctor’s invitation', async () => {
    const owner = await doctor({ last: 'Owner' });
    const intruder = await doctor({ last: 'Intruder' });
    const code = await invite(owner, 'Private');
    const [entry] = await sql()<{ id: string }[]>`
      select id from invitations where code_hash = ${hashInviteCode(code)}`;

    await bot.press(intruder, `dr:${entry?.id ?? ''}`);
    expect(textOf(intruder)).toBe(t('ru', 'doctor.invitationGone'));
    const [row] = await sql()<{ revoked_at: Date | null }[]>`
      select revoked_at from invitations where id = ${entry?.id ?? ''}`;
    expect(row?.revoked_at).toBeNull();
  });
});

describe('a patient opening the link', () => {
  it('registers a stranger first, carries the link through, then offers the connection', async () => {
    const doc = await doctor({ first: 'Rustam', last: 'Rahimov' });
    const code = await invite(doc, 'Aziza K.');
    const person = newPerson();

    await bot.say(person, `/start i_${code}`);
    expect(textOf(person)).toContain('Tilni tanlang');
    // Only the hash of the link is kept while the person registers, never the link.
    const stored = await conversationOf(person);
    expect(JSON.stringify(stored?.data)).toContain(hashInviteCode(code));
    expect(JSON.stringify(stored?.data)).not.toContain(code);

    await bot.press(person, 'l:ru');
    await bot.press(person, 'c:y');
    await bot.say(person, 'Aziza');
    await bot.say(person, 'Karimova');
    await bot.press(person, 'z:ok');

    expect(textOf(person)).toBe(t('ru', 'invite.offer', { doctor: 'Rustam Rahimov' }));
    expect(dataOf(person)).toEqual(['i:y', 'i:n']);
    expect(await conversationOf(person)).toMatchObject({ flow: 'INVITE', step: 'CONFIRM' });
    expect(await relationshipsOf(doc)).toEqual([]);
  });

  it('shows a registered patient the offer at once', async () => {
    const doc = await doctor();
    const code = await invite(doc);
    const person = newPerson();
    await register(person);

    await bot.say(person, `/start i_${code}`);
    expect(textOf(person)).toBe(t('ru', 'invite.offer', { doctor: 'Rustam Rahimov' }));
  });

  it('connects them on accepting, and asks the doctor to confirm who it is', async () => {
    const doc = await doctor({ locale: 'ru' });
    const code = await invite(doc, 'Aziza K.');

    const { patientId } = await connect(doc, code, { last: 'Karimova' });

    expect(textOf(patientId)).toBe(t('ru', 'invite.accepted'));
    const links = await relationshipsOf(doc);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ status: 'PENDING', patient: 'Karimova' });
    expect(links[0]?.consent_at).toEqual(bot.clock);

    const told = telegram.lastTo(doc);
    expect(told?.text).toContain('Aziza Karimova');
    expect(told?.text).toContain(t('ru', 'doctor.yourNote', { label: 'Aziza K.' }));
    expect(told?.text).toContain(t('ru', 'doctor.confirmQuestion'));
    expect(told?.buttons.flat().map((button) => button.data)).toEqual([
      `dc:${links[0]?.id ?? ''}:y`,
      `dc:${links[0]?.id ?? ''}:n`,
    ]);
    // Not yet connected for any clinical purpose.
    expect(
      await repos.patients.getSummary(
        { kind: 'CLINICIAN', userId: await userId(doc) },
        await userId(patientId),
      ),
    ).toBeNull();
  });

  it('tells the doctor in the doctor’s language when the patient speaks another', async () => {
    const doc = await doctor({ locale: 'uz' });
    const code = await invite(doc);
    const { patientId } = await connect(doc, code, { locale: 'ru' });
    expect(textOf(patientId)).toBe(t('ru', 'invite.accepted'));
    expect(telegram.lastTo(doc)?.text).toContain(t('uz', 'doctor.confirmQuestion'));
  });

  it('offers the connection in Uzbek to an Uzbek-speaking stranger', async () => {
    const doc = await doctor();
    const code = await invite(doc);
    const person = newPerson();
    await bot.say(person, `/start i_${code}`);
    await bot.press(person, 'l:uz');
    await bot.press(person, 'c:y');
    await bot.say(person, 'Oʻktam');
    await bot.say(person, 'Karimov');
    await bot.press(person, 'z:ok');
    expect(textOf(person)).toBe(t('uz', 'invite.offer', { doctor: 'Rustam Rahimov' }));
  });

  it('lets a patient decline, and the link can still be used afterwards', async () => {
    const doc = await doctor();
    const code = await invite(doc);
    const person = newPerson();
    await register(person);
    await bot.say(person, `/start i_${code}`);

    await bot.press(person, 'i:n');
    expect(textOf(person)).toBe(t('ru', 'invite.declined'));
    expect(await relationshipsOf(doc)).toEqual([]);
    expect(await conversationOf(person)).toBeUndefined();

    await bot.say(person, `/start i_${code}`);
    expect(textOf(person)).toBe(t('ru', 'invite.offer', { doctor: 'Rustam Rahimov' }));
    await bot.press(person, 'i:y');
    expect(await relationshipsOf(doc)).toHaveLength(1);
  });

  it('ignores an answer button pressed with nothing pending', async () => {
    const doc = await doctor();
    const person = newPerson();
    await register(person);
    const before = telegram.messagesTo(person).length;
    await bot.press(person, 'i:y');
    await bot.press(person, 'i:n');
    expect(telegram.messagesTo(person)).toHaveLength(before);
    expect(await relationshipsOf(doc)).toEqual([]);
  });

  it('notifies the doctor once even if the patient taps "connect" twice at the same moment', async () => {
    const doc = await doctor();
    const code = await invite(doc);
    const person = newPerson();
    await register(person);
    await bot.say(person, `/start i_${code}`);
    const offer = telegram.lastTo(person)?.messageId ?? 0;

    await Promise.all([bot.press(person, 'i:y', offer), bot.press(person, 'i:y', offer)]);

    expect(await relationshipsOf(doc)).toHaveLength(1);
    expect(countOf(doc, t('ru', 'doctor.confirmQuestion'))).toBe(1);
  });

  it('turns a used link into "invalid" for the next person', async () => {
    const doc = await doctor();
    const code = await invite(doc);
    await connect(doc, code);

    const late = newPerson();
    await register(late);
    await bot.say(late, `/start i_${code}`);
    expect(countOf(late, t('ru', 'invite.invalid'))).toBe(1);
    // ... and then the person is simply shown their menu.
    expect(textOf(late)).toContain(t('ru', 'menu.title'));
    expect((await relationshipsOf(doc)).map((link) => link.patient)).toEqual(['Karimova']);
  });
});

describe('the doctor’s answer', () => {
  async function waiting() {
    const doc = await doctor({ first: 'Rustam', last: 'Rahimov' });
    const code = await invite(doc, 'Aziza K.');
    const { patientId, relationshipId } = await connect(doc, code, { last: 'Karimova' });
    return { doc, code, patientId, relationshipId };
  }

  it('confirming connects the patient, tells them, and lets the doctor see them', async () => {
    const { doc, patientId, relationshipId } = await waiting();

    await bot.press(doc, `dc:${relationshipId}:y`);

    expect(textOf(doc)).toBe(t('ru', 'doctor.confirmed', { name: 'Aziza Karimova' }));
    expect(telegram.lastTo(doc)?.buttons).toEqual([]);
    expect(textOf(patientId)).toBe(t('ru', 'invite.connected', { doctor: 'Rustam Rahimov' }));
    expect((await relationshipsOf(doc))[0]?.status).toBe('ACTIVE');
    expect(
      await repos.patients.getSummary(
        { kind: 'CLINICIAN', userId: await userId(doc) },
        await userId(patientId),
      ),
    ).toMatchObject({ lastName: 'Karimova' });

    // The patient now sees their doctor under "my course".
    await bot.press(patientId, 'm:h');
    await bot.press(patientId, 'm:c');
    expect(textOf(patientId)).toContain(t('ru', 'course.doctorActive', { name: 'Rustam Rahimov' }));
  });

  it('declining ends the connection, tells the patient neutrally, and keeps the doctor out', async () => {
    const { doc, patientId, relationshipId } = await waiting();

    await bot.press(doc, `dc:${relationshipId}:n`);

    expect(textOf(doc)).toBe(t('ru', 'doctor.rejected', { name: 'Aziza Karimova' }));
    expect(textOf(patientId)).toBe(t('ru', 'invite.rejected'));
    expect((await relationshipsOf(doc))[0]?.status).toBe('ENDED');
    expect(
      await repos.patients.getSummary(
        { kind: 'CLINICIAN', userId: await userId(doc) },
        await userId(patientId),
      ),
    ).toBeNull();
  });

  it('tells the patient only once, however often the doctor taps', async () => {
    const { doc, patientId, relationshipId } = await waiting();

    await bot.press(doc, `dc:${relationshipId}:y`);
    await bot.press(doc, `dc:${relationshipId}:y`);
    await Promise.all([
      bot.press(doc, `dc:${relationshipId}:y`),
      bot.press(doc, `dc:${relationshipId}:y`),
    ]);

    expect(countOf(patientId, t('ru', 'invite.connected', { doctor: 'Rustam Rahimov' }))).toBe(1);
    expect(textOf(doc)).toBe(t('ru', 'doctor.confirmed', { name: 'Aziza Karimova' }));
  });

  it('does not let the opposite button undo an answer', async () => {
    const { doc, patientId, relationshipId } = await waiting();
    await bot.press(doc, `dc:${relationshipId}:y`);

    await bot.press(doc, `dc:${relationshipId}:n`);

    expect(textOf(doc)).toBe(t('ru', 'doctor.decisionStale'));
    expect((await relationshipsOf(doc))[0]?.status).toBe('ACTIVE');
    expect(countOf(patientId, t('ru', 'invite.rejected'))).toBe(0);
  });

  it('can be given from the doctor’s patient list', async () => {
    const { doc, patientId, relationshipId } = await waiting();

    await bot.press(doc, 'm:d');
    await bot.press(doc, 'd:p');
    expect(textOf(doc)).toContain(t('ru', 'doctor.patientPending', { name: 'Aziza Karimova' }));
    expect(dataOf(doc)).toContain(`dc:${relationshipId}:y`);
    expect(dataOf(doc)).toContain(`dc:${relationshipId}:n`);

    await bot.press(doc, `dc:${relationshipId}:y`);
    expect((await relationshipsOf(doc))[0]?.status).toBe('ACTIVE');
    await bot.press(doc, 'm:d');
    await bot.press(doc, 'd:p');
    expect(textOf(doc)).toContain(t('ru', 'doctor.patientActive', { name: 'Aziza Karimova' }));
    expect(dataOf(doc).some((data) => data.startsWith('dc:'))).toBe(false);
    expect(textOf(patientId)).toContain('Rustam Rahimov');
  });

  it('shows a patient who is still waiting, under "my course"', async () => {
    const { patientId } = await waiting();
    await bot.press(patientId, 'm:h');
    await bot.press(patientId, 'm:c');
    expect(textOf(patientId)).toContain(
      t('ru', 'course.doctorPending', { name: 'Rustam Rahimov' }),
    );
  });
});
