import { randomBytes } from 'node:crypto';
import {
  MAX_MEDICATIONS,
  createRepositories,
  createRepositoryDeps,
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeTelegram, createHarness, type Harness } from './test-harness';

/** The doctor writes a course in the chat and sends it; the patient receives the prescription. */

let testDatabase: TestDatabase;
let repositoryDeps: RepositoryDeps;
let repos: Repositories;
let telegram: FakeTelegram;
let bot: Harness;

const sql = () => testDatabase.db.sql;
const orm = () => testDatabase.db.orm;

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

let nextId = 10_000_000;
const newPerson = (): number => (nextId += 1);

const textOf = (id: number): string => telegram.lastTo(id)?.text ?? '(nothing was sent)';
const dataOf = (id: number): string[] =>
  (telegram.lastTo(id)?.buttons ?? []).flat().map((button) => button.data);
const labelsOf = (id: number): string[] =>
  (telegram.lastTo(id)?.buttons ?? []).flat().map((button) => button.text);
const allTextTo = (id: number): string =>
  telegram
    .messagesTo(id)
    .map((message) => message.text)
    .join('\n---\n');

async function userId(telegramId: number): Promise<string> {
  const [row] = await sql()<{ id: string }[]>`
    select id from users where telegram_user_id = ${telegramId}`;
  return row?.id ?? '';
}

async function register(
  id: number,
  options: { locale?: Locale; first?: string; last?: string } = {},
) {
  await bot.say(id, '/start');
  await bot.press(id, `l:${options.locale ?? 'ru'}`);
  await bot.press(id, 'c:y');
  await bot.say(id, options.first ?? 'Aziza');
  await bot.say(id, options.last ?? 'Karimova');
  await bot.press(id, 'z:ok');
}

async function doctor(options: { locale?: Locale; last?: string } = {}): Promise<number> {
  const id = newPerson();
  await register(id, { first: 'Rustam', last: options.last ?? 'Rahimov', ...options });
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

interface Linked {
  readonly patient: number;
  readonly relationshipId: string;
}

/** A registered patient already connected to the doctor and confirmed. */
async function linked(
  doc: number,
  options: { locale?: Locale; last?: string } = {},
): Promise<Linked> {
  const patient = newPerson();
  await register(patient, options);
  const relationshipId = await insertRelationship(
    sql(),
    await userId(patient),
    await userId(doc),
    'ACTIVE',
  );
  return { patient, relationshipId };
}

/** New course, patient chosen, length chosen: the wizard now asks for the first medication. */
async function begin(
  doc: number,
  link: Linked,
  days: '5' | '7' | '10' | '14' = '7',
): Promise<string> {
  await bot.press(doc, 'm:d');
  await bot.press(doc, 'd:c');
  await bot.press(doc, `kb:${link.relationshipId}`);
  await bot.press(doc, `w:l:${days}`);
  return courseIdOf(link);
}

async function courseIdOf(link: Linked): Promise<string> {
  const [row] = await sql()<{ id: string }[]>`
    select id from treatment_courses where care_relationship_id = ${link.relationshipId}
    order by created_at desc limit 1`;
  return row?.id ?? '';
}

async function courseRow(courseId: string) {
  const [row] = await sql()<
    { status: string; duration_days: number; start_window_to: Date | null; timezone: string }[]
  >`select status, duration_days, start_window_to, timezone from treatment_courses where id = ${courseId}`;
  return row;
}

interface Typed {
  name?: string;
  dose?: string;
  unit?: string;
  food?: string;
  /** '1'-'4' accepts the proposal; anything else is typed as the doctor's own times. */
  times?: string;
  note?: string;
}

/** Walks the medication steps from "name" to the draft card. */
async function addMedication(doc: number, typed: Typed = {}): Promise<void> {
  await bot.say(doc, typed.name ?? 'Amoxicillin');
  await bot.say(doc, typed.dose ?? '500');
  await bot.press(doc, `w:u:${typed.unit ?? 'MG'}`);
  await bot.press(doc, `w:f:${typed.food ?? 'AFTER_MEAL'}`);
  const times = typed.times ?? '2';
  if (['1', '2', '3', '4'].includes(times)) {
    await bot.press(doc, `w:q:${times}`);
  } else {
    await bot.press(doc, 'w:q:own');
    await bot.say(doc, times);
  }
  await bot.press(doc, 'w:t:ok');
  await bot.press(doc, 'w:d:all');
  if (typed.note === undefined) {
    await bot.press(doc, 'w:n:skip');
  } else {
    await bot.say(doc, typed.note);
  }
}

async function medicationsOf(courseId: string) {
  return sql()<
    {
      id: string;
      display_name: string;
      dose_value: string;
      dose_display: string | null;
      dose_unit: string;
      food_rule: string;
      prn: boolean;
      max_daily_doses: number | null;
      minimum_interval_minutes: number | null;
      active_from_day: number;
      active_to_day: number;
      instructions_enc: string | null;
      times: string[];
    }[]
  >`
    select m.id, m.display_name, m.dose_value, m.dose_display, m.dose_unit, m.food_rule, m.prn,
           m.max_daily_doses, m.minimum_interval_minutes, m.active_from_day, m.active_to_day,
           m.instructions_enc,
           coalesce((select array_agg(r.local_time::text order by r.local_time)
                     from schedule_rules r where r.medication_id = m.id), '{}') as times
    from course_medications m
    join treatment_courses c on c.current_revision_id = m.revision_id
    where c.id = ${courseId} order by m.created_at, m.id`;
}

describe('starting a course', () => {
  it('offers "new course" and "courses" in the doctor’s menu', async () => {
    const doc = await doctor();
    await bot.press(doc, 'm:d');
    expect(dataOf(doc).slice(0, 2)).toEqual(['d:c', 'd:l']);
  });

  it('asks who it is for, listing only confirmed patients', async () => {
    const doc = await doctor();
    const confirmed = await linked(doc, { last: 'Confirmed' });
    const waiting = newPerson();
    await register(waiting, { last: 'Waiting' });
    await insertRelationship(sql(), await userId(waiting), await userId(doc), 'PENDING');

    await bot.press(doc, 'm:d');
    await bot.press(doc, 'd:c');

    expect(textOf(doc)).toBe(t('ru', 'cw.pickPatient'));
    expect(dataOf(doc)).toEqual([`kb:${confirmed.relationshipId}`, 'm:d']);
    expect(labelsOf(doc)[0]).toBe('Confirmed Aziza');
  });

  it('explains that a patient must be connected first', async () => {
    const doc = await doctor();
    await bot.press(doc, 'm:d');
    await bot.press(doc, 'd:c');
    expect(textOf(doc)).toBe(t('ru', 'cw.noPatients'));
  });

  it('asks how long, creates the draft in the patient’s time zone, and asks for a medication', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    await sql()`update users set timezone = 'Europe/Moscow' where telegram_user_id = ${link.patient}`;
    await bot.press(doc, 'm:d');
    await bot.press(doc, 'd:c');
    await bot.press(doc, `kb:${link.relationshipId}`);

    expect(textOf(doc)).toBe(t('ru', 'cw.askDuration', { patient: 'Aziza Karimova' }));
    expect(dataOf(doc)).toEqual(['w:l:5', 'w:l:7', 'w:l:10', 'w:l:14', 'm:d']);

    for (const bad of ['0', '400', 'неделя', '7.5']) {
      await bot.say(doc, bad);
      expect(textOf(doc), bad).toBe(t('ru', 'cw.invalidDuration'));
    }
    expect(await courseIdOf(link)).toBe('');

    await bot.say(doc, '21 день');
    expect(textOf(doc)).toBe(t('ru', 'cw.askName'));
    expect(await courseRow(await courseIdOf(link))).toMatchObject({
      status: 'DRAFT',
      duration_days: 21,
      timezone: 'Europe/Moscow',
    });
  });

  it('continues the existing draft instead of starting a second one', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    await addMedication(doc);

    await bot.press(doc, 'm:d');
    await bot.press(doc, 'd:c');
    await bot.press(doc, `kb:${link.relationshipId}`);

    expect(textOf(doc)).toContain(t('ru', 'cw.draftTitle'));
    expect(textOf(doc)).toContain('Amoxicillin');
    const [row] = await sql()<{ n: number }[]>`
      select count(*)::int as n from treatment_courses where care_relationship_id = ${link.relationshipId}`;
    expect(row?.n).toBe(1);
    expect(await courseIdOf(link)).toBe(courseId);
  });

  it('refuses a patient who is not this doctor’s, and creates nothing', async () => {
    const doc = await doctor();
    const other = await doctor({ last: 'Other' });
    const theirs = await linked(other);

    await bot.press(doc, 'm:d');
    await bot.press(doc, `kb:${theirs.relationshipId}`);
    expect(textOf(doc)).toBe(t('ru', 'cw.notAvailable'));
    await bot.press(doc, 'w:l:7');
    await bot.say(doc, '7');
    expect(await courseIdOf(theirs)).toBe('');
  });

  it('is closed to patients, strangers and doctors without standing', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const applicant = newPerson();
    await register(applicant);
    await bot.press(applicant, 'm:d');
    await bot.press(applicant, 'd:r');
    await bot.say(applicant, 'Pediatrician, licence UZ-2');
    const stranger = newPerson();

    for (const who of [link.patient, applicant]) {
      await bot.press(who, 'd:c');
      expect(textOf(who)).toBe(t('ru', 'doctor.notAllowed'));
      await bot.press(who, `kb:${link.relationshipId}`);
      await bot.press(who, 'w:l:7');
    }
    await bot.press(stranger, 'd:c');
    await bot.press(stranger, `kb:${link.relationshipId}`);
    expect(telegram.messagesTo(stranger)).toEqual([]);
    expect(await courseIdOf(link)).toBe('');
  });
});

describe('adding a medication', () => {
  it('walks name, dose, unit, food, frequency, proposed times, days and instructions', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);

    await bot.say(doc, 'Amoxicillin');
    expect(textOf(doc)).toBe(t('ru', 'cw.askDose', { name: 'Amoxicillin' }));
    await bot.say(doc, '500');
    expect(textOf(doc)).toBe(t('ru', 'cw.askUnit', { name: 'Amoxicillin', dose: '500' }));
    expect(dataOf(doc)).toContain('w:u:MG');
    expect(dataOf(doc)).not.toContain('w:u:OTHER');
    await bot.press(doc, 'w:u:MG');
    expect(textOf(doc)).toBe(t('ru', 'cw.askFood', { name: 'Amoxicillin', dose: '500 мг' }));
    await bot.press(doc, 'w:f:AFTER_MEAL');
    expect(textOf(doc)).toBe(t('ru', 'cw.askFrequency', { name: 'Amoxicillin' }));
    expect(dataOf(doc)).toEqual([
      'w:q:1',
      'w:q:2',
      'w:q:3',
      'w:q:4',
      'w:q:own',
      'w:q:prn',
      `kv:${courseId}`,
    ]);

    await bot.press(doc, 'w:q:2');
    // A proposal with a disclaimer, and nothing is stored until the doctor confirms it.
    expect(textOf(doc)).toBe(
      t('ru', 'cw.proposeTimes', { name: 'Amoxicillin', times: '09:00, 21:00' }),
    );
    expect(textOf(doc)).toMatch(/не медицинская рекомендация/);
    expect(await medicationsOf(courseId)).toEqual([]);

    await bot.press(doc, 'w:t:ok');
    expect(textOf(doc)).toBe(t('ru', 'cw.askDays', { name: 'Amoxicillin', days: 7 }));
    await bot.press(doc, 'w:d:all');
    expect(textOf(doc)).toBe(t('ru', 'cw.askInstructions'));
    await bot.press(doc, 'w:n:skip');

    expect(textOf(doc)).toContain(t('ru', 'cw.draftTitle'));
    expect(textOf(doc)).toContain('1. Amoxicillin — 500 мг, после еды');
    expect(textOf(doc)).toContain(t('ru', 'card.everyDay', { times: '09:00, 21:00' }));
    expect(await medicationsOf(courseId)).toMatchObject([
      {
        display_name: 'Amoxicillin',
        dose_value: '500.000',
        dose_unit: 'MG',
        food_rule: 'AFTER_MEAL',
        prn: false,
        active_from_day: 1,
        active_to_day: 7,
        instructions_enc: null,
        times: ['09:00:00', '21:00:00'],
      },
    ]);
  });

  it('takes the doctor’s own times, shows them back, and stores them only once confirmed', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    await bot.say(doc, 'Ibuprofen');
    await bot.say(doc, '200');
    await bot.press(doc, 'w:u:MG');
    await bot.press(doc, 'w:f:WITH_MEAL');
    await bot.press(doc, 'w:q:own');
    expect(textOf(doc)).toBe(t('ru', 'cw.askTimes'));

    for (const bad of ['утром и вечером', '25:00', '8 8', '8:60']) {
      await bot.say(doc, bad);
      expect(textOf(doc), bad).toBe(t('ru', 'cw.invalidTimes'));
    }
    await bot.say(doc, '22 8 14:30');
    expect(textOf(doc)).toBe(
      t('ru', 'cw.proposeTimes', { name: 'Ibuprofen', times: '08:00, 14:30, 22:00' }),
    );
    expect(await medicationsOf(courseId)).toEqual([]);

    await bot.press(doc, 'w:t:ok');
    await bot.press(doc, 'w:d:all');
    await bot.press(doc, 'w:n:skip');
    expect((await medicationsOf(courseId))[0]?.times).toEqual(['08:00:00', '14:30:00', '22:00:00']);
  });

  it('lets the doctor replace a proposed time', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    await bot.say(doc, 'Vitamin D');
    await bot.say(doc, '2');
    await bot.press(doc, 'w:u:DROP');
    await bot.press(doc, 'w:f:ANY');
    await bot.press(doc, 'w:q:1');
    await bot.press(doc, 'w:t:change');
    expect(textOf(doc)).toBe(t('ru', 'cw.askTimes'));
    await bot.say(doc, '07:15');
    await bot.press(doc, 'w:t:ok');
    await bot.press(doc, 'w:d:all');
    await bot.press(doc, 'w:n:skip');

    expect(await medicationsOf(courseId)).toMatchObject([
      { dose_unit: 'DROP', food_rule: 'ANY', times: ['07:15:00'] },
    ]);
    expect(textOf(doc)).toContain('1. Vitamin D — 2 кап., независимо от еды');
  });

  it('records an as-needed medication only with both of its limits', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    await bot.say(doc, 'Paracetamol');
    await bot.say(doc, '1');
    await bot.press(doc, 'w:u:TABLET');
    await bot.press(doc, 'w:f:ANY');
    await bot.press(doc, 'w:q:prn');
    expect(textOf(doc)).toBe(t('ru', 'cw.askPrnMax', { name: 'Paracetamol' }));

    for (const bad of ['0', '25', 'часто']) {
      await bot.say(doc, bad);
      expect(textOf(doc), bad).toBe(t('ru', 'cw.invalidPrnMax'));
    }
    await bot.say(doc, '3');
    expect(textOf(doc)).toBe(t('ru', 'cw.askPrnInterval'));
    expect(labelsOf(doc).slice(0, 3)).toEqual(['30 мин', '1 ч', '2 ч']);
    expect(await medicationsOf(courseId)).toEqual([]);

    await bot.press(doc, 'w:i:240');
    await bot.press(doc, 'w:d:all');
    await bot.say(doc, 'Только при температуре выше 38,5');

    expect(await medicationsOf(courseId)).toMatchObject([
      { prn: true, max_daily_doses: 3, minimum_interval_minutes: 240, times: [] },
    ]);
    expect(textOf(doc)).toContain(t('ru', 'card.prn', { max: 3, interval: '4 ч' }));
    expect(textOf(doc)).toContain(
      t('ru', 'card.note', { text: 'Только при температуре выше 38,5' }),
    );
  });

  it('keeps a fraction as the doctor wrote it', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    await addMedication(doc, { name: 'Bisoprolol', dose: '1/2', unit: 'TABLET', times: '1' });

    expect(await medicationsOf(courseId)).toMatchObject([
      { dose_value: '0.500', dose_display: '1/2', dose_unit: 'TABLET' },
    ]);
    expect(textOf(doc)).toContain('1. Bisoprolol — 1/2 табл., после еды');
  });

  it('can limit a medication to some days of the course', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link, '10');
    await bot.say(doc, 'Azithromycin');
    await bot.say(doc, '500');
    await bot.press(doc, 'w:u:MG');
    await bot.press(doc, 'w:f:BEFORE_MEAL');
    await bot.press(doc, 'w:q:1');
    await bot.press(doc, 'w:t:ok');
    await bot.press(doc, 'w:d:some');
    expect(textOf(doc)).toBe(t('ru', 'cw.askDayRange', { days: 10 }));

    for (const bad of ['0-3', '5-20', 'первые три', '3-1']) {
      await bot.say(doc, bad);
      expect(textOf(doc), bad).toBe(t('ru', 'cw.invalidDayRange', { days: 10 }));
    }
    await bot.say(doc, '1-3');
    await bot.press(doc, 'w:n:skip');

    expect(await medicationsOf(courseId)).toMatchObject([{ active_from_day: 1, active_to_day: 3 }]);
    expect(textOf(doc)).toContain(t('ru', 'card.days', { from: 1, to: 3 }));
  });

  it('asks again, without losing the step, for a name or dose it cannot read', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);

    for (const bad of ['12345', 'x'.repeat(121), `Drug${String.fromCodePoint(0x202e)}`]) {
      await bot.say(doc, bad);
      expect(textOf(doc)).toBe(t('ru', 'cw.invalidMedName'));
    }
    await bot.say(doc, 'Amoxicillin');
    for (const bad of ['0', '500 мг', 'пол таблетки', '-1', '1.2345']) {
      await bot.say(doc, bad);
      expect(textOf(doc), bad).toBe(t('ru', 'cw.invalidDose'));
    }
    await bot.say(doc, '0,5');
    expect(textOf(doc)).toBe(t('ru', 'cw.askUnit', { name: 'Amoxicillin', dose: '0,5' }));
    expect(await medicationsOf(courseId)).toEqual([]);
  });

  it('encrypts the instructions and never keeps them in the conversation', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    await addMedication(doc, { note: 'Запивать полным стаканом воды' });

    const [medication] = await medicationsOf(courseId);
    expect(medication?.instructions_enc).not.toBeNull();
    expect(medication?.instructions_enc).not.toContain('стакан');
    const [leaks] = await sql()<{ n: number }[]>`
      select (select count(*) from conversation_states c where c::text like '%стакан%')::int
           + (select count(*) from audit_log a where a::text like '%стакан%' or a::text like '%Amoxicillin%')::int as n`;
    expect(leaks?.n).toBe(0);
    const plan = await repos.plans.getPlan(
      { kind: 'CLINICIAN', userId: await userId(doc) },
      courseId,
    );
    expect(plan?.medications[0]?.instructions).toBe('Запивать полным стаканом воды');
  });

  it('refuses instructions it cannot use and still lets the doctor skip', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    await bot.say(doc, 'Amoxicillin');
    await bot.say(doc, '500');
    await bot.press(doc, 'w:u:MG');
    await bot.press(doc, 'w:f:ANY');
    await bot.press(doc, 'w:q:1');
    await bot.press(doc, 'w:t:ok');
    await bot.press(doc, 'w:d:all');
    await bot.say(doc, 'x'.repeat(301));
    expect(textOf(doc)).toBe(t('ru', 'cw.invalidInstructions'));
    expect(await medicationsOf(courseId)).toEqual([]);
  });

  it('ignores a button from another step, however often it is pressed', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    const before = telegram.messagesTo(doc).length;

    // Still at "name": none of these belongs here.
    for (const data of ['w:u:MG', 'w:f:ANY', 'w:q:2', 'w:t:ok', 'w:d:all', 'w:n:skip', 'w:i:60']) {
      await bot.press(doc, data);
    }
    expect(telegram.messagesTo(doc)).toHaveLength(before);
    expect(textOf(doc)).toBe(t('ru', 'cw.askName'));
    expect(await medicationsOf(courseId)).toEqual([]);
  });

  it('keeps its place when the doctor types where a button is expected', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    await bot.say(doc, 'Amoxicillin');
    await bot.say(doc, '500');
    const unitQuestion = telegram.lastTo(doc)?.messageId ?? 0;

    // The step wants a unit button. Typed text is not an answer to it, and must not lose it.
    await bot.say(doc, 'миллиграммы');
    await bot.press(doc, 'w:u:MG', unitQuestion);

    // The question that was answered turns into the next one, and the wizard carries on from it.
    const shown = (): string =>
      telegram.messagesTo(doc).find((message) => message.messageId === unitQuestion)?.text ?? '';
    expect(shown()).toBe(t('ru', 'cw.askFood', { name: 'Amoxicillin', dose: '500 мг' }));
    for (const data of ['w:f:ANY', 'w:q:1', 'w:t:ok', 'w:d:all', 'w:n:skip']) {
      await bot.press(doc, data, unitQuestion);
    }
    expect(await medicationsOf(courseId)).toHaveLength(1);
  });

  it('drops a half-entered medication when the doctor goes back to the draft', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    await bot.say(doc, 'Abandoned');
    await bot.press(doc, `kv:${courseId}`);
    expect(textOf(doc)).toContain(t('ru', 'card.noMeds'));

    await bot.say(doc, '500');
    expect(textOf(doc)).toContain(t('ru', 'menu.title'));
    expect(await medicationsOf(courseId)).toEqual([]);
  });

  it('drops it on /menu too', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    await bot.say(doc, 'Abandoned');
    await bot.say(doc, '/menu');
    await bot.say(doc, '500');
    await bot.press(doc, 'w:u:MG');
    expect(await medicationsOf(courseId)).toEqual([]);
  });

  it('speaks the doctor’s language', async () => {
    const doc = await doctor({ locale: 'uz' });
    const link = await linked(doc);
    await begin(doc, link);
    expect(textOf(doc)).toBe(t('uz', 'cw.askName'));
    await bot.say(doc, 'Amoksitsillin');
    await bot.say(doc, '500');
    expect(labelsOf(doc)).toContain('mg');
    await bot.press(doc, 'w:u:MG');
    expect(textOf(doc)).toBe(t('uz', 'cw.askFood', { name: 'Amoksitsillin', dose: '500 mg' }));
  });
});

describe('the draft', () => {
  it('shows the whole prescription and what can be done with it', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    await addMedication(doc, { name: 'First' });
    await bot.press(doc, `ka:${courseId}`);
    await addMedication(doc, { name: 'Second', times: '08:00' });

    const text = textOf(doc);
    expect(text).toContain(t('ru', 'card.patient', { name: 'Aziza Karimova' }));
    expect(text).toContain(t('ru', 'card.duration', { days: 7 }));
    expect(text.indexOf('1. First')).toBeLessThan(text.indexOf('2. Second'));
    expect(text).toContain(t('ru', 'card.timezone', { zone: 'Asia/Tashkent' }));
    expect(dataOf(doc)).toEqual([
      `ka:${courseId}`,
      `kr:${courseId}`,
      `kd:${courseId}`,
      `ks:${courseId}`,
      `kq:${courseId}`,
      'm:d',
    ]);
  });

  it('offers neither "send" nor "remove" while it is empty', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    await bot.press(doc, `kv:${courseId}`);
    expect(dataOf(doc)).toEqual([`ka:${courseId}`, `kd:${courseId}`, `kq:${courseId}`, 'm:d']);
  });

  it('removes a medication the doctor picks', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    await addMedication(doc, { name: 'Keep' });
    await bot.press(doc, `ka:${courseId}`);
    await addMedication(doc, { name: 'Remove', times: '08:00' });

    await bot.press(doc, `kr:${courseId}`);
    expect(textOf(doc)).toBe(t('ru', 'cw.pickRemove'));
    expect(labelsOf(doc).slice(0, 2)).toEqual(['Keep', 'Remove']);
    const target = (await medicationsOf(courseId)).find((m) => m.display_name === 'Remove');
    await bot.press(doc, `kx:${target?.id ?? ''}`);

    expect((await medicationsOf(courseId)).map((m) => m.display_name)).toEqual(['Keep']);
    expect(textOf(doc)).not.toContain('Remove');
  });

  it('changes its length, and refuses to cut off days a medication needs', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link, '10');
    await addMedication(doc, { name: 'Whole' });
    await bot.press(doc, `kd:${courseId}`);
    expect(textOf(doc)).toBe(t('ru', 'cw.askNewDuration', { days: 10 }));
    await bot.say(doc, '14');
    expect(textOf(doc)).toContain(t('ru', 'card.duration', { days: 14 }));
    expect((await medicationsOf(courseId))[0]?.active_to_day).toBe(14);

    await sql()`update course_medications set active_from_day = 8, active_to_day = 12
                where id = ${(await medicationsOf(courseId))[0]?.id ?? ''}`;
    await bot.press(doc, `kd:${courseId}`);
    await bot.say(doc, '9');
    expect(textOf(doc)).toBe(t('ru', 'cw.durationConflict', { name: 'Whole' }));
    expect((await courseRow(courseId))?.duration_days).toBe(14);
  });

  it('is thrown away only after the doctor confirms, and the patient never hears of it', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    await addMedication(doc);
    const before = telegram.messagesTo(link.patient).length;

    await bot.press(doc, `kq:${courseId}`);
    expect(textOf(doc)).toBe(t('ru', 'cw.discardConfirm', { patient: 'Aziza Karimova' }));
    expect((await courseRow(courseId))?.status).toBe('DRAFT');
    await bot.press(doc, `ky:${courseId}`);

    expect(textOf(doc)).toBe(t('ru', 'cw.discarded'));
    expect((await courseRow(courseId))?.status).toBe('CANCELLED');
    expect(telegram.messagesTo(link.patient)).toHaveLength(before);
    await bot.press(link.patient, 'm:c');
    expect(textOf(link.patient)).not.toContain('Amoxicillin');

    // And a new one can be started for the same patient.
    const again = await begin(doc, link);
    expect(again).not.toBe(courseId);
  });

  it('stops at fifteen medications', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    const actor = { kind: 'CLINICIAN', userId: await userId(doc) } as const;
    for (let index = 0; index < MAX_MEDICATIONS; index += 1) {
      await repos.plans.addMedication(actor, courseId, {
        displayName: `Drug ${String(index)}`,
        doseValue: 1,
        doseUnit: 'TABLET',
        foodRule: 'ANY',
        activeFromDay: 1,
        activeToDay: 7,
        schedule: { kind: 'TIMES', times: ['08:00'] },
      });
    }

    await bot.press(doc, `kv:${courseId}`);
    expect(dataOf(doc)).not.toContain(`ka:${courseId}`);
    await bot.press(doc, `ka:${courseId}`);
    expect(textOf(doc)).toBe(t('ru', 'cw.limitMeds', { max: MAX_MEDICATIONS }));
  });

  it('is split across messages when it is too long for one, with the buttons under the last', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    const actor = { kind: 'CLINICIAN', userId: await userId(doc) } as const;
    for (let index = 0; index < MAX_MEDICATIONS; index += 1) {
      await repos.plans.addMedication(actor, courseId, {
        displayName: `${String(index)} ${'N'.repeat(110)}`,
        doseValue: 1,
        doseUnit: 'TABLET',
        foodRule: 'ANY',
        instructions: 'i'.repeat(300),
        activeFromDay: 1,
        activeToDay: 7,
        schedule: { kind: 'TIMES', times: ['08:00'] },
      });
    }
    const before = telegram.messagesTo(doc).length;

    await bot.press(doc, `kv:${courseId}`);

    const parts = telegram.messagesTo(doc).slice(before);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.text.length).toBeLessThanOrEqual(4096);
    }
    expect(parts.slice(0, -1).every((part) => part.buttons.length === 0)).toBe(true);
    expect(
      parts
        .at(-1)
        ?.buttons.flat()
        .map((button) => button.data),
    ).toContain(`ks:${courseId}`);
    const whole = parts.map((part) => part.text).join('\n');
    for (let index = 0; index < MAX_MEDICATIONS; index += 1) {
      expect(whole).toContain(`${String(index + 1)}. ${String(index)} N`);
    }
  });
});

describe('sending the course', () => {
  it('shows the prescription once more and asks how long the patient has to start', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    await addMedication(doc);

    await bot.press(doc, `ks:${courseId}`);

    expect(textOf(doc)).toContain('1. Amoxicillin — 500 мг, после еды');
    expect(textOf(doc)).toContain(t('ru', 'cw.sendConfirm'));
    expect(dataOf(doc)).toEqual([
      `kw:${courseId}:1`,
      `kw:${courseId}:3`,
      `kw:${courseId}:7`,
      `kw:${courseId}:14`,
      `kv:${courseId}`,
    ]);
    expect((await courseRow(courseId))?.status).toBe('DRAFT');
  });

  it('sends it: the doctor is told, the patient gets the prescription, and no reminder exists', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    await addMedication(doc, { note: 'Запивать водой' });
    await bot.press(doc, `ks:${courseId}`);

    await bot.press(doc, `kw:${courseId}:7`);

    // 2026-10-02 10:00 UTC plus seven days, on the patient's (Tashkent) clock.
    const until = '09.10.2026 15:00';
    expect(textOf(doc)).toBe(t('ru', 'cw.sent', { patient: 'Aziza Karimova', until }));
    expect(await courseRow(courseId)).toMatchObject({
      status: 'PENDING_PATIENT',
      start_window_to: new Date('2026-10-09T10:00:00Z'),
    });

    const received = textOf(link.patient);
    expect(received).toContain(t('ru', 'course.assigned', { doctor: 'Rustam Rahimov' }));
    expect(received).toContain('1. Amoxicillin — 500 мг, после еды');
    expect(received).toContain(t('ru', 'card.everyDay', { times: '09:00, 21:00' }));
    expect(received).toContain(t('ru', 'card.note', { text: 'Запивать водой' }));
    expect(received).toContain(t('ru', 'course.pendingNote', { until }));
    expect(received).toMatch(/экстренн/);
    expect(JSON.stringify(telegram.lastTo(link.patient)?.options)).not.toContain('parse_mode');

    const [counts] = await sql()<{ doses: number }[]>`
      select count(*)::int as doses from scheduled_doses where course_id = ${courseId}`;
    expect(counts?.doses).toBe(0);
  });

  it('gives the patient the prescription in the patient’s own language', async () => {
    const doc = await doctor();
    const link = await linked(doc, { locale: 'uz' });
    const courseId = await begin(doc, link);
    await addMedication(doc);
    await bot.press(doc, `ks:${courseId}`);
    await bot.press(doc, `kw:${courseId}:3`);

    const received = textOf(link.patient);
    expect(received).toContain(t('uz', 'course.assigned', { doctor: 'Rustam Rahimov' }));
    expect(received).toContain('1. Amoxicillin — 500 mg, ovqatdan keyin');
    expect(received).toMatch(/shoshilinch/);
    expect(textOf(doc)).toContain('Aziza Karimova');
  });

  it('shows the patient the course under "my course", and nothing while it is a draft', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    await addMedication(doc);

    await bot.say(link.patient, '/menu');
    await bot.press(link.patient, 'm:c');
    expect(textOf(link.patient)).not.toContain('Amoxicillin');
    expect(textOf(link.patient)).toContain(t('ru', 'course.none'));

    await bot.press(doc, `ks:${courseId}`);
    await bot.press(doc, `kw:${courseId}:7`);
    await bot.say(link.patient, '/menu');
    await bot.press(link.patient, 'm:c');

    const shown = textOf(link.patient);
    expect(shown).toContain(t('ru', 'course.title'));
    expect(shown).toContain(t('ru', 'card.doctor', { name: 'Rustam Rahimov' }));
    expect(shown).toContain(t('ru', 'card.status', { status: t('ru', 'status.PENDING_PATIENT') }));
    expect(shown).toContain('1. Amoxicillin — 500 мг, после еды');
    // ... with the button that starts it.
    expect(dataOf(link.patient)).toEqual([`ps:${courseId}`, 'm:h']);
  });

  it('happens once: a second press, or two at the same moment, tell the patient once', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    await addMedication(doc);
    await bot.press(doc, `ks:${courseId}`);
    const confirm = telegram.lastTo(doc)?.messageId ?? 0;

    await Promise.all([
      bot.press(doc, `kw:${courseId}:7`, confirm),
      bot.press(doc, `kw:${courseId}:7`, confirm),
    ]);
    await bot.press(doc, `kw:${courseId}:14`, confirm);

    const assigned = t('ru', 'course.assigned', { doctor: 'Rustam Rahimov' });
    expect(telegram.messagesTo(link.patient).filter((m) => m.text.includes(assigned))).toHaveLength(
      1,
    );
    expect((await courseRow(courseId))?.start_window_to).toEqual(new Date('2026-10-09T10:00:00Z'));
  });

  it('will not send an empty course, and says why', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    const before = telegram.messagesTo(link.patient).length;

    await bot.press(doc, `kw:${courseId}:7`);

    expect(textOf(doc)).toBe(
      `${t('ru', 'cw.cannotSend')}\n• ${t('ru', 'cw.problem.NO_MEDICATIONS')}`,
    );
    expect((await courseRow(courseId))?.status).toBe('DRAFT');
    expect(telegram.messagesTo(link.patient)).toHaveLength(before);
  });

  it('will not send a contradictory course, and names the medication', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    await addMedication(doc, { name: 'Doubled', times: '08:00' });
    const [medication] = await medicationsOf(courseId);
    await sql()`insert into schedule_rules (medication_id, local_time) values (${medication?.id ?? ''}, '08:00')`;

    await bot.press(doc, `kw:${courseId}:7`);

    expect(textOf(doc)).toContain(t('ru', 'cw.problem.DUPLICATE_SLOT', { name: 'Doubled' }));
    expect((await courseRow(courseId))?.status).toBe('DRAFT');
  });

  it('freezes the plan: afterwards it can be taken back but not edited, and old buttons do nothing', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    await addMedication(doc);
    const [medication] = await medicationsOf(courseId);
    await bot.press(doc, `ks:${courseId}`);
    await bot.press(doc, `kw:${courseId}:7`);

    await bot.press(doc, `kv:${courseId}`);
    expect(textOf(doc)).toContain(
      t('ru', 'card.status', { status: t('ru', 'status.PENDING_PATIENT') }),
    );
    expect(textOf(doc)).not.toContain(t('ru', 'cw.draftTitle'));
    // The one thing left to do with it before the patient starts: take it back.
    expect(dataOf(doc)).toEqual([`kc:${courseId}`, 'm:d']);

    for (const data of [
      `ka:${courseId}`,
      `kr:${courseId}`,
      `kd:${courseId}`,
      `kq:${courseId}`,
      `ky:${courseId}`,
    ]) {
      await bot.press(doc, data);
      expect(textOf(doc), data).toBe(t('ru', 'cw.notAvailable'));
    }
    await bot.press(doc, `kx:${medication?.id ?? ''}`);
    expect(textOf(doc)).toBe(t('ru', 'cw.notAvailable'));
    expect(await medicationsOf(courseId)).toHaveLength(1);
    expect((await courseRow(courseId))?.status).toBe('PENDING_PATIENT');
  });
});

describe('courses that are not this person’s to touch', () => {
  it('cannot be read, edited, sent or thrown away by another doctor', async () => {
    const owner = await doctor({ last: 'Owner' });
    const intruder = await doctor({ last: 'Intruder' });
    const link = await linked(owner);
    const courseId = await begin(owner, link);
    await addMedication(owner, { name: 'Private' });
    const [medication] = await medicationsOf(courseId);
    const before = telegram.messagesTo(link.patient).length;

    for (const data of [
      `kv:${courseId}`,
      `ka:${courseId}`,
      `kr:${courseId}`,
      `kd:${courseId}`,
      `ks:${courseId}`,
      `kw:${courseId}:7`,
      `kq:${courseId}`,
      `ky:${courseId}`,
      `kx:${medication?.id ?? ''}`,
    ]) {
      await bot.press(intruder, data);
      expect(textOf(intruder), data).toBe(t('ru', 'cw.notAvailable'));
    }
    expect(allTextTo(intruder)).not.toContain('Private');
    expect((await courseRow(courseId))?.status).toBe('DRAFT');
    expect(await medicationsOf(courseId)).toHaveLength(1);
    expect(telegram.messagesTo(link.patient)).toHaveLength(before);
  });

  it('cannot be sent to themselves, or seen as a draft, by the patient', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    await addMedication(doc, { name: 'Unsent' });

    for (const data of [`kv:${courseId}`, `ks:${courseId}`, `kw:${courseId}:7`, `ky:${courseId}`]) {
      await bot.press(link.patient, data);
    }
    expect(allTextTo(link.patient)).not.toContain('Unsent');
    expect((await courseRow(courseId))?.status).toBe('DRAFT');
  });

  it('are out of reach of a doctor who has lost standing since starting the draft', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    await addMedication(doc);
    await sql()`update clinician_profiles set verification_status = 'REVOKED' where user_id = ${await userId(doc)}`;

    await bot.press(doc, `kw:${courseId}:7`);
    expect(textOf(doc)).toBe(t('ru', 'doctor.notAllowed'));
    expect((await courseRow(courseId))?.status).toBe('DRAFT');
  });

  it('ignore ids that are not ids and windows that are not offered', async () => {
    const doc = await doctor();
    const link = await linked(doc);
    const courseId = await begin(doc, link);
    await addMedication(doc);
    const before = telegram.messagesTo(doc).length;

    for (const data of [
      `kw:${courseId}:2`,
      `kw:${courseId}:365`,
      'kw:nope:7',
      'ks:nope',
      "kv:' or 1=1",
    ]) {
      await bot.press(doc, data);
    }
    expect(telegram.messagesTo(doc)).toHaveLength(before);
    expect((await courseRow(courseId))?.status).toBe('DRAFT');
  });
});

describe('the doctor’s courses', () => {
  it('lists drafts and sent courses with their state, and opens either', async () => {
    const doc = await doctor();
    const first = await linked(doc, { last: 'Sent' });
    const second = await linked(doc, { last: 'Drafted' });
    const sentCourse = await begin(doc, first);
    await addMedication(doc);
    await bot.press(doc, `ks:${sentCourse}`);
    await bot.press(doc, `kw:${sentCourse}:7`);
    const draftCourse = await begin(doc, second);

    await bot.press(doc, 'm:d');
    await bot.press(doc, 'd:l');

    expect(textOf(doc)).toContain(t('ru', 'cw.listTitle'));
    expect(textOf(doc)).toContain(
      t('ru', 'cw.listLine', {
        patient: 'Aziza Sent',
        status: t('ru', 'status.PENDING_PATIENT'),
        days: 7,
      }),
    );
    expect(textOf(doc)).toContain(
      t('ru', 'cw.listLine', {
        patient: 'Aziza Drafted',
        status: t('ru', 'status.DRAFT'),
        days: 7,
      }),
    );
    expect(dataOf(doc)).toEqual([`kv:${draftCourse}`, `kv:${sentCourse}`, 'm:d']);

    await bot.press(doc, `kv:${sentCourse}`);
    expect(textOf(doc)).toContain('Amoxicillin');
  });

  it('says so when there are none', async () => {
    const doc = await doctor();
    await bot.press(doc, 'm:d');
    await bot.press(doc, 'd:l');
    expect(textOf(doc)).toBe(t('ru', 'cw.listNone'));
  });
});

describe('starting from the patient’s last course', () => {
  async function withSentCourse() {
    const doc = await doctor();
    const link = await linked(doc);
    const first = await begin(doc, link, '10');
    await addMedication(doc, { name: 'Repeated', note: 'Как в прошлый раз' });
    await bot.press(doc, `ks:${first}`);
    await bot.press(doc, `kw:${first}:7`);
    await bot.press(doc, 'm:d');
    await bot.press(doc, 'd:c');
    await bot.press(doc, `kb:${link.relationshipId}`);
    return { doc, link, first };
  }

  it('offers to copy it, and the copy is a new draft with the same prescription', async () => {
    const { doc, link, first } = await withSentCourse();
    expect(textOf(doc)).toContain('Aziza Karimova');
    expect(dataOf(doc)).toEqual(['w:s:scratch', 'w:s:copy', 'm:d']);

    await bot.press(doc, 'w:s:copy');

    const copy = await courseIdOf(link);
    expect(copy).not.toBe(first);
    expect(await courseRow(copy)).toMatchObject({ status: 'DRAFT', duration_days: 10 });
    expect(textOf(doc)).toContain(t('ru', 'cw.draftTitle'));
    expect(textOf(doc)).toContain('1. Repeated — 500 мг, после еды');
    expect(textOf(doc)).toContain(t('ru', 'card.note', { text: 'Как в прошлый раз' }));
    expect((await courseRow(first))?.status).toBe('PENDING_PATIENT');
  });

  it('or starts from nothing', async () => {
    const { doc, link, first } = await withSentCourse();
    await bot.press(doc, 'w:s:scratch');
    expect(textOf(doc)).toBe(t('ru', 'cw.askDuration', { patient: 'Aziza Karimova' }));
    await bot.press(doc, 'w:l:5');

    const fresh = await courseIdOf(link);
    expect(fresh).not.toBe(first);
    expect(await medicationsOf(fresh)).toEqual([]);
    expect(textOf(doc)).toBe(t('ru', 'cw.askName'));
  });
});
