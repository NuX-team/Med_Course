import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Mirrors `EncryptionKey` in @medcourse/config (structurally compatible, no import needed). */
export interface CipherKey {
  readonly id: string;
  readonly key: Uint8Array;
}

export type CipherErrorCode = 'MALFORMED' | 'UNKNOWN_KEY' | 'AUTHENTICATION_FAILED';

/** Messages are fixed strings: never plaintext, ciphertext or key material. */
export class CipherError extends Error {
  readonly code: CipherErrorCode;

  constructor(code: CipherErrorCode, message: string) {
    super(message);
    this.name = 'CipherError';
    this.code = code;
  }
}

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Identifies one encrypted cell. Binding the ciphertext to table, column and row id means a
 * value copied to another row or column fails authentication instead of decrypting there.
 */
export function fieldAad(table: string, column: string, rowId: string): string {
  return `${table}.${column}:${rowId}`;
}

/**
 * Application-level encryption for personal and medical free text (ARCHITECTURE §4.2).
 *
 * Stored form: `v1.<keyId>.<iv>.<tag>.<ciphertext>`, each part base64url. The first key in the
 * ring encrypts; every key decrypts, so rotation is "prepend a new key" followed by lazily
 * re-encrypting rows for which {@link FieldCipher.usesActiveKey} is false.
 */
export class FieldCipher {
  readonly #keys = new Map<string, Buffer>();
  readonly #activeId: string;

  constructor(keys: readonly CipherKey[]) {
    const [active] = keys;
    if (active === undefined) {
      throw new CipherError('UNKNOWN_KEY', 'at least one encryption key is required');
    }
    for (const { id, key } of keys) {
      if (!KEY_ID_PATTERN.test(id)) {
        throw new CipherError('MALFORMED', 'encryption key id has invalid characters');
      }
      if (key.length !== KEY_BYTES) {
        throw new CipherError('MALFORMED', 'encryption key must be 32 bytes');
      }
      if (this.#keys.has(id)) {
        throw new CipherError('MALFORMED', 'encryption key ids must be unique');
      }
      this.#keys.set(id, Buffer.from(key));
    }
    this.#activeId = active.id;
  }

  encrypt(plaintext: string, aad: string): string {
    const key = this.#keyFor(this.#activeId);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

    return [
      VERSION,
      this.#activeId,
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ciphertext.toString('base64url'),
    ].join('.');
  }

  decrypt(payload: string, aad: string): string {
    const { keyId, iv, tag, ciphertext } = parse(payload);
    const decipher = createDecipheriv(ALGORITHM, this.#keyFor(keyId), iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);

    try {
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new CipherError('AUTHENTICATION_FAILED', 'value was tampered with or moved');
    }
  }

  /** False means the row was written under an older key and can be re-encrypted. */
  usesActiveKey(payload: string): boolean {
    return parse(payload).keyId === this.#activeId;
  }

  #keyFor(id: string): Buffer {
    const key = this.#keys.get(id);
    if (key === undefined) {
      throw new CipherError('UNKNOWN_KEY', 'value was encrypted with a key that is not configured');
    }
    return key;
  }
}

function parse(payload: string): { keyId: string; iv: Buffer; tag: Buffer; ciphertext: Buffer } {
  const parts = payload.split('.');
  const [version, keyId, iv, tag, ciphertext] = parts;
  if (
    parts.length !== 5 ||
    version !== VERSION ||
    keyId === undefined ||
    iv === undefined ||
    tag === undefined ||
    ciphertext === undefined
  ) {
    throw new CipherError('MALFORMED', 'not an encrypted value');
  }

  const ivBytes = Buffer.from(iv, 'base64url');
  const tagBytes = Buffer.from(tag, 'base64url');
  if (ivBytes.length !== IV_BYTES || tagBytes.length !== TAG_BYTES) {
    throw new CipherError('MALFORMED', 'not an encrypted value');
  }
  return { keyId, iv: ivBytes, tag: tagBytes, ciphertext: Buffer.from(ciphertext, 'base64url') };
}
