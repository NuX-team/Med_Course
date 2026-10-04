const MAX_NAME_LENGTH = 100;
const MAX_NOTE_LENGTH = 500;

/**
 * Text typed into a chat, made safe to store and show to another person: whitespace is tidied;
 * anything empty, too long, containing control characters, or with no letter at all is refused.
 */
export function cleanText(input: string, maxLength: number): string | null {
  const text = input.replace(/\s+/gu, ' ').trim();
  if (text.length === 0 || Array.from(text).length > maxLength) {
    return null;
  }
  // Cc: control characters. Zl, Zp: line and paragraph separators. Bidi_Control: the marks that
  // reverse text direction and can make one name display as another.
  if (/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/u.test(text)) {
    return null;
  }
  return /\p{L}/u.test(text) ? text : null;
}

/**
 * A first or last name as typed into a chat. Letters of any script are fine, and so are
 * apostrophes, hyphens and emoji next to them: this is not the place to decide how someone
 * spells their name. Also used for a doctor's private label for an invitation.
 */
export function cleanName(input: string): string | null {
  return cleanText(input, MAX_NAME_LENGTH);
}

/** A free-text note (a doctor's application): same rules as a name, but longer. */
export function cleanNote(input: string): string | null {
  return cleanText(input, MAX_NOTE_LENGTH);
}
