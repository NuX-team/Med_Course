-- People, clinics and who may see whom (ARCHITECTURE §4, §9).
-- Enum-like columns are text + a single-column CHECK named <table>_<column>_chk, because
-- Postgres enum types cannot drop values and would make the down migrations lossy.

create function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- Used by append-only tables: history is corrected by adding rows, never by editing them.
create function forbid_modification() returns trigger
language plpgsql as $$
begin
  raise exception '% on % is not allowed: the table is append-only', tg_op, tg_table_name
    using errcode = 'restrict_violation';
end
$$;

create table clinics (
  id uuid primary key default gen_random_uuid(),
  name text not null constraint clinics_name_len_chk check (length(btrim(name)) between 1 and 200),
  status text not null default 'ACTIVE'
    constraint clinics_status_chk check (status in ('ACTIVE', 'SUSPENDED')),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table users (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null
    constraint users_telegram_user_id_chk check (telegram_user_id > 0),
  status text not null default 'ACTIVE'
    constraint users_status_chk check (status in ('ACTIVE', 'BLOCKED', 'DELETED')),
  locale text not null default 'ru'
    constraint users_locale_chk check (locale in ('ru', 'uz')),
  timezone text not null default 'Asia/Tashkent'
    constraint users_timezone_len_chk check (length(timezone) between 1 and 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint users_telegram_user_id_key unique (telegram_user_id),
  constraint users_deleted_chk check ((status = 'DELETED') = (deleted_at is not null))
);

-- A user is a patient, a clinician, clinic staff, or several at once: roles are the presence
-- of the profile rows below, not a column on users. Profiles share the user's id.
create table patient_profiles (
  user_id uuid primary key references users (id),
  first_name text not null
    constraint patient_profiles_first_name_len_chk check (length(btrim(first_name)) between 1 and 100),
  last_name text not null
    constraint patient_profiles_last_name_len_chk check (length(btrim(last_name)) between 1 and 100),
  date_of_birth_enc text,
  phone_enc text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table clinician_profiles (
  user_id uuid primary key references users (id),
  clinic_id uuid not null references clinics (id),
  first_name text not null
    constraint clinician_profiles_first_name_len_chk check (length(btrim(first_name)) between 1 and 100),
  last_name text not null
    constraint clinician_profiles_last_name_len_chk check (length(btrim(last_name)) between 1 and 100),
  verification_status text not null default 'PENDING'
    constraint clinician_profiles_verification_status_chk
      check (verification_status in ('PENDING', 'VERIFIED', 'REVOKED')),
  verified_by uuid references users (id),
  verified_at timestamptz,
  verification_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clinician_profiles_user_clinic_key unique (user_id, clinic_id),
  constraint clinician_profiles_verified_chk
    check (verification_status <> 'VERIFIED' or (verified_by is not null and verified_at is not null))
);
create index clinician_profiles_clinic_idx on clinician_profiles (clinic_id);

create table clinic_staff (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  clinic_id uuid not null references clinics (id),
  role text not null constraint clinic_staff_role_chk check (role in ('RECEPTION', 'CLINIC_ADMIN')),
  status text not null default 'ACTIVE'
    constraint clinic_staff_status_chk check (status in ('ACTIVE', 'REVOKED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clinic_staff_user_clinic_key unique (user_id, clinic_id)
);

create table platform_staff (
  user_id uuid primary key references users (id),
  role text not null constraint platform_staff_role_chk check (role in ('TECH_ADMIN')),
  status text not null default 'ACTIVE'
    constraint platform_staff_status_chk check (status in ('ACTIVE', 'REVOKED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Doctor-patient link. A clinician sees a patient's data only while it is ACTIVE.
create table care_relationships (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patient_profiles (user_id),
  clinician_id uuid not null references clinician_profiles (user_id),
  status text not null default 'PENDING'
    constraint care_relationships_status_chk check (status in ('PENDING', 'ACTIVE', 'ENDED')),
  consent_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Target of the composite foreign key on treatment_courses.
  constraint care_relationships_id_pair_key unique (id, patient_id, clinician_id),
  constraint care_relationships_active_chk check (status <> 'ACTIVE' or consent_at is not null),
  constraint care_relationships_ended_chk check ((status = 'ENDED') = (ended_at is not null)),
  constraint care_relationships_distinct_chk check (patient_id <> clinician_id)
);
create unique index care_relationships_open_pair_idx
  on care_relationships (clinician_id, patient_id) where status in ('PENDING', 'ACTIVE');
create index care_relationships_patient_idx on care_relationships (patient_id);

-- Read-only observer added by a clinician with the patient's consent (TZ §5.6).
create table caregiver_relationships (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patient_profiles (user_id),
  caregiver_user_id uuid not null references users (id),
  added_by uuid not null references users (id),
  scope text not null default 'SCHEDULE'
    constraint caregiver_relationships_scope_chk check (scope in ('SCHEDULE', 'SCHEDULE_AND_REASONS')),
  status text not null default 'PENDING'
    constraint caregiver_relationships_status_chk check (status in ('PENDING', 'ACTIVE', 'REVOKED')),
  consent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint caregiver_relationships_active_chk check (status <> 'ACTIVE' or consent_at is not null),
  constraint caregiver_relationships_self_chk check (patient_id <> caregiver_user_id)
);
create unique index caregiver_relationships_open_idx
  on caregiver_relationships (patient_id, caregiver_user_id) where status in ('PENDING', 'ACTIVE');
create index caregiver_relationships_caregiver_idx on caregiver_relationships (caregiver_user_id);

create trigger clinics_set_updated_at before update on clinics
  for each row execute function set_updated_at();
create trigger users_set_updated_at before update on users
  for each row execute function set_updated_at();
create trigger patient_profiles_set_updated_at before update on patient_profiles
  for each row execute function set_updated_at();
create trigger clinician_profiles_set_updated_at before update on clinician_profiles
  for each row execute function set_updated_at();
create trigger clinic_staff_set_updated_at before update on clinic_staff
  for each row execute function set_updated_at();
create trigger platform_staff_set_updated_at before update on platform_staff
  for each row execute function set_updated_at();
create trigger care_relationships_set_updated_at before update on care_relationships
  for each row execute function set_updated_at();
create trigger caregiver_relationships_set_updated_at before update on caregiver_relationships
  for each row execute function set_updated_at();
