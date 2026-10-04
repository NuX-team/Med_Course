import {
  MAX_MEDICATIONS,
  START_WINDOW_DAYS,
  type CoursePlan,
  type DoseUnit,
  type FoodRule,
  type MedicationSchedule,
  type PlanProblemView,
} from '@medcourse/db';
import { t, type Locale, type MessageKey } from '@medcourse/i18n';
import {
  formatLocalDateTime,
  suggestDailyTimes,
  type SuggestedFrequency,
} from '@medcourse/schedule';
import {
  WIZARD_VALUES,
  encodeCallback,
  type Callback,
  type CourseAction,
  type WizardChoice,
} from './callbacks';
import { changeLines, courseCard, doseText, intervalText, startDeadline } from './card';
import {
  cleanInstructions,
  cleanMedicationName,
  formatDose,
  parseDailyLimit,
  parseDayRange,
  parseDose,
  parseDuration,
  parseTimes,
} from './course-input';
import { standing } from './doctor';
import { Chat, asClinician, clip, fullName } from './session';
import type { Button, Reply } from './types';

/** How many patients or courses are offered as buttons at once. */
const PICK_LIMIT = 40;
const BUTTON_TEXT = 30;

type Step =
  | 'SOURCE'
  | 'DURATION'
  | 'NEW_DURATION'
  | 'MED_NAME'
  | 'MED_DOSE'
  | 'MED_UNIT'
  | 'MED_FOOD'
  | 'MED_FREQ'
  | 'MED_TIMES'
  | 'MED_TIMES_CONFIRM'
  | 'MED_PRN_MAX'
  | 'MED_PRN_INTERVAL'
  | 'MED_DAYS'
  | 'MED_DAY_RANGE'
  | 'MED_NOTE';

/**
 * The medication being entered, one field per step. It lives in the conversation only until
 * its last step, then goes into the draft in the database. The free-text instructions are that
 * last step, so they are never stored here.
 */
interface MedicationDraft {
  readonly courseId: string;
  readonly name?: string;
  readonly doseValue?: number;
  readonly doseDisplay?: string | null;
  readonly unit?: DoseUnit;
  readonly food?: FoodRule;
  readonly times?: readonly string[];
  readonly prnMax?: number;
  readonly prnInterval?: number;
  readonly from?: number;
  readonly to?: number;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Reads the draft back out of the conversation, keeping only fields of the right shape. */
function readDraft(data: Readonly<Record<string, unknown>>): MedicationDraft | null {
  if (!isString(data.courseId)) {
    return null;
  }
  const unit = (WIZARD_VALUES.unit as readonly string[]).includes(data.unit as string)
    ? (data.unit as DoseUnit)
    : undefined;
  const food = (WIZARD_VALUES.food as readonly string[]).includes(data.food as string)
    ? (data.food as FoodRule)
    : undefined;
  const times = Array.isArray(data.times) && data.times.every(isString) ? data.times : undefined;
  return {
    courseId: data.courseId,
    ...(isString(data.name) ? { name: data.name } : {}),
    ...(isNumber(data.doseValue) ? { doseValue: data.doseValue } : {}),
    ...(isString(data.doseDisplay) ? { doseDisplay: data.doseDisplay } : {}),
    ...(unit === undefined ? {} : { unit }),
    ...(food === undefined ? {} : { food }),
    ...(times === undefined ? {} : { times }),
    ...(isNumber(data.prnMax) ? { prnMax: data.prnMax } : {}),
    ...(isNumber(data.prnInterval) ? { prnInterval: data.prnInterval } : {}),
    ...(isNumber(data.from) ? { from: data.from } : {}),
    ...(isNumber(data.to) ? { to: data.to } : {}),
  };
}

/**
 * The doctor writes a course in the chat: who it is for, how long, and each medication step by
 * step, then reviews the whole prescription and sends it (TZ §5.1). The draft itself is in the
 * database from the moment its length is known, so it survives a closed chat and can be
 * continued later. Nothing here decides anything medical: the bot records what the doctor
 * says, shows it back, and refuses only what cannot be laid out as a schedule.
 */
export class CourseFlow {
  readonly #chat: Chat;

  constructor(chat: Chat) {
    this.#chat = chat;
  }

  // Shared pieces -------------------------------------------------------------------------

  /** A doctor in good standing, or null: every entry point starts here. */
  #doctor(): { userId: string; locale: Locale } | null {
    const { user, profile, clinician } = this.#chat.s;
    if (user === null || profile === null || standing(clinician) !== 'GOOD') {
      return null;
    }
    return { userId: user.id, locale: this.#chat.locale() };
  }

  #step(): Step | null {
    const talk = this.#chat.s.talk;
    return talk?.flow === 'COURSE' ? (talk.step as Step) : null;
  }

  #draft(): MedicationDraft | null {
    const talk = this.#chat.s.talk;
    return talk?.flow === 'COURSE' ? readDraft(talk.data) : null;
  }

  async #go(step: Step, data: Record<string, unknown>): Promise<void> {
    await this.#chat.remember('COURSE', step, data);
  }

  #button(
    key: MessageKey,
    callback: Callback,
    params: Record<string, string | number> = {},
  ): Button {
    return this.#chat.button(this.#chat.locale(), key, callback, params);
  }

  #choice(
    key: MessageKey,
    choice: WizardChoice,
    params: Record<string, string | number> = {},
  ): Button {
    return this.#button(key, { kind: 'wizard', ...choice }, params);
  }

  #toDoctorMenu(): Button[][] {
    return [[this.#button('common.back', { kind: 'menu', target: 'doctor' })]];
  }

  #toCourse(courseId: string): Button[][] {
    return [[this.#button('common.back', { kind: 'course', action: 'open', courseId })]];
  }

  #notAvailable(): Reply[] {
    return [this.#chat.respond(t(this.#chat.locale(), 'cw.notAvailable'), this.#toDoctorMenu())];
  }

  /** One message if the text fits, several if not; the buttons go under the last one. */
  #show(chunks: readonly string[], buttons: Button[][]): Reply[] {
    if (chunks.length <= 1) {
      return [this.#chat.respond(chunks[0] ?? '', buttons)];
    }
    return chunks.map((chunk, index) =>
      index === chunks.length - 1 ? this.#chat.send(chunk, buttons) : this.#chat.send(chunk),
    );
  }

  // Starting a course ---------------------------------------------------------------------

  /** "New course": pick the patient. */
  async begin(): Promise<Reply[]> {
    const doctor = this.#doctor();
    if (doctor === null) {
      return this.#refuse();
    }
    await this.#chat.clearSideConversation();
    const patients = (
      await this.#chat.ctx.repos.care.listForClinician(asClinician(doctor.userId))
    ).filter((entry) => entry.status === 'ACTIVE');
    if (patients.length === 0) {
      return [this.#chat.edit(t(doctor.locale, 'cw.noPatients'), this.#toDoctorMenu())];
    }
    return [
      this.#chat.edit(t(doctor.locale, 'cw.pickPatient'), [
        ...patients.slice(0, PICK_LIMIT).map((entry) => [
          {
            text: clip(`${entry.lastName} ${entry.firstName}`, BUTTON_TEXT),
            data: encodeCallback({ kind: 'courseBegin', relationshipId: entry.relationshipId }),
          },
        ]),
        ...this.#toDoctorMenu(),
      ]),
    ];
  }

  #refuse(): Reply[] {
    const { user, profile } = this.#chat.s;
    return user === null || profile === null
      ? []
      : [this.#chat.respond(t(this.#chat.locale(), 'doctor.notAllowed'), this.#toDoctorMenu())];
  }

  /** The patient is chosen: continue their draft, offer to copy their last course, or start. */
  async forPatient(relationshipId: string): Promise<Reply[]> {
    const doctor = this.#doctor();
    if (doctor === null) {
      return this.#refuse();
    }
    const { repos } = this.#chat.ctx;
    const actor = asClinician(doctor.userId);

    const existing = await repos.plans.draftFor(actor, relationshipId);
    if (existing !== null) {
      return this.overview(existing.id);
    }
    const patient = (await repos.care.listForClinician(actor)).find(
      (entry) => entry.relationshipId === relationshipId && entry.status === 'ACTIVE',
    );
    if (patient === undefined) {
      return this.#notAvailable();
    }

    const last = await repos.plans.lastSent(actor, relationshipId);
    if (last !== null) {
      await this.#go('SOURCE', { relationshipId, lastCourseId: last.courseId });
      return [
        this.#chat.edit(
          t(doctor.locale, 'cw.copyOffer', {
            patient: fullName(patient),
            date: formatLocalDateTime(last.createdAt, this.#chat.s.user?.timezone ?? 'UTC').slice(
              0,
              10,
            ),
          }),
          [
            [this.#choice('cw.fromScratch', { field: 'source', value: 'scratch' })],
            [this.#choice('cw.copyLast', { field: 'source', value: 'copy' })],
            ...this.#toDoctorMenu(),
          ],
        ),
      ];
    }
    return this.#askDuration(relationshipId, fullName(patient));
  }

  async #askDuration(relationshipId: string, patientName: string): Promise<Reply[]> {
    await this.#go('DURATION', { relationshipId, patientName });
    return [
      this.#chat.edit(t(this.#chat.locale(), 'cw.askDuration', { patient: patientName }), [
        WIZARD_VALUES.length.map((days) =>
          this.#choice('cw.daysButton', { field: 'length', value: days }, { days }),
        ),
        ...this.#toDoctorMenu(),
      ]),
    ];
  }

  async #openDraft(durationDays: number, copyFrom?: string): Promise<Reply[]> {
    const doctor = this.#doctor();
    const data = this.#chat.s.talk?.data ?? {};
    if (doctor === null || !isString(data.relationshipId)) {
      return this.#notAvailable();
    }
    const opened = await this.#chat.ctx.repos.plans.openDraft(asClinician(doctor.userId), {
      relationshipId: data.relationshipId,
      durationDays,
      ...(copyFrom === undefined ? {} : { copyFrom }),
    });
    if (opened === null) {
      await this.#chat.clear();
      return this.#notAvailable();
    }
    // A fresh, empty draft goes straight to its first medication; anything else is shown whole.
    if (opened.created && copyFrom === undefined) {
      await this.#go('MED_NAME', { courseId: opened.course.id });
      return [this.#chat.respond(t(doctor.locale, 'cw.askName'), this.#toCourse(opened.course.id))];
    }
    return this.overview(opened.course.id);
  }

  // One course ----------------------------------------------------------------------------

  /**
   * The whole course on one screen. A draft comes with the buttons that write it; a course that
   * has been sent comes with what can still be done to it: take it back, put it on hold, resume
   * it, change its plan, end it.
   */
  async overview(courseId: string): Promise<Reply[]> {
    const doctor = this.#doctor();
    if (doctor === null) {
      return this.#refuse();
    }
    await this.#chat.clear();
    const plan = await this.#chat.ctx.repos.plans.getPlan(asClinician(doctor.userId), courseId);
    if (plan === null) {
      return this.#notAvailable();
    }
    const act = (key: MessageKey, action: CourseAction): Button[] => [
      this.#button(key, { kind: 'course', action, courseId }),
    ];
    const chunks = courseCard(doctor.locale, plan, 'DOCTOR', { now: this.#chat.ctx.now });

    if (plan.course.status === 'DRAFT') {
      const hasMedications = plan.medications.length > 0;
      return this.#show(chunks, [
        ...(plan.medications.length < MAX_MEDICATIONS ? [act('cw.addMed', 'addMedication')] : []),
        ...(hasMedications ? [act('cw.removeMed', 'removeMenu')] : []),
        act('cw.changeDuration', 'duration'),
        ...(hasMedications ? [act('cw.send', 'send')] : []),
        act('cw.discard', 'discard'),
        ...this.#toDoctorMenu(),
      ]);
    }

    const running = plan.course.status === 'ACTIVE' || plan.course.status === 'PAUSED';
    const changing: Button[][] = !running
      ? []
      : plan.change === null
        ? [act('cw.change', 'change')]
        : plan.change.status === 'DRAFT'
          ? [act('cw.changeContinue', 'change')]
          : [act('cw.changeWithdraw', 'changeDrop')];
    const note =
      !running || plan.change === null
        ? null
        : t(
            doctor.locale,
            plan.change.status === 'DRAFT' ? 'cw.changeDraftNote' : 'cw.changeWaiting',
          );
    const last = chunks.length - 1;
    return this.#show(
      note === null
        ? chunks
        : chunks.map((chunk, index) => (index === last ? `${chunk}\n\n${note}` : chunk)),
      [
        ...(plan.course.status === 'PENDING_PATIENT' ? [act('cw.withdraw', 'cancel')] : []),
        ...(plan.course.status === 'ACTIVE' ? [act('cw.pause', 'pause')] : []),
        ...(plan.course.status === 'PAUSED' ? [act('cw.resume', 'resume')] : []),
        ...changing,
        ...(running ? [act('cw.cancel', 'cancel')] : []),
        // Anything that has started has a history to read, whatever became of it since.
        ...(plan.course.startAt === null
          ? []
          : [
              [
                this.#button('cw.report', {
                  kind: 'history',
                  audience: 'doctor',
                  courseId,
                }),
              ],
            ]),
        ...this.#toDoctorMenu(),
      ],
    );
  }

  /**
   * The change the doctor is writing for a running course: the new plan as far as it has got,
   * what it adds and removes, and the buttons that write it. With no unsent change to show
   * (a plain draft, or a change already sent), this is the course's own screen.
   */
  async editor(courseId: string): Promise<Reply[]> {
    const doctor = this.#doctor();
    if (doctor === null) {
      return this.#refuse();
    }
    const change = await this.#chat.ctx.repos.changes.get(asClinician(doctor.userId), courseId);
    if (change?.status !== 'DRAFT') {
      return this.overview(courseId);
    }
    await this.#chat.clear();
    const { locale } = doctor;
    const plan = change.proposed;
    const act = (key: MessageKey, action: CourseAction): Button[] => [
      this.#button(key, { kind: 'course', action, courseId }),
    ];
    const difference = changeLines(locale, change);
    const chunks = courseCard(locale, plan, 'DOCTOR', {
      now: this.#chat.ctx.now,
      title: t(locale, 'cw.changeTitle'),
    });
    const tail = [
      ...(difference.length === 0 ? [t(locale, 'cw.changeNone')] : difference),
      '',
      t(locale, 'cw.changeHint'),
    ].join('\n');
    const last = chunks.length - 1;
    return this.#show(
      chunks.map((chunk, index) => (index === last ? `${chunk}\n\n${tail}` : chunk)),
      [
        ...(plan.medications.length < MAX_MEDICATIONS ? [act('cw.addMed', 'addMedication')] : []),
        ...(plan.medications.length > 0 ? [act('cw.removeMed', 'removeMenu')] : []),
        ...(difference.length > 0 ? [act('cw.changeSend', 'changeSend')] : []),
        act('cw.changeDrop', 'changeDrop'),
        ...this.#toCourse(courseId),
      ],
    );
  }

  /**
   * The plan this doctor is writing for this course: their draft, or the unsent change of a
   * running course. Null if the button is stale or the course was never theirs.
   */
  async #writable(courseId: string): Promise<CoursePlan | null> {
    const doctor = this.#doctor();
    return doctor === null
      ? null
      : this.#chat.ctx.repos.plans.getEditable(asClinician(doctor.userId), courseId);
  }

  async onCourse(action: CourseAction, courseId: string): Promise<Reply[]> {
    if (this.#doctor() === null) {
      return this.#refuse();
    }
    if (action === 'open') {
      return this.overview(courseId);
    }
    const plan = await this.#writable(courseId);
    const locale = this.#chat.locale();
    // Length, sending and discarding belong to a draft; a change of a running course has its own.
    const forDraftOnly =
      action === 'duration' || action === 'send' || action === 'discard' || action === 'discardYes';
    if (plan === null || (forDraftOnly && plan.course.status !== 'DRAFT')) {
      await this.#chat.clearSideConversation();
      return this.#notAvailable();
    }

    switch (action) {
      case 'addMedication':
        if (plan.medications.length >= MAX_MEDICATIONS) {
          return [
            this.#chat.edit(
              t(locale, 'cw.limitMeds', { max: MAX_MEDICATIONS }),
              this.#toCourse(courseId),
            ),
          ];
        }
        await this.#go('MED_NAME', { courseId });
        return [this.#chat.edit(t(locale, 'cw.askName'), this.#toCourse(courseId))];

      case 'removeMenu':
        await this.#chat.clear();
        return [
          this.#chat.edit(t(locale, 'cw.pickRemove'), [
            ...plan.medications.map((medication) => [
              {
                text: clip(medication.displayName, BUTTON_TEXT),
                data: encodeCallback({
                  kind: 'courseRemoveMedication',
                  medicationId: medication.id,
                }),
              },
            ]),
            ...this.#toCourse(courseId),
          ]),
        ];

      case 'duration':
        await this.#go('NEW_DURATION', { courseId });
        return [
          this.#chat.edit(
            t(locale, 'cw.askNewDuration', { days: plan.course.durationDays }),
            this.#toCourse(courseId),
          ),
        ];

      case 'send': {
        // The doctor reads the prescription once more, exactly as the patient will, and the
        // button that sends it is the answer to "how long may the patient take to start?".
        await this.#chat.clear();
        const chunks = courseCard(locale, plan, 'DOCTOR');
        const last = chunks.length - 1;
        const withQuestion = chunks.map((chunk, index) =>
          index === last ? `${chunk}\n\n${t(locale, 'cw.sendConfirm')}` : chunk,
        );
        return this.#show(withQuestion, [
          START_WINDOW_DAYS.map((days) =>
            this.#button('cw.daysButton', { kind: 'courseWindow', courseId, days }, { days }),
          ),
          ...this.#toCourse(courseId),
        ]);
      }

      case 'discard':
        await this.#chat.clear();
        return [
          this.#chat.edit(t(locale, 'cw.discardConfirm', { patient: fullName(plan.patient) }), [
            [this.#button('cw.discardYes', { kind: 'course', action: 'discardYes', courseId })],
            ...this.#toCourse(courseId),
          ]),
        ];

      case 'discardYes': {
        const doctor = this.#doctor();
        const gone =
          doctor !== null &&
          (await this.#chat.ctx.repos.plans.discard(
            asClinician(doctor.userId),
            courseId,
            this.#chat.ctx.now,
          ));
        await this.#chat.clear();
        return gone
          ? [this.#chat.edit(t(locale, 'cw.discarded'), this.#toDoctorMenu())]
          : this.#notAvailable();
      }

      default:
        // What is done to a sent course is not this flow's to do.
        return this.#notAvailable();
    }
  }

  async onRemoveMedication(medicationId: string): Promise<Reply[]> {
    const doctor = this.#doctor();
    if (doctor === null) {
      return this.#refuse();
    }
    const courseId = await this.#chat.ctx.repos.plans.removeMedication(
      asClinician(doctor.userId),
      medicationId,
    );
    return courseId === null ? this.#notAvailable() : this.editor(courseId);
  }

  /** The doctor chose the start window: this is the act of sending. */
  async onWindow(courseId: string, windowDays: number): Promise<Reply[]> {
    const doctor = this.#doctor();
    if (doctor === null) {
      return this.#refuse();
    }
    const { repos, now } = this.#chat.ctx;
    const result = await repos.plans.send(asClinician(doctor.userId), courseId, {
      windowDays,
      now,
    });
    await this.#chat.clear();

    if (result.status === 'NOT_EDITABLE') {
      return this.#notAvailable();
    }
    if (result.status === 'INVALID') {
      return [
        this.#chat.edit(
          [
            t(doctor.locale, 'cw.cannotSend'),
            ...result.problems.map((problem) => `• ${this.problemText(problem)}`),
          ].join('\n'),
          this.#toCourse(courseId),
        ),
      ];
    }

    const { plan, patient } = result;
    const until = startDeadline(plan) ?? '';
    // The patient reads the same prescription the doctor just confirmed, in their own language.
    const card = courseCard(patient.locale, plan, 'PATIENT');
    const last = card.length - 1;
    const forPatient = card.map((chunk, index) => {
      const head =
        index === 0
          ? `${t(patient.locale, 'course.assigned', { doctor: fullName(plan.clinician) })}\n\n`
          : '';
      const tail =
        index === last
          ? `\n\n${t(patient.locale, 'course.pendingNote', { until })}\n\n${t(patient.locale, 'course.followDoctor')}`
          : '';
      return `${head}${chunk}${tail}`;
    });
    return [
      this.#chat.edit(
        t(doctor.locale, 'cw.sent', { patient: fullName(plan.patient), until }),
        this.#toDoctorMenu(),
      ),
      // The button that starts the course goes under the prescription it starts.
      ...forPatient.map((text, index) =>
        index === last
          ? this.#chat.sendTo(patient.telegramUserId, text, [
              [
                this.#chat.button(patient.locale, 'course.start', {
                  kind: 'patientCourse',
                  action: 'ask',
                  courseId,
                }),
              ],
            ])
          : this.#chat.sendTo(patient.telegramUserId, text),
      ),
    ];
  }

  problemText(problem: PlanProblemView): string {
    const locale = this.#chat.locale();
    const name = problem.medicationName ?? '';
    switch (problem.code) {
      case 'NO_MEDICATIONS':
        return t(locale, 'cw.problem.NO_MEDICATIONS');
      case 'DUPLICATE_SLOT':
        return t(locale, 'cw.problem.DUPLICATE_SLOT', { name });
      case 'MEDICATION_OUTSIDE_COURSE':
        return t(locale, 'cw.problem.MEDICATION_OUTSIDE_COURSE', { name });
      case 'TOO_MANY_SLOTS':
        return t(locale, 'cw.problem.TOO_MANY_SLOTS');
      default:
        return t(locale, 'cw.problem.OTHER', { code: problem.code });
    }
  }

  /** "Courses": the doctor's own, newest first. */
  async list(): Promise<Reply[]> {
    const doctor = this.#doctor();
    if (doctor === null) {
      return this.#refuse();
    }
    await this.#chat.clearSideConversation();
    const courses = await this.#chat.ctx.repos.plans.listForClinician(asClinician(doctor.userId));
    if (courses.length === 0) {
      return [this.#chat.edit(t(doctor.locale, 'cw.listNone'), this.#toDoctorMenu())];
    }
    const shown = courses.slice(0, 20);
    const lineOf = (course: (typeof courses)[number]): string =>
      t(doctor.locale, 'cw.listLine', {
        patient: clip(fullName(course.patient), 40),
        status: t(doctor.locale, `status.${course.status}`),
        days: course.durationDays,
      });
    return [
      this.#chat.edit(
        `${t(doctor.locale, 'cw.listTitle')}\n\n${shown.map((course) => `• ${lineOf(course)}`).join('\n')}`,
        [
          ...shown.map((course) => [
            {
              text: clip(
                `${course.patient.lastName} · ${t(doctor.locale, `status.${course.status}`)}`,
                BUTTON_TEXT + 8,
              ),
              data: encodeCallback({ kind: 'course', action: 'open', courseId: course.courseId }),
            },
          ]),
          ...this.#toDoctorMenu(),
        ],
      ),
    ];
  }

  // The wizard: buttons -------------------------------------------------------------------

  /** A choice on a wizard step. Honoured only on the step that offers it. */
  async onChoice(choice: WizardChoice): Promise<Reply[]> {
    if (this.#doctor() === null) {
      return this.#refuse();
    }
    const step = this.#step();
    const locale = this.#chat.locale();
    const data = this.#chat.s.talk?.data ?? {};

    switch (choice.field) {
      case 'source':
        if (step !== 'SOURCE' || !isString(data.relationshipId)) {
          return [];
        }
        if (choice.value === 'copy') {
          return isString(data.lastCourseId) ? this.#openDraft(1, data.lastCourseId) : [];
        }
        return this.#askDurationAgain(data.relationshipId);

      case 'length':
        return step === 'DURATION' ? this.#openDraft(Number(choice.value)) : [];

      case 'unit': {
        const draft = this.#draft();
        if (step !== 'MED_UNIT' || draft?.name === undefined || draft.doseValue === undefined) {
          return [];
        }
        const next = { ...draft, unit: choice.value };
        await this.#go('MED_FOOD', next);
        return [
          this.#chat.edit(t(locale, 'cw.askFood', { name: draft.name, dose: this.#doseOf(next) }), [
            ...WIZARD_VALUES.food.map((food) => [
              this.#choice(`food.${food}`, { field: 'food', value: food }),
            ]),
            ...this.#toCourse(draft.courseId),
          ]),
        ];
      }

      case 'food': {
        const draft = this.#draft();
        if (step !== 'MED_FOOD' || draft?.name === undefined) {
          return [];
        }
        await this.#go('MED_FREQ', { ...draft, food: choice.value });
        return [
          this.#chat.edit(t(locale, 'cw.askFrequency', { name: draft.name }), [
            [
              this.#choice('cw.freq1', { field: 'freq', value: '1' }),
              this.#choice('cw.freq2', { field: 'freq', value: '2' }),
            ],
            [
              this.#choice('cw.freq3', { field: 'freq', value: '3' }),
              this.#choice('cw.freq4', { field: 'freq', value: '4' }),
            ],
            [this.#choice('cw.ownTimes', { field: 'freq', value: 'own' })],
            [this.#choice('cw.prn', { field: 'freq', value: 'prn' })],
            ...this.#toCourse(draft.courseId),
          ]),
        ];
      }

      case 'freq': {
        const draft = this.#draft();
        if (step !== 'MED_FREQ' || draft?.name === undefined) {
          return [];
        }
        if (choice.value === 'own') {
          await this.#go('MED_TIMES', { ...draft });
          return [this.#chat.edit(t(locale, 'cw.askTimes'), this.#toCourse(draft.courseId))];
        }
        if (choice.value === 'prn') {
          await this.#go('MED_PRN_MAX', { ...draft });
          return [
            this.#chat.edit(
              t(locale, 'cw.askPrnMax', { name: draft.name }),
              this.#toCourse(draft.courseId),
            ),
          ];
        }
        // A proposal, never a decision: the next screen says so and waits for the doctor.
        const times = suggestDailyTimes(Number(choice.value) as SuggestedFrequency);
        return this.#proposeTimes({ ...draft, times });
      }

      case 'times': {
        const draft = this.#draft();
        if (
          step !== 'MED_TIMES_CONFIRM' ||
          draft?.name === undefined ||
          draft.times === undefined
        ) {
          return [];
        }
        if (choice.value === 'change') {
          await this.#go('MED_TIMES', { ...draft });
          return [this.#chat.edit(t(locale, 'cw.askTimes'), this.#toCourse(draft.courseId))];
        }
        return this.#askDays(draft);
      }

      case 'interval': {
        const draft = this.#draft();
        if (step !== 'MED_PRN_INTERVAL' || draft?.prnMax === undefined) {
          return [];
        }
        return this.#askDays({ ...draft, prnInterval: Number(choice.value) });
      }

      case 'days': {
        const draft = this.#draft();
        if (step !== 'MED_DAYS' || draft?.name === undefined) {
          return [];
        }
        const plan = await this.#writable(draft.courseId);
        if (plan === null) {
          await this.#chat.clear();
          return this.#notAvailable();
        }
        if (choice.value === 'some') {
          await this.#go('MED_DAY_RANGE', { ...draft });
          return [
            this.#chat.edit(
              t(locale, 'cw.askDayRange', { days: plan.course.durationDays }),
              this.#toCourse(draft.courseId),
            ),
          ];
        }
        return this.#askInstructions({ ...draft, from: 1, to: plan.course.durationDays });
      }

      case 'note':
        return step === 'MED_NOTE' ? this.#save(null) : [];
    }
  }

  async #askDurationAgain(relationshipId: string): Promise<Reply[]> {
    const doctor = this.#doctor();
    const patient =
      doctor === null
        ? undefined
        : (await this.#chat.ctx.repos.care.listForClinician(asClinician(doctor.userId))).find(
            (entry) => entry.relationshipId === relationshipId && entry.status === 'ACTIVE',
          );
    return patient === undefined
      ? this.#notAvailable()
      : this.#askDuration(relationshipId, fullName(patient));
  }

  #doseOf(draft: MedicationDraft): string {
    const value = formatDose((draft.doseValue ?? 0).toFixed(3), draft.doseDisplay ?? null);
    return draft.unit === undefined
      ? value
      : doseText(this.#chat.locale(), {
          doseValue: (draft.doseValue ?? 0).toFixed(3),
          doseDisplay: draft.doseDisplay ?? null,
          doseUnit: draft.unit,
        });
  }

  async #proposeTimes(draft: MedicationDraft): Promise<Reply[]> {
    await this.#go('MED_TIMES_CONFIRM', { ...draft });
    return [
      this.#chat.respond(
        t(this.#chat.locale(), 'cw.proposeTimes', {
          name: draft.name ?? '',
          times: (draft.times ?? []).join(', '),
        }),
        [
          [this.#choice('cw.confirmTimes', { field: 'times', value: 'ok' })],
          [this.#choice('cw.changeTimes', { field: 'times', value: 'change' })],
          ...this.#toCourse(draft.courseId),
        ],
      ),
    ];
  }

  async #askDays(draft: MedicationDraft): Promise<Reply[]> {
    const plan = await this.#writable(draft.courseId);
    if (plan === null) {
      await this.#chat.clear();
      return this.#notAvailable();
    }
    await this.#go('MED_DAYS', { ...draft });
    return [
      this.#chat.respond(
        t(this.#chat.locale(), 'cw.askDays', {
          name: draft.name ?? '',
          days: plan.course.durationDays,
        }),
        [
          [this.#choice('cw.wholeCourse', { field: 'days', value: 'all' })],
          [this.#choice('cw.someDays', { field: 'days', value: 'some' })],
          ...this.#toCourse(draft.courseId),
        ],
      ),
    ];
  }

  async #askInstructions(draft: MedicationDraft): Promise<Reply[]> {
    await this.#go('MED_NOTE', { ...draft });
    return [
      this.#chat.respond(t(this.#chat.locale(), 'cw.askInstructions'), [
        [this.#choice('cw.skip', { field: 'note', value: 'skip' })],
        ...this.#toCourse(draft.courseId),
      ]),
    ];
  }

  /** The last step: the medication, complete, goes into the draft. */
  async #save(instructions: string | null): Promise<Reply[]> {
    const doctor = this.#doctor();
    const draft = this.#draft();
    const complete =
      draft?.name !== undefined &&
      draft.doseValue !== undefined &&
      draft.unit !== undefined &&
      draft.food !== undefined &&
      draft.from !== undefined &&
      draft.to !== undefined;
    let schedule: MedicationSchedule | null = null;
    if (draft?.prnMax !== undefined && draft.prnInterval !== undefined) {
      schedule = {
        kind: 'PRN',
        maxDailyDoses: draft.prnMax,
        minimumIntervalMinutes: draft.prnInterval,
      };
    } else if (draft?.times !== undefined && draft.times.length > 0) {
      schedule = { kind: 'TIMES', times: draft.times };
    }
    if (doctor === null || draft === null || !complete || schedule === null) {
      await this.#chat.clear();
      return this.#notAvailable();
    }

    const result = await this.#chat.ctx.repos.plans.addMedication(
      asClinician(doctor.userId),
      draft.courseId,
      {
        displayName: draft.name ?? '',
        doseValue: draft.doseValue ?? 0,
        doseDisplay: draft.doseDisplay ?? null,
        doseUnit: draft.unit ?? 'MG',
        foodRule: draft.food ?? 'ANY',
        instructions,
        activeFromDay: draft.from ?? 1,
        activeToDay: draft.to ?? 1,
        schedule,
      },
    );
    if (result.status === 'LIMIT') {
      await this.#chat.clear();
      return [
        this.#chat.respond(
          t(doctor.locale, 'cw.limitMeds', { max: MAX_MEDICATIONS }),
          this.#toCourse(draft.courseId),
        ),
      ];
    }
    if (result.status === 'NOT_EDITABLE') {
      await this.#chat.clear();
      return this.#notAvailable();
    }
    return this.editor(draft.courseId);
  }

  // The wizard: typed answers -------------------------------------------------------------

  /** What the doctor typed, if a wizard step is waiting for text. Null if none is. */
  async onText(text: string): Promise<Reply[] | null> {
    const step = this.#step();
    if (step === null) {
      return null;
    }
    if (this.#doctor() === null) {
      await this.#chat.clear();
      return null;
    }
    const locale = this.#chat.locale();
    const say = (key: MessageKey, params: Record<string, string | number> = {}): Reply[] => [
      this.#chat.send(t(locale, key, params)),
    ];

    if (step === 'DURATION') {
      const days = parseDuration(text);
      return days === null ? say('cw.invalidDuration') : this.#openDraft(days);
    }
    const draft = this.#draft();
    if (draft === null) {
      await this.#chat.clear();
      return null;
    }

    switch (step) {
      case 'NEW_DURATION': {
        const days = parseDuration(text);
        if (days === null) {
          return say('cw.invalidDuration');
        }
        const doctor = this.#doctor();
        const result =
          doctor === null
            ? ({ status: 'NOT_EDITABLE' } as const)
            : await this.#chat.ctx.repos.plans.setDuration(
                asClinician(doctor.userId),
                draft.courseId,
                days,
              );
        if (result.status === 'CONFLICT') {
          return [
            this.#chat.send(
              t(locale, 'cw.durationConflict', { name: result.medicationName }),
              this.#toCourse(draft.courseId),
            ),
          ];
        }
        return result.status === 'OK' ? this.overview(draft.courseId) : this.#notAvailable();
      }

      case 'MED_NAME': {
        const name = cleanMedicationName(text);
        if (name === null) {
          return say('cw.invalidMedName');
        }
        await this.#go('MED_DOSE', { courseId: draft.courseId, name });
        return [this.#chat.send(t(locale, 'cw.askDose', { name }), this.#toCourse(draft.courseId))];
      }

      case 'MED_DOSE': {
        const dose = parseDose(text);
        if (dose === null || draft.name === undefined) {
          return say('cw.invalidDose');
        }
        const next = { ...draft, doseValue: dose.value, doseDisplay: dose.display };
        await this.#go('MED_UNIT', next);
        const units = WIZARD_VALUES.unit.map((unit) =>
          this.#choice(`unit.${unit}`, { field: 'unit', value: unit }),
        );
        return [
          this.#chat.send(t(locale, 'cw.askUnit', { name: draft.name, dose: this.#doseOf(next) }), [
            units.slice(0, 4),
            units.slice(4, 7),
            units.slice(7),
            ...this.#toCourse(draft.courseId),
          ]),
        ];
      }

      case 'MED_TIMES': {
        const times = parseTimes(text);
        return times === null ? say('cw.invalidTimes') : this.#proposeTimes({ ...draft, times });
      }

      case 'MED_PRN_MAX': {
        const prnMax = parseDailyLimit(text);
        if (prnMax === null) {
          return say('cw.invalidPrnMax');
        }
        await this.#go('MED_PRN_INTERVAL', { ...draft, prnMax });
        const intervals = WIZARD_VALUES.interval.map((minutes) => ({
          text: intervalText(locale, Number(minutes)),
          data: encodeCallback({ kind: 'wizard', field: 'interval', value: minutes }),
        }));
        return [
          this.#chat.send(t(locale, 'cw.askPrnInterval'), [
            intervals.slice(0, 4),
            intervals.slice(4),
            ...this.#toCourse(draft.courseId),
          ]),
        ];
      }

      case 'MED_DAY_RANGE': {
        const plan = await this.#writable(draft.courseId);
        if (plan === null) {
          await this.#chat.clear();
          return this.#notAvailable();
        }
        const range = parseDayRange(text, plan.course.durationDays);
        return range === null
          ? say('cw.invalidDayRange', { days: plan.course.durationDays })
          : this.#askInstructions({ ...draft, from: range.from, to: range.to });
      }

      case 'MED_NOTE': {
        const instructions = cleanInstructions(text);
        return instructions === null ? say('cw.invalidInstructions') : this.#save(instructions);
      }

      default:
        // A step that expects a button: the text is not an answer to it.
        return null;
    }
  }
}
