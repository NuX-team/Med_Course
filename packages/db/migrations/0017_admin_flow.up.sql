-- The administrator's section in the bot (stage 16): a typed answer (what was checked about a
-- doctor, or who to make an administrator) is remembered under its own conversation flow.
alter table conversation_states drop constraint conversation_states_flow_chk;
alter table conversation_states
  add constraint conversation_states_flow_chk
    check (flow in ('ONBOARDING', 'SETTINGS', 'DOCTOR', 'INVITE', 'COURSE', 'DOSE', 'CAREGIVER', 'ADMIN'));
