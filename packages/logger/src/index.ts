import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger } from 'pino';

/**
 * Keys that must never reach logs: secrets, personal data and medical free text
 * (ARCHITECTURE §9). `update` and `body` cover raw Telegram updates and request bodies.
 */
const SENSITIVE_KEYS = [
  'token',
  'botToken',
  'secret',
  'password',
  'authorization',
  'databaseUrl',
  'phone',
  'dateOfBirth',
  'date_of_birth',
  'reason_text',
  'reasonText',
  'instructions',
  'update',
  'body',
] as const;

/**
 * pino redaction has no recursive wildcard, so each key is covered at the top level
 * and one level down. Deeper structures must not be logged as-is.
 */
export const REDACT_PATHS: readonly string[] = [
  ...SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`]),
  'req.headers.authorization',
  'req.headers["x-telegram-bot-api-secret-token"]',
];

export interface CreateLoggerOptions {
  readonly service: string;
  readonly level: string;
  /** Defaults to stdout. Tests pass their own stream. */
  readonly stream?: DestinationStream;
}

export function createLogger(options: CreateLoggerOptions): Logger {
  return pino(
    {
      level: options.level,
      base: { service: options.service },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
    },
    options.stream,
  );
}
