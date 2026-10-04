import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import type { Sql } from 'postgres';
import { migrateUp, type Migration } from './migrate';

/**
 * Backups made by the application itself (TZ §12): every row of every table as one line of
 * JSON, read in a single snapshot, compressed, and encrypted with a key that is not the one the
 * database fields are encrypted with. Restoring is the reverse into an empty database: the
 * schema comes from the migrations, the rows from the file, and the result is checked table by
 * table against the counts and checksums the backup took of itself.
 *
 * This is deliberately not `pg_dump`: the application image carries no Postgres client, and a
 * backup that cannot be restored and checked on the spot is not a backup.
 */

const MAGIC = Buffer.from('MCBK1\n', 'ascii');
const NONCE_PREFIX_BYTES = 8;
const TAG_BYTES = 16;
const CHUNK_BYTES = 64 * 1024;
const BATCH_ROWS = 200;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export interface BackupKey {
  readonly id: string;
  readonly key: Uint8Array;
}

export interface TableDigest {
  readonly rows: number;
  /** A checksum of the table's content that does not depend on the order of its rows. */
  readonly checksum: string;
}

export interface BackupManifest {
  readonly createdAt: string;
  readonly migrations: readonly { readonly id: string; readonly checksum: string }[];
  readonly tables: Readonly<Record<string, TableDigest>>;
  readonly sequences: Readonly<Record<string, number>>;
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupError';
  }
}

function nonce(prefix: Buffer, counter: number): Buffer {
  const out = Buffer.alloc(NONCE_PREFIX_BYTES + 4);
  prefix.copy(out);
  out.writeUInt32BE(counter, NONCE_PREFIX_BYTES);
  return out;
}

/** What is authenticated with each chunk: its place in the file, and whether it is the last. */
function aad(counter: number, last: boolean): Buffer {
  const out = Buffer.alloc(5);
  out.writeUInt32BE(counter);
  out.writeUInt8(last ? 1 : 0, 4);
  return out;
}

/**
 * AES-256-GCM in chunks. Each chunk is sealed with its number and with whether it is the final
 * one, so a file that was cut short, or had chunks dropped or reordered, does not decrypt.
 */
class Seal extends Transform {
  readonly #key: Uint8Array;
  readonly #prefix = randomBytes(NONCE_PREFIX_BYTES);
  #pending = Buffer.alloc(0);
  #counter = 0;

  constructor(key: BackupKey) {
    super();
    this.#key = key.key;
    const id = Buffer.from(key.id, 'ascii');
    this.push(Buffer.concat([MAGIC, Buffer.from([id.length]), id, this.#prefix]));
  }

  #emit(plain: Buffer, last: boolean): void {
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce(this.#prefix, this.#counter));
    cipher.setAAD(aad(this.#counter, last));
    const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    const head = Buffer.alloc(5);
    head.writeUInt8(last ? 1 : 0);
    head.writeUInt32BE(sealed.length, 1);
    this.push(Buffer.concat([head, sealed]));
    this.#counter += 1;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.#pending = Buffer.concat([this.#pending, chunk]);
    while (this.#pending.length > CHUNK_BYTES) {
      this.#emit(this.#pending.subarray(0, CHUNK_BYTES), false);
      this.#pending = this.#pending.subarray(CHUNK_BYTES);
    }
    done();
  }

  override _flush(done: TransformCallback): void {
    this.#emit(this.#pending, true);
    done();
  }
}

class Unseal extends Transform {
  readonly #keys: readonly BackupKey[];
  #key: Uint8Array | null = null;
  #prefix: Buffer | null = null;
  #pending = Buffer.alloc(0);
  #counter = 0;
  #finished = false;

  constructor(keys: readonly BackupKey[]) {
    super();
    this.#keys = keys;
  }

  #header(): boolean {
    if (this.#pending.length < MAGIC.length + 1) {
      return false;
    }
    if (!this.#pending.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new BackupError('this is not a MedCourse backup file');
    }
    const idLength = this.#pending.readUInt8(MAGIC.length);
    const end = MAGIC.length + 1 + idLength + NONCE_PREFIX_BYTES;
    if (this.#pending.length < end) {
      return false;
    }
    const id = this.#pending.subarray(MAGIC.length + 1, MAGIC.length + 1 + idLength).toString();
    const key = this.#keys.find((candidate) => candidate.id === id);
    if (key === undefined) {
      throw new BackupError(`the backup was made with key "${id}", which is not configured`);
    }
    this.#key = key.key;
    this.#prefix = Buffer.from(this.#pending.subarray(end - NONCE_PREFIX_BYTES, end));
    this.#pending = this.#pending.subarray(end);
    return true;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    try {
      this.#pending = Buffer.concat([this.#pending, chunk]);
      if (this.#key === null && !this.#header()) {
        done();
        return;
      }
      while (this.#pending.length >= 5) {
        if (this.#finished) {
          throw new BackupError('the backup file has data after its end');
        }
        const last = this.#pending.readUInt8(0) === 1;
        const length = this.#pending.readUInt32BE(1);
        if (length < TAG_BYTES || length > CHUNK_BYTES + TAG_BYTES) {
          throw new BackupError('the backup file is damaged');
        }
        if (this.#pending.length < 5 + length) {
          break;
        }
        const sealed = this.#pending.subarray(5, 5 + length);
        const decipher = createDecipheriv(
          'aes-256-gcm',
          this.#key ?? Buffer.alloc(32),
          nonce(this.#prefix ?? Buffer.alloc(NONCE_PREFIX_BYTES), this.#counter),
        );
        decipher.setAAD(aad(this.#counter, last));
        decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
        this.push(
          Buffer.concat([
            decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)),
            decipher.final(),
          ]),
        );
        this.#counter += 1;
        this.#finished = last;
        this.#pending = this.#pending.subarray(5 + length);
      }
      done();
    } catch (error) {
      done(
        error instanceof BackupError
          ? error
          : new BackupError(
              'the backup file is damaged, or the key is not the one it was made with',
            ),
      );
    }
  }

  override _flush(done: TransformCallback): void {
    done(
      this.#finished && this.#pending.length === 0
        ? null
        : new BackupError('the backup file is cut short'),
    );
  }
}

function safe(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) {
    throw new BackupError(`unexpected name in the database: ${identifier}`);
  }
  return `"${identifier}"`;
}

async function tablesOf(sql: Sql): Promise<string[]> {
  const rows = await sql<{ tablename: string }[]>`
    select tablename from pg_tables
    where schemaname = 'public' and tablename <> 'schema_migrations'
    order by tablename`;
  return rows.map((row) => row.tablename);
}

async function digestOf(sql: Sql, table: string): Promise<TableDigest> {
  const [row] = await sql.unsafe<{ rows: number; checksum: string }[]>(
    `select count(*)::int as rows,
            md5(coalesce(string_agg(md5(row_to_json(t)::text), '' order by md5(row_to_json(t)::text)), '')) as checksum
     from ${safe(table)} t`,
  );
  return { rows: row?.rows ?? 0, checksum: row?.checksum ?? '' };
}

async function sequencesOf(sql: Sql): Promise<Record<string, number>> {
  const rows = await sql<{ name: string; value: string | null }[]>`
    select sequencename as name, last_value::text as value from pg_sequences
    where schemaname = 'public'`;
  return Object.fromEntries(
    rows.flatMap((row) => (row.value === null ? [] : [[row.name, Number(row.value)]])),
  );
}

/**
 * Writes a backup of the whole database to `path`. Everything is read inside one repeatable-read
 * transaction, so the file is the database as it was at a single moment.
 */
export async function writeBackup(
  sql: Sql,
  key: BackupKey,
  path: string,
  now: Date,
): Promise<BackupManifest> {
  // Opened first, and exclusively: a backup never replaces a file that is already there, and
  // that is found out before the database is asked for anything.
  const file = createWriteStream(path, { flags: 'wx' });
  await once(file, 'open');
  const gzip = createGzip();
  const written = pipeline(gzip, new Seal(key), file);
  // A failure of the file is reported when the pipeline is awaited below, not as a stray rejection.
  written.catch(() => undefined);
  const line = (value: unknown): Promise<void> =>
    new Promise((resolve, reject) => {
      gzip.write(`${JSON.stringify(value)}\n`, (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });

  let manifest: BackupManifest | undefined;
  try {
    await sql.begin('isolation level repeatable read read only', async (tx) => {
      const snapshot = tx as unknown as Sql;
      const migrations = await tx<{ id: string; checksum: string }[]>`
        select id, checksum from schema_migrations order by id`;
      const tables: Record<string, TableDigest> = {};
      await line({ type: 'header', version: 1, createdAt: now.toISOString() });
      for (const table of await tablesOf(snapshot)) {
        tables[table] = await digestOf(snapshot, table);
        await line({ type: 'table', name: table });
        const cursor = tx
          .unsafe<{ row: string }[]>(`select row_to_json(t)::text as row from ${safe(table)} t`)
          .cursor(BATCH_ROWS);
        for await (const rows of cursor) {
          for (const { row } of rows) {
            await line({ type: 'row', row });
          }
        }
      }
      manifest = {
        createdAt: now.toISOString(),
        migrations: migrations.map(({ id, checksum }) => ({ id, checksum })),
        tables,
        sequences: await sequencesOf(snapshot),
      };
      await line({ type: 'manifest', manifest });
    });
  } finally {
    gzip.end();
    await written;
  }
  if (manifest === undefined) {
    throw new BackupError('the backup was not written');
  }
  return manifest;
}

type BackupLine =
  | { type: 'header'; version: number; createdAt: string }
  | { type: 'table'; name: string }
  | { type: 'row'; row: string }
  | { type: 'manifest'; manifest: BackupManifest };

async function* linesOf(path: string, keys: readonly BackupKey[]): AsyncGenerator<BackupLine> {
  const gunzip = createGunzip();
  const source = pipeline(createReadStream(path), new Unseal(keys), gunzip);
  // A failure upstream ends the reader below; it is re-thrown when the pipeline is awaited.
  source.catch(() => undefined);
  for await (const text of createInterface({ input: gunzip, crlfDelay: Infinity })) {
    if (text !== '') {
      yield JSON.parse(text) as BackupLine;
    }
  }
  await source;
}

/** Reads a backup to its end and returns what it says about itself. Changes nothing anywhere. */
export async function inspectBackup(
  path: string,
  keys: readonly BackupKey[],
): Promise<BackupManifest> {
  let manifest: BackupManifest | undefined;
  for await (const line of linesOf(path, keys)) {
    if (line.type === 'manifest') {
      ({ manifest } = line);
    }
  }
  if (manifest === undefined) {
    throw new BackupError('the backup file has no manifest: it was not finished');
  }
  return manifest;
}

export interface RestoreReport {
  readonly manifest: BackupManifest;
  /** Empty when every table came back with the rows and the content the backup recorded. */
  readonly problems: readonly string[];
}

/**
 * Restores a backup into an EMPTY database: applies the migrations, loads every row, puts the
 * sequences back, and then compares each table with what the backup recorded about itself.
 * The connection must be a superuser's: rows are loaded with triggers and foreign keys set
 * aside (the journal tables, and plans already signed off, cannot be inserted otherwise).
 * Refuses a database that already has tables, and a backup made by a different set of
 * migrations than the ones given.
 */
export async function restoreBackup(
  sql: Sql,
  keys: readonly BackupKey[],
  path: string,
  migrations: readonly Migration[],
): Promise<RestoreReport> {
  const [existing] = await sql<{ n: number }[]>`
    select count(*)::int as n from pg_tables where schemaname = 'public'`;
  if ((existing?.n ?? 0) > 0) {
    throw new BackupError('the target database is not empty: restore only into a new database');
  }
  // Read to the end first: a damaged or foreign file is found before anything is created.
  const manifest = await inspectBackup(path, keys);
  const known = new Map(migrations.map((migration) => [migration.id, migration.checksum]));
  const foreign = manifest.migrations.filter(({ id, checksum }) => known.get(id) !== checksum);
  if (foreign.length > 0 || manifest.migrations.length > migrations.length) {
    throw new BackupError(
      `the backup was made by another version of the schema (${foreign.map(({ id }) => id).join(', ') || 'newer migrations'})`,
    );
  }
  await migrateUp(
    sql,
    migrations.filter((migration) => manifest.migrations.some(({ id }) => id === migration.id)),
  );

  await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`;
    let table: string | null = null;
    let batch: string[] = [];
    const flush = async (): Promise<void> => {
      if (table !== null && batch.length > 0) {
        await tx.unsafe(
          `insert into ${safe(table)} overriding system value
           select (json_populate_record(null::${safe(table)}, line::json)).*
           from unnest($1::text[]) as line`,
          [batch],
        );
      }
      batch = [];
    };
    for await (const line of linesOf(path, keys)) {
      if (line.type === 'table') {
        await flush();
        table = line.name;
      } else if (line.type === 'row') {
        batch.push(line.row);
        if (batch.length >= BATCH_ROWS) {
          await flush();
        }
      }
    }
    await flush();
    for (const [name, value] of Object.entries(manifest.sequences)) {
      await tx.unsafe(`select setval('${safe(name).replaceAll('"', '')}', $1)`, [value]);
    }
  });

  return { manifest, problems: await verifyAgainst(sql, manifest) };
}

/** Compares a database with what a backup recorded: tables, row counts, content checksums. */
export async function verifyAgainst(sql: Sql, manifest: BackupManifest): Promise<string[]> {
  const problems: string[] = [];
  const tables = await tablesOf(sql);
  for (const table of tables) {
    if (!(table in manifest.tables)) {
      problems.push(`${table}: not in the backup`);
    }
  }
  for (const [table, expected] of Object.entries(manifest.tables)) {
    if (!tables.includes(table)) {
      problems.push(`${table}: missing after the restore`);
      continue;
    }
    const actual = await digestOf(sql, table);
    if (actual.rows !== expected.rows) {
      problems.push(
        `${table}: ${String(actual.rows)} rows, the backup has ${String(expected.rows)}`,
      );
    } else if (actual.checksum !== expected.checksum) {
      problems.push(`${table}: the content differs from the backup`);
    }
  }
  const sequences = await sequencesOf(sql);
  for (const [name, value] of Object.entries(manifest.sequences)) {
    if (sequences[name] !== value) {
      problems.push(
        `sequence ${name}: ${String(sequences[name])}, the backup has ${String(value)}`,
      );
    }
  }
  return problems;
}

/** The size of a backup file, for the line a run prints about itself. */
export async function backupSize(path: string): Promise<number> {
  return (await stat(path)).size;
}

const FILE_PATTERN = /^medcourse-\d{8}-\d{6}\.mcbk$/;

/** `2026-10-04T08:15:30.000Z` as `20261004-081530`: sorts by time, safe in a file name. */
export function backupFileName(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `medcourse-${stamp}.mcbk`;
}

/** Deletes all but the newest `keep` backup files in a directory. Other files are left alone. */
export async function pruneBackups(directory: string, keep: number): Promise<string[]> {
  const files = (await readdir(directory)).filter((name) => FILE_PATTERN.test(name)).sort();
  const old = files.slice(0, Math.max(0, files.length - keep));
  for (const name of old) {
    await unlink(join(directory, name));
  }
  return old;
}
