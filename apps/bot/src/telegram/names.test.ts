import { describe, expect, it } from 'vitest';
import { cleanName, cleanNote } from './names';

const code = (point: number): string => String.fromCodePoint(point);

describe('cleanName', () => {
  it.each([
    ['Aziza', 'Aziza'],
    ['  Aziza  ', 'Aziza'],
    ['Азиза', 'Азиза'],
    ['Oʻktam', 'Oʻktam'],
    ["O'Brien", "O'Brien"],
    ['Anna-Maria', 'Anna-Maria'],
    ['Мария  Ивановна', 'Мария Ивановна'],
    ['Aziza 🙂', 'Aziza 🙂'],
    ['李', '李'],
    ['A', 'A'],
    ['tab\tseparated', 'tab separated'],
    ['line\nbreak', 'line break'],
    [`a${code(0x2028)}b`, 'a b'],
    ['<b>Aziza</b>', '<b>Aziza</b>'],
  ])('accepts %j as %j', (input, expected) => {
    expect(cleanName(input)).toBe(expected);
  });

  it.each([
    ['nothing', ''],
    ['only spaces', '   '],
    ['only whitespace characters', '\n\t'],
    ['digits only', '123'],
    ['punctuation only', '!!!'],
    ['an emoji only', '🙂'],
    ['dashes only', '---'],
    ['a NUL character', `${code(0)}Aziza`],
    ['a bell character', `Azi${code(7)}za`],
    ['a right-to-left override, which can disguise a name', `Aziza${code(0x202e)}`],
    ['a left-to-right isolate', `${code(0x2066)}Aziza`],
  ])('refuses %s', (_why, input) => {
    expect(cleanName(input)).toBeNull();
  });

  it('counts characters, not UTF-16 units, against the 100-character limit', () => {
    expect(cleanName('a'.repeat(100))).toBe('a'.repeat(100));
    expect(cleanName('a'.repeat(101))).toBeNull();
    expect(cleanName(`a${'🙂'.repeat(99)}`)).not.toBeNull();
    expect(cleanName(`a${'🙂'.repeat(100)}`)).toBeNull();
  });
});

describe('cleanNote', () => {
  it('takes what a doctor writes about themselves, tidied into one line', () => {
    expect(cleanNote('  Pediatrician,\nCity Clinic No. 5,   licence UZ-12345 ')).toBe(
      'Pediatrician, City Clinic No. 5, licence UZ-12345',
    );
    expect(cleanNote('Педиатр, поликлиника №5, лицензия UZ-12345')).toBe(
      'Педиатр, поликлиника №5, лицензия UZ-12345',
    );
  });

  it('allows up to 500 characters, where a name allows 100', () => {
    expect(cleanNote('a'.repeat(500))).toBe('a'.repeat(500));
    expect(cleanNote('a'.repeat(501))).toBeNull();
    expect(cleanName('a'.repeat(101))).toBeNull();
    expect(cleanNote('a'.repeat(101))).not.toBeNull();
  });

  it('refuses the same things a name refuses', () => {
    for (const bad of ['', '   ', '12345', `Dr${code(0x202e)}`, `x${code(0)}y`]) {
      expect(cleanNote(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
