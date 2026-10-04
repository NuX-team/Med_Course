import { randomBytes } from 'node:crypto';
import {
  createRepositories,
  createRepositoryDeps,
  type NewMedication,
  type Repositories,
  type RepositoryDeps,
} from '@medcourse/db';
import {
  createTestDatabase,
  insertRelationship,
  insertTechAdmin,
  type TestDatabase,
} from '@medcourse/db/testing';
import { t, type Locale } from '@medcourse/i18n';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { BOT_USERNAME, FakeTelegram, createHarness, type Harness } from './test-harness';

/**
 * A caregiver, end to end: the doctor issues a link, a third person opens it and agrees, the
 * patient allows it, and the caregiver then sees the patient's day and nothing more. The course
 * is "Amoxicillin" at 08:00 and 20:00, started at 05:00 on 3 October 2026 (Tashkent time).
 */

let testDatabase: TestDatabase;
let repositoryDeps: RepositoryDeps;
let repos: Repositories;
let telegram: FakeTelegram;
let bot: Harness;

const sql = () => testDatabase.db.sql;
const orm = () => testDatabase.db.orm;
const SENT = new Date('2026-10-02T10:00:00Z');
const STARTED = new Date('2026-10-03T00:00:00Z');
const local = (day: number, time: string): Date => {
  const [hours, minutes] = time.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, 2 + day, (hours ?? 0) - 5, minutes ?? 0));
};

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
  bot.clock = SENT;
});

let nextId = 29_000_000;
const newPerson = (): number => (nextId += 1);

const textOf = (id: number): string => telegram.lastTo(id)?.text ?? '(nothing was sent)';
const dataOf = (id: number): string[] =>
  (telegram.lastTo(id)?.buttons ?? []).flat().map((button) => button.data);
const textsTo = (id: number): string[] => telegram.messagesTo(id).map((message) => message.text);

async function userId(telegramId: number): Promise<string> {
  const [row] = await sql()<{ id: string }[]>`
    select id from users where telegram_user_id = ${telegramId}`;
  return row?.id ?? '';
}

async function register(id: number, options: { locale?: Locale; first?: string; last?: string }) {
  await bot.say(id, '/start');
  await bot.press(id, `l:${options.locale ?? 'ru'}`);
  await bot.press(id, 'c:y');
  await bot.say(id, options.first ?? 'Aziza');
  await bot.say(id, options.last ?? 'Karimova');
  await bot.press(id, 'z:ok');
}

async function doctor(): Promise<number> {
  const id = newPerson();
  await register(id, { first: 'Rustam', last: 'Rahimov' });
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

const AMOXICILLIN: NewMedication = {
  displayName: 'Amoxicillin',
  doseValue: 500,
  doseUnit: 'MG',
  foodRule: 'AFTER_MEAL',
  activeFromDay: 1,
  activeToDay: 7,
  schedule: { kind: 'TIMES', times: ['08:00', '20:00'] },
};

interface Scene {
  readonly doc: number;
  readonly patient: number;
  readonly patientUserId: string;
  readonly relationshipId: string;
  readonly courseId: string;
  /** A registered third person: the caregiver to be. */
  readonly helper: number;
}

/** A doctor, a patient with a running course, and a third person with an account. */
async function scene(
  options: { patientLocale?: Locale; helperLocale?: Locale } = {},
): Promise<Scene> {
  bot.clock = SENT;
  const doc = await doctor();
  const patient = newPerson();
  await register(
    patient,
    options.patientLocale === undefined ? {} : { locale: options.patientLocale },
  );
  const patientUserId = await userId(patient);
  const relationshipId = await insertRelationship(
    sql(),
    patientUserId,
    await userId(doc),
    'ACTIVE',
  );
  const actor = { kind: 'CLINICIAN', userId: await userId(doc) } as const;
  const opened = await repos.plans.openDraft(actor, { relationshipId, durationDays: 7 });
  const courseId = opened?.course.id ?? '';
  await repos.plans.addMedication(actor, courseId, AMOXICILLIN);
  await repos.plans.send(actor, courseId, { windowDays: 7, now: SENT });
  bot.clock = STARTED;
  await bot.say(patient, '/menu');
  await bot.press(patient, `pc:${courseId}`);
  const helper = newPerson();
  await register(helper, {
    first: 'Dilnoza',
    last: 'Yusupova',
    ...(options.helperLocale === undefined ? {} : { locale: options.helperLocale }),
  });
  bot.clock = local(1, '07:00');
  return { doc, patient, patientUserId, relationshipId, courseId, helper };
}

/** The doctor asks for a caregiver link; returns what goes after `?start=`. */
async function issueLink(s: Scene): Promise<string> {
  await bot.say(s.doc, '/menu');
  await bot.press(s.doc, `gi:${s.relationshipId}`);
  const found = /\?start=(g_[A-Za-z0-9_-]{22})/u.exec(textOf(s.doc));
  expect(found).not.toBeNull();
  return found?.[1] ?? '';
}

/** The helper opens the link and agrees; returns the patient's decision buttons. */
async function request(s: Scene): Promise<{ allow: string; refuse: string }> {
  await bot.say(s.helper, `/start ${await issueLink(s)}`);
  await bot.press(s.helper, 'g:y');
  const [allow = '', refuse = ''] = dataOf(s.patient);
  return { allow, refuse };
}

async function watching(s: Scene): Promise<void> {
  const { allow } = await request(s);
  await bot.press(s.patient, allow);
}

describe('the doctor issues a link', () => {
  it('from the list of patients, as a message that can be forwarded', async () => {
    const s = await scene();
    await bot.say(s.doc, '/menu');
    await bot.press(s.doc, 'd:p');
    expect(dataOf(s.doc)).toContain(`gi:${s.relationshipId}`);

    await bot.press(s.doc, `gi:${s.relationshipId}`);

    const text = textOf(s.doc);
    expect(text).toContain(`https://t.me/${BOT_USERNAME}?start=g_`);
    expect(text).toContain('Aziza Karimova');
    // Until when, on the doctor's own clock: three days from 07:00 on 3 October.
    expect(text).toContain('06.10.2026 07:00');
    expect(dataOf(s.doc)).toEqual(['d:p']);
  });

  it('only for their own confirmed patient, and only while in good standing', async () => {
    const s = await scene();
    const other = await doctor();
    bot.clock = local(1, '07:00');
    await bot.say(other, '/menu');
    await bot.press(other, `gi:${s.relationshipId}`);
    expect(textOf(other)).toBe(t('ru', 'doctor.notAllowed'));

    // In the hands of someone who is no doctor the button does nothing useful either.
    await bot.say(s.helper, '/menu');
    await bot.press(s.helper, `gi:${s.relationshipId}`);
    expect(textOf(s.helper)).toBe(t('ru', 'doctor.notAllowed'));

    const [links] = await sql()<{ n: number }[]>`
      select count(*)::int as n from caregiver_invitations where care_relationship_id = ${s.relationshipId}`;
    expect(links?.n).toBe(0);
  });
});

describe('the person the link is for', () => {
  it('is told who asks and whom they would watch, and what they will and will not be able to do', async () => {
    const s = await scene();
    await bot.say(s.helper, `/start ${await issueLink(s)}`);

    expect(textOf(s.helper)).toBe(
      t('ru', 'cg.offer', { doctor: 'Rustam Rahimov', patient: 'Aziza Karimova' }),
    );
    expect(dataOf(s.helper)).toEqual(['g:y', 'g:n']);
    // Looking is not agreeing: the patient has not been asked anything yet.
    expect(textsTo(s.patient).join('\n')).not.toContain('Dilnoza');
  });

  it('agrees, and the patient is asked in the patient’s own language', async () => {
    const s = await scene({ patientLocale: 'uz' });
    await bot.say(s.helper, `/start ${await issueLink(s)}`);

    await bot.press(s.helper, 'g:y');

    expect(textOf(s.helper)).toBe(t('ru', 'cg.requested', { patient: 'Aziza Karimova' }));
    expect(textOf(s.patient)).toBe(
      t('uz', 'cg.askPatient', { doctor: 'Rustam Rahimov', caregiver: 'Dilnoza Yusupova' }),
    );
    const buttons = dataOf(s.patient);
    expect(buttons).toHaveLength(2);
    expect(buttons[0]).toMatch(/^gd:[0-9a-f-]{36}:y$/);
    expect(buttons[1]).toMatch(/^gd:[0-9a-f-]{36}:n$/);

    // Until the patient answers, the helper sees nothing and has no "wards" in the menu.
    await bot.say(s.helper, '/menu');
    expect(dataOf(s.helper)).not.toContain('m:w');
    await bot.press(s.helper, `gw:${s.patientUserId}`);
    expect(textOf(s.helper)).toBe(t('ru', 'cg.wardGone'));
    await bot.press(s.helper, 'm:w');
    expect(textOf(s.helper)).toBe(t('ru', 'cg.wardsNone'));
  });

  it('declines, and nothing reaches the patient', async () => {
    const s = await scene();
    const before = textsTo(s.patient).length;
    await bot.say(s.helper, `/start ${await issueLink(s)}`);
    await bot.press(s.helper, 'g:n');

    expect(textOf(s.helper)).toBe(t('ru', 'cg.declined'));
    expect(textsTo(s.patient)).toHaveLength(before);
    // The offer is closed: a late "agree" on the same message does nothing.
    await bot.press(s.helper, 'g:y');
    expect(textsTo(s.patient)).toHaveLength(before);
  });

  it('must have an account first: a stranger is asked to register, and told nothing about the patient', async () => {
    const s = await scene();
    const payload = await issueLink(s);
    const stranger = newPerson();

    await bot.say(stranger, `/start ${payload}`);

    const said = textsTo(stranger).join('\n');
    expect(said).toContain(t('ru', 'cg.registerFirst'));
    expect(said).not.toContain('Aziza');
    expect(said).not.toContain('Rustam');

    // Registered, the same link works.
    await bot.press(stranger, 'l:ru');
    await bot.press(stranger, 'c:y');
    await bot.say(stranger, 'Timur');
    await bot.say(stranger, 'Aliev');
    await bot.press(stranger, 'z:ok');
    await bot.say(stranger, `/start ${payload}`);
    expect(textOf(stranger)).toBe(
      t('ru', 'cg.offer', { doctor: 'Rustam Rahimov', patient: 'Aziza Karimova' }),
    );
  });

  it('cannot use a link that is wrong, used up, or meant for watching over themself', async () => {
    const s = await scene();
    await bot.say(s.helper, '/start g_definitely-not-a-code');
    expect(textOf(s.helper)).toBe(t('ru', 'cg.linkInvalid'));
    await bot.say(s.helper, '/start g_AAAAAAAAAAAAAAAAAAAAAA');
    expect(textOf(s.helper)).toBe(t('ru', 'cg.linkInvalid'));

    const payload = await issueLink(s);
    await bot.say(s.patient, `/start ${payload}`);
    expect(textOf(s.patient)).toBe(t('ru', 'cg.own'));

    await bot.say(s.helper, `/start ${payload}`);
    await bot.press(s.helper, 'g:y');
    const second = newPerson();
    await register(second, { first: 'Second', last: 'Person' });
    await bot.say(second, `/start ${payload}`);
    expect(textOf(second)).toBe(t('ru', 'cg.linkInvalid'));
    // The same person through a fresh link: already asked, nothing new.
    await bot.say(s.helper, `/start ${await issueLink(s)}`);
    expect(textOf(s.helper)).toBe(t('ru', 'cg.already', { patient: 'Aziza Karimova' }));
  });
});

describe('the patient’s answer', () => {
  it('yes: the caregiver is told, and "wards" appears in their menu', async () => {
    const s = await scene({ helperLocale: 'uz' });
    const { allow } = await request(s);

    await bot.press(s.patient, allow);

    expect(textOf(s.patient)).toBe(t('ru', 'cg.allowed', { caregiver: 'Dilnoza Yusupova' }));
    expect(textOf(s.helper)).toBe(t('uz', 'cg.youAllowed', { patient: 'Aziza Karimova' }));
    expect(dataOf(s.helper)).toEqual(['m:w']);
    await bot.say(s.helper, '/menu');
    expect(dataOf(s.helper)).toContain('m:w');
    // The patient's own menu does not grow a "wards" button: they watch over nobody.
    await bot.say(s.patient, '/menu');
    expect(dataOf(s.patient)).not.toContain('m:w');
  });

  it('no: the caregiver is told, and still sees nothing', async () => {
    const s = await scene();
    const { refuse, allow } = await request(s);

    await bot.press(s.patient, refuse);

    expect(textOf(s.patient)).toBe(t('ru', 'cg.refused', { caregiver: 'Dilnoza Yusupova' }));
    expect(textOf(s.helper)).toBe(t('ru', 'cg.youRefused', { patient: 'Aziza Karimova' }));
    await bot.press(s.helper, `gw:${s.patientUserId}`);
    expect(textOf(s.helper)).toBe(t('ru', 'cg.wardGone'));
    // A refusal is final for that request: the old "allow" button no longer opens anything.
    await bot.say(s.patient, '/menu');
    await bot.press(s.patient, allow);
    expect(textOf(s.patient)).toBe(t('ru', 'cg.notAvailable'));
    await bot.say(s.helper, '/menu');
    expect(dataOf(s.helper)).not.toContain('m:w');
  });

  it('given twice says the same and tells the caregiver once', async () => {
    const s = await scene();
    const { allow } = await request(s);
    const question = telegram.lastTo(s.patient)?.messageId;
    await bot.press(s.patient, allow, question);
    await bot.press(s.patient, allow, question);

    expect(textOf(s.patient)).toBe(t('ru', 'cg.allowed', { caregiver: 'Dilnoza Yusupova' }));
    expect(
      textsTo(s.helper).filter(
        (text) => text === t('ru', 'cg.youAllowed', { patient: 'Aziza Karimova' }),
      ),
    ).toHaveLength(1);
  });

  it('is the patient’s alone: nobody else can press it for them', async () => {
    const s = await scene();
    const { allow } = await request(s);
    for (const who of [s.helper, s.doc]) {
      await bot.say(who, '/menu');
      await bot.press(who, allow);
      expect(textOf(who)).toBe(t('ru', 'cg.notAvailable'));
    }
    await bot.say(s.helper, '/menu');
    expect(dataOf(s.helper)).not.toContain('m:w');
  });
});

describe('what the caregiver sees', () => {
  it('is the patient’s day: the schedule, what became of each dose, and the figure', async () => {
    const s = await scene();
    await watching(s);
    const [dose] = await sql()<{ id: string }[]>`
      select id from scheduled_doses where course_id = ${s.courseId} order by scheduled_at limit 1`;
    bot.clock = local(1, '08:05');
    await bot.say(s.patient, '/menu');
    await bot.press(s.patient, `xt:${dose?.id ?? ''}`);

    bot.clock = local(1, '12:00');
    await bot.say(s.helper, '/menu');
    await bot.press(s.helper, 'm:w');
    expect(dataOf(s.helper)).toEqual([`gw:${s.patientUserId}`, 'm:h']);
    await bot.press(s.helper, `gw:${s.patientUserId}`);

    expect(textOf(s.helper)).toBe(
      [
        t('ru', 'cg.wardTitle', { patient: 'Aziza Karimova', date: '03.10.2026' }),
        [
          t('ru', 'cg.wardCourse', { status: t('ru', 'status.ACTIVE') }),
          `08:00 — Amoxicillin, 500 мг · ${t('ru', 'dose.TAKEN')}`,
          `20:00 — Amoxicillin, 500 мг · ${t('ru', 'dose.SCHEDULED')}`,
          t('ru', 'history.figure', { taken: 1, occurred: 1, percent: '100' }),
        ].join('\n'),
        t('ru', 'cg.readOnly'),
      ].join('\n\n'),
    );
    // Nothing to press but "refresh" and "back": no button answers for the patient.
    expect(dataOf(s.helper)).toEqual([`gw:${s.patientUserId}`, 'm:w']);
  });

  it('cannot be used to answer for the patient, mark an intake or touch the course', async () => {
    const s = await scene();
    await watching(s);
    const [dose] = await sql()<{ id: string }[]>`
      select id from scheduled_doses where course_id = ${s.courseId} order by scheduled_at limit 1`;
    bot.clock = local(1, '08:05');
    await bot.say(s.helper, '/menu');

    await bot.press(s.helper, `xt:${dose?.id ?? ''}`);
    expect(textOf(s.helper)).toBe(t('ru', 'dose.notAvailable'));
    await bot.press(s.helper, `pq:${s.courseId}`);
    expect(textOf(s.helper)).toBe(t('ru', 'start.notAvailable'));
    await bot.press(s.helper, `hv:${s.courseId}`);
    expect(textOf(s.helper)).toBe(t('ru', 'history.notAvailable'));
    await bot.press(s.helper, `kn:${s.courseId}`);
    expect(textOf(s.helper)).toBe(t('ru', 'doctor.notAllowed'));

    const [row] = await sql()<{ status: string; course: string }[]>`
      select d.status, c.status as course from scheduled_doses d
      join treatment_courses c on c.id = d.course_id where d.id = ${dose?.id ?? ''}`;
    expect(row).toEqual({ status: 'SCHEDULED', course: 'ACTIVE' });
  });

  it('says who skipped a dose, in words meant for an onlooker', async () => {
    const s = await scene();
    await watching(s);
    const [dose] = await sql()<{ id: string }[]>`
      select id from scheduled_doses where course_id = ${s.courseId} order by scheduled_at limit 1`;
    bot.clock = local(1, '08:05');
    await bot.say(s.patient, '/menu');
    await bot.press(s.patient, `xr:${dose?.id ?? ''}:f`);

    await bot.say(s.helper, '/menu');
    await bot.press(s.helper, `gw:${s.patientUserId}`);
    expect(textOf(s.helper)).toContain(
      `08:00 — Amoxicillin, 500 мг · ${t('ru', 'history.skippedByPatient')}`,
    );
    // The reason itself is not the caregiver's to read.
    expect(textOf(s.helper)).not.toContain(t('ru', 'dose.reason.FORGOT'));
  });
});

describe('the patient ends it', () => {
  it('from the settings, at once: the caregiver is told and sees nothing more', async () => {
    const s = await scene();
    await watching(s);

    await bot.say(s.patient, '/menu');
    await bot.press(s.patient, 'm:s');
    expect(dataOf(s.patient)).toContain('s:c');
    await bot.press(s.patient, 's:c');
    expect(textOf(s.patient)).toBe(
      `${t('ru', 'cg.listTitle')}\n${t('ru', 'cg.listActive', { name: 'Dilnoza Yusupova' })}`,
    );
    const revoke = dataOf(s.patient).find((data) => data.startsWith('gr:')) ?? '';
    expect(dataOf(s.patient)).toEqual([revoke, 'm:s']);

    await bot.press(s.patient, revoke);

    expect(textOf(s.patient)).toBe(t('ru', 'cg.revoked', { caregiver: 'Dilnoza Yusupova' }));
    expect(textOf(s.helper)).toBe(t('ru', 'cg.youRevoked', { patient: 'Aziza Karimova' }));
    await bot.say(s.helper, '/menu');
    expect(dataOf(s.helper)).not.toContain('m:w');
    await bot.press(s.helper, `gw:${s.patientUserId}`);
    expect(textOf(s.helper)).toBe(t('ru', 'cg.wardGone'));

    await bot.say(s.patient, '/menu');
    await bot.press(s.patient, 's:c');
    expect(textOf(s.patient)).toBe(t('ru', 'cg.listNone'));
    // Pressed again, the old button finds nothing to end.
    await bot.press(s.patient, revoke);
    expect(textOf(s.patient)).toBe(t('ru', 'cg.notAvailable'));
  });

  it('or before it began: a waiting request is listed and can be closed the same way', async () => {
    const s = await scene();
    await request(s);
    await bot.say(s.patient, '/menu');
    await bot.press(s.patient, 's:c');
    expect(textOf(s.patient)).toContain(t('ru', 'cg.listPending', { name: 'Dilnoza Yusupova' }));

    const revoke = dataOf(s.patient).find((data) => data.startsWith('gr:')) ?? '';
    await bot.press(s.patient, revoke);
    expect(textOf(s.patient)).toBe(t('ru', 'cg.revoked', { caregiver: 'Dilnoza Yusupova' }));
  });

  it('with nobody watching, the settings say so', async () => {
    const s = await scene();
    await bot.say(s.patient, '/menu');
    await bot.press(s.patient, 's:c');
    expect(textOf(s.patient)).toBe(t('ru', 'cg.listNone'));
    expect(dataOf(s.patient)).toEqual(['m:s']);
  });
});
