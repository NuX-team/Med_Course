import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What must stay true of the repository itself (stage 14, ARCHITECTURE §9): no secret in what is
 * committed, no way for a person's text to become markup, nowhere that a query is built out of
 * strings without a reviewer having said so. These are the checks that would have caught the
 * bot token landing in the repository at stage 3; they run on every `pnpm test`.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function git(...args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

// What is committed, and what is about to be: a new file that is not ignored counts too, so the
// checks speak before the commit and not after it.
const listed = git('ls-files', '-z', '--cached', '--others', '--exclude-standard');
const FILES = listed === null ? [] : listed.split('\0').filter((name) => name !== '');
const BINARY = /\.(png|jpe?g|gif|ico|pdf|ttf|woff2?|mcbk)$/i;
const text = new Map<string, string>();
for (const name of FILES) {
  if (!BINARY.test(name)) {
    try {
      text.set(name, readFileSync(join(ROOT, name), 'utf8'));
    } catch {
      // Listed but not on disk (deleted, not yet committed): nothing to read.
    }
  }
}
const isTest = (name: string): boolean =>
  name.endsWith('.test.ts') || name.startsWith('packages/db/test/');
const source = [...text].filter(
  ([name]) => /^(apps|packages)\/[^/]+\/src\/.*\.ts$/.test(name) && !isTest(name),
);

// Without a git checkout there is nothing to check; in a checkout there always is.
const inCheckout = FILES.length > 100;

/** Tokens the tests make up on purpose: exactly these, and no other, may look like a bot token. */
const MADE_UP = new Set(['7654321098:AAH-x_Yz0123456789abcdefghijklmnopqrs']);

describe.runIf(inCheckout)('what is committed', () => {
  it('holds nothing shaped like a Telegram bot token, apart from the ones the tests make up', () => {
    const found: string[] = [];
    for (const [name, content] of text) {
      for (const match of content.matchAll(
        /(?<![A-Za-z0-9_-])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
      )) {
        if (!MADE_UP.has(match[0])) {
          found.push(name);
        }
      }
    }
    // File names only: the value itself must never be printed.
    expect(found).toEqual([]);
  });

  it('holds no private key and no real encryption key', () => {
    const keys: string[] = [];
    for (const [name, content] of text) {
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(content)) {
        keys.push(`${name}: a private key`);
      }
      for (const match of content.matchAll(
        /\b(?:ENCRYPTION_KEYS|BACKUP_KEY)\s*[=:]\s*['"]?([a-z][a-z0-9_-]*):[A-Za-z0-9+/]{43}=/gi,
      )) {
        // A throwaway key has an id that starts with "dev": the configuration refuses those outside local.
        if (!(match[1] ?? '').startsWith('dev')) {
          keys.push(`${name}: a key whose id does not start with "dev"`);
        }
      }
    }
    expect(keys).toEqual([]);
  });

  it('keeps .env out of the repository and has the examples hold no secret', () => {
    expect(
      FILES.filter((name) => /(^|\/)\.env($|\.(?!(production\.)?example$))/.test(name)),
    ).toEqual([]);
    expect(git('check-ignore', '.env')?.trim()).toBe('.env');
    expect(git('check-ignore', 'deploy/.env.production')?.trim()).toBe('deploy/.env.production');
    // The server's example names every secret and gives a value to none of them.
    const production = text.get('deploy/.env.production.example') ?? '';
    for (const name of [
      'POSTGRES_PASSWORD',
      'ENCRYPTION_KEYS',
      'BACKUP_KEY',
      'TELEGRAM_BOT_TOKEN',
      'TELEGRAM_WEBHOOK_SECRET',
      'METRICS_TOKEN',
    ]) {
      expect(production, name).toMatch(new RegExp(`^${name}=\\s*$`, 'm'));
    }
    const example = text.get('.env.example') ?? '';
    expect(example).toMatch(/^TELEGRAM_BOT_TOKEN=\s*$/m);
    expect(example).not.toMatch(/^BACKUP_KEY=\S/m);
    expect(example).not.toMatch(/^METRICS_TOKEN=\S/m);
  });

  it('has the bot say everything as plain text: nothing in the code asks Telegram for markup', () => {
    expect(
      source.filter(([, content]) => content.includes('parse_mode')).map(([name]) => name),
    ).toEqual([]);
  });

  it('runs no code made of strings and starts no other program', () => {
    const offenders = source
      .filter(([name]) => !name.endsWith('/dev-db.ts'))
      .filter(([, content]) =>
        /\beval\(|new Function\(|child_process|dangerouslySetInnerHTML/.test(content),
      )
      .map(([name]) => name);
    expect(offenders).toEqual([]);
  });

  it('builds a query out of strings only where a reviewer has looked: the migration runner, backups, the operator’s commands, the dev database', () => {
    const raw = source
      .filter(([, content]) => content.includes('.unsafe('))
      .map(([name]) => name)
      .sort();
    // A new entry here is a decision: say in the commit why it cannot be a parameter.
    expect(raw).toEqual([
      'packages/db/src/backup.ts',
      'packages/db/src/dev-db.ts',
      'packages/db/src/migrate.ts',
      'packages/db/src/ops.ts',
    ]);
  });

  it('reads the environment in one place only', () => {
    const readers = source
      .filter(([, content]) => content.includes('process.env'))
      .map(([name]) => name)
      .filter((name) => !name.startsWith('packages/config/') && !name.endsWith('/dev-db.ts'));
    expect(readers).toEqual([]);
  });

  it('serves nothing over http that a browser could run: the panel sends no script and the policy forbids it', () => {
    const app = text.get('apps/panel/src/app.ts') ?? '';
    const html = text.get('apps/panel/src/html.ts') ?? '';
    expect(app).toContain("default-src 'none'");
    expect(app).not.toMatch(/script-src/);
    expect(html).not.toMatch(/<script/);
    expect(`${app}${html}`).not.toMatch(/unsafe-inline|unsafe-eval/);
  });
});
