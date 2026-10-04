import { createHmac, hkdfSync } from 'node:crypto';
import { actorKind, actorUserId, type Actor } from './access/actor';
import type { Executor } from './orm';
import { auditLog } from './schema';

/** JSON with sorted keys, so equal values always hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('cannot hash a non-finite number');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'bigint') {
    return JSON.stringify(value.toString());
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  throw new TypeError(`cannot hash a value of type ${typeof value}`);
}

/** Names of the fields whose values differ. Only names ever reach the audit log. */
export function changedFields(
  before: Readonly<Record<string, unknown>> | null | undefined,
  after: Readonly<Record<string, unknown>> | null | undefined,
): string[] {
  const left = before ?? {};
  const right = after ?? {};
  const names = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...names]
    .filter((name) => canonicalJson(left[name] ?? null) !== canonicalJson(right[name] ?? null))
    .sort();
}

/**
 * Keyed hash (HMAC-SHA256) of a record's state. Keyed because low-entropy values such as a
 * phone number would otherwise be recoverable from a plain hash. The key is derived from the
 * active encryption key, so there is no extra secret to manage.
 */
export class AuditHasher {
  readonly #key: Buffer;

  constructor(secret: Uint8Array) {
    this.#key = Buffer.from(
      hkdfSync('sha256', secret, Buffer.alloc(0), 'medcourse/audit-hash/v1', 32),
    );
  }

  hash(value: unknown): string {
    return createHmac('sha256', this.#key).update(canonicalJson(value)).digest('hex');
  }
}

export interface AuditEntry {
  readonly actor: Actor;
  readonly entityType: string;
  readonly entityId: string;
  readonly action: string;
  /** State before and after, as stored. Hashed, never written out. */
  readonly before?: Readonly<Record<string, unknown>> | null;
  readonly after?: Readonly<Record<string, unknown>> | null;
  /** Overrides the diff of before/after, for fields whose stored form is not comparable. */
  readonly changes?: readonly string[];
  readonly reason?: string;
  readonly requestId?: string;
}

export class AuditWriter {
  readonly #hasher: AuditHasher;

  constructor(hasher: AuditHasher) {
    this.#hasher = hasher;
  }

  /** Call inside the transaction of the change it describes, so both commit or neither does. */
  async record(db: Executor, entry: AuditEntry): Promise<void> {
    await db.insert(auditLog).values({
      actorKind: actorKind(entry.actor),
      actorUserId: actorUserId(entry.actor),
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      changes: [...(entry.changes ?? changedFields(entry.before, entry.after))],
      beforeHash: entry.before ? this.#hasher.hash(entry.before) : null,
      afterHash: entry.after ? this.#hasher.hash(entry.after) : null,
      reason: entry.reason ?? (entry.actor.kind === 'SYSTEM' ? entry.actor.reason : null),
      requestId: entry.requestId ?? null,
    });
  }
}
