import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALES,
  dictionaries,
  isLocale,
  placeholdersOf,
  plural,
  t,
  type MessageKey,
} from './index';

const keys = Object.keys(dictionaries.ru) as MessageKey[];

/** Texts that appear on buttons, not in message bodies. */
const buttonKeys: MessageKey[] = [
  'settings.privacy',
  'privacy.doctors',
  'privacy.withdraw',
  'privacy.delete',
  'privacy.leaveYes',
  'privacy.withdrawYes',
  'privacy.regrant',
  'privacy.deleteYes',
  'privacy.keep',
  'export.pdf',
  'export.csv',
  'consent.accept',
  'consent.decline',
  'consent.reconsider',
  'timezone.confirm',
  'timezone.other',
  'timezone.city.tashkent',
  'timezone.city.almaty',
  'timezone.city.moscow',
  'timezone.city.istanbul',
  'timezone.city.dubai',
  'timezone.city.seoul',
  'menu.course',
  'menu.today',
  'menu.history',
  'menu.settings',
  'settings.language',
  'settings.timezone',
  'menu.doctor',
  'invite.accept',
  'invite.decline',
  'doctor.register',
  'doctor.invite',
  'doctor.patients',
  'doctor.invitations',
  'doctor.skip',
  'doctor.revokeButton',
  'doctor.confirm',
  'doctor.reject',
  'doctor.newCourse',
  'doctor.courses',
  ...keys.filter((key) => key.startsWith('unit.') || key.startsWith('food.')),
  'cw.fromScratch',
  'cw.copyLast',
  'cw.daysButton',
  'cw.freq1',
  'cw.freq2',
  'cw.freq3',
  'cw.freq4',
  'cw.ownTimes',
  'cw.prn',
  'cw.confirmTimes',
  'cw.changeTimes',
  'cw.minutes',
  'cw.hours',
  'cw.wholeCourse',
  'cw.someDays',
  'cw.skip',
  'cw.addMed',
  'cw.removeMed',
  'cw.changeDuration',
  'cw.send',
  'cw.discard',
  'cw.discardYes',
  'cw.pause',
  'cw.pauseYes',
  'cw.resume',
  'cw.resumeYes',
  'cw.cancel',
  'cw.cancelYes',
  'cw.withdraw',
  'cw.withdrawYes',
  'cw.newForPatient',
  'cw.change',
  'cw.changeContinue',
  'cw.changeSend',
  'cw.changeSendYes',
  'cw.changeDrop',
  'cw.changeWithdraw',
  'course.changeAccept',
  'course.changeView',
  'course.changeViewN',
  'history.open',
  'report.days',
  'report.older',
  'report.newer',
  'report.back',
  'cw.report',
  'prn.confirm',
  'prn.undo',
  'course.pauseAsk',
  'course.pauseAskN',
  'course.pauseSend',
  'alert.openCourse',
  'menu.wards',
  'settings.caregivers',
  'cg.accept',
  'cg.decline',
  'cg.allow',
  'cg.refuse',
  'cg.refresh',
  'course.start',
  'course.startN',
  'start.confirm',
  'start.later',
  'dose.take',
  'dose.takeLate',
  'dose.later',
  'dose.skip',
  'dose.undo',
  'dose.reason.FORGOT',
  'dose.reason.NO_MEDICATION',
  'dose.reason.OTHER',
  'dose.reasonSilent',
  'admin.menu',
  'admin.applicationsButton',
  'admin.doctorsButton',
  'admin.statsButton',
  'admin.incidentsButton',
  'admin.adminsButton',
  'admin.verifyButton',
  'admin.revokeButton',
  'admin.revokeYesButton',
  'admin.addAdminButton',
  'admin.removeAdminButton',
  'admin.removeAdminYesButton',
  'admin.cancelButton',
  'common.back',
];

describe('the dictionaries', () => {
  it('have exactly the same keys in every language', () => {
    for (const locale of LOCALES) {
      expect(Object.keys(dictionaries[locale]).sort(), locale).toEqual([...keys].sort());
    }
  });

  it('have no empty or untrimmed texts', () => {
    for (const locale of LOCALES) {
      for (const key of keys) {
        const text = dictionaries[locale][key];
        expect(text.trim(), `${locale}:${key}`).toBe(text);
        expect(text.length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });

  it('use the same {placeholders} in every language', () => {
    for (const key of keys) {
      const reference = placeholdersOf(dictionaries.ru[key]).sort();
      for (const locale of LOCALES) {
        expect(placeholdersOf(dictionaries[locale][key]).sort(), `${locale}:${key}`).toEqual(
          reference,
        );
      }
    }
  });

  it('fit into one Telegram message, and button labels fit on a button', () => {
    for (const locale of LOCALES) {
      for (const key of keys) {
        expect(dictionaries[locale][key].length, `${locale}:${key}`).toBeLessThanOrEqual(4000);
      }
      for (const key of buttonKeys) {
        expect(dictionaries[locale][key].length, `${locale}:${key}`).toBeLessThanOrEqual(40);
      }
    }
  });

  it('keep the emergency notice in the help and the consent text', () => {
    expect(dictionaries.ru['help.text']).toMatch(/экстренн/);
    expect(dictionaries.ru['consent.text']).toMatch(/экстренн/);
    expect(dictionaries.uz['help.text']).toMatch(/shoshilinch/);
    expect(dictionaries.uz['consent.text']).toMatch(/shoshilinch/);
    // ... and in what a patient reads when a course is assigned to them.
    expect(dictionaries.ru['course.followDoctor']).toMatch(/экстренн/);
    expect(dictionaries.uz['course.followDoctor']).toMatch(/shoshilinch/);
    // ... and where a patient is invited to write in their own words.
    expect(dictionaries.ru['dose.reasonAsk']).toMatch(/экстренн/);
    expect(dictionaries.uz['dose.reasonAsk']).toMatch(/shoshilinch/);
    // ... and wherever an as-needed mark goes beyond what the doctor allowed.
    for (const key of ['prn.warnTail', 'prn.doneOver'] as const) {
      expect(dictionaries.ru[key]).toMatch(/экстренн/);
      expect(dictionaries.uz[key]).toMatch(/shoshilinch/);
    }
    // ... and where a patient asks for a pause instead of stopping on their own.
    expect(dictionaries.ru['course.pauseQuestion']).toMatch(/экстренн/);
    expect(dictionaries.uz['course.pauseQuestion']).toMatch(/shoshilinch/);
  });

  it('say that a proposed time is not medical advice, wherever the system proposes one', () => {
    expect(dictionaries.ru['cw.proposeTimes']).toMatch(/не медицинская рекомендация/);
    expect(dictionaries.uz['cw.proposeTimes']).toMatch(/tibbiy tavsiya emas/);
  });

  it('differ between languages, so one was not pasted over the other', () => {
    const identical = keys.filter((key) => dictionaries.ru[key] === dictionaries.uz[key]);
    expect(identical).toEqual([]);
  });
});

describe('t', () => {
  it('fills placeholders, every occurrence, and ignores extras', () => {
    expect(t('ru', 'onboarding.askLastName', { name: 'Азиза' })).toBe(
      'Спасибо, Азиза. Теперь напишите фамилию.',
    );
    expect(t('uz', 'menu.hello', { name: 'Aziza', unused: 1 })).toBe('Assalomu alaykum, Aziza!');
    expect(t('ru', 'settings.timezoneChanged', { zone: 42 })).toContain('42');
  });

  it('inserts values verbatim: what a person typed is never interpreted', () => {
    expect(t('ru', 'menu.hello', { name: '{name} $& <b>x</b>' })).toBe(
      'Здравствуйте, {name} $& <b>x</b>!',
    );
  });

  it('refuses to show a raw placeholder to a patient', () => {
    expect(() => t('ru', 'menu.hello')).toThrow(/missing value for \{name\}/);
  });

  it('returns plain texts unchanged', () => {
    expect(t('ru', 'menu.title')).toBe('Главное меню');
    expect(t('uz', 'menu.title')).toBe('Asosiy menyu');
  });
});

describe('placeholdersOf', () => {
  it('lists names once, in order', () => {
    expect(placeholdersOf('{a} and {b} and {a}')).toEqual(['a', 'b']);
    expect(placeholdersOf('none here')).toEqual([]);
    expect(placeholdersOf('{ not } {1x} {ok2}')).toEqual(['ok2']);
  });
});

describe('plural', () => {
  const doses = { one: 'доза', few: 'дозы', many: 'доз', other: 'дозы' };

  it.each([
    [0, 'доз'],
    [1, 'доза'],
    [2, 'дозы'],
    [4, 'дозы'],
    [5, 'доз'],
    [11, 'доз'],
    [12, 'доз'],
    [14, 'доз'],
    [21, 'доза'],
    [22, 'дозы'],
    [25, 'доз'],
    [101, 'доза'],
    [111, 'доз'],
  ])('in Russian, %i takes the form "%s"', (count, expected) => {
    expect(plural('ru', count, doses)).toBe(expected);
  });

  it('in Uzbek only has one and other, and falls back when a form is missing', () => {
    const forms = { one: 'doza', other: 'doza' };
    for (const count of [0, 1, 2, 5, 21]) {
      expect(plural('uz', count, forms)).toBe('doza');
    }
    expect(plural('ru', 3, { one: 'a', other: 'z' })).toBe('z');
  });
});

describe('locales', () => {
  it('knows which values are locales', () => {
    expect(isLocale('ru')).toBe(true);
    expect(isLocale('uz')).toBe(true);
    for (const bad of ['en', 'RU', '', null, undefined, 3, {}]) {
      expect(isLocale(bad)).toBe(false);
    }
    expect(DEFAULT_LOCALE).toBe('ru');
  });
});
