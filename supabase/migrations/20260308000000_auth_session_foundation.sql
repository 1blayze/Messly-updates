begin;

create table if not exists public.auth_email_verifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  purpose text not null default 'signup',
  code_hash text not null,
  password_encrypted text not null,
  attempts smallint not null default 0,
  max_attempts smallint not null default 5,
  expires_at timestamptz not null,
  last_attempt_at timestamptz null,
  consumed_at timestamptz null,
  invalidated_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint auth_email_verifications_email_lower_chk check (email = lower(email)),
  constraint auth_email_verifications_purpose_chk check (purpose in ('signup')),
  constraint auth_email_verifications_attempts_chk check (attempts >= 0 and attempts <= max_attempts),
  constraint auth_email_verifications_max_attempts_chk check (max_attempts between 1 and 10)
);

create index if not exists auth_email_verifications_email_purpose_idx
  on public.auth_email_verifications (email, purpose, created_at desc);

create index if not exists auth_email_verifications_user_purpose_idx
  on public.auth_email_verifications (user_id, purpose, created_at desc);

create index if not exists auth_email_verifications_active_idx
  on public.auth_email_verifications (expires_at)
  where consumed_at is null and invalidated_at is null;

drop trigger if exists trg_auth_email_verifications_set_updated_at on public.auth_email_verifications;
create trigger trg_auth_email_verifications_set_updated_at
before update on public.auth_email_verifications
for each row execute function public.set_updated_at();

alter table public.auth_email_verifications enable row level security;
alter table public.auth_email_verifications force row level security;

revoke all on public.auth_email_verifications from anon;
revoke all on public.auth_email_verifications from authenticated;

alter table public.user_sessions
  add column if not exists auth_session_id uuid null,
  add column if not exists revoked_at timestamptz null;

create unique index if not exists user_sessions_auth_session_id_uidx
  on public.user_sessions (auth_session_id)
  where auth_session_id is not null;

create index if not exists user_sessions_user_revoked_last_seen_idx
  on public.user_sessions (user_id, revoked_at, last_seen_at desc);

create index if not exists user_sessions_active_lookup_idx
  on public.user_sessions (auth_session_id, user_id)
  where revoked_at is null and ended_at is null;

commit;
