delete from conversation_states where flow = 'CAREGIVER';
alter table conversation_states drop constraint conversation_states_flow_chk;
alter table conversation_states
  add constraint conversation_states_flow_chk
    check (flow in ('ONBOARDING', 'SETTINGS', 'DOCTOR', 'INVITE', 'COURSE', 'DOSE'));

drop table caregiver_invitations;
