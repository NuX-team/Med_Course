import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import EmbeddedPostgres from 'embedded-postgres';
import postgres from 'postgres';

/**
 * pnpm dev:db
 *
 * A Postgres 16 for local development without Docker. It keeps its data between runs in
 * `.dev-pg/` at the repository root (git-ignored) and listens on 127.0.0.1:5433 with the same
 * user, password and database as `.env.example`, so the default DATABASE_URL just works.
 * Leave it running in its own terminal; Ctrl+C stops it cleanly.
 *
 * Development only: a throwaway password on a loopback address. Not for anything real.
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const DATA_DIRECTORY = join(ROOT, '.dev-pg');
const PORT = Number(process.env.POSTGRES_HOST_PORT ?? 5433);
const USER = process.env.POSTGRES_USER ?? 'medcourse';
const PASSWORD = process.env.POSTGRES_PASSWORD ?? 'medcourse';
const DATABASE = process.env.POSTGRES_DB ?? 'medcourse';

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const server = new EmbeddedPostgres({
    databaseDir: DATA_DIRECTORY,
    port: PORT,
    user: USER,
    password: PASSWORD,
    persistent: true,
    // UTF8 is required (names carry emoji); C avoids depending on the machine's locale.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => undefined,
    onError: () => undefined,
  });

  if (!existsSync(join(DATA_DIRECTORY, 'PG_VERSION'))) {
    print(`creating a new database cluster in ${DATA_DIRECTORY} ...`);
    await server.initialise();
  }
  await server.start();

  const admin = postgres(`postgres://${USER}:${PASSWORD}@127.0.0.1:${String(PORT)}/postgres`, {
    max: 1,
    onnotice: () => undefined,
  });
  try {
    const existing = await admin`select 1 from pg_database where datname = ${DATABASE}`;
    if (existing.length === 0) {
      await admin.unsafe(`create database "${DATABASE.replaceAll('"', '')}"`);
      print(`created the database "${DATABASE}"`);
    }
  } finally {
    await admin.end({ timeout: 5 });
  }

  print(`ready: postgres://${USER}:***@127.0.0.1:${String(PORT)}/${DATABASE}  (Ctrl+C to stop)`);

  let stopping = false;
  const stop = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    print('stopping ...');
    void server.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
