-- Doctor registration and connecting a patient to a doctor (ARCHITECTURE §7, TZ §5.1).

-- What the applicant says about themselves, for whoever verifies them. Free text, never used
-- for anything but that review.
alter table clinician_profiles
  add column applicant_note text
    constraint clinician_profiles_applicant_note_len_chk
      check (applicant_note is null or length(btrim(applicant_note)) between 1 and 500);

-- A one-time link a doctor hands to a patient. The code itself is never stored: only its
-- SHA-256, so a database dump cannot be turned into working links. Using it creates the
-- (still unconfirmed) care relationship in the same transaction.
create table invitations (
  id uuid primary key default gen_random_uuid(),
  clinician_id uuid not null references clinician_profiles (user_id),
  code_hash text not null constraint invitations_code_hash_chk check (code_hash ~ '^[0-9a-f]{64}$'),
  -- The doctor's own note about who this is for; the patient never sees it.
  label text constraint invitations_label_len_chk check (label is null or length(btrim(label)) between 1 and 100),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by uuid,
  care_relationship_id uuid,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint invitations_code_hash_key unique (code_hash),
  constraint invitations_expiry_chk check (expires_at > created_at),
  -- Used means all three of: when, by whom, and the relationship it produced.
  constraint invitations_used_chk check (
    (used_at is null) = (used_by is null) and (used_at is null) = (care_relationship_id is null)
  ),
  -- An invitation is either used or withdrawn, never both.
  constraint invitations_final_chk check (used_at is null or revoked_at is null),
  -- The relationship it produced must be between exactly this doctor and this patient.
  constraint invitations_relationship_fk foreign key (care_relationship_id, used_by, clinician_id)
    references care_relationships (id, patient_id, clinician_id)
);
create index invitations_clinician_idx on invitations (clinician_id, created_at);

-- Wrong or unusable codes tried by a Telegram user, to slow down guessing. Only failures are
-- recorded, and only the Telegram id, never the code that was tried.
create table invitation_attempts (
  id bigint generated always as identity primary key,
  telegram_user_id bigint not null
    constraint invitation_attempts_telegram_user_id_chk check (telegram_user_id > 0),
  at timestamptz not null default now()
);
create index invitation_attempts_user_idx on invitation_attempts (telegram_user_id, at);

alter table conversation_states drop constraint conversation_states_flow_chk;
alter table conversation_states
  add constraint conversation_states_flow_chk
    check (flow in ('ONBOARDING', 'SETTINGS', 'DOCTOR', 'INVITE'));
