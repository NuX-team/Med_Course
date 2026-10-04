-- Materialized dose slots and the append-only log of what happened to them
-- (ARCHITECTURE §4.1, §5.2, §6.2).

create table scheduled_doses (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null,
  revision_id uuid not null,
  medication_id uuid not null,
  medication_line_id uuid not null,
  schedule_rule_id uuid not null,
  scheduled_at timestamptz not null,
  deadline_at timestamptz not null,
  status text not null default 'SCHEDULED'
    constraint scheduled_doses_status_chk check (status in (
      'SCHEDULED', 'NOTIFIED', 'SNOOZED', 'TAKEN', 'SKIPPED', 'MISSED', 'TAKEN_LATE', 'SUPERSEDED'
    )),
  missed_at timestamptz,
  late_taken_at timestamptz,
  finalized_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Every reference stays inside one course, one revision and one medication.
  constraint scheduled_doses_course_revision_fk
    foreign key (course_id, revision_id) references course_revisions (course_id, id),
  constraint scheduled_doses_medication_revision_fk
    foreign key (medication_id, revision_id) references course_medications (id, revision_id),
  constraint scheduled_doses_medication_line_fk
    foreign key (medication_id, medication_line_id) references course_medications (id, line_id),
  constraint scheduled_doses_rule_fk
    foreign key (schedule_rule_id, medication_id) references schedule_rules (id, medication_id),
  constraint scheduled_doses_id_course_key unique (id, course_id),

  constraint scheduled_doses_deadline_chk check (deadline_at > scheduled_at),
  -- finalized_at says "an outcome exists"; MISSED keeps it when it later becomes TAKEN_LATE.
  constraint scheduled_doses_finalized_chk
    check ((status in ('TAKEN', 'SKIPPED', 'MISSED', 'TAKEN_LATE')) = (finalized_at is not null)),
  constraint scheduled_doses_missed_chk check ((status in ('MISSED', 'TAKEN_LATE')) = (missed_at is not null)),
  constraint scheduled_doses_late_chk check ((status = 'TAKEN_LATE') = (late_taken_at is not null))
);
-- Two live slots for one drug at one moment cannot exist (ARCHITECTURE §8.3).
create unique index scheduled_doses_slot_idx
  on scheduled_doses (course_id, medication_line_id, scheduled_at) where status <> 'SUPERSEDED';
-- The sweeper that turns overdue slots into MISSED reads only unresolved ones.
create index scheduled_doses_due_idx
  on scheduled_doses (deadline_at) where status in ('SCHEDULED', 'NOTIFIED', 'SNOOZED');
create index scheduled_doses_course_idx on scheduled_doses (course_id, scheduled_at);

-- Never edited: a correction is a new CORRECTION event, a late tap is a new LATE_TAKEN event.
-- Stage 13 (erasure on request) will have to revisit this trigger deliberately.
create table dose_events (
  id uuid primary key default gen_random_uuid(),
  scheduled_dose_id uuid,
  course_id uuid not null references treatment_courses (id),
  -- Set for as-needed (PRN) intake, which has no scheduled slot.
  medication_line_id uuid,
  event_type text not null
    constraint dose_events_event_type_chk check (event_type in (
      'NOTIFIED', 'SNOOZED', 'TAKEN', 'SKIPPED', 'MISSED', 'LATE_TAKEN', 'CORRECTION', 'SUPERSEDED', 'PRN_TAKEN'
    )),
  actor_kind text not null
    constraint dose_events_actor_kind_chk check (actor_kind in (
      'PATIENT', 'CLINICIAN', 'CLINIC_STAFF', 'CAREGIVER', 'TECH_ADMIN', 'SYSTEM'
    )),
  actor_user_id uuid references users (id),
  reason_code text
    constraint dose_events_reason_code_chk check (reason_code in ('FORGOT', 'NO_MEDICATION', 'OTHER')),
  reason_text_enc text,
  source text not null
    constraint dose_events_source_chk check (source in ('TELEGRAM', 'SYSTEM', 'ADMIN')),
  idempotency_key text not null constraint dose_events_idempotency_key_len_chk check (length(idempotency_key) between 1 and 200),
  -- Machine data only (for example the statuses before and after a CORRECTION). No free text.
  details jsonb,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),

  constraint dose_events_idempotency_key_key unique (idempotency_key),
  constraint dose_events_dose_fk
    foreign key (scheduled_dose_id, course_id) references scheduled_doses (id, course_id),
  constraint dose_events_prn_chk check ((event_type = 'PRN_TAKEN') = (scheduled_dose_id is null)),
  constraint dose_events_prn_line_chk check (event_type <> 'PRN_TAKEN' or medication_line_id is not null),
  constraint dose_events_reason_chk check (reason_code is null or event_type = 'SKIPPED'),
  -- Free text exists only next to "other reason" (TZ §6.4).
  constraint dose_events_reason_text_chk check (reason_text_enc is null or reason_code = 'OTHER'),
  constraint dose_events_actor_chk check ((actor_kind = 'SYSTEM') = (actor_user_id is null)),
  -- Only the system itself writes events marked as coming from the system.
  constraint dose_events_source_actor_chk check ((actor_kind = 'SYSTEM') = (source = 'SYSTEM'))
);
create index dose_events_dose_idx on dose_events (scheduled_dose_id, occurred_at);
create index dose_events_course_idx on dose_events (course_id, occurred_at);

create trigger dose_events_append_only before update or delete on dose_events
  for each row execute function forbid_modification();
create trigger dose_events_no_truncate before truncate on dose_events
  for each statement execute function forbid_modification();

create trigger scheduled_doses_set_updated_at before update on scheduled_doses
  for each row execute function set_updated_at();
