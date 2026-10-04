import { createRepositories, type Executor, type RepositoryDeps } from '@medcourse/db';
import type { Logger } from '@medcourse/logger';
import { InputFile } from 'grammy';
import { handleUpdate, extractIncoming } from './handler';
import { replyMarkup, type Reply, type TelegramApi, type Update } from './types';

export interface ProcessDeps {
  readonly orm: Executor;
  readonly repositoryDeps: RepositoryDeps;
  readonly api: TelegramApi;
  readonly logger: Logger;
  /** The bot's own username, for invitation links. */
  readonly botUsername: string;
  /** Where the staff panel lives, for sign-in links; absent when none is deployed. */
  readonly panelBaseUrl?: string | null;
  /** Injected so tests control the clock. */
  readonly now?: () => Date;
}

/** Telegram's answer when an edit would change nothing, e.g. a button pressed twice. Harmless. */
const NOT_MODIFIED = /message is not modified/i;
const APOLOGY =
  'Что-то пошло не так. Попробуйте ещё раз / Nimadir xato ketdi. Yana urinib koʻring.';

/**
 * One update, start to finish: claim it, do the database work in one transaction, then talk to
 * Telegram. Never throws, so a webhook always gets its answer and a polling loop never stops.
 *
 * The update is claimed first and handled at most once. That is deliberate: Telegram redelivers
 * anything not acknowledged in time, and handling a button press twice is worse than losing one
 * the person can simply press again. Reminders do not rely on this path; they will have an outbox.
 */
export async function processUpdate(deps: ProcessDeps, update: Update): Promise<void> {
  const { orm, repositoryDeps, logger } = deps;
  const now = deps.now ?? (() => new Date());

  try {
    if (!(await createRepositories(orm, repositoryDeps).telegram.claimUpdate(update.update_id))) {
      logger.debug({ updateId: update.update_id }, 'duplicate update ignored');
      return;
    }
  } catch (err) {
    logger.error({ err, updateId: update.update_id }, 'could not claim update');
    return;
  }

  let replies: Reply[];
  try {
    replies = await orm.transaction((tx) =>
      handleUpdate(
        {
          repos: createRepositories(tx, repositoryDeps),
          now: now(),
          botUsername: deps.botUsername,
          panelBaseUrl: deps.panelBaseUrl ?? null,
        },
        update,
      ),
    );
  } catch (err) {
    // `err`, never the update: its text is whatever the person typed.
    logger.error({ err, updateId: update.update_id }, 'handling an update failed');
    const incoming = extractIncoming(update);
    if (incoming !== null) {
      await deliver(deps.api, [{ kind: 'send', chatId: incoming.chatId, text: APOLOGY }], logger);
    }
    return;
  }

  await deliver(deps.api, replies, logger);
}

/** Sends replies in order. A failed one is logged and the rest still go out. */
export async function deliver(
  api: TelegramApi,
  replies: readonly Reply[],
  logger: Logger,
): Promise<void> {
  for (const reply of replies) {
    try {
      switch (reply.kind) {
        case 'send':
          await api.sendMessage(reply.chatId, reply.text, replyMarkup(reply.buttons));
          break;
        case 'edit':
          await api.editMessageText(
            reply.chatId,
            reply.messageId,
            reply.text,
            replyMarkup(reply.buttons),
          );
          break;
        case 'answer':
          await api.answerCallbackQuery(reply.callbackQueryId);
          break;
        case 'document':
          await api.sendDocument(reply.chatId, new InputFile(reply.content, reply.filename), {
            caption: reply.caption,
          });
          break;
      }
    } catch (err) {
      if (err instanceof Error && NOT_MODIFIED.test(err.message)) {
        continue;
      }
      logger.warn({ err, kind: reply.kind }, 'could not deliver a reply');
      if (reply.kind === 'document') {
        // The person pressed a button and is waiting for a file: tell them it did not come.
        try {
          await api.sendMessage(reply.chatId, reply.fallback);
        } catch {
          // Telegram is out of reach altogether; the warning above is all there is to say.
        }
      }
    }
  }
}
