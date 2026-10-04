-- What the Telegram layer needs before any course exists (ARCHITECTURE §4.1, §7): update
-- deduplication, a place for half-finished conversations, and recorded consent.

-- Telegram redelivers a webhook that did not answer in time; an update id seen once is never
-- handled again. Pruned by age (stage 4 worker task, later).
create table tg_updates (
  update_id bigint primary key,
  received_at timestamptz not null default now()
);
create index tg_updates_received_idx on tg_updates (received_at);

-- One unfinished conversation per Telegram user. Keyed by the Telegram id, not by users.id:
-- the first steps happen before the person has agreed to anything and so before a users row
-- exists. Holds only what the next step needs, and expires.
create table conversation_states (
  telegram_user_id bigint primary key
    constraint conversation_states_telegram_user_id_chk check (telegram_user_id > 0),
  flow text not null
    constraint conversation_states_flow_chk check (flow in ('ONBOARDING', 'SETTINGS')),
  step text not null constraint conversation_states_step_len_chk check (length(step) between 1 and 32),
  data jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversation_states_expires_idx on conversation_states (expires_at);
create trigger conversation_states_set_updated_at before update on conversation_states
  for each row execute function set_updated_at();

-- Every decision, never edited: withdrawing consent is a new row, and the history of what the
-- person agreed to, in which version of the text and language, stays.
create table consent_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  kind text not null constraint consent_records_kind_chk check (kind in ('PERSONAL_DATA')),
  version text not null constraint consent_records_version_len_chk check (length(version) between 1 and 32),
  decision text not null constraint consent_records_decision_chk check (decision in ('GRANTED', 'REVOKED')),
  locale text not null constraint consent_records_locale_chk check (locale in ('ru', 'uz')),
  context text not null default 'ONBOARDING'
    constraint consent_records_context_chk check (context in ('ONBOARDING', 'SETTINGS')),
  at timestamptz not null default now()
);
create index consent_records_user_idx on consent_records (user_id, kind, at);

create trigger consent_records_append_only before update or delete on consent_records
  for each row execute function forbid_modification();
create trigger consent_records_no_truncate before truncate on consent_records
  for each statement execute function forbid_modification();

-- The timezone starts as a proposal (Asia/Tashkent); this says the person agreed to it.
alter table users add column timezone_confirmed_at timestamptz;
