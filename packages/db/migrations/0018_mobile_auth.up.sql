-- Mobile app (stage 17): sign-in through the bot, bearer sessions, device tokens.
--
-- The app has no identity of its own: a person signs in by confirming in the bot, so every app
-- account is an existing Telegram account (telegram_user_id stays the key everywhere).
--
-- 1. The app asks for a sign-in: a row with the hash of a link code (goes into t.me/<bot>?start=a_…)
--    and the hash of a poll token (stays in the app).
-- 2. The person opens the link and presses "Confirm" in the bot: user_id and confirmed_at are set.
-- 3. The app polls with its token; the first poll after confirmation spends the row and gets a session.
create table app_logins (
  id uuid primary key default gen_random_uuid(),
  link_hash text not null
    constraint app_logins_link_hash_chk check (link_hash ~ '^[0-9a-f]{64}$'),
  poll_hash text not null
    constraint app_logins_poll_hash_chk check (poll_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid references users (id),
  confirmed_at timestamptz,
  used_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint app_logins_link_hash_key unique (link_hash),
  constraint app_logins_poll_hash_key unique (poll_hash),
  constraint app_logins_expiry_chk check (expires_at > created_at),
  constraint app_logins_confirmed_chk check ((user_id is null) = (confirmed_at is null)),
  constraint app_logins_used_chk check (used_at is null or confirmed_at is not null)
);
create index app_logins_created_idx on app_logins (created_at);

-- Opaque bearer tokens, stored hashed; the plain token lives only on the device.
create table auth_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  token_hash text not null
    constraint auth_sessions_token_hash_chk check (token_hash ~ '^[0-9a-f]{64}$'),
  platform text not null default 'ios'
    constraint auth_sessions_platform_chk check (platform in ('ios', 'android')),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint auth_sessions_token_hash_key unique (token_hash),
  constraint auth_sessions_expiry_chk check (expires_at > created_at)
);
create index auth_sessions_user_idx on auth_sessions (user_id);

-- Push tokens are collected now so reminders can gain a second channel later; today every
-- reminder still goes through the Telegram bot (owner's decision, stage 17).
create table device_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id),
  platform text not null
    constraint device_tokens_platform_chk check (platform in ('ios', 'android')),
  token text not null
    constraint device_tokens_token_chk check (token ~ '^[0-9A-Za-z_:-]{16,512}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint device_tokens_token_key unique (platform, token)
);
create index device_tokens_user_idx on device_tokens (user_id);
create trigger device_tokens_set_updated_at before update on device_tokens
  for each row execute function set_updated_at();
