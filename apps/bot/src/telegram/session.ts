import {
  systemActor,
  type Actor,
  type ClinicianSummary,
  type ConversationFlow,
  type PrivacyStanding,
  type Repositories,
  type UserRow,
} from '@medcourse/db';
import { DEFAULT_LOCALE, t, type Locale, type MessageKey, type Params } from '@medcourse/i18n';
import { encodeCallback, type Callback, type MenuTarget } from './callbacks';
import type { Button, Reply } from './types';

/** How long an unfinished conversation is remembered; every step renews it. */
export const CONVERSATION_TTL_MS = 24 * 3_600_000;

export const system = systemActor('telegram');
export const asPatient = (userId: string): Actor => ({ kind: 'PATIENT', userId });
export const asClinician = (userId: string): Actor => ({ kind: 'CLINICIAN', userId });

export interface HandlerContext {
  /** Bound to the transaction this update is handled in. */
  readonly repos: Repositories;
  readonly now: Date;
  /** The bot's own username: invitation links are built from it. */
  readonly botUsername: string;
  /** Where the staff panel lives, for sign-in links; null when none is deployed. */
  readonly panelBaseUrl: string | null;
}

/** What an update is, once the parts we do not handle are gone. */
export interface Incoming {
  readonly telegramUserId: number;
  readonly chatId: number;
  readonly kind: 'text' | 'callback' | 'other';
  readonly text?: string;
  readonly callback?: { readonly id: string; readonly data: string };
  /** The message a pressed button belongs to, so it can be edited in place. */
  readonly messageId?: number;
  /**
   * Names this very message or button press. An answer recorded under it is recorded once, even
   * if the same update were somehow handled again.
   */
  readonly key: string;
}

export type OnboardingStep =
  'LANGUAGE' | 'CONSENT' | 'DECLINED' | 'FIRST_NAME' | 'LAST_NAME' | 'TIMEZONE';

export const ONBOARDING_STEPS: readonly string[] = [
  'LANGUAGE',
  'CONSENT',
  'DECLINED',
  'FIRST_NAME',
  'LAST_NAME',
  'TIMEZONE',
];

/** Where a person is in a multi-step exchange. Loose JSON: read each field defensively. */
export interface Talk {
  readonly flow: ConversationFlow;
  readonly step: string;
  readonly data: Readonly<Record<string, unknown>>;
}

export interface Session {
  readonly incoming: Incoming;
  readonly user: UserRow | null;
  /** The person's name if they have finished onboarding. */
  readonly profile: { readonly firstName: string; readonly lastName: string } | null;
  /** The person's doctor profile, if they ever applied (whatever its state). */
  readonly clinician: ClinicianSummary | null;
  /** Whether a patient has allowed this person to watch over their course. */
  readonly watching: boolean;
  /** The onboarding conversation, if that is what they are in the middle of. */
  readonly conversation: {
    readonly step: OnboardingStep;
    readonly data: Record<string, unknown>;
  } | null;
  /** Whatever conversation they are in, of any kind. */
  readonly talk: Talk | null;
  /** Their language, once known: the account's, or the one chosen mid-onboarding. */
  readonly locale: Locale | null;
  /** Where a registered person stands on consent and deletion; null before registration. */
  readonly standing: PrivacyStanding | null;
}

/** A conversation's data is loose JSON; a value is only ever used if it is really a string. */
export function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function fullName(person: {
  readonly firstName: string;
  readonly lastName: string;
}): string {
  return `${person.firstName} ${person.lastName}`;
}

/** Cut to at most `max` characters (not UTF-16 units), marking the cut. */
export function clip(text: string, max: number): string {
  const characters = Array.from(text);
  return characters.length <= max ? text : `${characters.slice(0, max - 1).join('')}…`;
}

/**
 * Everything a flow needs to talk to one person in one chat: building replies in their
 * language and remembering where they are. Holds no rules of its own.
 */
export class Chat {
  readonly ctx: HandlerContext;
  readonly s: Session;

  constructor(context: HandlerContext, session: Session) {
    this.ctx = context;
    this.s = session;
  }

  /** The person's language; Russian only if nothing is known yet (never for a registered person). */
  locale(): Locale {
    return this.s.locale ?? DEFAULT_LOCALE;
  }

  /** A fixed text in the person's language, or in both if their language is not known yet. */
  say(key: MessageKey, params: Params = {}): string {
    const locale = this.s.locale;
    return locale === null
      ? `${t('ru', key, params)}\n\n———\n\n${t('uz', key, params)}`
      : t(locale, key, params);
  }

  send(text: string, buttons?: readonly (readonly Button[])[]): Reply {
    return this.sendTo(this.s.incoming.chatId, text, buttons);
  }

  /** To somebody else's chat: a private chat has the same id as the person. */
  sendTo(chatId: number, text: string, buttons?: readonly (readonly Button[])[]): Reply {
    return buttons === undefined
      ? { kind: 'send', chatId, text }
      : { kind: 'send', chatId, text, buttons };
  }

  /** Edits the message the pressed button was on; sends a new one if it cannot be identified. */
  edit(text: string, buttons?: readonly (readonly Button[])[]): Reply {
    const { chatId, messageId } = this.s.incoming;
    if (messageId === undefined || messageId === 0) {
      return this.send(text, buttons);
    }
    return buttons === undefined
      ? { kind: 'edit', chatId, messageId, text }
      : { kind: 'edit', chatId, messageId, text, buttons };
  }

  /** Answers a button press by editing its message, and a typed message by sending a new one. */
  respond(text: string, buttons?: readonly (readonly Button[])[]): Reply {
    return this.s.incoming.kind === 'callback'
      ? this.edit(text, buttons)
      : this.send(text, buttons);
  }

  button(locale: Locale, key: MessageKey, callback: Callback, params: Params = {}): Button {
    return { text: t(locale, key, params), data: encodeCallback(callback) };
  }

  back(target: MenuTarget): Button {
    return this.button(this.locale(), 'common.back', { kind: 'menu', target });
  }

  async remember(
    flow: ConversationFlow,
    step: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.ctx.repos.telegram.setConversation(
      this.s.incoming.telegramUserId,
      { flow, step, data },
      this.ctx.now,
      CONVERSATION_TTL_MS,
    );
  }

  async clear(): Promise<void> {
    await this.ctx.repos.telegram.clearConversation(this.s.incoming.telegramUserId);
  }

  /**
   * Forgets a half-finished doctor or invitation exchange, so that the next thing typed is not
   * mistaken for its answer. Onboarding is left alone: its steps are what a new person needs.
   */
  async clearSideConversation(): Promise<void> {
    if (this.s.talk !== null && this.s.talk.flow !== 'ONBOARDING') {
      await this.clear();
    }
  }
}
