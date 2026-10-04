delete from conversation_states where flow = 'COURSE';
alter table conversation_states drop constraint conversation_states_flow_chk;
alter table conversation_states
  add constraint conversation_states_flow_chk
    check (flow in ('ONBOARDING', 'SETTINGS', 'DOCTOR', 'INVITE'));
drop index treatment_courses_one_draft_idx;
