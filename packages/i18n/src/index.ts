import { ru, type MessageKey } from './ru';
import { uz } from './uz';

export type { MessageKey } from './ru';

export const LOCALES = ['ru', 'uz'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'ru';

export const dictionaries: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = {
  ru,
  uz,
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

export type Params = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/** The names of the `{placeholders}` in a text, in order of first appearance. */
export function placeholdersOf(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1] ?? ''))];
}

/**
 * The text for `key` in `locale`, with `{placeholders}` filled in. A placeholder with no value is
 * a bug in the caller and throws, rather than showing "{name}" to a patient. Values are inserted
 * as they are: texts are plain, so nothing needs escaping.
 */
export function t(locale: Locale, key: MessageKey, params: Params = {}): string {
  return dictionaries[locale][key].replace(PLACEHOLDER, (_whole, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw new Error(`missing value for {${name}} in "${key}"`);
    }
    return String(value);
  });
}

export interface PluralForms {
  readonly one: string;
  readonly few?: string;
  readonly many?: string;
  readonly other: string;
}

/**
 * Picks the grammatical form for a count: Russian has one / few / many / other (1 доза, 2 дозы,
 * 5 доз), Uzbek only one / other. A language that lacks a category falls back to `other`.
 */
export function plural(locale: Locale, count: number, forms: PluralForms): string {
  const category = new Intl.PluralRules(locale).select(count);
  return category === 'one'
    ? forms.one
    : (forms[category as 'few' | 'many' | 'other'] ?? forms.other);
}
