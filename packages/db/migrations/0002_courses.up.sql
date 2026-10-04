-- Courses, their versioned plans and reminder policy (ARCHITECTURE §4.1, §5, §6.1).

create table treatment_courses (
  id uuid primary key default gen_random_uuid(),
  care_relationship_id uuid not null,
  patient_id uuid not null,
  clinician_id uuid not null,
  clinic_id uuid not null,
  status text not null default 'DRAFT'
    constraint treatment_courses_status_chk check (status in (
      'DRAFT', 'PENDING_PATIENT', 'ACTIVE', 'PAUSED', 'CANCELLATION_REVIEW',
      'CANCELLED', 'EXPIRED_NOT_STARTED', 'COMPLETED', 'ARCHIVED'
    )),
  duration_days integer not null,
  planned_start_at timestamptz,
  start_window_from timestamptz,
  start_window_to timestamptz,
  start_at timestamptz,
  effective_start_date date,
  timezone text not null constraint treatment_courses_timezone_len_chk check (length(timezone) between 1 and 64),
  current_revision_id uuid,
  ended_at timestamptz,
  cancellation_reason_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The course must name a real doctor-patient link AND agree with its two ends, and the
  -- clinic must be the clinician's own: a course cannot be wired to someone else's patient.
  constraint treatment_courses_relationship_fk
    foreign key (care_relationship_id, patient_id, clinician_id)
    references care_relationships (id, patient_id, clinician_id),
  constraint treatment_courses_clinician_clinic_fk
    foreign key (clinician_id, clinic_id) references clinician_profiles (user_id, clinic_id),

  constraint treatment_courses_duration_chk check (duration_days between 1 and 365),
  constraint treatment_courses_window_chk check (
    (start_window_from is null) = (start_window_to is null)
    and (start_window_from is null or start_window_from <= start_window_to)
  ),
  constraint treatment_courses_start_pair_chk check ((start_at is null) = (effective_start_date is null)),
  -- A running or finished course has started; one that never started has no start.
  constraint treatment_courses_started_chk
    check (status not in ('ACTIVE', 'PAUSED', 'COMPLETED') or start_at is not null),
  constraint treatment_courses_not_started_chk
    check (status not in ('DRAFT', 'PENDING_PATIENT', 'EXPIRED_NOT_STARTED') or start_at is null),
  constraint treatment_courses_ended_chk check (
    status not in ('COMPLETED', 'CANCELLED', 'EXPIRED_NOT_STARTED', 'ARCHIVED') or ended_at is not null
  )
);
create index treatment_courses_patient_idx on treatment_courses (patient_id, status);
create index treatment_courses_clinician_idx on treatment_courses (clinician_id, status);
create index treatment_courses_clinic_idx on treatment_courses (clinic_id, status);
create index treatment_courses_relationship_idx on treatment_courses (care_relationship_id);
create index treatment_courses_planned_start_idx on treatment_courses (planned_start_at);
create index treatment_courses_start_idx on treatment_courses (start_at);

-- One row per version of the plan. A confirmed revision is history and never changes.
create table course_revisions (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references treatment_courses (id),
  rev_no integer not null constraint course_revisions_rev_no_chk check (rev_no >= 1),
  status text not null default 'DRAFT'
    constraint course_revisions_status_chk check (status in ('DRAFT', 'CONFIRMED', 'APPLIED', 'SUPERSEDED')),
  created_by uuid not null references users (id),
  reason text,
  confirmed_by_clinician_at timestamptz,
  confirmed_by_patient_at timestamptz,
  applied_at timestamptz,
  created_at timestamptz not null default now(),
  constraint course_revisions_course_rev_key unique (course_id, rev_no),
  -- Target of composite foreign keys that must stay inside one course.
  constraint course_revisions_course_id_key unique (course_id, id),
  constraint course_revisions_confirmed_chk
    check (status = 'DRAFT' or confirmed_by_clinician_at is not null),
  constraint course_revisions_applied_chk
    check (status not in ('APPLIED', 'SUPERSEDED') or applied_at is not null)
);
create unique index course_revisions_one_applied_idx on course_revisions (course_id) where status = 'APPLIED';

alter table treatment_courses
  add constraint treatment_courses_current_revision_fk
  foreign key (id, current_revision_id) references course_revisions (course_id, id);

create table course_medications (
  id uuid primary key default gen_random_uuid(),
  revision_id uuid not null references course_revisions (id),
  -- Stable across the revisions of one course: the identity of "this drug in this course".
  line_id uuid not null,
  display_name text not null
    constraint course_medications_name_len_chk check (length(btrim(display_name)) between 1 and 120),
  dose_value numeric(10, 3) not null constraint course_medications_dose_value_chk check (dose_value > 0),
  dose_unit text not null
    constraint course_medications_dose_unit_chk check (dose_unit in (
      'MG', 'G', 'MCG', 'ML', 'TABLET', 'CAPSULE', 'DROP', 'IU', 'PUFF', 'SACHET', 'OTHER'
    )),
  -- The doctor's own wording, e.g. "1/2 tablet" (TZ §9.2: keep the displayed original).
  dose_display text constraint course_medications_dose_display_len_chk check (length(dose_display) <= 60),
  food_rule text not null default 'ANY'
    constraint course_medications_food_rule_chk
      check (food_rule in ('BEFORE_MEAL', 'WITH_MEAL', 'AFTER_MEAL', 'ANY')),
  instructions_enc text,
  prn boolean not null default false,
  max_daily_doses integer constraint course_medications_max_daily_chk check (max_daily_doses >= 1),
  minimum_interval_minutes integer
    constraint course_medications_min_interval_chk check (minimum_interval_minutes >= 1),
  active_from_day integer not null constraint course_medications_from_day_chk check (active_from_day >= 1),
  active_to_day integer not null,
  created_at timestamptz not null default now(),
  constraint course_medications_revision_line_key unique (revision_id, line_id),
  constraint course_medications_id_revision_key unique (id, revision_id),
  constraint course_medications_id_line_key unique (id, line_id),
  constraint course_medications_days_chk check (active_to_day >= active_from_day),
  -- TZ §7.6: an as-needed drug is never published without its limits.
  constraint course_medications_prn_chk
    check (not prn or (max_daily_doses is not null and minimum_interval_minutes is not null)),
  constraint course_medications_other_unit_chk check (dose_unit <> 'OTHER' or dose_display is not null)
);
create index course_medications_revision_idx on course_medications (revision_id);

create table schedule_rules (
  id uuid primary key default gen_random_uuid(),
  medication_id uuid not null references course_medications (id),
  local_time time(0) not null,
  -- ISO weekdays, 1 = Monday. NULL means every day.
  days_of_week smallint[],
  -- Course days this rule covers inside the medication's own range. NULL means all of it.
  day_from integer,
  day_to integer,
  created_at timestamptz not null default now(),
  constraint schedule_rules_id_medication_key unique (id, medication_id),
  constraint schedule_rules_days_of_week_chk check (
    days_of_week is null
    or (cardinality(days_of_week) between 1 and 7 and days_of_week <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[])
  ),
  constraint schedule_rules_day_range_chk check (
    (day_from is null) = (day_to is null) and (day_from is null or (day_from >= 1 and day_to >= day_from))
  )
);
create index schedule_rules_medication_idx on schedule_rules (medication_id);

-- Defaults are the proposal in ARCHITECTURE §5.3 (D-9) and are set per course by the doctor.
create table reminder_policies (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null unique references treatment_courses (id),
  attempts integer not null default 3 constraint reminder_policies_attempts_chk check (attempts between 1 and 10),
  retry_interval_minutes integer not null default 10
    constraint reminder_policies_retry_chk check (retry_interval_minutes between 1 and 120),
  miss_after_minutes integer not null default 30
    constraint reminder_policies_miss_after_chk check (miss_after_minutes between 1 and 1440),
  snooze_options_minutes integer[] not null default '{5,10,15}'
    constraint reminder_policies_snooze_chk check (
      cardinality(snooze_options_minutes) between 1 and 5
      and 0 < all (snooze_options_minutes) and 240 >= all (snooze_options_minutes)
    ),
  max_snoozes integer not null default 3 constraint reminder_policies_max_snoozes_chk check (max_snoozes between 0 and 10),
  correction_window_minutes integer not null default 60
    constraint reminder_policies_correction_chk check (correction_window_minutes between 0 and 10080),
  lead_minutes integer not null default 0 constraint reminder_policies_lead_chk check (lead_minutes between 0 and 240),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The deadline must fall after the last reminder attempt, or that attempt could never be answered.
  constraint reminder_policies_deadline_chk check (miss_after_minutes > (attempts - 1) * retry_interval_minutes)
);

-- Every change of a course's state, with who and why (ARCHITECTURE §6.1). Append-only.
create table course_transitions (
  id bigint generated always as identity primary key,
  course_id uuid not null references treatment_courses (id),
  from_status text
    constraint course_transitions_from_status_chk check (from_status in (
      'DRAFT', 'PENDING_PATIENT', 'ACTIVE', 'PAUSED', 'CANCELLATION_REVIEW',
      'CANCELLED', 'EXPIRED_NOT_STARTED', 'COMPLETED', 'ARCHIVED'
    )),
  to_status text not null
    constraint course_transitions_to_status_chk check (to_status in (
      'DRAFT', 'PENDING_PATIENT', 'ACTIVE', 'PAUSED', 'CANCELLATION_REVIEW',
      'CANCELLED', 'EXPIRED_NOT_STARTED', 'COMPLETED', 'ARCHIVED'
    )),
  actor_kind text not null
    constraint course_transitions_actor_kind_chk check (actor_kind in (
      'PATIENT', 'CLINICIAN', 'CLINIC_STAFF', 'CAREGIVER', 'TECH_ADMIN', 'SYSTEM'
    )),
  actor_user_id uuid references users (id),
  reason text,
  request_id text,
  at timestamptz not null default now(),
  constraint course_transitions_actor_chk check ((actor_kind = 'SYSTEM') = (actor_user_id is null))
);
create index course_transitions_course_idx on course_transitions (course_id, at);

-- Guards ---------------------------------------------------------------------------------

create function assert_revision_is_draft(p_revision_id uuid) returns void
language plpgsql as $$
declare
  v_status text;
begin
  select status into v_status from course_revisions where id = p_revision_id;
  -- A missing revision is reported by the foreign key, not here.
  if v_status is not null and v_status <> 'DRAFT' then
    raise exception 'revision % is %: its plan can no longer change', p_revision_id, v_status
      using errcode = 'restrict_violation';
  end if;
end
$$;

create function course_revisions_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'DRAFT' then
      raise exception 'revision % is %: only drafts can be deleted', old.id, old.status
        using errcode = 'restrict_violation';
    end if;
    return old;
  end if;

  if new.course_id <> old.course_id or new.rev_no <> old.rev_no then
    raise exception 'course_id and rev_no of revision % are fixed', old.id
      using errcode = 'restrict_violation';
  end if;

  if new.status <> old.status and not (
    (old.status = 'DRAFT' and new.status in ('CONFIRMED', 'SUPERSEDED'))
    or (old.status = 'CONFIRMED' and new.status in ('APPLIED', 'SUPERSEDED'))
    or (old.status = 'APPLIED' and new.status = 'SUPERSEDED')
  ) then
    raise exception 'revision % cannot go from % to %', old.id, old.status, new.status
      using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;

create function course_medications_guard() returns trigger
language plpgsql as $$
begin
  if tg_op in ('UPDATE', 'DELETE') then
    perform assert_revision_is_draft(old.revision_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform assert_revision_is_draft(new.revision_id);
  end if;
  if tg_op = 'UPDATE' then
    if new.revision_id <> old.revision_id then
      raise exception 'medication % cannot move to another revision', old.id
        using errcode = 'restrict_violation';
    end if;
    if new.prn and exists (select 1 from schedule_rules where medication_id = new.id) then
      raise exception 'medication % has schedule rules and cannot become as-needed (PRN)', new.id
        using errcode = 'restrict_violation';
    end if;
  end if;
  return coalesce(new, old);
end
$$;

create function schedule_rules_guard() returns trigger
language plpgsql as $$
declare
  v_revision uuid;
  v_prn boolean;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select revision_id into v_revision from course_medications where id = old.medication_id;
    perform assert_revision_is_draft(v_revision);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select revision_id, prn into v_revision, v_prn from course_medications where id = new.medication_id;
    perform assert_revision_is_draft(v_revision);
    -- As-needed drugs have no planned slots (TZ §7.6): nothing may be scheduled for them.
    if v_prn then
      raise exception 'medication % is as-needed (PRN) and cannot have schedule rules', new.medication_id
        using errcode = 'restrict_violation';
    end if;
  end if;
  return coalesce(new, old);
end
$$;

create trigger course_revisions_guard before update or delete on course_revisions
  for each row execute function course_revisions_guard();
create trigger course_medications_guard before insert or update or delete on course_medications
  for each row execute function course_medications_guard();
create trigger schedule_rules_guard before insert or update or delete on schedule_rules
  for each row execute function schedule_rules_guard();

create trigger course_transitions_append_only before update or delete on course_transitions
  for each row execute function forbid_modification();
create trigger course_transitions_no_truncate before truncate on course_transitions
  for each statement execute function forbid_modification();

create trigger treatment_courses_set_updated_at before update on treatment_courses
  for each row execute function set_updated_at();
create trigger reminder_policies_set_updated_at before update on reminder_policies
  for each row execute function set_updated_at();
