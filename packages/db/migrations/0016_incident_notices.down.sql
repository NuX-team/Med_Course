drop index incidents_unnoticed_idx;
alter table incidents
  drop column notified_at,
  drop column last_notice_at,
  drop column notice_tries;
