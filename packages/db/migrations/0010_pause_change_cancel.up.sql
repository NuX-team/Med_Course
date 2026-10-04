-- Pausing a course, changing its plan, cancelling it and finishing it (ARCHITECTURE §5.4, §5.5, §6.1).

-- When a course was on hold. The end of a course is counted in days of treatment, so these
-- intervals are what moves it: a day wholly inside one is not counted.
create table course_pauses (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references treatment_courses (id),
  paused_at timestamptz not null,
  paused_by uuid not null references users (id),
  -- Null while the course is still on hold.
  resumed_at timestamptz,
  resumed_by uuid references users (id),
  created_at timestamptz not null default now(),

  constraint course_pauses_order_chk check (resumed_at is null or resumed_at > paused_at),
  constraint course_pauses_resumed_pair_chk check ((resumed_at is null) = (resumed_by is null))
);
-- A course is on hold at most once at a time.
create unique index course_pauses_one_open_idx on course_pauses (course_id) where resumed_at is null;
create index course_pauses_course_idx on course_pauses (course_id, paused_at);

-- A pause is history: it can be closed once, and nothing else about it ever changes.
create function course_pauses_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a pause of course % is history and cannot be deleted', old.course_id
      using errcode = 'restrict_violation';
  end if;
  if new.course_id <> old.course_id or new.paused_at <> old.paused_at or new.paused_by <> old.paused_by then
    raise exception 'the start of pause % is fixed', old.id using errcode = 'restrict_violation';
  end if;
  if old.resumed_at is not null
     and (new.resumed_at is distinct from old.resumed_at or new.resumed_by is distinct from old.resumed_by) then
    raise exception 'pause % is already closed', old.id using errcode = 'restrict_violation';
  end if;
  return new;
end
$$;
create trigger course_pauses_guard before update or delete on course_pauses
  for each row execute function course_pauses_guard();

-- A plan that was proposed and then withdrawn (or outlived by its course) is SUPERSEDED without
-- ever having been applied.
alter table course_revisions drop constraint course_revisions_applied_chk;
alter table course_revisions
  add constraint course_revisions_applied_chk check (status <> 'APPLIED' or applied_at is not null);

-- One plan in the making per course: either still being written or waiting for the patient.
create unique index course_revisions_one_pending_idx
  on course_revisions (course_id) where status in ('DRAFT', 'CONFIRMED');

-- The completion sweeper looks for running courses by when they started.
create index treatment_courses_running_idx on treatment_courses (effective_start_date) where status = 'ACTIVE';
