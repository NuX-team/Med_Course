import { describe, expect, it } from 'vitest';
import {
  cleanInstructions,
  cleanMedicationName,
  formatDose,
  parseDailyLimit,
  parseDayRange,
  parseDose,
  parseDuration,
  parseTimes,
  shortTime,
} from './course-input';

describe('parseDuration', () => {
  it.each([
    ['7', 7],
    [' 10 ', 10],
    ['1', 1],
    ['365', 365],
    ['7 дней', 7],
    ['10 kun', 10],
    ['5 дн.', 5],
  ])('reads %j as %i days', (text, days) => {
    expect(parseDuration(text)).toBe(days);
  });

  it.each([
    '0',
    '366',
    '-5',
    '7.5',
    '7,5',
    'семь',
    '',
    ' ',
    '7 8',
    '1e2',
    '0x10',
    '7 дней подряд',
    '٧',
  ])('refuses %j', (text) => {
    expect(parseDuration(text)).toBeNull();
  });
});

describe('parseDose', () => {
  it.each<[string, number, string | null]>([
    ['500', 500, null],
    ['0,5', 0.5, null],
    ['0.5', 0.5, null],
    ['2.125', 2.125, null],
    [' 10 ', 10, null],
    ['1/2', 0.5, '1/2'],
    ['1 / 4', 0.25, '1/4'],
    ['1/3', 0.333, '1/3'],
    ['1 1/2', 1.5, '1 1/2'],
    ['9999999', 9_999_999, null],
  ])('reads %j as %d', (text, value, display) => {
    expect(parseDose(text)).toEqual({ value, display });
  });

  it.each([
    '0',
    '0,0',
    '-1',
    '1/0',
    '0/2',
    '3/2',
    '2/2',
    '0.0001',
    '1.2345',
    '10000000',
    '500 мг',
    'пол таблетки',
    '1,5,5',
    '1..5',
    '1e3',
    '',
    '½',
    '1/2/3',
    '٥',
  ])('refuses %j', (text) => {
    expect(parseDose(text)).toBeNull();
  });
});

describe('parseTimes', () => {
  it.each<[string, string[]]>([
    ['08:00', ['08:00']],
    ['8', ['08:00']],
    ['8:30', ['08:30']],
    ['8.30', ['08:30']],
    ['22:00 08:00 14:30', ['08:00', '14:30', '22:00']],
    ['08:00, 14:30; 22:00', ['08:00', '14:30', '22:00']],
    ['  0   23:59 ', ['00:00', '23:59']],
    ['8 20', ['08:00', '20:00']],
  ])('reads %j', (text, times) => {
    expect(parseTimes(text)).toEqual(times);
  });

  it.each([
    '',
    '   ',
    '24:00',
    '8:60',
    '8:5',
    '08:00 08:00',
    '8 08:00',
    'утром',
    '8-30',
    '08:00:00',
    '8 30',
    '-8',
    '1 2 3 4 5 6 7 8 9 10 11 12 13',
  ])('refuses %j', (text) => {
    expect(parseTimes(text)).toBeNull();
  });

  it('allows up to twelve times a day', () => {
    expect(parseTimes('1 2 3 4 5 6 7 8 9 10 11 12')).toHaveLength(12);
  });
});

describe('parseDayRange', () => {
  it.each<[string, { from: number; to: number }]>([
    ['1-5', { from: 1, to: 5 }],
    ['1 – 5', { from: 1, to: 5 }],
    ['с 2 по 4', { from: 2, to: 4 }],
    ['3', { from: 3, to: 3 }],
    ['10-10', { from: 10, to: 10 }],
    ['дни 1-10', { from: 1, to: 10 }],
  ])('reads %j in a 10-day course', (text, range) => {
    expect(parseDayRange(text, 10)).toEqual(range);
  });

  it.each(['0-5', '5-1', '1-11', '11', '', 'все', '1-2-3', '1 2 3', '1.5', '1,5'])(
    'refuses %j in a 10-day course',
    (text) => {
      expect(parseDayRange(text, 10)).toBeNull();
    },
  );
});

describe('parseDailyLimit', () => {
  it('takes a whole number from 1 to 24 and nothing else', () => {
    expect(parseDailyLimit('3')).toBe(3);
    expect(parseDailyLimit(' 24 ')).toBe(24);
    for (const bad of ['0', '25', '-1', '2.5', 'три', '', '3 раза']) {
      expect(parseDailyLimit(bad), bad).toBeNull();
    }
  });
});

describe('names and instructions', () => {
  it('accept what a prescription really looks like', () => {
    expect(cleanMedicationName('  Амоксициллин   500 ')).toBe('Амоксициллин 500');
    expect(cleanMedicationName('5-НОК')).toBe('5-НОК');
    expect(cleanMedicationName('x'.repeat(120))).toHaveLength(120);
    expect(cleanInstructions('Запивать водой,\nне разжёвывать')).toBe(
      'Запивать водой, не разжёвывать',
    );
  });

  it('refuse what cannot be shown safely or is too long', () => {
    expect(cleanMedicationName('x'.repeat(121))).toBeNull();
    expect(cleanMedicationName('12345')).toBeNull();
    expect(cleanMedicationName(`Drug${String.fromCodePoint(0x202e)}`)).toBeNull();
    expect(cleanInstructions('x'.repeat(301))).toBeNull();
    expect(cleanInstructions('   ')).toBeNull();
  });
});

describe('formatDose and shortTime', () => {
  it.each<[string, string | null, string]>([
    ['500.000', null, '500'],
    ['0.500', null, '0,5'],
    ['2.125', null, '2,125'],
    ['10.050', null, '10,05'],
    ['0.500', '1/2', '1/2'],
    ['1.500', '', '1,5'],
  ])('shows %j (%j) as %j', (value, display, shown) => {
    expect(formatDose(value, display)).toBe(shown);
  });

  it('drops the seconds of a stored time', () => {
    expect(shortTime('08:00:00')).toBe('08:00');
  });

  it('round-trips: what is parsed and stored reads back the way it was typed', () => {
    for (const typed of ['500', '0,5', '2,125', '1/2', '1 1/2']) {
      const dose = parseDose(typed);
      expect(formatDose((dose?.value ?? 0).toFixed(3), dose?.display ?? null)).toBe(typed);
    }
  });
});
