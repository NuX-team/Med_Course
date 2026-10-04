-- Privacy (TZ §12, §12.1): leaving a doctor, withdrawing consent, asking for one's data to be
-- deleted, and the short summary of a finished course for a later doctor.

-- A request to delete one's data. Access ends the moment it is made; the data itself is
-- anonymised when the request falls due, and until then the person may take the request back.
create table deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  status text not null default 'PENDING'
    constraint deletion_requests_status_chk check (status in ('PENDING', 'CANCELLED', 'DONE')),
  requested_at timestamptz not null,
  due_at timestamptz not null,
  -- When it was taken back, or carried out.
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint deletion_requests_due_chk check (due_at > requested_at),
  constraint deletion_requests_closed_chk check ((status = 'PENDING') = (closed_at is null))
);
create unique index deletion_requests_open_idx on deletion_requests (user_id) where status = 'PENDING';
create index deletion_requests_due_idx on deletion_requests (due_at) where status = 'PENDING';
create trigger deletion_requests_set_updated_at before update on deletion_requests
  for each row execute function set_updated_at();

-- An anonymised account keeps its row (courses and the audit trail point at it) but not the
-- Telegram id: that is replaced by a negative number that identifies nobody, which also lets
-- the same person register afresh later.
create sequence erased_users_seq;
alter table users drop constraint users_telegram_user_id_chk;
alter table users add constraint users_telegram_user_id_chk
  check (telegram_user_id > 0 or (status = 'DELETED' and telegram_user_id < 0));

-- The patient lets this doctor read the summaries of their earlier courses.
alter table care_relationships add column history_shared_at timestamptz;

-- What is kept of a finished course for a later doctor (TZ §12.1): dates, drugs, figures.
-- No instructions, no reasons, nothing a person typed about themselves.
create table course_summaries (
  course_id uuid primary key references treatment_courses (id),
  patient_id uuid not null references users (id),
  clinician_id uuid not null references users (id),
  content jsonb not null,
  created_at timestamptz not null
);
create index course_summaries_patient_idx on course_summaries (patient_id, created_at);

-- Anonymisation has to blank free text in two places that are otherwise frozen: what a patient
-- wrote about a skipped dose (an append-only journal) and what a doctor wrote for the patient in
-- a signed-off plan. Both guards let exactly that through, and only inside a transaction that
-- has said `set local medcourse.erasure = 'on'`: the text set to null, every other column as
-- it was.
create or replace function forbid_modification() returns trigger
language plpgsql as $$
begin
  -- Nested, and through jsonb: this function serves tables that have no such column, and a
  -- statement-level TRUNCATE that has no row at all.
  if tg_op = 'UPDATE' and tg_table_name = 'dose_events' then
    if current_setting('medcourse.erasure', true) = 'on'
       and (to_jsonb(new) ->> 'reason_text_enc') is null
       and (to_jsonb(new) - 'reason_text_enc') = (to_jsonb(old) - 'reason_text_enc') then
      return new;
    end if;
  end if;
  raise exception '% on % is not allowed: the table is append-only', tg_op, tg_table_name
    using errcode = 'restrict_violation';
end
$$;

create or replace function course_medications_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and current_setting('medcourse.erasure', true) = 'on'
     and new.instructions_enc is null
     and (to_jsonb(new) - 'instructions_enc' - 'updated_at')
       = (to_jsonb(old) - 'instructions_enc' - 'updated_at') then
    return new;
  end if;
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
