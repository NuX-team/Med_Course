-- The staff panel (ARCHITECTURE §9, TZ §14.1, §14.2): signing in from the bot, and incidents.

-- A one-time link the bot hands to a member of staff who asks for it. Only the SHA-256 of the
-- token is stored; it lives for minutes and is used once.
create table panel_logins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  token_hash text not null constraint panel_logins_token_hash_chk check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  constraint panel_logins_token_hash_key unique (token_hash),
  constraint panel_logins_expiry_chk check (expires_at > created_at)
);
create index panel_logins_user_idx on panel_logins (user_id, created_at);

-- A signed-in browser. The cookie holds a random token; the database holds only its hash.
-- What the person may do is not stored here: it is read from their staff records on every
-- request, so a revoked role stops working at once.
create table panel_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  token_hash text not null constraint panel_sessions_token_hash_chk check (token_hash ~ '^[0-9a-f]{64}$'),
  -- Echoed in every form of this session and checked on every change (CSRF).
  csrf_token text not null constraint panel_sessions_csrf_len_chk check (length(csrf_token) between 20 and 100),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint panel_sessions_token_hash_key unique (token_hash),
  constraint panel_sessions_expiry_chk check (expires_at > created_at)
);
create index panel_sessions_user_idx on panel_sessions (user_id, created_at);

-- Something that needs a person's attention. OPERATIONAL incidents belong to a clinic and are
-- about a course (a reminder that cannot be delivered, a run of doses not taken); TECHNICAL
-- ones belong to nobody's clinic and are about the service itself (a queue that is stuck).
create table incidents (
  id uuid primary key default gen_random_uuid(),
  kind text not null constraint incidents_kind_chk check (kind in ('OPERATIONAL', 'TECHNICAL')),
  type text not null
    constraint incidents_type_chk check (type in (
      'UNDELIVERED', 'MISS_SERIES', 'QUEUE_STUCK', 'QUEUE_LATE', 'SWEEP_LATE'
    )),
  clinic_id uuid references clinics (id),
  course_id uuid references treatment_courses (id),
  -- One incident per fact, however many times the fact is noticed.
  dedupe_key text not null
    constraint incidents_dedupe_key_len_chk check (length(dedupe_key) between 1 and 200),
  -- Machine data only (counts, codes). Never free text, never anything medical.
  details jsonb,
  status text not null default 'OPEN'
    constraint incidents_status_chk check (status in ('OPEN', 'RESOLVED')),
  -- What was done about it ("called, the patient is travelling"). Encrypted: see FieldCipher.
  resolution_note_enc text,
  resolved_by uuid references users (id),
  resolved_at timestamptz,
  opened_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint incidents_dedupe_key_key unique (dedupe_key),
  constraint incidents_scope_chk check (
    (kind = 'OPERATIONAL') = (clinic_id is not null) and (kind = 'OPERATIONAL') = (course_id is not null)
  ),
  constraint incidents_type_kind_chk check (
    (kind = 'OPERATIONAL') = (type in ('UNDELIVERED', 'MISS_SERIES'))
  ),
  constraint incidents_resolved_chk check (
    (status = 'RESOLVED') = (resolved_at is not null) and (status = 'RESOLVED') = (resolved_by is not null)
  ),
  constraint incidents_note_chk check (resolution_note_enc is null or status = 'RESOLVED')
);
create index incidents_clinic_idx on incidents (clinic_id, status, opened_at);
create index incidents_kind_idx on incidents (kind, status, opened_at);

create trigger incidents_set_updated_at before update on incidents
  for each row execute function set_updated_at();
