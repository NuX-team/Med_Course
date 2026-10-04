-- A caregiver watches a patient's course (TZ §5.6, D-14): added by the doctor, allowed by the
-- patient, read-only. The relationship table exists since the foundation; this adds the
-- one-time link a doctor hands to the caregiver.

-- Like a patient invitation: the code itself is never stored, only its SHA-256. Using the link
-- creates the (not yet allowed) caregiver relationship in the same transaction.
create table caregiver_invitations (
  id uuid primary key default gen_random_uuid(),
  care_relationship_id uuid not null,
  patient_id uuid not null,
  clinician_id uuid not null,
  code_hash text not null
    constraint caregiver_invitations_code_hash_chk check (code_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid references users (id),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),

  constraint caregiver_invitations_code_hash_key unique (code_hash),
  -- Issued by exactly the doctor who treats exactly this patient.
  constraint caregiver_invitations_relationship_fk
    foreign key (care_relationship_id, patient_id, clinician_id)
    references care_relationships (id, patient_id, clinician_id),
  constraint caregiver_invitations_expiry_chk check (expires_at > created_at),
  constraint caregiver_invitations_used_chk check ((used_at is null) = (used_by is null)),
  constraint caregiver_invitations_final_chk check (used_at is null or revoked_at is null),
  -- Nobody is invited to watch over themselves.
  constraint caregiver_invitations_self_chk check (used_by is null or used_by <> patient_id)
);
create index caregiver_invitations_patient_idx on caregiver_invitations (patient_id, created_at);

alter table conversation_states drop constraint conversation_states_flow_chk;
alter table conversation_states
  add constraint conversation_states_flow_chk
    check (flow in ('ONBOARDING', 'SETTINGS', 'DOCTOR', 'INVITE', 'COURSE', 'DOSE', 'CAREGIVER'));
