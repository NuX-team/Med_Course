-- History, as-needed (PRN) intake and what the doctor is told (ARCHITECTURE §8, §11; TZ §5.3, §7.6).

-- Messages owed to a doctor about one of their courses: a dose not taken, a run of them, a
-- reminder that could not be delivered, a patient asking for a pause. Like the reminder queue,
-- a row is written in the transaction of the fact it reports and sent later by the worker; the
-- text is composed when it is sent, from what is true then.
create table doctor_alerts (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references treatment_courses (id),
  recipient_user_id uuid not null references users (id),
  kind text not null
    constraint doctor_alerts_kind_chk check (kind in (
      'MISSED', 'SKIPPED', 'SERIES', 'DIGEST', 'UNDELIVERED', 'PAUSE_REQUEST', 'PRN_OVER'
    )),
  -- SKIPPED: the dose. Null for alerts about a moment or about the course as a whole.
  scheduled_dose_id uuid,
  -- MISSED and SERIES: the moment the doses were due. DIGEST: since when it counts.
  slot_at timestamptz,
  -- PRN_OVER: which as-needed medication.
  medication_line_id uuid,
  -- One alert per fact, however many times the fact is noticed.
  dedupe_key text not null
    constraint doctor_alerts_dedupe_key_len_chk check (length(dedupe_key) between 1 and 200),
  due_at timestamptz not null,
  status text not null default 'QUEUED'
    constraint doctor_alerts_status_chk
      check (status in ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED')),
  locked_until timestamptz,
  sent_at timestamptz,
  tries integer not null default 0 constraint doctor_alerts_tries_chk check (tries >= 0),
  -- A machine code for the last failure, never free text.
  last_error text
    constraint doctor_alerts_last_error_len_chk check (last_error is null or length(last_error) <= 60),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint doctor_alerts_dedupe_key_key unique (dedupe_key),
  constraint doctor_alerts_dose_fk
    foreign key (scheduled_dose_id, course_id) references scheduled_doses (id, course_id),
  constraint doctor_alerts_sent_chk check ((status = 'SENT') = (sent_at is not null)),
  constraint doctor_alerts_lock_chk check ((status = 'SENDING') = (locked_until is not null)),
  constraint doctor_alerts_skipped_chk check ((kind = 'SKIPPED') = (scheduled_dose_id is not null)),
  constraint doctor_alerts_slot_chk
    check (kind not in ('MISSED', 'SERIES', 'DIGEST') or slot_at is not null),
  constraint doctor_alerts_prn_chk check ((kind = 'PRN_OVER') = (medication_line_id is not null))
);
create index doctor_alerts_due_idx on doctor_alerts (due_at) where status = 'QUEUED';
create index doctor_alerts_stuck_idx on doctor_alerts (locked_until) where status = 'SENDING';
create index doctor_alerts_course_idx on doctor_alerts (course_id, kind, due_at);

create trigger doctor_alerts_set_updated_at before update on doctor_alerts
  for each row execute function set_updated_at();

-- A patient may take back an as-needed mark made by mistake. The log is append-only, so the
-- taking back is an event of its own that names the mark it cancels (in `details`).
alter table dose_events drop constraint dose_events_event_type_chk;
alter table dose_events
  add constraint dose_events_event_type_chk check (event_type in (
    'NOTIFIED', 'SNOOZED', 'TAKEN', 'SKIPPED', 'MISSED', 'LATE_TAKEN', 'CORRECTION', 'SUPERSEDED',
    'PRN_TAKEN', 'PRN_CANCELLED'
  ));
alter table dose_events drop constraint dose_events_prn_chk;
alter table dose_events
  add constraint dose_events_prn_chk
    check ((event_type in ('PRN_TAKEN', 'PRN_CANCELLED')) = (scheduled_dose_id is null));
alter table dose_events drop constraint dose_events_prn_line_chk;
alter table dose_events
  add constraint dose_events_prn_line_chk
    check (event_type not in ('PRN_TAKEN', 'PRN_CANCELLED') or medication_line_id is not null);

-- Counting as-needed intake of one drug over the last day.
create index dose_events_prn_idx on dose_events (course_id, medication_line_id, occurred_at)
  where scheduled_dose_id is null;
