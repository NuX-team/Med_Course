-- Starting a course (ARCHITECTURE §5.2, §8): when the patient starts, every dose of the plan
-- becomes a row in scheduled_doses, and every reminder for it a row here, with the moment it
-- is due already worked out. The worker (stage 8) only has to send what is due.

create table notifications (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references treatment_courses (id),
  scheduled_dose_id uuid not null,
  recipient_user_id uuid not null references users (id),
  kind text not null
    constraint notifications_kind_chk check (kind in ('DOSE_REMINDER', 'DOSE_LEAD')),
  -- Which reminder for this dose: 1 at the slot time, then the retries.
  attempt_no integer not null default 1
    constraint notifications_attempt_no_chk check (attempt_no between 1 and 10),
  due_at timestamptz not null,
  status text not null default 'QUEUED'
    constraint notifications_status_chk
      check (status in ('QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED')),
  -- While SENDING: after this moment another worker may take the row over.
  locked_until timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A reminder belongs to a dose of the same course.
  constraint notifications_dose_fk
    foreign key (scheduled_dose_id, course_id) references scheduled_doses (id, course_id),
  constraint notifications_sent_chk check ((status = 'SENT') = (sent_at is not null)),
  constraint notifications_lock_chk check ((status = 'SENDING') = (locked_until is not null))
);
-- One row per dose, kind and attempt: materialising twice cannot double the reminders.
create unique index notifications_dose_attempt_idx
  on notifications (scheduled_dose_id, kind, attempt_no);
-- What the outbox reads: only what is still waiting, by when it is due.
create index notifications_due_idx on notifications (due_at) where status = 'QUEUED';
create index notifications_course_idx on notifications (course_id);

create trigger notifications_set_updated_at before update on notifications
  for each row execute function set_updated_at();
