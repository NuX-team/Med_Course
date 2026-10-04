-- Sending reminders and recording what the patient answers (ARCHITECTURE §6.2, §8).

-- How many times sending was tried, and the machine code of the last failure (never free text).
alter table notifications
  add column tries integer not null default 0
    constraint notifications_tries_chk check (tries >= 0),
  add column last_error text
    constraint notifications_last_error_len_chk check (last_error is null or length(last_error) <= 60);

-- "Later" adds a reminder of its own, so a dose can have more attempts than its policy plans.
alter table notifications drop constraint notifications_attempt_no_chk;
alter table notifications
  add constraint notifications_attempt_no_chk check (attempt_no between 1 and 30);

-- A reminder stuck in SENDING (the worker died mid-send) is taken over once its lock runs out.
create index notifications_stuck_idx on notifications (locked_until) where status = 'SENDING';

alter table conversation_states drop constraint conversation_states_flow_chk;
alter table conversation_states
  add constraint conversation_states_flow_chk
    check (flow in ('ONBOARDING', 'SETTINGS', 'DOCTOR', 'INVITE', 'COURSE', 'DOSE'));
