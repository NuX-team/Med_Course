import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type { TestProject } from 'vitest/node';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/**
 * One Postgres for the whole db test project. CI and anyone with Docker running set
 * DATABASE_URL to an existing server (a superuser, since each test file creates a database);
 * otherwise a throwaway Postgres 16 is started from the embedded-postgres package and removed
 * afterwards.
 */
export default async function setup(
  project: TestProject,
): Promise<(() => Promise<void>) | undefined> {
  const external = process.env.DATABASE_URL;
  if (external !== undefined && external !== '') {
    project.provide('adminDatabaseUrl', external);
    return undefined;
  }

  const databaseDir = await mkdtemp(join(tmpdir(), 'medcourse-pg-'));
  const port = await freePort();
  const pg = new EmbeddedPostgres({
    databaseDir,
    port,
    user: 'postgres',
    password: 'postgres',
    persistent: false,
    // Without this a Windows host creates databases in WIN1251, which cannot store an emoji in a name.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => undefined,
    onError: () => undefined,
  });

  await pg.initialise();
  await pg.start();
  project.provide(
    'adminDatabaseUrl',
    `postgres://postgres:postgres@127.0.0.1:${String(port)}/postgres`,
  );

  return async () => {
    await pg.stop();
    await rm(databaseDir, { recursive: true, force: true });
  };
}
