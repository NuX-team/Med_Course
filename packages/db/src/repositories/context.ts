import { AuditHasher, AuditWriter } from '../audit';
import { FieldCipher, type CipherKey } from '../field-cipher';

/** What every repository needs besides a database handle. Build once, reuse per request. */
export interface RepositoryDeps {
  readonly cipher: FieldCipher;
  readonly audit: AuditWriter;
  /** Stamped on audit entries so a log line and an audit row can be tied together. */
  readonly requestId?: string;
}

/** The first key is the active one: it encrypts and derives the audit hashing key. */
export function createRepositoryDeps(
  keys: readonly CipherKey[],
  options: { readonly requestId?: string } = {},
): RepositoryDeps {
  const [active] = keys;
  if (active === undefined) {
    throw new Error('at least one encryption key is required');
  }
  return {
    cipher: new FieldCipher(keys),
    audit: new AuditWriter(new AuditHasher(active.key)),
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
  };
}
