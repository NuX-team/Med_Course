-- Drafting a course in the bot (ARCHITECTURE §6.1, TZ §5.1).

-- A doctor has at most one unfinished course per patient: opening "a new course" for someone
-- who already has a draft continues that draft, and two taps cannot create two.
create unique index treatment_courses_one_draft_idx
  on treatment_courses (care_relationship_id) where status = 'DRAFT';

alter table conversation_states drop constraint conversation_states_flow_chk;
alter table conversation_states
  add constraint conversation_states_flow_chk
    check (flow in ('ONBOARDING', 'SETTINGS', 'DOCTOR', 'INVITE', 'COURSE'));
