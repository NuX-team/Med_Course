import { randomBytes } from 'node:crypto';
import { createRepositoryDeps, resolveActors, type RepositoryDeps } from '@medcourse/db';
import { createTestDatabase, type TestDatabase } from '@medcourse/db/testing';
import { t, type Locale } from '@medcourse/i18n';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CONSENT_VERSION } from './handler';
import { FakeTelegram, createHarness, type Harness } from './test-harness';
import type { Update } from './types';

let testDatabase: TestDatabase;
let repositoryDeps: RepositoryDeps;
let telegram: FakeTelegram;
let bot: Harness;

const sql = () => testDatabase.db.sql;
const orm = () => testDatabase.db.orm;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  repositoryDeps = createRepositoryDeps([{ id: 't', key: randomBytes(32) }]);
  telegram = new FakeTelegram();
  bot = createHarness({ orm: orm(), repositoryDeps, telegram });
});

afterAll(async () => {
  await testDatabase.drop();
});

let nextId = 7_000_000;
const newPerson = (): number => (nextId += 1);

const textOf = (id: number): string => telegram.lastTo(id)?.text ?? '(nothing was sent)';
const buttonsOf = (id: number): string[] =>
  (telegram.lastTo(id)?.buttons ?? []).flat().map((button) => button.data);

async function userRow(id: number) {
  const [row] = await sql()<
    {
      id: string;
      locale: string;
      timezone: string;
      timezone_confirmed_at: Date | null;
      status: string;
    }[]
  >`select id, locale, timezone, timezone_confirmed_at, status from users where telegram_user_id = ${id}`;
  return row;
}

async function consentRows(id: number) {
  return sql()<{ decision: string; version: string; locale: string; context: string }[]>`
    select c.decision, c.version, c.locale, c.context from consent_records c
    join users u on u.id = c.user_id where u.telegram_user_id = ${id} order by c.at, c.id`;
}

async function profileOf(id: number) {
  const [row] = await sql()<{ first_name: string; last_name: string }[]>`
    select p.first_name, p.last_name from patient_profiles p
    join users u on u.id = p.user_id where u.telegram_user_id = ${id}`;
  return row;
}

async function conversationOf(id: number) {
  const [row] = await sql()<{ flow: string; step: string }[]>`
    select flow, step from conversation_states where telegram_user_id = ${id}`;
  return row;
}

/** Walks a person through the whole onboarding. */
async function register(
  id: number,
  options: { locale?: Locale; first?: string; last?: string; zoneButton?: string } = {},
): Promise<void> {
  const locale = options.locale ?? 'ru';
  await bot.say(id, '/start');
  await bot.press(id, `l:${locale}`);
  await bot.press(id, 'c:y');
  await bot.say(id, options.first ?? 'Aziza');
  await bot.say(id, options.last ?? 'Karimova');
  await bot.press(id, options.zoneButton ?? 'z:ok');
}

describe('first contact', () => {
  it('asks a stranger for a language, in both languages, and creates nothing yet', async () => {
    const id = newPerson();
    await bot.say(id, '/start');

    expect(textOf(id)).toContain('Выберите язык');
    expect(textOf(id)).toContain('Tilni tanlang');
    expect(buttonsOf(id)).toEqual(['l:ru', 'l:uz']);
    expect(await userRow(id)).toBeUndefined();
    expect(await conversationOf(id)).toEqual({ flow: 'ONBOARDING', step: 'LANGUAGE' });
  });

  it('treats anything else a stranger sends as the same beginning', async () => {
    const typed = newPerson();
    await bot.say(typed, 'hello?');
    expect(buttonsOf(typed)).toEqual(['l:ru', 'l:uz']);

    const photo = newPerson();
    await bot.sendNonText(photo);
    expect(buttonsOf(photo)).toEqual(['l:ru', 'l:uz']);
  });

  it('answers every button press, so Telegram stops showing a spinner', async () => {
    const id = newPerson();
    await bot.say(id, '/start');
    const before = telegram.answered.length;
    await bot.press(id, 'l:ru');
    expect(telegram.answered.length).toBe(before + 1);
  });
});

describe('language and consent', () => {
  it('turns the language prompt into the consent screen in the chosen language', async () => {
    const id = newPerson();
    await bot.say(id, '/start');
    const prompt = telegram.lastTo(id)?.messageId ?? 0;
    await bot.press(id, 'l:uz');

    expect(telegram.edits.at(-1)).toMatchObject({ chatId: id, messageId: prompt });
    expect(textOf(id)).toContain(t('uz', 'consent.title'));
    expect(textOf(id)).toContain(t('uz', 'consent.text'));
    expect(buttonsOf(id)).toEqual(['c:y', 'c:n']);
    expect(await userRow(id)).toBeUndefined();
  });

  it('keeps the emergency notice in the consent text a person is asked to accept', async () => {
    const id = newPerson();
    await bot.say(id, '/start');
    await bot.press(id, 'l:ru');
    expect(textOf(id)).toMatch(/экстренн/);
  });

  it('stores nothing at all if the person declines, and lets them change their mind', async () => {
    const id = newPerson();
    await bot.say(id, '/start');
    await bot.press(id, 'l:ru');
    await bot.press(id, 'c:n');

    expect(textOf(id)).toBe(t('ru', 'consent.declined'));
    expect(buttonsOf(id)).toEqual(['c:a']);
    expect(await userRow(id)).toBeUndefined();
    expect(await conversationOf(id)).toEqual({ flow: 'ONBOARDING', step: 'DECLINED' });

    await bot.press(id, 'c:a');
    expect(textOf(id)).toContain(t('ru', 'consent.text'));
    expect(buttonsOf(id)).toEqual(['c:y', 'c:n']);
  });

  it('shows the same step again on /start instead of starting over', async () => {
    const id = newPerson();
    await bot.say(id, '/start');
    await bot.press(id, 'l:ru');
    await bot.say(id, '/start');

    expect(telegram.lastTo(id)?.text).toContain(t('ru', 'consent.text'));
    expect(await conversationOf(id)).toEqual({ flow: 'ONBOARDING', step: 'CONSENT' });
  });

  it('records who agreed to which text, in which language, and opens the account', async () => {
    const id = newPerson();
    await bot.say(id, '/start');
    await bot.press(id, 'l:uz');
    await bot.press(id, 'c:y');

    expect(await userRow(id)).toMatchObject({
      locale: 'uz',
      timezone: 'Asia/Tashkent',
      timezone_confirmed_at: null,
      status: 'ACTIVE',
    });
    expect(await consentRows(id)).toEqual([
      { decision: 'GRANTED', version: CONSENT_VERSION, locale: 'uz', context: 'ONBOARDING' },
    ]);
    expect(textOf(id)).toBe(t('uz', 'onboarding.askFirstName'));
  });

  it('removes the consent buttons once the person has answered', async () => {
    const id = newPerson();
    await bot.say(id, '/start');
    await bot.press(id, 'l:ru');
    const consentMessage = telegram.lastTo(id);
    await bot.press(id, 'c:y');

    expect(consentMessage?.buttons).toEqual([]);
  });
});

describe('the name and the time zone', () => {
  async function toFirstName(): Promise<number> {
    const id = newPerson();
    await bot.say(id, '/start');
    await bot.press(id, 'l:ru');
    await bot.press(id, 'c:y');
    return id;
  }

  it('asks for the last name by the first name, then proposes the Tashkent zone', async () => {
    const id = await toFirstName();
    await bot.say(id, 'Aziza');
    expect(textOf(id)).toBe(t('ru', 'onboarding.askLastName', { name: 'Aziza' }));

    await bot.say(id, 'Karimova');
    expect(textOf(id)).toBe(
      t('ru', 'onboarding.askTimezone', { zone: t('ru', 'timezone.city.tashkent') }),
    );
    expect(buttonsOf(id)).toEqual(['z:ok', 'z:o']);
    expect(await profileOf(id)).toEqual({ first_name: 'Aziza', last_name: 'Karimova' });
  });

  it('keeps asking, politely, until the name is usable', async () => {
    const id = await toFirstName();
    for (const bad of ['123', '🙂', '!!!', 'x'.repeat(101), '']) {
      await bot.say(id, bad || ' ');
      expect(textOf(id), JSON.stringify(bad)).toBe(t('ru', 'onboarding.invalidName'));
    }
    expect(await conversationOf(id)).toMatchObject({ step: 'FIRST_NAME' });
    expect(await profileOf(id)).toBeUndefined();

    await bot.say(id, 'Aziza');
    expect(await conversationOf(id)).toMatchObject({ step: 'LAST_NAME' });
  });

  it('stores a name with an emoji, an apostrophe and angle brackets exactly as typed, and sends it as plain text', async () => {
    const id = await toFirstName();
    await bot.say(id, "Aziza 🙂 <b>O'Brien</b>");
    await bot.say(id, 'Karimova');

    expect(await profileOf(id)).toEqual({
      first_name: "Aziza 🙂 <b>O'Brien</b>",
      last_name: 'Karimova',
    });
    const echoed = telegram.messagesTo(id).find((message) => message.text.includes('<b>'));
    expect(echoed).toBeDefined();
    expect(JSON.stringify(echoed?.options)).not.toContain('parse_mode');
  });

  it('normalises whitespace in a name', async () => {
    const id = await toFirstName();
    await bot.say(id, '  Aziza   Gulnora  ');
    await bot.say(id, 'Karimova');
    expect((await profileOf(id))?.first_name).toBe('Aziza Gulnora');
  });

  it('finishes when the proposed zone is confirmed, and the person can then act as a patient', async () => {
    const id = await toFirstName();
    await bot.say(id, 'Aziza');
    await bot.say(id, 'Karimova');
    await bot.press(id, 'z:ok');

    const user = await userRow(id);
    expect(user).toMatchObject({ timezone: 'Asia/Tashkent' });
    expect(user?.timezone_confirmed_at).toEqual(bot.clock);
    expect(await conversationOf(id)).toBeUndefined();
    expect(textOf(id)).toContain(t('ru', 'menu.hello', { name: 'Aziza' }));
    expect(buttonsOf(id)).toEqual(['m:c', 'm:t', 'm:y', 'm:s', 'm:d']);
    expect(telegram.edits.at(-1)?.text).toBe(t('ru', 'onboarding.done', { name: 'Aziza' }));

    const actors = await resolveActors(orm(), user?.id ?? '');
    expect(actors.map((actor) => actor.kind)).toEqual(['PATIENT']);
  });

  it('lets the person pick another city, and stores that zone', async () => {
    const id = await toFirstName();
    await bot.say(id, 'Aziza');
    await bot.say(id, 'Karimova');
    await bot.press(id, 'z:o');
    expect(buttonsOf(id)).toEqual([
      'z:tashkent',
      'z:almaty',
      'z:moscow',
      'z:istanbul',
      'z:dubai',
      'z:seoul',
    ]);

    await bot.press(id, 'z:moscow');
    expect(await userRow(id)).toMatchObject({ timezone: 'Europe/Moscow' });
    expect((await userRow(id))?.timezone_confirmed_at).toEqual(bot.clock);
  });

  it('ignores a forged zone, and a zone button pressed at the wrong moment', async () => {
    const id = await toFirstName();
    await bot.press(id, 'z:ok'); // still asking for the first name
    await bot.say(id, 'Aziza');
    await bot.say(id, 'Karimova');
    await bot.press(id, 'z:berlin');
    await bot.press(id, 'z:../../etc/passwd');

    expect(await userRow(id)).toMatchObject({
      timezone: 'Asia/Tashkent',
      timezone_confirmed_at: null,
    });
    expect(await conversationOf(id)).toMatchObject({ step: 'TIMEZONE' });
  });

  it('writes the whole story to the audit log without a single name in it', async () => {
    const id = newPerson();
    await register(id, { first: 'Unmistakable', last: 'Surname' });

    const user = await userRow(id);
    const rows = await sql()<{ action: string; blob: string }[]>`
      select action, audit_log::text as blob from audit_log where entity_id = ${user?.id ?? ''} order by id`;
    expect(rows.map((row) => row.action)).toEqual(['CREATE', 'CREATE', 'UPDATE']);
    for (const row of rows) {
      expect(row.blob).not.toContain('Unmistakable');
      expect(row.blob).not.toContain('Surname');
    }
  });
});

describe('a registered person', () => {
  async function registered(locale: Locale = 'ru', first = 'Aziza'): Promise<number> {
    const id = newPerson();
    await register(id, { locale, first });
    return id;
  }

  it('gets the menu on /start, /menu and on anything they type', async () => {
    const id = await registered();
    for (const text of ['/start', '/menu', 'what now', '/unknown']) {
      await bot.say(id, text);
      expect(textOf(id), text).toContain(t('ru', 'menu.hello', { name: 'Aziza' }));
      expect(buttonsOf(id), text).toEqual(['m:c', 'm:t', 'm:y', 'm:s', 'm:d']);
    }
  });

  it('shows "nothing yet" for the course, today and history, each with a way back', async () => {
    const id = await registered();
    const expectations: [string, string][] = [
      ['m:c', t('ru', 'course.none')],
      ['m:t', t('ru', 'today.none')],
      ['m:y', t('ru', 'history.none')],
    ];
    for (const [button, text] of expectations) {
      await bot.press(id, button);
      expect(textOf(id)).toBe(text);
      expect(buttonsOf(id)).toEqual(['m:h']);
      await bot.press(id, 'm:h');
      expect(textOf(id)).toContain(t('ru', 'menu.title'));
    }
  });

  it('changes the language, remembers it, and speaks it from then on', async () => {
    const id = await registered('ru');
    await bot.press(id, 'm:s');
    expect(buttonsOf(id)).toEqual(['s:l', 's:z', 's:c', 's:p', 'm:h']);
    await bot.press(id, 's:l');
    expect(buttonsOf(id)).toEqual(['sl:ru', 'sl:uz', 'm:s']);
    await bot.press(id, 'sl:uz');

    expect(textOf(id)).toBe(t('uz', 'settings.languageChanged'));
    expect((await userRow(id))?.locale).toBe('uz');
    await bot.say(id, '/menu');
    expect(textOf(id)).toContain(t('uz', 'menu.title'));
  });

  it('changes the time zone and confirms it with the moment', async () => {
    const id = await registered();
    await bot.press(id, 'm:s');
    await bot.press(id, 's:z');
    expect(textOf(id)).toBe(
      t('ru', 'settings.timezoneCurrent', { zone: t('ru', 'timezone.city.tashkent') }),
    );

    bot.clock = new Date('2026-10-05T08:00:00Z');
    await bot.press(id, 'sz:dubai');
    expect(textOf(id)).toBe(
      t('ru', 'settings.timezoneChanged', { zone: t('ru', 'timezone.city.dubai') }),
    );
    const user = await userRow(id);
    expect(user).toMatchObject({ timezone: 'Asia/Dubai' });
    expect(user?.timezone_confirmed_at).toEqual(bot.clock);
    bot.clock = new Date('2026-10-02T10:00:00Z');
  });

  it('answers /help in their language, with the emergency notice', async () => {
    const id = await registered('uz');
    await bot.say(id, '/help');
    expect(textOf(id)).toBe(t('uz', 'help.text'));
    expect(textOf(id)).toMatch(/shoshilinch/);
  });

  it('is told the bot only understands text and buttons when they send something else', async () => {
    const id = await registered();
    await bot.sendNonText(id);
    expect(textOf(id)).toBe(t('ru', 'error.unsupported'));
  });

  it('goes through onboarding entirely in Uzbek when that is chosen', async () => {
    const id = newPerson();
    await bot.say(id, '/start');
    await bot.press(id, 'l:uz');
    await bot.press(id, 'c:y');
    expect(textOf(id)).toBe(t('uz', 'onboarding.askFirstName'));
    await bot.say(id, 'Oʻktam');
    expect(textOf(id)).toBe(t('uz', 'onboarding.askLastName', { name: 'Oʻktam' }));
    await bot.say(id, 'Rahimov');
    await bot.press(id, 'z:ok');
    expect(textOf(id)).toContain(t('uz', 'menu.hello', { name: 'Oʻktam' }));
  });

  it('answers /help to a stranger in both languages', async () => {
    const id = newPerson();
    await bot.say(id, '/help');
    expect(textOf(id)).toContain(t('ru', 'help.text'));
    expect(textOf(id)).toContain(t('uz', 'help.text'));
  });
});

describe('repeats, races and stale buttons', () => {
  it('handles a redelivered update once: no second reply, no second effect', async () => {
    const id = newPerson();
    const update = {
      update_id: bot.nextUpdateId(),
      message: {
        message_id: 1,
        date: 0,
        chat: { id, type: 'private' },
        from: { id, is_bot: false, first_name: 'T' },
        text: '/start',
      },
    } as unknown as Update;

    await bot.deliver(update);
    await bot.deliver(update);
    await bot.deliver(update);

    expect(telegram.messagesTo(id)).toHaveLength(1);
  });

  it('records one consent and one account when the accept button is tapped repeatedly', async () => {
    const id = newPerson();
    await bot.say(id, '/start');
    await bot.press(id, 'l:ru');
    const consentMessage = telegram.lastTo(id)?.messageId;

    await bot.press(id, 'c:y', consentMessage);
    await bot.press(id, 'c:y', consentMessage);
    await bot.press(id, 'c:y', consentMessage);

    expect(await consentRows(id)).toHaveLength(1);
    expect(await sql()`select 1 from users where telegram_user_id = ${id}`).toHaveLength(1);
    expect(
      telegram
        .messagesTo(id)
        .filter((message) => message.text === t('ru', 'onboarding.askFirstName')),
    ).toHaveLength(1);
  });

  it('survives the accept button arriving several times at the same instant', async () => {
    const id = newPerson();
    await bot.say(id, '/start');
    await bot.press(id, 'l:ru');
    const consentMessage = telegram.lastTo(id)?.messageId;

    await Promise.all(Array.from({ length: 6 }, () => bot.press(id, 'c:y', consentMessage)));

    expect(await consentRows(id)).toHaveLength(1);
    expect(await sql()`select 1 from users where telegram_user_id = ${id}`).toHaveLength(1);
    expect(await conversationOf(id)).toMatchObject({ step: 'FIRST_NAME' });
  });

  it('ignores an old button pressed after the conversation has moved on', async () => {
    const id = newPerson();
    await bot.say(id, '/start');
    const languageMessage = telegram.lastTo(id)?.messageId;
    await bot.press(id, 'l:ru');
    const consentMessage = telegram.lastTo(id)?.messageId;
    await bot.press(id, 'c:y');
    await bot.say(id, 'Aziza');

    await bot.press(id, 'l:uz', languageMessage);
    await bot.press(id, 'c:n', consentMessage);
    await bot.press(id, 'c:a', consentMessage);

    expect(await userRow(id)).toMatchObject({ locale: 'ru' });
    expect(await consentRows(id)).toHaveLength(1);
    expect(await conversationOf(id)).toMatchObject({ step: 'LAST_NAME' });
  });

  it('only answers a button it does not recognise, and one that no longer applies to a registered person', async () => {
    const id = newPerson();
    await register(id);
    const before = telegram.messagesTo(id).length;
    const edits = telegram.edits.length;

    await bot.press(id, 'zzz:nonsense');
    await bot.press(id, 'm:__proto__');
    await bot.press(id, 'c:y');
    await bot.press(id, 'l:uz');

    expect(telegram.messagesTo(id)).toHaveLength(before);
    expect(telegram.edits).toHaveLength(edits);
    expect((await userRow(id))?.locale).toBe('ru');
  });

  it('keeps two people’s conversations apart, interleaved', async () => {
    const a = newPerson();
    const b = newPerson();
    await bot.say(a, '/start');
    await bot.say(b, '/start');
    await bot.press(a, 'l:ru');
    await bot.press(b, 'l:uz');
    await Promise.all([bot.press(a, 'c:y'), bot.press(b, 'c:y')]);
    await Promise.all([bot.say(a, 'Anna'), bot.say(b, 'Bobur')]);
    await Promise.all([bot.say(a, 'Petrova'), bot.say(b, 'Aliyev')]);
    await Promise.all([bot.press(a, 'z:ok'), bot.press(b, 'z:ok')]);

    expect(await profileOf(a)).toEqual({ first_name: 'Anna', last_name: 'Petrova' });
    expect(await profileOf(b)).toEqual({ first_name: 'Bobur', last_name: 'Aliyev' });
    expect((await userRow(a))?.locale).toBe('ru');
    expect((await userRow(b))?.locale).toBe('uz');
  });
});

describe('what the bot ignores', () => {
  it('says nothing in group chats, to other bots, and about update types it does not use', async () => {
    const id = newPerson();
    const before = telegram.sent.length;

    await bot.say(id, '/start', { chat: 'group' });
    await bot.say(id, '/start', { isBot: true });
    await bot.deliver({
      update_id: bot.nextUpdateId(),
      edited_message: { message_id: 1, date: 0, chat: { id, type: 'private' }, text: '/start' },
    } as unknown as Update);
    await bot.deliver({
      update_id: bot.nextUpdateId(),
      callback_query: {
        id: 'g',
        from: { id, is_bot: false, first_name: 'T' },
        chat_instance: 'i',
        message: { message_id: 5, date: 0, chat: { id: -100, type: 'group' } },
        data: 'l:ru',
      },
    } as unknown as Update);
    await bot.deliver({ update_id: bot.nextUpdateId() });

    expect(telegram.sent).toHaveLength(before);
    expect(await userRow(id)).toBeUndefined();
    expect(await conversationOf(id)).toBeUndefined();
  });

  it('says nothing to a blocked person and does not let them register again', async () => {
    const id = newPerson();
    await register(id);
    await sql()`update users set status = 'BLOCKED' where telegram_user_id = ${id}`;
    const before = telegram.messagesTo(id).length;

    await bot.say(id, '/start');
    await bot.say(id, '/menu');
    await bot.press(id, 'm:s');

    expect(telegram.messagesTo(id)).toHaveLength(before);
    expect(await profileOf(id)).toBeDefined();
  });
});

describe('time passing', () => {
  it('forgets a conversation after a day, but remembers that consent was given', async () => {
    const id = newPerson();
    await bot.say(id, '/start');
    await bot.press(id, 'l:ru');
    await bot.press(id, 'c:y');
    await bot.say(id, 'Aziza');

    bot.clock = new Date(bot.clock.getTime() + 25 * 3_600_000);
    await bot.say(id, 'Karimova');
    bot.clock = new Date('2026-10-02T10:00:00Z');

    // No stale last name is applied to a profile; the person is asked for their first name again, not for consent.
    expect(await profileOf(id)).toBeUndefined();
    expect(textOf(id)).toBe(t('ru', 'onboarding.askFirstName'));
    expect(await consentRows(id)).toHaveLength(1);
  });

  it('asks for consent again when a person returns after a day having never accepted', async () => {
    const id = newPerson();
    await bot.say(id, '/start');
    await bot.press(id, 'l:ru');

    bot.clock = new Date(bot.clock.getTime() + 25 * 3_600_000);
    await bot.say(id, '/start');
    bot.clock = new Date('2026-10-02T10:00:00Z');

    expect(buttonsOf(id)).toEqual(['l:ru', 'l:uz']);
    expect(await userRow(id)).toBeUndefined();
  });
});

describe('when something goes wrong', () => {
  it('apologises instead of crashing, and does not retry the update', async () => {
    const id = newPerson();
    const failing = new Proxy(orm(), {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return () => Promise.reject(new Error('database went away'));
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
      },
    });
    const broken = createHarness({ orm: failing, repositoryDeps, telegram });
    const update = {
      update_id: broken.nextUpdateId(),
      message: {
        message_id: 1,
        date: 0,
        chat: { id, type: 'private' },
        from: { id, is_bot: false, first_name: 'T' },
        text: '/start',
      },
    } as unknown as Update;

    await expect(broken.deliver(update)).resolves.toBeUndefined();
    expect(textOf(id)).toContain('Что-то пошло не так');
    expect(textOf(id)).toContain('Nimadir xato ketdi');

    // Claimed, so a redelivery does not run it (or apologise) a second time.
    const count = telegram.messagesTo(id).length;
    await broken.deliver(update);
    expect(telegram.messagesTo(id)).toHaveLength(count);
  });

  it('keeps going when Telegram refuses one reply', async () => {
    const id = newPerson();
    await bot.say(id, '/start');
    await bot.press(id, 'l:ru');

    telegram.failNext.sendMessage = new Error('Forbidden: bot was blocked by the user');
    await bot.press(id, 'c:y');

    // The first-name question could not be sent, but the work was committed and the edit went out.
    expect(await userRow(id)).toBeDefined();
    expect(await consentRows(id)).toHaveLength(1);
    expect(telegram.edits.at(-1)?.chatId).toBe(id);

    await bot.say(id, 'Aziza');
    expect(textOf(id)).toBe(t('ru', 'onboarding.askLastName', { name: 'Aziza' }));
  });

  it('treats "message is not modified" as harmless', async () => {
    const id = newPerson();
    await register(id);
    telegram.failNext.editMessageText = new Error('Bad Request: message is not modified');
    await bot.press(id, 'm:s');
    await bot.press(id, 'm:h');
    expect(textOf(id)).toContain(t('ru', 'menu.title'));
  });

  it('survives a person who is not in the database being addressed after a restart', async () => {
    const fresh = createHarness({ orm: orm(), repositoryDeps });
    const id = newPerson();
    await fresh.say(id, '/start');
    await fresh.press(id, 'l:uz');
    expect(fresh.telegram.lastTo(id)?.text).toContain(t('uz', 'consent.title'));
  });
});
