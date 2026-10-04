-- Telling people about an incident (TZ §14, ARCHITECTURE §12): an incident that nobody is told
-- about is found only by whoever happens to open the panel. The worker sends one short message
-- to those who handle it, and these columns say how that went: how many times it was tried, when
-- last, and when it counted as done.
alter table incidents
  add column notice_tries integer not null default 0
    constraint incidents_notice_tries_chk check (notice_tries between 0 and 100),
  add column last_notice_at timestamptz,
  add column notified_at timestamptz;

-- Incidents opened before this migration were seen in the panel: they are not announced now.
update incidents set notified_at = coalesce(updated_at, now()) where notified_at is null;

-- What the worker looks for: incidents still waiting to be announced.
create index incidents_unnoticed_idx on incidents (opened_at) where notified_at is null;
