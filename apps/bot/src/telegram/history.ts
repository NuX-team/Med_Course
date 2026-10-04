import type { CourseReport, HistoryEntry, HistoryPage } from '@medcourse/db';
import { t, type Locale } from '@medcourse/i18n';
import { renderReport } from '@medcourse/report';
import {
  formatLocalDate,
  formatLocalDateTime,
  formatLocalTime,
  type Adherence,
} from '@medcourse/schedule';
import type { ExportFileFormat, HistoryAudience } from './callbacks';
import { doseText, joinBlocks } from './card';
import { standing } from './doctor';
import { Chat, asClinician, asPatient, fullName } from './session';
import type { Button, Reply } from './types';

/** A percentage as people here write it: "33,3", not "33.3". */
export function percentText(percent: number): string {
  return String(percent).replace('.', ',');
}

/** "Taken on time: 3 of 4 (75%)", or the plain statement that nothing has come due yet. */
export function figureText(locale: Locale, adherence: Adherence): string {
  return adherence.percent === null
    ? t(locale, 'history.noFigure')
    : t(locale, 'history.figure', {
        taken: adherence.taken,
        occurred: adherence.occurred,
        percent: percentText(adherence.percent),
      });
}

/**
 * The summary of a course as text (TZ §14.3). The formula is printed with the figure every
 * time, and the figure is called what it is: how the schedule was followed, not how the
 * treatment worked.
 */
export function reportText(
  locale: Locale,
  report: CourseReport,
  audience: HistoryAudience,
): string[] {
  const { plan, adherence } = report;
  const { course } = plan;
  const head = [
    t(locale, 'report.title'),
    audience === 'doctor'
      ? t(locale, 'card.patient', { name: fullName(plan.patient) })
      : t(locale, 'card.doctor', { name: fullName(plan.clinician) }),
    t(locale, 'card.status', { status: t(locale, `status.${course.status}`) }),
  ];
  const figures = [
    t(locale, 'report.due', { occurred: adherence.occurred }),
    t(locale, 'report.taken', { count: adherence.taken }),
    t(locale, 'report.takenLate', { count: adherence.takenLate }),
    t(locale, 'report.skipped', { count: adherence.skipped }),
    t(locale, 'report.missed', { count: adherence.missed }),
    adherence.percent === null
      ? t(locale, 'report.noPercent')
      : t(locale, 'report.percent', { percent: percentText(adherence.percent) }),
  ];
  const blocks = [head.join('\n'), figures.join('\n')];

  if (report.byMedication.length > 1) {
    blocks.push(
      [
        t(locale, 'report.byMedication'),
        ...report.byMedication.map((line) =>
          line.adherence.percent === null
            ? t(locale, 'report.medLineEmpty', { name: line.displayName })
            : t(locale, 'report.medLine', {
                name: line.displayName,
                taken: line.adherence.taken,
                occurred: line.adherence.occurred,
                percent: percentText(line.adherence.percent),
              }),
        ),
      ].join('\n'),
    );
  }
  if (adherence.skipped > 0) {
    const reasons = [
      t(locale, 'report.reasons', {
        forgot: report.skipReasons.FORGOT,
        none: report.skipReasons.NO_MEDICATION,
        other: report.skipReasons.OTHER,
      }),
    ];
    if (report.otherReasons.length > 0) {
      reasons.push(
        t(locale, 'report.otherReasons'),
        ...report.otherReasons.map(
          (reason) =>
            `${formatLocalDateTime(reason.at, course.timezone)} — ${reason.displayName}: ${reason.text}`,
        ),
      );
    }
    blocks.push(reasons.join('\n'));
  }
  if (report.prn.length > 0) {
    blocks.push(
      report.prn
        .map((drug) => t(locale, 'report.prn', { name: drug.displayName, count: drug.count }))
        .join('\n'),
    );
  }
  blocks.push(t(locale, 'report.formula'));
  return joinBlocks(blocks);
}

function entryLine(
  locale: Locale,
  entry: HistoryEntry,
  zone: string,
  audience: HistoryAudience,
): string {
  const what = `${formatLocalTime(entry.at, zone)} — ${entry.displayName}, ${doseText(locale, entry)}`;
  if (entry.status === null) {
    return `${what} · ${t(locale, 'history.prnEntry')}`;
  }
  if (entry.status !== 'SKIPPED') {
    return `${what} · ${t(locale, `dose.${entry.status}`)}`;
  }
  // "Skipped by you" is the patient's wording; the doctor reads who skipped it.
  const label =
    audience === 'doctor' ? t(locale, 'history.skippedByPatient') : t(locale, 'dose.SKIPPED');
  return entry.skipReason === null
    ? `${what} · ${label}`
    : `${what} · ${label} (${t(locale, `dose.reason.${entry.skipReason}`)})`;
}

/** A page of a course's history as text: newest day first, a block per day. */
export function daysText(locale: Locale, page: HistoryPage, audience: HistoryAudience): string[] {
  const zone = page.plan.course.timezone;
  if (page.days.length === 0) {
    return [t(locale, 'history.empty')];
  }
  return joinBlocks([
    ...page.days.map((day) =>
      [
        formatLocalDate(day.date),
        ...day.entries.map((entry) => entryLine(locale, entry, zone, audience)),
      ].join('\n'),
    ),
    t(locale, 'history.page', { page: page.page, pages: page.pages }),
  ]);
}

/**
 * History and figures (TZ §6.1, §14.3): the patient's own courses with how each was followed,
 * and, for the doctor, the same summary and day-by-day record of a patient's course. Nothing
 * here changes anything; the repositories decide who may read what.
 */
export class HistoryFlow {
  readonly #chat: Chat;

  constructor(chat: Chat) {
    this.#chat = chat;
  }

  /** Who is reading, as the repositories know them. Null if this person may not read as that. */
  #reader(audience: HistoryAudience) {
    const { user, profile, clinician } = this.#chat.s;
    if (user === null || profile === null) {
      return null;
    }
    if (audience === 'patient') {
      return asPatient(user.id);
    }
    return standing(clinician) === 'GOOD' ? asClinician(user.id) : null;
  }

  #back(audience: HistoryAudience, courseId: string): Button {
    const locale = this.#chat.locale();
    return audience === 'patient'
      ? this.#chat.button(locale, 'common.back', { kind: 'menu', target: 'history' })
      : this.#chat.button(locale, 'common.back', { kind: 'course', action: 'open', courseId });
  }

  #gone(audience: HistoryAudience): Reply[] {
    const locale = this.#chat.locale();
    return [
      this.#chat.respond(t(locale, 'history.notAvailable'), [
        [
          this.#chat.button(locale, 'common.back', {
            kind: 'menu',
            target: audience === 'patient' ? 'history' : 'doctor',
          }),
        ],
      ]),
    ];
  }

  #show(chunks: readonly string[], buttons: Button[][]): Reply[] {
    if (chunks.length <= 1) {
      return [this.#chat.respond(chunks[0] ?? '', buttons)];
    }
    return chunks.map((chunk, index) =>
      index === chunks.length - 1 ? this.#chat.send(chunk, buttons) : this.#chat.send(chunk),
    );
  }

  /** "History": the patient's courses that have a past, each with its figure. */
  async list(): Promise<Reply[]> {
    const reader = this.#reader('patient');
    if (reader === null) {
      return [];
    }
    const locale = this.#chat.locale();
    const home: Button[][] = [[this.#chat.back('home')]];
    const courses = await this.#chat.ctx.repos.history.courses(reader);
    if (courses.length === 0) {
      return [this.#chat.edit(t(locale, 'history.none'), home)];
    }
    const blocks = [
      t(locale, 'history.title'),
      ...courses.map(({ plan, adherence }, index) => {
        const status = t(locale, `status.${plan.course.status}`);
        const started = plan.course.effectiveStartDate;
        return [
          started === null
            ? t(locale, 'history.courseNotStarted', { n: index + 1, status })
            : t(locale, 'history.course', { n: index + 1, status, date: formatLocalDate(started) }),
          t(locale, 'card.doctor', { name: fullName(plan.clinician) }),
          ...(started === null ? [] : [figureText(locale, adherence)]),
        ].join('\n');
      }),
    ];
    return this.#show(joinBlocks(blocks), [
      ...courses.flatMap(({ plan }, index) =>
        plan.course.effectiveStartDate === null
          ? []
          : [
              [
                this.#chat.button(
                  locale,
                  'history.open',
                  { kind: 'history', audience: 'patient', courseId: plan.course.id },
                  { n: index + 1 },
                ),
              ],
            ],
      ),
      ...home,
    ]);
  }

  /** The summary of one course. */
  async report(audience: HistoryAudience, courseId: string): Promise<Reply[]> {
    const reader = this.#reader(audience);
    if (reader === null) {
      return [];
    }
    await this.#chat.clearSideConversation();
    const locale = this.#chat.locale();
    const report = await this.#chat.ctx.repos.history.report(reader, courseId);
    if (report === null) {
      return this.#gone(audience);
    }
    return this.#show(reportText(locale, report, audience), [
      [
        this.#chat.button(locale, 'report.days', {
          kind: 'historyDays',
          audience,
          courseId,
          page: 1,
        }),
      ],
      (['PDF', 'CSV'] as const).map((format) =>
        this.#chat.button(locale, format === 'PDF' ? 'export.pdf' : 'export.csv', {
          kind: 'historyExport',
          audience,
          courseId,
          format,
        }),
      ),
      [this.#back(audience, courseId)],
    ]);
  }

  /**
   * The report of a course as a file (TZ §14.3), sent as a document into the chat of the person
   * who pressed the button: there is no link for anyone else to open. The repository decides
   * whether this person may have it, records that they asked, and limits how often.
   */
  async export(
    audience: HistoryAudience,
    courseId: string,
    format: ExportFileFormat,
  ): Promise<Reply[]> {
    const reader = this.#reader(audience);
    if (reader === null) {
      return [];
    }
    const locale = this.#chat.locale();
    const { repos, now } = this.#chat.ctx;
    const result = await repos.history.exportCourse(reader, { courseId, format, now });
    if (result === null) {
      return this.#gone(audience);
    }
    if (result.status === 'TOO_MANY') {
      return [this.#chat.send(t(locale, 'export.tooMany'))];
    }
    const { plan } = result.export.report;
    const file = await renderReport({ export: result.export, locale, audience });
    return [
      {
        kind: 'document',
        chatId: this.#chat.s.incoming.chatId,
        filename: file.filename,
        content: file.content,
        caption: t(locale, 'export.caption', {
          name: fullName(plan.patient),
          at: formatLocalDateTime(now, plan.course.timezone),
        }),
        fallback: t(locale, 'error.generic'),
      },
    ];
  }

  /** One page of the course day by day. */
  async days(audience: HistoryAudience, courseId: string, page: number): Promise<Reply[]> {
    const reader = this.#reader(audience);
    if (reader === null) {
      return [];
    }
    await this.#chat.clearSideConversation();
    const locale = this.#chat.locale();
    const found = await this.#chat.ctx.repos.history.days(reader, {
      courseId,
      page,
      now: this.#chat.ctx.now,
    });
    if (found === null) {
      return this.#gone(audience);
    }
    const turn = (key: 'report.older' | 'report.newer', to: number): Button =>
      this.#chat.button(locale, key, { kind: 'historyDays', audience, courseId, page: to });
    const turning = [
      ...(found.page < found.pages ? [turn('report.older', found.page + 1)] : []),
      ...(found.page > 1 ? [turn('report.newer', found.page - 1)] : []),
    ];
    return this.#show(daysText(locale, found, audience), [
      ...(turning.length > 0 ? [turning] : []),
      [this.#chat.button(locale, 'report.back', { kind: 'history', audience, courseId })],
    ]);
  }
}
