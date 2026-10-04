import { randomUUID } from 'node:crypto';
import {
  DEFAULT_REMINDER_POLICY,
  DOSE_STATUSES as SCHEDULE_DOSE_STATUSES,
  deadlineAt,
  generateSlots,
  planRevisionSwitch,
  validatePlan,
  validateReminderPolicy,
  type MedicationInput,
  type ReminderPolicy,
  type RuleInput,
  type Slot,
} from '@medcourse/schedule';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  insertClinic,
  insertClinician,
  insertCourse,
  insertPatient,
  insertRelationship,
} from '../test/fixtures';
import { createTestDatabase, type TestDatabase } from '../test/helpers';
import { DOSE_STATUSES } from './schema';

/**
 * packages/schedule decides what is allowed and when things happen; packages/db decides what can
 * be stored. They are written separately and must not drift. Each test here would fail the day
 * one of them changes without the other.
 */

let testDatabase: TestDatabase;
const sql = () => testDatabase.db.sql;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
});

afterAll(async () => {
  await testDatabase.drop();
});

async function newCourse(): Promise<{ courseId: string; revisionId: string }> {
  const clinic = await insertClinic(sql());
  const doctor = await insertClinician(sql(), clinic);
  const patient = await insertPatient(sql());
  const relationshipId = await insertRelationship(sql(), patient, doctor);
  return insertCourse(sql(), {
    patientId: patient,
    clinicianId: doctor,
    clinicId: clinic,
    relationshipId,
  });
}

async function accepted(statement: PromiseLike<unknown>): Promise<boolean> {
  try {
    await statement;
    return true;
  } catch (error) {
    if (error instanceof postgres.PostgresError) {
      return false;
    }
    throw error;
  }
}

describe('dose statuses', () => {
  it('are the same list in both packages', () => {
    expect([...SCHEDULE_DOSE_STATUSES]).toEqual([...DOSE_STATUSES]);
  });
});

describe('the reminder policy', () => {
  it('has the defaults the database column defaults give', async () => {
    const { courseId } = await newCourse();
    const [row] = await sql()<
      {
        attempts: number;
        retry_interval_minutes: number;
        miss_after_minutes: number;
        snooze_options_minutes: number[];
        max_snoozes: number;
        correction_window_minutes: number;
        lead_minutes: number;
      }[]
    >`select attempts, retry_interval_minutes, miss_after_minutes, snooze_options_minutes, max_snoozes,
             correction_window_minutes, lead_minutes
      from reminder_policies where course_id = ${courseId}`;

    expect({
      attempts: row?.attempts,
      retryIntervalMinutes: row?.retry_interval_minutes,
      missAfterMinutes: row?.miss_after_minutes,
      snoozeOptionsMinutes: row?.snooze_options_minutes,
      maxSnoozes: row?.max_snoozes,
      correctionWindowMinutes: row?.correction_window_minutes,
      leadMinutes: row?.lead_minutes,
    }).toEqual(DEFAULT_REMINDER_POLICY);
  });

  it('is accepted by the validator exactly when the database accepts it', async () => {
    const { courseId } = await newCourse();

    const accepts = (policy: ReminderPolicy) =>
      accepted(sql()`
        update reminder_policies set
          attempts = ${policy.attempts},
          retry_interval_minutes = ${policy.retryIntervalMinutes},
          miss_after_minutes = ${policy.missAfterMinutes},
          snooze_options_minutes = ${`{${policy.snoozeOptionsMinutes.join(',')}}`}::int[],
          max_snoozes = ${policy.maxSnoozes},
          correction_window_minutes = ${policy.correctionWindowMinutes},
          lead_minutes = ${policy.leadMinutes}
        where course_id = ${courseId}`);

    const grid = {
      attempts: [0, 1, 3, 10, 11],
      retryIntervalMinutes: [0, 1, 10, 120, 121],
      missAfterMinutes: [0, 1, 20, 21, 30, 1440, 1441],
      snoozeOptionsMinutes: [[5, 10, 15], [], [0], [5, 241], [1, 2, 3, 4, 5, 6], [240], [-5]],
      maxSnoozes: [-1, 0, 3, 10, 11],
      correctionWindowMinutes: [-1, 0, 60, 10_080, 10_081],
      leadMinutes: [-1, 0, 240, 241],
    } as const;

    // Every edge of every field on its own against the defaults, then a few hundred random mixes.
    const cases: ReminderPolicy[] = [DEFAULT_REMINDER_POLICY];
    for (const [field, values] of Object.entries(grid)) {
      for (const value of values) {
        cases.push({ ...DEFAULT_REMINDER_POLICY, [field]: value });
      }
    }
    let state = 99;
    const pick = <T>(values: readonly T[]): T => {
      state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
      return values[state % values.length] as T;
    };
    for (let index = 0; index < 400; index += 1) {
      cases.push({
        attempts: pick(grid.attempts),
        retryIntervalMinutes: pick(grid.retryIntervalMinutes),
        missAfterMinutes: pick(grid.missAfterMinutes),
        snoozeOptionsMinutes: pick(grid.snoozeOptionsMinutes),
        maxSnoozes: pick(grid.maxSnoozes),
        correctionWindowMinutes: pick(grid.correctionWindowMinutes),
        leadMinutes: pick(grid.leadMinutes),
      });
    }

    let accepts_ = 0;
    for (const policy of cases) {
      const databaseAccepts = await accepts(policy);
      expect(validateReminderPolicy(policy).length === 0, JSON.stringify(policy)).toBe(
        databaseAccepts,
      );
      if (databaseAccepts) accepts_ += 1;
    }
    // The comparison is only meaningful if both outcomes were exercised.
    expect(accepts_).toBeGreaterThan(5);
    expect(accepts_).toBeLessThan(cases.length - 5);
  });
});

describe('a plan the validator judges', () => {
  interface PlanCase {
    name: string;
    medication: {
      prn?: boolean;
      maxDailyDoses?: number | null;
      minimumIntervalMinutes?: number | null;
      activeFromDay?: number;
      activeToDay?: number;
    };
    rules: {
      localTime: string;
      daysOfWeek?: number[] | null;
      dayFrom?: number | null;
      dayTo?: number | null;
    }[];
    /** What the validator should say about the plan as a whole. */
    validator: 'accept' | 'reject';
    /** What the database should say when the same rows are inserted into a draft. */
    database: 'accept' | 'reject';
  }

  const daily = [{ localTime: '08:00' }];
  const cases: PlanCase[] = [
    {
      name: 'an ordinary daily dose',
      medication: {},
      rules: daily,
      validator: 'accept',
      database: 'accept',
    },
    {
      name: 'a weekday rule',
      medication: {},
      rules: [{ localTime: '08:00', daysOfWeek: [1, 3, 5] }],
      validator: 'accept',
      database: 'accept',
    },
    {
      name: 'a day range inside the drug',
      medication: { activeToDay: 7 },
      rules: [{ localTime: '08:00', dayFrom: 2, dayTo: 4 }],
      validator: 'accept',
      database: 'accept',
    },
    {
      name: 'an as-needed drug with both limits',
      medication: { prn: true, maxDailyDoses: 3, minimumIntervalMinutes: 240 },
      rules: [],
      validator: 'accept',
      database: 'accept',
    },

    {
      name: 'an as-needed drug with no limits',
      medication: { prn: true },
      rules: [],
      validator: 'reject',
      database: 'reject',
    },
    {
      name: 'an as-needed drug with one limit',
      medication: { prn: true, maxDailyDoses: 3 },
      rules: [],
      validator: 'reject',
      database: 'reject',
    },
    {
      name: 'an as-needed drug with a zero limit',
      medication: { prn: true, maxDailyDoses: 0, minimumIntervalMinutes: 240 },
      rules: [],
      validator: 'reject',
      database: 'reject',
    },
    {
      name: 'an as-needed drug with a schedule',
      medication: { prn: true, maxDailyDoses: 3, minimumIntervalMinutes: 240 },
      rules: daily,
      validator: 'reject',
      database: 'reject',
    },
    {
      name: 'a drug starting on day 0',
      medication: { activeFromDay: 0 },
      rules: daily,
      validator: 'reject',
      database: 'reject',
    },
    {
      name: 'a drug ending before it starts',
      medication: { activeFromDay: 5, activeToDay: 4 },
      rules: daily,
      validator: 'reject',
      database: 'reject',
    },
    {
      name: 'a time of 25:00',
      medication: {},
      rules: [{ localTime: '25:00' }],
      validator: 'reject',
      database: 'reject',
    },
    {
      name: 'weekday 0',
      medication: {},
      rules: [{ localTime: '08:00', daysOfWeek: [0] }],
      validator: 'reject',
      database: 'reject',
    },
    {
      name: 'weekday 8',
      medication: {},
      rules: [{ localTime: '08:00', daysOfWeek: [8] }],
      validator: 'reject',
      database: 'reject',
    },
    {
      name: 'an empty weekday list',
      medication: {},
      rules: [{ localTime: '08:00', daysOfWeek: [] }],
      validator: 'reject',
      database: 'reject',
    },
    {
      name: 'a day range with only a start',
      medication: {},
      rules: [{ localTime: '08:00', dayFrom: 2 }],
      validator: 'reject',
      database: 'reject',
    },
    {
      name: 'a day range that runs backwards',
      medication: {},
      rules: [{ localTime: '08:00', dayFrom: 4, dayTo: 3 }],
      validator: 'reject',
      database: 'reject',
    },

    // The validator is deliberately stricter than the database here: the database is the last
    // line of defence and checks only what it can without knowing the course.
    {
      name: 'a time written 8:00',
      medication: {},
      rules: [{ localTime: '8:00' }],
      validator: 'reject',
      database: 'accept',
    },
    {
      name: 'a drug that outlasts the course',
      medication: { activeToDay: 8 },
      rules: daily,
      validator: 'reject',
      database: 'accept',
    },
    {
      name: 'a rule outside the drug’s own days',
      medication: { activeFromDay: 2, activeToDay: 5 },
      rules: [{ localTime: '08:00', dayFrom: 1, dayTo: 5 }],
      validator: 'reject',
      database: 'accept',
    },
    {
      name: 'a scheduled drug with no schedule',
      medication: {},
      rules: [],
      validator: 'reject',
      database: 'accept',
    },
  ];

  it.each(cases)('$name: validator says $validator, database says $database', async (planCase) => {
    const { revisionId } = await newCourse();
    const { medication } = planCase;
    const prn = medication.prn ?? false;
    const lineId = randomUUID();

    const input: MedicationInput = {
      id: 'm',
      lineId,
      prn,
      maxDailyDoses: medication.maxDailyDoses ?? null,
      minimumIntervalMinutes: medication.minimumIntervalMinutes ?? null,
      activeFromDay: medication.activeFromDay ?? 1,
      activeToDay: medication.activeToDay ?? 7,
      rules: planCase.rules.map((rule, index): RuleInput => ({ id: `r${String(index)}`, ...rule })),
    };
    const verdict = validatePlan({
      durationDays: 7,
      timezone: 'Asia/Tashkent',
      medications: [input],
    });
    expect(verdict.length === 0 ? 'accept' : 'reject', JSON.stringify(verdict)).toBe(
      planCase.validator,
    );

    let databaseAccepts = await accepted(sql()`
      insert into course_medications
        (revision_id, line_id, display_name, dose_value, dose_unit, active_from_day, active_to_day,
         prn, max_daily_doses, minimum_interval_minutes)
      values (${revisionId}, ${lineId}, 'Testamol', 500, 'MG', ${input.activeFromDay}, ${input.activeToDay},
              ${prn}, ${input.maxDailyDoses ?? null}, ${input.minimumIntervalMinutes ?? null})`);
    if (databaseAccepts) {
      const [row] = await sql()<{ id: string }[]>`
        select id from course_medications where revision_id = ${revisionId} and line_id = ${lineId}`;
      for (const rule of planCase.rules) {
        databaseAccepts &&= await accepted(sql()`
          insert into schedule_rules (medication_id, local_time, days_of_week, day_from, day_to)
          values (${row?.id ?? ''}, ${rule.localTime}, ${rule.daysOfWeek === undefined || rule.daysOfWeek === null ? null : `{${rule.daysOfWeek.join(',')}}`}::smallint[],
                  ${rule.dayFrom ?? null}, ${rule.dayTo ?? null})`);
      }
    }
    expect(databaseAccepts ? 'accept' : 'reject').toBe(planCase.database);
  });
});

describe('a laid-out schedule', () => {
  /** Two drugs written to a draft revision, returned in the shape the schedule package reads. */
  async function storedPlan(): Promise<{
    courseId: string;
    revisionId: string;
    medications: MedicationInput[];
  }> {
    const { courseId, revisionId } = await newCourse();
    const medications: MedicationInput[] = [];

    const drugs = [
      {
        name: 'Alpha',
        times: [
          { time: '08:00', days: null },
          { time: '20:00', days: null },
        ],
      },
      { name: 'Beta', times: [{ time: '12:00', days: [1, 3, 5] }] },
    ];
    for (const drug of drugs) {
      const lineId = randomUUID();
      const [stored] = await sql()<{ id: string }[]>`
        insert into course_medications
          (revision_id, line_id, display_name, dose_value, dose_unit, active_from_day, active_to_day)
        values (${revisionId}, ${lineId}, ${drug.name}, 1, 'TABLET', 1, 7) returning id`;
      const rules: RuleInput[] = [];
      for (const { time, days } of drug.times) {
        const [rule] = await sql()<{ id: string }[]>`
          insert into schedule_rules (medication_id, local_time, days_of_week)
          values (${stored?.id ?? ''}, ${time}, ${days === null ? null : `{${days.join(',')}}`}::smallint[])
          returning id`;
        rules.push({ id: rule?.id ?? '', localTime: time, daysOfWeek: days });
      }
      medications.push({
        id: stored?.id ?? '',
        lineId,
        prn: false,
        activeFromDay: 1,
        activeToDay: 7,
        rules,
      });
    }
    return { courseId, revisionId, medications };
  }

  const timeline = { effectiveStartDate: '2026-10-02', timezone: 'Asia/Tashkent', durationDays: 7 };

  async function insertDoses(
    courseId: string,
    revisionId: string,
    slots: readonly Slot[],
  ): Promise<void> {
    for (const slot of slots) {
      await sql()`
        insert into scheduled_doses
          (course_id, revision_id, medication_id, medication_line_id, schedule_rule_id, scheduled_at, deadline_at)
        values (${courseId}, ${revisionId}, ${slot.medicationId}, ${slot.medicationLineId}, ${slot.ruleId},
                ${slot.scheduledAt}, ${deadlineAt(slot.scheduledAt, DEFAULT_REMINDER_POLICY)})`;
    }
  }

  it('goes into scheduled_doses without a single constraint violation', async () => {
    const { courseId, revisionId, medications } = await storedPlan();
    expect(validatePlan({ durationDays: 7, timezone: timeline.timezone, medications })).toEqual([]);

    const slots = generateSlots({ medications, timeline });
    expect(slots.length).toBe(7 * 2 + 3); // Alpha twice a day for 7 days, Beta Fri/Mon/Wed
    await insertDoses(courseId, revisionId, slots);

    const [row] = await sql()<{ count: number }[]>`
      select count(*)::int as count from scheduled_doses where course_id = ${courseId}`;
    expect(row?.count).toBe(slots.length);
  });

  it('can be replaced: superseded slots are free again for the new plan', async () => {
    const { courseId, revisionId, medications } = await storedPlan();
    const slots = generateSlots({ medications, timeline });
    await insertDoses(courseId, revisionId, slots);

    const now = new Date('2026-10-04T10:00:00Z');
    const stored = await sql()<
      { id: string; scheduled_at: Date; deadline_at: Date; status: 'SCHEDULED' }[]
    >`select id, scheduled_at, deadline_at, status from scheduled_doses where course_id = ${courseId}`;
    const plan = planRevisionSwitch({
      existing: stored.map((row) => ({
        id: row.id,
        scheduledAt: row.scheduled_at,
        deadlineAt: row.deadline_at,
        status: row.status,
      })),
      newSlots: generateSlots({ medications, timeline }),
      now,
    });
    expect(plan.supersede.length).toBeGreaterThan(0);
    expect(plan.create.length).toBe(plan.supersede.length);

    await sql()`update scheduled_doses set status = 'SUPERSEDED' where id in ${sql()(plan.supersede)}`;
    await insertDoses(courseId, revisionId, plan.create);

    const [live] = await sql()<{ count: number }[]>`
      select count(*)::int as count from scheduled_doses
      where course_id = ${courseId} and status <> 'SUPERSEDED' and scheduled_at > ${now}`;
    expect(live?.count).toBe(plan.create.length);
    const [total] = await sql()<{ count: number }[]>`
      select count(*)::int as count from scheduled_doses
      where course_id = ${courseId} and status <> 'SUPERSEDED'`;
    expect(total?.count).toBe(slots.length);
  });

  it('is refused by the database if the same slots are inserted twice, as the generator already refuses duplicates', async () => {
    const { courseId, revisionId, medications } = await storedPlan();
    const slots = generateSlots({ medications, timeline });
    await insertDoses(courseId, revisionId, slots);
    await expect(insertDoses(courseId, revisionId, slots.slice(0, 1))).rejects.toMatchObject({
      constraint_name: 'scheduled_doses_slot_idx',
    });
  });
});
