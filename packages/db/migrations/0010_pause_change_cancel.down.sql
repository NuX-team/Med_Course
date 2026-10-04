drop index treatment_courses_running_idx;
drop index course_revisions_one_pending_idx;

-- The older rule wants a moment of application on every superseded plan. A plan that was never
-- applied has none, so the moment it stopped being current stands in for it.
alter table course_revisions drop constraint course_revisions_applied_chk;
update course_revisions
  set applied_at = coalesce(confirmed_by_clinician_at, created_at)
  where status = 'SUPERSEDED' and applied_at is null;
alter table course_revisions
  add constraint course_revisions_applied_chk
    check (status not in ('APPLIED', 'SUPERSEDED') or applied_at is not null);

drop table course_pauses;
drop function course_pauses_guard();
