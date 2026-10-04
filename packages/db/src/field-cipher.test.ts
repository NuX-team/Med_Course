import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CipherError, FieldCipher, fieldAad } from './field-cipher';

const keyA = { id: 'k1', key: randomBytes(32) };
const keyB = { id: 'k2', key: randomBytes(32) };
const AAD = fieldAad('patient_profiles', 'phone_enc', 'row-1');

function cipherErrorCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof CipherError) {
      return error.code;
    }
    throw error;
  }
  return 'no error';
}

describe('FieldCipher', () => {
  it('round-trips text, including Cyrillic and the empty string', () => {
    const cipher = new FieldCipher([keyA]);
    for (const text of ['+998901234567', 'принимать после еды', '', 'a'.repeat(5_000)]) {
      expect(cipher.decrypt(cipher.encrypt(text, AAD), AAD)).toBe(text);
    }
  });

  it('never stores plaintext and uses a fresh IV every time', () => {
    const cipher = new FieldCipher([keyA]);
    const first = cipher.encrypt('+998901234567', AAD);
    const second = cipher.encrypt('+998901234567', AAD);

    expect(first).not.toContain('998901234567');
    expect(first).not.toBe(second);
    expect(first.split('.')).toHaveLength(5);
    expect(first.startsWith('v1.k1.')).toBe(true);
  });

  it('rejects a value moved to another row or column', () => {
    const cipher = new FieldCipher([keyA]);
    const stored = cipher.encrypt('secret', AAD);

    expect(
      cipherErrorCode(() =>
        cipher.decrypt(stored, fieldAad('patient_profiles', 'phone_enc', 'row-2')),
      ),
    ).toBe('AUTHENTICATION_FAILED');
    expect(
      cipherErrorCode(() =>
        cipher.decrypt(stored, fieldAad('patient_profiles', 'dob_enc', 'row-1')),
      ),
    ).toBe('AUTHENTICATION_FAILED');
  });

  it('detects tampering with any part', () => {
    const cipher = new FieldCipher([keyA]);
    const parts = cipher.encrypt('secret', AAD).split('.');

    for (const index of [2, 3, 4]) {
      const tampered = [...parts];
      const original = Buffer.from(tampered[index] ?? '', 'base64url');
      original[0] = (original[0] ?? 0) ^ 0xff;
      tampered[index] = original.toString('base64url');
      expect(cipherErrorCode(() => cipher.decrypt(tampered.join('.'), AAD))).toBe(
        'AUTHENTICATION_FAILED',
      );
    }
  });

  it('encrypts with the first key, decrypts with any, and flags rows on old keys', () => {
    const before = new FieldCipher([keyA]);
    const legacy = before.encrypt('old value', AAD);

    const rotated = new FieldCipher([keyB, keyA]);
    const fresh = rotated.encrypt('new value', AAD);

    expect(fresh.startsWith('v1.k2.')).toBe(true);
    expect(rotated.decrypt(legacy, AAD)).toBe('old value');
    expect(rotated.decrypt(fresh, AAD)).toBe('new value');
    expect(rotated.usesActiveKey(fresh)).toBe(true);
    expect(rotated.usesActiveKey(legacy)).toBe(false);
  });

  it('fails clearly when the key is gone', () => {
    const legacy = new FieldCipher([keyA]).encrypt('value', AAD);
    expect(cipherErrorCode(() => new FieldCipher([keyB]).decrypt(legacy, AAD))).toBe('UNKNOWN_KEY');
  });

  it.each(['', 'plain text', 'v1.k1.a.b', 'v2.k1.AAAA.AAAA.AAAA', 'v1.k1.AAAA.AAAA.AAAA'])(
    'rejects a malformed stored value: %j',
    (value) => {
      expect(cipherErrorCode(() => new FieldCipher([keyA]).decrypt(value, AAD))).toBe('MALFORMED');
    },
  );

  it('validates the key ring', () => {
    expect(cipherErrorCode(() => new FieldCipher([]))).toBe('UNKNOWN_KEY');
    expect(cipherErrorCode(() => new FieldCipher([{ id: 'k1', key: randomBytes(16) }]))).toBe(
      'MALFORMED',
    );
    expect(cipherErrorCode(() => new FieldCipher([{ id: 'bad.id', key: randomBytes(32) }]))).toBe(
      'MALFORMED',
    );
    expect(cipherErrorCode(() => new FieldCipher([keyA, { id: 'k1', key: randomBytes(32) }]))).toBe(
      'MALFORMED',
    );
  });

  it('keeps plaintext out of error messages', () => {
    const cipher = new FieldCipher([keyA]);
    const stored = cipher.encrypt('very-secret-phone', AAD);
    try {
      cipher.decrypt(stored, 'wrong-aad');
    } catch (error) {
      expect(String(error)).not.toContain('very-secret-phone');
    }
  });
});
