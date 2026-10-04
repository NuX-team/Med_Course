import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MigrationError, loadMigrations } from './migrate';

let directory = '';

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'medcourse-migrations-'));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function write(name: string, body = 'select 1;'): Promise<void> {
  await writeFile(join(directory, name), body);
}

describe('loadMigrations', () => {
  it('pairs up and down files in numeric order and checksums the up script', async () => {
    await write('0002_second.up.sql', 'select 2;');
    await write('0002_second.down.sql');
    await write('0001_first.up.sql', 'select 1;');
    await write('0001_first.down.sql');

    const migrations = await loadMigrations(directory);

    expect(migrations.map((migration) => migration.id)).toEqual(['0001_first', '0002_second']);
    expect(migrations[0]?.up).toBe('select 1;');
    expect(migrations[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(migrations[0]?.checksum).not.toBe(migrations[1]?.checksum);
  });

  it('ignores files that are not SQL', async () => {
    await write('0001_first.up.sql');
    await write('0001_first.down.sql');
    await write('README.md', '# notes');

    expect(await loadMigrations(directory)).toHaveLength(1);
  });

  it('rejects a migration without a down', async () => {
    await write('0001_first.up.sql');
    await expect(loadMigrations(directory)).rejects.toThrow(MigrationError);
  });

  it('rejects a migration without an up', async () => {
    await write('0001_first.down.sql');
    await expect(loadMigrations(directory)).rejects.toThrow(MigrationError);
  });

  it('rejects gaps and a missing start in the numbering', async () => {
    await write('0001_first.up.sql');
    await write('0001_first.down.sql');
    await write('0003_third.up.sql');
    await write('0003_third.down.sql');
    await expect(loadMigrations(directory)).rejects.toThrow(/without gaps/);
  });

  it.each(['1_short.up.sql', '0001_Upper.up.sql', '0001_first.sql', '0001-first.up.sql'])(
    'rejects the badly named file %s',
    async (name) => {
      await write(name);
      await expect(loadMigrations(directory)).rejects.toThrow(MigrationError);
    },
  );
});
