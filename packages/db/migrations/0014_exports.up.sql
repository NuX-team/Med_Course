-- Reports of a course handed out as files (TZ §14.3): who asked, for which course, in which
-- format, and when. The file itself is never stored: it is built from the data and sent to the
-- person who asked. The rows are the record of that, and what the hourly limit is counted from.
create table course_exports (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references treatment_courses (id),
  requested_by uuid not null references users (id),
  -- The capacity the person asked in: only the patient and the treating doctor may.
  actor_kind text not null
    constraint course_exports_actor_kind_chk check (actor_kind in ('PATIENT', 'CLINICIAN')),
  format text not null constraint course_exports_format_chk check (format in ('CSV', 'PDF')),
  created_at timestamptz not null
);
create index course_exports_requester_idx on course_exports (requested_by, created_at);
create index course_exports_course_idx on course_exports (course_id, created_at);

create trigger course_exports_append_only before update or delete on course_exports
  for each row execute function forbid_modification();
create trigger course_exports_no_truncate before truncate on course_exports
  for each statement execute function forbid_modification();
