import type { Executor, RepositoryDeps } from '@medcourse/db';
import { createLogger } from '@medcourse/logger';
import type { InputFile } from 'grammy';
import { processUpdate } from './process';
import type { Button, TelegramApi, Update } from './types';

/** Used by tests only. A Telegram that records what the bot says and lets a test answer back. */

export interface SentMessage {
  readonly messageId: number;
  readonly chatId: number;
  text: string;
  buttons: readonly (readonly Button[])[];
  readonly options: unknown;
}

export interface SentDocument {
  readonly chatId: number;
  readonly filename: string;
  readonly content: Uint8Array;
  readonly caption: string;
}

/** The username the fake Telegram reports for the bot, so tests can recognise invitation links. */
/** Where the harness pretends the staff panel is. */
export const PANEL_BASE_URL = 'https://panel.medcourse.test';
export const BOT_USERNAME = 'medcourse_test_bot';

/** Shared by every harness: two of them on one database must not hand out the same update id. */
let lastUpdateId = 100_000;

type FakeMethod = 'sendMessage' | 'editMessageText' | 'answerCallbackQuery' | 'sendDocument';

export class FakeTelegram implements TelegramApi {
  readonly sent: SentMessage[] = [];
  readonly edits: { chatId: number; messageId: number; text: string }[] = [];
  readonly answered: string[] = [];
  readonly documents: SentDocument[] = [];
  /** Makes the next call to the named method fail, once. */
  failNext: Partial<Record<FakeMethod, Error | undefined>> = {};
  #nextMessageId = 1000;

  #maybeFail(method: FakeMethod): void {
    const error = this.failNext[method];
    if (error !== undefined) {
      this.failNext[method] = undefined;
      throw error;
    }
  }

  sendMessage(
    chatId: number,
    text: string,
    other?: { reply_markup?: { inline_keyboard: { text: string; callback_data?: string }[][] } },
  ): Promise<unknown> {
    this.#maybeFail('sendMessage');
    this.#nextMessageId += 1;
    this.sent.push({
      messageId: this.#nextMessageId,
      chatId,
      text,
      buttons: toButtons(other),
      options: other ?? {},
    });
    return Promise.resolve({ message_id: this.#nextMessageId });
  }

  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    other?: { reply_markup?: { inline_keyboard: { text: string; callback_data?: string }[][] } },
  ): Promise<unknown> {
    this.#maybeFail('editMessageText');
    this.edits.push({ chatId, messageId, text });
    const message = this.sent.find(
      (entry) => entry.chatId === chatId && entry.messageId === messageId,
    );
    if (message !== undefined) {
      message.text = text;
      message.buttons = toButtons(other);
    }
    return Promise.resolve(true);
  }

  answerCallbackQuery(callbackQueryId: string): Promise<unknown> {
    this.#maybeFail('answerCallbackQuery');
    this.answered.push(callbackQueryId);
    return Promise.resolve(true);
  }

  async sendDocument(
    chatId: number,
    document: InputFile,
    other?: { caption?: string },
  ): Promise<unknown> {
    this.#maybeFail('sendDocument');
    const raw = await document.toRaw();
    if (!(raw instanceof Uint8Array)) {
      throw new TypeError('the fake Telegram takes a document held in memory');
    }
    this.documents.push({
      chatId,
      filename: document.filename ?? '',
      content: raw,
      caption: other?.caption ?? '',
    });
    return { message_id: (this.#nextMessageId += 1) };
  }

  documentsTo(chatId: number): SentDocument[] {
    return this.documents.filter((document) => document.chatId === chatId);
  }

  getMe(): Promise<{ username: string }> {
    return Promise.resolve({ username: BOT_USERNAME });
  }

  getUpdates(): Promise<Update[]> {
    return Promise.resolve([]);
  }

  setWebhook(): Promise<unknown> {
    return Promise.resolve(true);
  }

  deleteWebhook(): Promise<unknown> {
    return Promise.resolve(true);
  }

  /** What the person currently sees in a chat: the messages as last sent or edited. */
  messagesTo(chatId: number): SentMessage[] {
    return this.sent.filter((message) => message.chatId === chatId);
  }

  lastTo(chatId: number): SentMessage | undefined {
    return this.messagesTo(chatId).at(-1);
  }
}

function toButtons(
  other:
    | { reply_markup?: { inline_keyboard: { text: string; callback_data?: string }[][] } }
    | undefined,
): Button[][] {
  return (other?.reply_markup?.inline_keyboard ?? []).map((row) =>
    row.map((button) => ({ text: button.text, data: button.callback_data ?? '' })),
  );
}

export interface Harness {
  readonly telegram: FakeTelegram;
  /** The clock the bot sees. Move it to test expiry. */
  clock: Date;
  /** A person types something (or sends something other than text). */
  say(
    telegramUserId: number,
    text: string,
    options?: { chat?: 'private' | 'group'; isBot?: boolean },
  ): Promise<void>;
  /** A person presses the button with this data on the given message (default: the latest one). */
  press(telegramUserId: number, data: string, messageId?: number): Promise<void>;
  /** The button on the latest message whose label contains `label`. */
  buttonLabelled(telegramUserId: number, label: string): Button;
  /** Feeds a ready-made update, with a fixed id: for redelivery tests. */
  deliver(update: Update): Promise<void>;
  nextUpdateId(): number;
  sendNonText(telegramUserId: number): Promise<void>;
}

/** Wires the real handler, real repositories and a real database to a fake Telegram. */
export function createHarness(options: {
  orm: Executor;
  repositoryDeps: RepositoryDeps;
  telegram?: FakeTelegram;
  /** `null` for a server with no panel. Defaults to PANEL_BASE_URL. */
  panelBaseUrl?: string | null;
}): Harness {
  const telegram = options.telegram ?? new FakeTelegram();
  const logger = createLogger({ service: 'bot-test', level: 'silent' });
  let messageId = 1;
  const harness: Harness = {
    telegram,
    clock: new Date('2026-10-02T10:00:00Z'),
    nextUpdateId: () => (lastUpdateId += 1),

    async deliver(update) {
      await processUpdate(
        {
          orm: options.orm,
          repositoryDeps: options.repositoryDeps,
          api: telegram,
          logger,
          botUsername: BOT_USERNAME,
          panelBaseUrl: options.panelBaseUrl === undefined ? PANEL_BASE_URL : options.panelBaseUrl,
          now: () => harness.clock,
        },
        update,
      );
    },

    async say(telegramUserId, text, opts = {}) {
      messageId += 1;
      await harness.deliver({
        update_id: harness.nextUpdateId(),
        message: {
          message_id: messageId,
          date: 0,
          chat: { id: telegramUserId, type: opts.chat ?? 'private' },
          from: { id: telegramUserId, is_bot: opts.isBot ?? false, first_name: 'Test' },
          text,
        },
      } as unknown as Update);
    },

    async sendNonText(telegramUserId) {
      messageId += 1;
      await harness.deliver({
        update_id: harness.nextUpdateId(),
        message: {
          message_id: messageId,
          date: 0,
          chat: { id: telegramUserId, type: 'private' },
          from: { id: telegramUserId, is_bot: false, first_name: 'Test' },
          photo: [{ file_id: 'x', file_unique_id: 'y', width: 1, height: 1 }],
        },
      } as unknown as Update);
    },

    async press(telegramUserId, data, targetMessageId) {
      const target = targetMessageId ?? telegram.lastTo(telegramUserId)?.messageId ?? 0;
      await harness.deliver({
        update_id: harness.nextUpdateId(),
        callback_query: {
          id: `cb-${String(harness.nextUpdateId())}`,
          from: { id: telegramUserId, is_bot: false, first_name: 'Test' },
          chat_instance: 'instance',
          message: { message_id: target, date: 0, chat: { id: telegramUserId, type: 'private' } },
          data,
        },
      } as unknown as Update);
    },

    buttonLabelled(telegramUserId, label) {
      const found = telegram
        .lastTo(telegramUserId)
        ?.buttons.flat()
        .find((button) => button.text.includes(label));
      if (found === undefined) {
        const shown = telegram
          .lastTo(telegramUserId)
          ?.buttons.flat()
          .map((button) => button.text);
        throw new Error(
          `no button labelled "${label}"; the last message has ${JSON.stringify(shown)}`,
        );
      }
      return found;
    },
  };
  return harness;
}
