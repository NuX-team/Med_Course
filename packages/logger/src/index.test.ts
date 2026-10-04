import { describe, expect, it } from 'vitest';
import { createLogger } from './index';

function captureLogger(level = 'info') {
  const lines: string[] = [];
  const logger = createLogger({
    service: 'test',
    level,
    stream: {
      write(line: string) {
        lines.push(line);
      },
    },
  });
  return { logger, lines };
}

describe('createLogger', () => {
  it('writes JSON with service, string level and ISO time', () => {
    const { logger, lines } = captureLogger();
    logger.info({ courseId: 'c1' }, 'hello');

    const entry = JSON.parse(lines[0] ?? '') as Record<string, unknown>;
    expect(entry).toMatchObject({ service: 'test', level: 'info', courseId: 'c1', msg: 'hello' });
    expect(String(entry.time)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('respects the level', () => {
    const { logger, lines } = captureLogger('warn');
    logger.info('dropped');
    logger.warn('kept');
    expect(lines).toHaveLength(1);
  });

  it.each([
    ['top level', { token: 'tok-123', phone: '+998901234567' }],
    ['one level down', { ctx: { token: 'tok-123', phone: '+998901234567' } }],
  ])('redacts secrets and personal data (%s)', (_name, payload) => {
    const { logger, lines } = captureLogger();
    logger.info(payload, 'event');

    expect(lines[0]).not.toContain('tok-123');
    expect(lines[0]).not.toContain('998901234567');
    expect(lines[0]).toContain('[redacted]');
  });

  it('redacts medical free text and raw Telegram updates', () => {
    const { logger, lines } = captureLogger();
    logger.info(
      {
        reason_text: 'болит голова',
        instructions: 'после еды',
        update: { message: { text: 'raw update' } },
      },
      'event',
    );

    expect(lines[0]).not.toContain('болит голова');
    expect(lines[0]).not.toContain('после еды');
    expect(lines[0]).not.toContain('raw update');
  });

  it('redacts credential headers on request logs', () => {
    const { logger, lines } = captureLogger();
    logger.info(
      {
        req: {
          headers: {
            authorization: 'Bearer abc',
            'x-telegram-bot-api-secret-token': 'hook-secret',
            'user-agent': 'TelegramBot',
          },
        },
      },
      'request',
    );

    expect(lines[0]).not.toContain('Bearer abc');
    expect(lines[0]).not.toContain('hook-secret');
    expect(lines[0]).toContain('TelegramBot');
  });
});
