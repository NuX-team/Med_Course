-- Who did what to which record (ARCHITECTURE §9). Insert-only: the triggers below refuse
-- UPDATE, DELETE and TRUNCATE for every role. Production additionally revokes those privileges
-- from the application role (stage 14 hardening).
--
-- Contents are minimal on purpose: field names and hashes, never clinical text.

create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_kind text not null
    constraint audit_log_actor_kind_chk check (actor_kind in (
      'PATIENT', 'CLINICIAN', 'CLINIC_STAFF', 'CAREGIVER', 'TECH_ADMIN', 'SYSTEM'
    )),
  -- Deliberately not a foreign key: the trail must outlive the user it names.
  actor_user_id uuid,
  entity_type text not null constraint audit_log_entity_type_len_chk check (length(entity_type) between 1 and 64),
  entity_id text not null constraint audit_log_entity_id_len_chk check (length(entity_id) between 1 and 128),
  action text not null constraint audit_log_action_len_chk check (length(action) between 1 and 64),
  -- Names of the fields that changed, not their values.
  changes text[] not null default '{}',
  before_hash text,
  after_hash text,
  reason text,
  request_id text
);
create index audit_log_entity_idx on audit_log (entity_type, entity_id, at);
create index audit_log_actor_idx on audit_log (actor_user_id, at);

create trigger audit_log_append_only before update or delete on audit_log
  for each row execute function forbid_modification();
create trigger audit_log_no_truncate before truncate on audit_log
  for each statement execute function forbid_modification();
