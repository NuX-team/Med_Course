import type { PrnItem } from '@medcourse/db';
import { t, type Locale } from '@medcourse/i18n';
import { formatLocalDateTime, formatLocalTime } from '@medcourse/schedule';
import { doseText, intervalText } from './card';
import { Chat, asPatient, clip } from './session';
import type { Button, Reply } from './types';

/** One as-needed drug as a line of "today": what the doctor allowed and what has been marked. */
export function prnLine(locale: Locale, item: PrnItem): string {
  return t(locale, 'prn.line', {
    name: item.displayName,
    dose: doseText(locale, item),
    count: item.takenInDay,
    max: item.maxDailyDoses,
  });
}

/**
 * As-needed (PRN) intake as the patient meets it (TZ §7.6, D-12). Two taps: the first shows what
 * the doctor prescribed and what has been marked in the last day, and says so plainly if one
 * more would go beyond it; the second records the fact. The bot never says when to take the
 * drug: it repeats the doctor's limits and records what the patient reports.
 */
export class PrnFlow {
  readonly #chat: Chat;

  constructor(chat: Chat) {
    this.#chat = chat;
  }

  #patient(): { userId: string } | null {
    const { user, profile } = this.#chat.s;
    return user !== null && profile !== null ? { userId: user.id } : null;
  }

  #toToday(): Button[] {
    const locale = this.#chat.locale();
    return [this.#chat.button(locale, 'menu.today', { kind: 'menu', target: 'today' })];
  }

  #undoButton(item: PrnItem): Button[][] {
    return item.undoable === null
      ? []
      : [
          [
            this.#chat.button(this.#chat.locale(), 'prn.undo', {
              kind: 'prnUndo',
              eventId: item.undoable.eventId,
            }),
          ],
        ];
  }

  #gone(): Reply[] {
    return [this.#chat.respond(t(this.#chat.locale(), 'prn.notAvailable'), [this.#toToday()])];
  }

  /** Buttons for "today": one per as-needed drug that can be marked now. */
  buttons(items: readonly PrnItem[]): Button[][] {
    const locale = this.#chat.locale();
    return items.map((item) => [
      this.#chat.button(
        locale,
        'prn.button',
        { kind: 'prn', action: 'ask', medicationId: item.medicationId },
        { name: clip(item.displayName, 24) },
      ),
    ]);
  }

  /** First tap: the doctor's limits, what has been marked, and the question. Nothing changes. */
  async ask(medicationId: string): Promise<Reply[]> {
    const patient = this.#patient();
    if (patient === null) {
      return [];
    }
    await this.#chat.clearSideConversation();
    const locale = this.#chat.locale();
    const { repos, now } = this.#chat.ctx;
    const item = await repos.prn.get(asPatient(patient.userId), medicationId, now);
    if (item === null) {
      return this.#gone();
    }
    const lines = [
      t(locale, 'prn.ask', {
        name: item.displayName,
        dose: doseText(locale, item),
        max: item.maxDailyDoses,
        interval: intervalText(locale, item.minimumIntervalMinutes),
        count: item.takenInDay,
      }),
    ];
    if (item.lastTakenAt !== null) {
      lines.push(
        t(locale, 'prn.lastAt', { time: formatLocalDateTime(item.lastTakenAt, item.timezone) }),
      );
    }
    if (item.excess !== null) {
      const from = formatLocalDateTime(item.withinLimitsFrom, item.timezone);
      lines.push(
        '',
        t(locale, item.excess === 'DAILY_LIMIT' ? 'prn.warnLimit' : 'prn.warnInterval', {
          time: from,
        }),
        t(locale, 'prn.warnTail'),
      );
    }
    return [
      this.#chat.edit(lines.join('\n'), [
        [
          this.#chat.button(locale, 'prn.confirm', {
            kind: 'prn',
            action: 'confirm',
            medicationId,
          }),
        ],
        ...this.#undoButton(item),
        this.#toToday(),
      ]),
    ];
  }

  /** Second tap: the intake is recorded, within the limits or beyond them. */
  async confirm(medicationId: string): Promise<Reply[]> {
    const patient = this.#patient();
    if (patient === null) {
      return [];
    }
    await this.#chat.clearSideConversation();
    const locale = this.#chat.locale();
    const { repos, now } = this.#chat.ctx;
    const result = await repos.prn.take(asPatient(patient.userId), {
      medicationId,
      now,
      key: this.#chat.s.incoming.key,
    });
    if (result.status === 'NOT_AVAILABLE') {
      return this.#gone();
    }
    const { item } = result;
    const facts = {
      name: item.displayName,
      time: formatLocalTime(item.lastTakenAt ?? now, item.timezone),
    };
    const text =
      result.status === 'ALREADY'
        ? t(locale, 'prn.already', facts)
        : t(locale, result.over === null ? 'prn.done' : 'prn.doneOver', facts);
    return [this.#chat.edit(text, [...this.#undoButton(item), this.#toToday()])];
  }

  /** The patient takes one mark back. */
  async undo(eventId: string): Promise<Reply[]> {
    const patient = this.#patient();
    if (patient === null) {
      return [];
    }
    await this.#chat.clearSideConversation();
    const locale = this.#chat.locale();
    const { repos, now } = this.#chat.ctx;
    const result = await repos.prn.undo(asPatient(patient.userId), { eventId, now });
    switch (result.status) {
      case 'NOT_AVAILABLE':
        return this.#gone();
      case 'UNDONE':
        return [
          this.#chat.edit(t(locale, 'prn.undone', { name: result.item.displayName }), [
            this.#toToday(),
          ]),
        ];
      case 'ALREADY':
        return [this.#chat.edit(t(locale, 'prn.undoneAlready'), [this.#toToday()])];
      case 'NOT_CORRECTABLE':
        return [this.#chat.edit(t(locale, 'prn.notCorrectable'), [this.#toToday()])];
    }
  }
}
