import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Update } from './types';

const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/**
 * The URL path Telegram is told to call. Derived from the secret, so there is nothing more to
 * configure and the address itself cannot be guessed. The header check below is the real gate.
 */
export function webhookPath(secret: string): string {
  const segment = createHmac('sha256', secret)
    .update('telegram-webhook-path')
    .digest('hex')
    .slice(0, 32);
  return `/telegram/${segment}`;
}

/** Equal secrets compare equal in the same time as unequal ones: no timing oracle. */
export function secretMatches(expected: string, received: string | undefined): boolean {
  if (received === undefined) {
    return false;
  }
  const digest = (value: string): Buffer => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(expected), digest(received));
}

function isUpdate(body: unknown): body is Update {
  return (
    typeof body === 'object' &&
    body !== null &&
    Number.isSafeInteger((body as { update_id?: unknown }).update_id)
  );
}

export interface WebhookOptions {
  readonly secret: string;
  /** Handles one update. Must not throw: the webhook always answers 200 once it is called. */
  readonly onUpdate: (update: Update) => Promise<void>;
}

/**
 * `POST <webhookPath>`. A wrong or missing secret is refused with 403 and nothing else; a body
 * that is not an update is a 400. Everything accepted is answered 200, even when handling it
 * failed (that is logged inside `onUpdate`): an error status only makes Telegram retry.
 */
export function registerWebhook(app: FastifyInstance, options: WebhookOptions): void {
  app.post(
    webhookPath(options.secret),
    {
      // Before the body is read, so an unauthenticated caller costs nothing to parse.
      onRequest: async (request, reply) => {
        const header = request.headers[SECRET_HEADER];
        if (!secretMatches(options.secret, typeof header === 'string' ? header : undefined)) {
          return reply.code(403).send({ error: 'forbidden', requestId: request.id });
        }
        return undefined;
      },
    },
    async (request, reply) => {
      if (!isUpdate(request.body)) {
        return reply.code(400).send({ error: 'bad_request', requestId: request.id });
      }
      await options.onUpdate(request.body);
      return { ok: true };
    },
  );
}
