delete from conversation_states where flow in ('DOCTOR', 'INVITE');
alter table conversation_states drop constraint conversation_states_flow_chk;
alter table conversation_states
  add constraint conversation_states_flow_chk check (flow in ('ONBOARDING', 'SETTINGS'));
drop table invitation_attempts;
drop table invitations;
alter table clinician_profiles drop column applicant_note;
