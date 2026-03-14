-- Spotify OAuth backend storage and profile projection

alter table public.profiles
  add column if not exists spotify_connection jsonb;

create table if not exists public.spotify_oauth_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  spotify_user_id text not null,
  access_token text not null,
  refresh_token text not null,
  token_type text not null default 'Bearer',
  scope text null,
  expires_at timestamptz not null,
  account_name text null,
  account_url text null,
  account_product text null,
  connected_at timestamptz not null default now(),
  refreshed_at timestamptz null,
  revoked_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists spotify_oauth_tokens_spotify_user_active_idx
  on public.spotify_oauth_tokens (spotify_user_id)
  where revoked_at is null;

create index if not exists spotify_oauth_tokens_expires_idx
  on public.spotify_oauth_tokens (expires_at);

do $$
begin
  if exists (
    select 1
    from pg_proc
    where proname = 'set_updated_at'
  ) then
    drop trigger if exists trg_spotify_oauth_tokens_set_updated_at on public.spotify_oauth_tokens;
    create trigger trg_spotify_oauth_tokens_set_updated_at
    before update on public.spotify_oauth_tokens
    for each row execute function public.set_updated_at();
  end if;
end $$;

create table if not exists public.spotify_oauth_states (
  state text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  client_context text null,
  created_at timestamptz not null default now()
);

create index if not exists spotify_oauth_states_user_idx
  on public.spotify_oauth_states (user_id);

create index if not exists spotify_oauth_states_expires_idx
  on public.spotify_oauth_states (expires_at);

alter table public.spotify_oauth_tokens enable row level security;
alter table public.spotify_oauth_states enable row level security;

revoke all on table public.spotify_oauth_tokens from anon, authenticated;
revoke all on table public.spotify_oauth_states from anon, authenticated;

grant all on table public.spotify_oauth_tokens to service_role;
grant all on table public.spotify_oauth_states to service_role;
