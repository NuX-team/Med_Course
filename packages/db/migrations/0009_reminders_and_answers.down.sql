delete from conversation_states where flow = 'DOSE';
alter table conversation_states drop constraint conversation_states_flow_chk;
alter table conversation_states
  add constraint conversation_states_flow_chk
    check (flow in ('ONBOARDING', 'SETTINGS', 'DOCTOR', 'INVITE', 'COURSE'));
drop index notifications_stuck_idx;
delete from notifications where attempt_no > 10;
alter table notifications drop constraint notifications_attempt_no_chk;
alter table notifications
  add constraint notifications_attempt_no_chk check (attempt_no between 1 and 10);
alter table notifications drop column last_error, drop column tries;
