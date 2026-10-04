import type { InputFile } from 'grammy';
import type { InlineKeyboardMarkup, Update } from 'grammy/types';

export type { Update } from 'grammy/types';

/**
 * The slice of the Telegram Bot API this bot uses. grammY's `Api` satisfies it, and tests
 * supply a recorder, so nothing above this line needs a network.
 */
export interface TelegramApi {
  sendMessage(
    chatId: number,
    text: string,
    other?: { reply_markup?: InlineKeyboardMarkup },
  ): Promise<unknown>;
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    other?: { reply_markup?: InlineKeyboardMarkup },
  ): Promise<unknown>;
  answerCallbackQuery(callbackQueryId: string): Promise<unknown>;
  /** A file into a chat. Used for reports, which go to the person who asked and nowhere else. */
  sendDocument(chatId: number, document: InputFile, other?: { caption?: string }): Promise<unknown>;
  /** Who the bot is: its username builds the invitation links. */
  getMe(): Promise<{ readonly username?: string }>;
  getUpdates(other?: {
    offset?: number;
    timeout?: number;
    allowed_updates?: readonly string[];
  }): Promise<Update[]>;
  setWebhook(
    url: string,
    other?: { secret_token?: string; allowed_updates?: readonly string[] },
  ): Promise<unknown>;
  deleteWebhook(other?: { drop_pending_updates?: boolean }): Promise<unknown>;
}

/** What the bot asks Telegram to send us. Everything else (edited messages, polls, ...) is noise. */
export const ALLOWED_UPDATES = ['message', 'callback_query'] as const;

export interface Button {
  readonly text: string;
  /** At most 64 bytes: Telegram's limit on callback data. */
  readonly data: string;
}

/** What the handler wants said. Delivery happens after the database work has committed. */
export type Reply =
  | {
      readonly kind: 'send';
      readonly chatId: number;
      readonly text: string;
      readonly buttons?: readonly (readonly Button[])[];
    }
  | {
      readonly kind: 'edit';
      readonly chatId: number;
      readonly messageId: number;
      readonly text: string;
      readonly buttons?: readonly (readonly Button[])[];
    }
  | { readonly kind: 'answer'; readonly callbackQueryId: string }
  /** A file built for the person who asked. `fallback` is said instead if it cannot be sent. */
  | {
      readonly kind: 'document';
      readonly chatId: number;
      readonly filename: string;
      readonly content: Uint8Array;
      readonly caption: string;
      readonly fallback: string;
    };
