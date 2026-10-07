import {
  ForbiddenError,
  type Actor,
  type ClinicianApplication,
  type TechAdminRow,
  type VerificationStatus,
} from '@medcourse/db';
import { t, type MessageKey } from '@medcourse/i18n';
import { formatLocalDateTime } from '@medcourse/schedule';
import { encodeCallback, type AdminAction, type AdminPersonAction } from './callbacks';
import { Chat, clip, fullName, system } from './session';
import type { Button, Reply } from './types';

/** A list longer than this is cut, with a note: a message holds 4096 characters and a keyboard 100 buttons. */
const LIST_LIMIT = 20;
const BUTTON_NAME = 26;
/** An administrator's button carries the Telegram id too, which must not be cut off. */
const ADMIN_BUTTON_NAME = 44;
const MIN_REFERENCE = 3;
const MAX_REFERENCE = 200;
const TELEGRAM_ID = /^[1-9][0-9]{0,14}$/;
const FALLBACK_ZONE = 'Asia/Tashkent';

/**
 * The administrator's section, in the chat: who applied to be a doctor, confirming and withdrawing
 * doctors, the state of the service, open incidents, and who else is an administrator. Whether a
 * person may do any of it is decided by the database on every call (an administrator who is no
 * longer one gets nothing); `session.admin` only decides whether the menu offers the section.
 */
export class AdminFlow {
  readonly #chat: Chat;

  constructor(chat: Chat) {
    this.#chat = chat;
  }

  /** The person as the administrator the repositories check, or null for anyone else. */
  #actor(): Actor | null {
    const { user, admin } = this.#chat.s;
    return admin && user !== null ? { kind: 'TECH_ADMIN', userId: user.id } : null;
  }

  /** Runs what an administrator does; if the database says they are no longer one, says nothing. */
  async #guarded(action: (actor: Actor) => Promise<Reply[]>): Promise<Reply[]> {
    const actor = this.#actor();
    if (actor === null) {
      return [];
    }
    try {
      return await action(actor);
    } catch (error) {
      if (error instanceof ForbiddenError) {
        await this.#chat.clearSideConversation();
        return [];
      }
      throw error;
    }
  }

  #back(action: AdminAction | 'menu'): Button[] {
    const locale = this.#chat.locale();
    return action === 'menu'
      ? [this.#chat.back('admin')]
      : [this.#chat.button(locale, 'common.back', { kind: 'admin', action })];
  }

  #person(label: string, action: AdminPersonAction, userId: string, width = BUTTON_NAME): Button {
    return { text: clip(label, width), data: encodeButton(action, userId) };
  }

  // The section ---------------------------------------------------------------------------

  async section(): Promise<Reply[]> {
    return this.#guarded(async (actor) => {
      await this.#chat.clearSideConversation();
      const locale = this.#chat.locale();
      const waiting = await this.#chat.ctx.repos.clinicians.listByStatus(actor, 'PENDING');
      const row = (key: MessageKey, action: AdminAction, params = {}): Button[] => [
        this.#chat.button(locale, key, { kind: 'admin', action }, params),
      ];
      return [
        this.#chat.respond(t(locale, 'admin.title'), [
          row('admin.applicationsButton', 'applications', { n: waiting.length }),
          row('admin.doctorsButton', 'doctors'),
          row('admin.statsButton', 'stats'),
          row('admin.incidentsButton', 'incidents'),
          row('admin.adminsButton', 'admins'),
          [this.#chat.back('home')],
        ]),
      ];
    });
  }

  // Buttons -------------------------------------------------------------------------------

  async onAction(action: AdminAction): Promise<Reply[]> {
    switch (action) {
      case 'applications':
        return this.#doctorList('PENDING');
      case 'doctors':
        return this.#doctorList('VERIFIED');
      case 'stats':
        return this.#stats();
      case 'incidents':
        return this.#incidents();
      case 'admins':
        return this.#admins();
      case 'addAdmin':
        return this.#askAdminId();
      case 'cancel':
        return this.#cancel();
    }
  }

  async onPerson(action: AdminPersonAction, userId: string): Promise<Reply[]> {
    switch (action) {
      case 'open':
        return this.#card(userId);
      case 'verify':
        return this.#askReference(userId);
      case 'revokeAsk':
        return this.#revokeAsk(userId);
      case 'revoke':
        return this.#revoke(userId);
      case 'revokeAdminAsk':
        return this.#removeAdminAsk(userId);
      case 'revokeAdmin':
        return this.#removeAdmin(userId);
    }
  }

  // Doctors -------------------------------------------------------------------------------

  async #doctorList(status: 'PENDING' | 'VERIFIED'): Promise<Reply[]> {
    return this.#guarded(async (actor) => {
      await this.#chat.clearSideConversation();
      const locale = this.#chat.locale();
      const doctors = await this.#chat.ctx.repos.clinicians.listByStatus(actor, status);
      if (doctors.length === 0) {
        return [
          this.#chat.respond(
            t(locale, status === 'PENDING' ? 'admin.noApplications' : 'admin.noDoctors'),
            [this.#back('menu')],
          ),
        ];
      }
      const shown = doctors.slice(0, LIST_LIMIT);
      const title = t(
        locale,
        status === 'PENDING' ? 'admin.applicationsTitle' : 'admin.doctorsTitle',
        {
          n: doctors.length,
        },
      );
      return [
        this.#chat.respond(
          doctors.length > shown.length
            ? `${title}\n\n${t(locale, 'admin.listMore', { n: shown.length })}`
            : title,
          [
            ...shown.map((doctor) => [this.#person(fullName(doctor), 'open', doctor.userId)]),
            this.#back('menu'),
          ],
        ),
      ];
    });
  }

  /** One doctor, whatever state they are in. */
  #find(actor: Actor, userId: string): Promise<ClinicianApplication | null> {
    return this.#chat.ctx.repos.clinicians.getApplication(actor, userId);
  }

  #zone(): string {
    return this.#chat.s.user?.timezone ?? FALLBACK_ZONE;
  }

  async #card(userId: string): Promise<Reply[]> {
    return this.#guarded(async (actor) => {
      await this.#chat.clearSideConversation();
      const locale = this.#chat.locale();
      const doctor = await this.#find(actor, userId);
      if (doctor === null) {
        return [this.#chat.respond(t(locale, 'admin.noDoctor'), [this.#back('menu')])];
      }
      const lines = [
        t(locale, 'admin.card', {
          name: fullName(doctor),
          status: t(locale, `admin.status.${doctor.verificationStatus}`),
          telegramId: String(doctor.telegramUserId),
          date: formatLocalDateTime(doctor.appliedAt, this.#zone()),
        }),
        ...(doctor.note === null ? [] : [t(locale, 'admin.cardNote', { note: doctor.note })]),
        ...(doctor.verificationReference === null
          ? []
          : [t(locale, 'admin.cardChecked', { reference: doctor.verificationReference })]),
      ];
      const status: VerificationStatus = doctor.verificationStatus;
      // A withdrawn doctor is not "confirmed" but reinstated (D-130): the same question about
      // what was checked, under a label that says what is really happening.
      const decision: Button[] =
        status === 'VERIFIED'
          ? [this.#personButton('admin.revokeButton', 'revokeAsk', userId)]
          : status === 'REVOKED'
            ? [this.#personButton('admin.reinstateButton', 'verify', userId)]
            : [this.#personButton('admin.verifyButton', 'verify', userId)];
      return [
        this.#chat.respond(lines.join('\n'), [
          decision,
          this.#back(status === 'VERIFIED' ? 'doctors' : 'applications'),
        ]),
      ];
    });
  }

  #personButton(key: MessageKey, action: AdminPersonAction, userId: string): Button {
    return {
      text: t(this.#chat.locale(), key),
      data: encodeButton(action, userId),
    };
  }

  async #askReference(userId: string): Promise<Reply[]> {
    return this.#guarded(async (actor) => {
      const locale = this.#chat.locale();
      const doctor = await this.#find(actor, userId);
      if (doctor === null) {
        return [this.#chat.respond(t(locale, 'admin.noDoctor'), [this.#back('menu')])];
      }
      if (doctor.verificationStatus === 'VERIFIED') {
        return [
          this.#chat.respond(t(locale, 'admin.alreadyVerified', { name: fullName(doctor) }), [
            this.#back('doctors'),
          ]),
        ];
      }
      await this.#chat.remember('ADMIN', 'REFERENCE', { clinicianId: userId });
      return [
        this.#chat.respond(t(locale, 'admin.askReference', { name: fullName(doctor) }), [
          [this.#chat.button(locale, 'admin.cancelButton', { kind: 'admin', action: 'cancel' })],
        ]),
      ];
    });
  }

  async #revokeAsk(userId: string): Promise<Reply[]> {
    return this.#guarded(async (actor) => {
      const locale = this.#chat.locale();
      const doctor = await this.#find(actor, userId);
      if (doctor === null) {
        return [this.#chat.respond(t(locale, 'admin.noDoctor'), [this.#back('menu')])];
      }
      return [
        this.#chat.respond(t(locale, 'admin.revokeAsk', { name: fullName(doctor) }), [
          [this.#personButton('admin.revokeYesButton', 'revoke', userId)],
          [this.#chat.button(locale, 'admin.cancelButton', { kind: 'admin', action: 'cancel' })],
        ]),
      ];
    });
  }

  async #revoke(userId: string): Promise<Reply[]> {
    return this.#guarded(async (actor) => {
      const locale = this.#chat.locale();
      const outcome = await this.#chat.ctx.repos.clinicians.revoke(actor, { clinicianId: userId });
      if (outcome === null) {
        return [this.#chat.respond(t(locale, 'admin.noDoctor'), [this.#back('menu')])];
      }
      const name = fullName(outcome.clinician);
      return [
        this.#chat.respond(
          t(locale, outcome.changed ? 'admin.revoked' : 'admin.alreadyRevoked', { name }),
          [this.#back('menu')],
        ),
      ];
    });
  }

  // Typed answers -------------------------------------------------------------------------

  /** What an administrator typed, if they were asked for something; null when they were not. */
  async onText(text: string): Promise<Reply[] | null> {
    const talk = this.#chat.s.talk;
    if (talk?.flow !== 'ADMIN') {
      return null;
    }
    if (this.#actor() === null) {
      await this.#chat.clear();
      return null;
    }
    switch (talk.step) {
      case 'REFERENCE':
        return this.#acceptReference(text, talk.data.clinicianId);
      case 'ADMIN_ID':
        return this.#acceptAdminId(text);
      default:
        // An exchange this version does not know: drop it instead of treating text as its answer.
        await this.#chat.clear();
        return null;
    }
  }

  async #acceptReference(text: string, clinicianId: unknown): Promise<Reply[]> {
    return this.#guarded(async (actor) => {
      const locale = this.#chat.locale();
      const reference = clip(text.trim(), MAX_REFERENCE);
      if (Array.from(reference).length < MIN_REFERENCE) {
        return [
          this.#chat.send(t(locale, 'admin.referenceShort'), [
            [this.#chat.button(locale, 'admin.cancelButton', { kind: 'admin', action: 'cancel' })],
          ]),
        ];
      }
      await this.#chat.clear();
      if (typeof clinicianId !== 'string') {
        return [this.#chat.send(t(locale, 'admin.noMore'), [this.#back('menu')])];
      }
      const outcome = await this.#chat.ctx.repos.clinicians.verify(actor, {
        clinicianId,
        reference,
      });
      if (outcome === null) {
        return [this.#chat.send(t(locale, 'admin.noDoctor'), [this.#back('menu')])];
      }
      const name = fullName(outcome.clinician);
      if (!outcome.changed) {
        return [
          this.#chat.send(t(locale, 'admin.alreadyVerified', { name }), [this.#back('menu')]),
        ];
      }
      return [
        // The doctor is told in their own chat and language, as the command line does.
        this.#chat.sendTo(outcome.telegramUserId, t(outcome.locale, 'doctor.verified')),
        this.#chat.send(t(locale, 'admin.verified', { name }), [this.#back('menu')]),
      ];
    });
  }

  // Administrators ------------------------------------------------------------------------

  #adminName(row: Pick<TechAdminRow, 'firstName' | 'lastName'>): string {
    return row.firstName === null || row.lastName === null
      ? t(this.#chat.locale(), 'admin.noName')
      : fullName({ firstName: row.firstName, lastName: row.lastName });
  }

  async #admins(): Promise<Reply[]> {
    return this.#guarded(async (actor) => {
      await this.#chat.clearSideConversation();
      const locale = this.#chat.locale();
      const admins = await this.#chat.ctx.repos.platform.listTechAdmins(actor);
      // Oneself is counted but not offered: one's own rights are taken away by somebody else.
      const others = admins.filter((row) => row.userId !== this.#chat.s.user?.id);
      const shown = others.slice(0, LIST_LIMIT);
      const title = t(locale, 'admin.adminsTitle', { n: admins.length });
      return [
        this.#chat.respond(
          others.length > shown.length
            ? `${title}\n\n${t(locale, 'admin.listMore', { n: shown.length })}`
            : title,
          [
            ...shown.map((row) => [
              this.#person(
                t(locale, 'admin.adminLine', {
                  name: this.#adminName(row),
                  telegramId: String(row.telegramUserId),
                }),
                'revokeAdminAsk',
                row.userId,
                ADMIN_BUTTON_NAME,
              ),
            ]),
            [
              this.#chat.button(locale, 'admin.addAdminButton', {
                kind: 'admin',
                action: 'addAdmin',
              }),
            ],
            this.#back('menu'),
          ],
        ),
      ];
    });
  }

  async #askAdminId(): Promise<Reply[]> {
    return this.#guarded(async () => {
      const locale = this.#chat.locale();
      await this.#chat.remember('ADMIN', 'ADMIN_ID', {});
      return [
        this.#chat.respond(t(locale, 'admin.askAdminId'), [
          [this.#chat.button(locale, 'admin.cancelButton', { kind: 'admin', action: 'cancel' })],
        ]),
      ];
    });
  }

  async #acceptAdminId(text: string): Promise<Reply[]> {
    return this.#guarded(async (actor) => {
      const locale = this.#chat.locale();
      const cancel = [
        [this.#chat.button(locale, 'admin.cancelButton', { kind: 'admin', action: 'cancel' })],
      ];
      const typed = text.trim();
      if (!TELEGRAM_ID.test(typed)) {
        return [this.#chat.send(t(locale, 'admin.badId'), cancel)];
      }
      const { repos } = this.#chat.ctx;
      const account = await repos.users.findByTelegramId(system, Number(typed));
      if (account?.status !== 'ACTIVE') {
        return [this.#chat.send(t(locale, 'admin.noAccount'), cancel)];
      }
      const granted = await repos.platform.grantTechAdmin(actor, account.id);
      if (granted === 'NO_ACCOUNT') {
        return [this.#chat.send(t(locale, 'admin.noAccount'), cancel)];
      }
      await this.#chat.clear();
      const row = (await repos.platform.listTechAdmins(actor)).find(
        (candidate) => candidate.userId === account.id,
      );
      const name = row === undefined ? typed : this.#adminName(row);
      if (granted === 'ALREADY') {
        return [this.#chat.send(t(locale, 'admin.adminAlready', { name }), [this.#back('menu')])];
      }
      return [
        this.#chat.sendTo(account.telegramUserId, t(account.locale, 'admin.youAreAdmin')),
        this.#chat.send(t(locale, 'admin.adminAdded', { name }), [this.#back('menu')]),
      ];
    });
  }

  async #removeAdminAsk(userId: string): Promise<Reply[]> {
    return this.#guarded(async (actor) => {
      const locale = this.#chat.locale();
      const row = (await this.#chat.ctx.repos.platform.listTechAdmins(actor)).find(
        (candidate) => candidate.userId === userId,
      );
      if (row === undefined) {
        return [this.#chat.respond(t(locale, 'admin.notAdmin'), [this.#back('admins')])];
      }
      return [
        this.#chat.respond(t(locale, 'admin.removeAdminAsk', { name: this.#adminName(row) }), [
          [this.#personButton('admin.removeAdminYesButton', 'revokeAdmin', userId)],
          [this.#chat.button(locale, 'admin.cancelButton', { kind: 'admin', action: 'cancel' })],
        ]),
      ];
    });
  }

  async #removeAdmin(userId: string): Promise<Reply[]> {
    return this.#guarded(async (actor) => {
      const locale = this.#chat.locale();
      const { repos } = this.#chat.ctx;
      const row = (await repos.platform.listTechAdmins(actor)).find(
        (candidate) => candidate.userId === userId,
      );
      const result = await repos.platform.revokeTechAdmin(actor, userId);
      const text = {
        REVOKED: t(locale, 'admin.adminRemoved', {
          name: row === undefined ? '' : this.#adminName(row),
        }),
        NOT_ADMIN: t(locale, 'admin.notAdmin'),
        SELF: t(locale, 'admin.removeSelf'),
        LAST: t(locale, 'admin.removeLast'),
      }[result];
      const replies: Reply[] = [this.#chat.respond(text, [this.#back('admins')])];
      if (result === 'REVOKED' && row !== undefined) {
        replies.unshift(this.#chat.sendTo(row.telegramUserId, t(row.locale, 'admin.youRemoved')));
      }
      return replies;
    });
  }

  // The service --------------------------------------------------------------------------

  async #stats(): Promise<Reply[]> {
    return this.#guarded(async (actor) => {
      await this.#chat.clearSideConversation();
      const locale = this.#chat.locale();
      const { repos, now } = this.#chat.ctx;
      const stats = await repos.panel.techStats(actor, now);
      const open = await repos.incidents.list(actor, 'OPEN');
      const lines = [
        t(locale, 'admin.statsTitle'),
        '',
        t(locale, 'admin.statsQueue', {
          title: t(locale, 'pn.tech.reminders'),
          overdue: stats.reminders.overdue,
          stuck: stats.reminders.stuck,
        }),
        t(locale, 'admin.statsQueue', {
          title: t(locale, 'pn.tech.alerts'),
          overdue: stats.alerts.overdue,
          stuck: stats.alerts.stuck,
        }),
        t(locale, 'admin.statsSent', { sent: stats.reminders.sentInDay }),
        t(locale, 'admin.statsUnswept', { n: stats.unsweptDoses }),
        t(locale, 'admin.statsPeople', {
          users: stats.users,
          verified: stats.doctors.VERIFIED ?? 0,
          pending: stats.doctors.PENDING ?? 0,
        }),
        t(locale, 'admin.statsOpenIncidents', { n: open.length }),
      ];
      return [this.#chat.respond(lines.join('\n'), [this.#back('menu')])];
    });
  }

  async #incidents(): Promise<Reply[]> {
    return this.#guarded(async (actor) => {
      await this.#chat.clearSideConversation();
      const locale = this.#chat.locale();
      const open = await this.#chat.ctx.repos.incidents.list(actor, 'OPEN');
      if (open.length === 0) {
        return [this.#chat.respond(t(locale, 'admin.noIncidents'), [this.#back('menu')])];
      }
      const lines = open.slice(0, LIST_LIMIT).map((incident) =>
        t(locale, 'admin.incidentLine', {
          type: t(locale, `pn.inc.type.${incident.type}`),
          date: formatLocalDateTime(incident.openedAt, this.#zone()),
        }),
      );
      return [
        this.#chat.respond(
          [
            t(locale, 'admin.incidentsTitle', { n: open.length }),
            ...lines,
            ...(open.length > lines.length
              ? [t(locale, 'admin.listMore', { n: lines.length })]
              : []),
          ].join('\n'),
          [this.#back('menu')],
        ),
      ];
    });
  }

  async #cancel(): Promise<Reply[]> {
    return this.#guarded(async () => {
      await this.#chat.clear();
      return [this.#chat.respond(t(this.#chat.locale(), 'admin.cancelled'), [this.#back('menu')])];
    });
  }
}

function encodeButton(action: AdminPersonAction, userId: string): string {
  return encodeCallback({ kind: 'adminPerson', action, userId });
}
