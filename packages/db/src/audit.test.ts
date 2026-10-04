import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AuditHasher, canonicalJson, changedFields } from './audit';

describe('canonicalJson', () => {
  it('ignores key order and undefined values', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: undefined } })).toBe(
      canonicalJson({ a: { d: 2 }, b: 1 }),
    );
  });

  it('distinguishes types and values', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: '1' }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson(null)).toBe('null');
  });

  it('serialises dates and bigints stably', () => {
    expect(canonicalJson(new Date('2026-10-02T12:00:00Z'))).toBe('"2026-10-02T12:00:00.000Z"');
    expect(canonicalJson(10n)).toBe('"10"');
  });

  it('refuses what it cannot represent', () => {
    expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalJson(() => 1)).toThrow(TypeError);
  });
});

describe('changedFields', () => {
  it('lists names only, sorted, including added and removed fields', () => {
    expect(changedFields({ a: 1, b: 2, c: 3 }, { a: 1, b: 9, d: 4 })).toEqual(['b', 'c', 'd']);
  });

  it('treats a missing field and null as equal', () => {
    expect(changedFields({ a: null }, {})).toEqual([]);
  });

  it('handles an absent side (creation)', () => {
    expect(changedFields(null, { a: 1, b: 2 })).toEqual(['a', 'b']);
  });
});

describe('AuditHasher', () => {
  const key = randomBytes(32);

  it('is stable for equal state and sensitive to any change', () => {
    const hasher = new AuditHasher(key);
    expect(hasher.hash({ phone: 'x', n: 1 })).toBe(hasher.hash({ n: 1, phone: 'x' }));
    expect(hasher.hash({ phone: 'x' })).not.toBe(hasher.hash({ phone: 'y' }));
    expect(hasher.hash({ phone: 'x' })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is keyed: another secret gives another hash', () => {
    const value = { phone: '+998901234567' };
    expect(new AuditHasher(key).hash(value)).not.toBe(new AuditHasher(randomBytes(32)).hash(value));
  });

  it('is not a plain hash of the data', () => {
    const value = { phone: '+998901234567' };
    expect(new AuditHasher(key).hash(value)).not.toBe(
      new AuditHasher(new Uint8Array(32)).hash(value),
    );
  });
});
