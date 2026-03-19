begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

do $$
begin
  if exists (
    select 1
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pgcrypto'
      and n.nspname = 'public'
  ) then
    alter extension pgcrypto set schema extensions;
  end if;

  if exists (
    select 1
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pg_trgm'
      and n.nspname = 'public'
  ) then
    alter extension pg_trgm set schema extensions;
  end if;
end;
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text null,
  username text not null,
  display_name text null,
  avatar_url text null,
  banner_url text null,
  bio text null,
  about text null,
  banner_color text null,
  profile_theme_primary_color text null,
  profile_theme_accent_color text null,
  friend_requests_allow_all boolean not null default true,
  friend_requests_allow_friends_of_friends boolean not null default true,
  avatar_key text null,
  avatar_hash text null,
  banner_key text null,
  banner_hash text null,
  status text not null default 'invisible',
  last_active timestamptz null,
  public_id text null,
  spotify_connection jsonb null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_username_format_chk check (username ~ '^[a-z0-9._]{3,32}$'),
  constraint profiles_username_lower_chk check (username = lower(username)),
  constraint profiles_email_lower_chk check (email is null or email = lower(email)),
  constraint profiles_status_chk check (status in ('online', 'idle', 'dnd', 'invisible')),
  constraint profiles_spotify_connection_object_chk check (
    spotify_connection is null or jsonb_typeof(spotify_connection) = 'object'
  )
);

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text null,
  username text not null,
  display_name text null,
  avatar_url text null,
  banner_url text null,
  about text null,
  avatar_key text null,
  avatar_hash text null,
  banner_key text null,
  banner_hash text null,
  status text not null default 'invisible',
  last_active timestamptz null,
  public_id text null,
  banner_color text null,
  profile_theme_primary_color text null,
  profile_theme_accent_color text null,
  spotify_connection jsonb null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint users_username_format_chk check (username ~ '^[a-z0-9._]{3,32}$'),
  constraint users_username_lower_chk check (username = lower(username)),
  constraint users_email_lower_chk check (email is null or email = lower(email)),
  constraint users_status_chk check (status in ('online', 'idle', 'dnd', 'invisible')),
  constraint users_spotify_connection_object_chk check (
    spotify_connection is null or jsonb_typeof(spotify_connection) = 'object'
  )
);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  type text not null default 'dm',
  user1_id uuid not null references public.profiles(id) on delete cascade,
  user2_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint conversations_type_chk check (type in ('dm')),
  constraint conversations_distinct_users_chk check (user1_id <> user2_id),
  constraint conversations_user_order_chk check (user1_id < user2_id)
);

create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint friend_requests_status_chk check (status in ('pending', 'accepted', 'rejected')),
  constraint friend_requests_distinct_users_chk check (requester_id <> addressee_id)
);

create table if not exists public.user_blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint user_blocks_distinct_users_chk check (blocker_id <> blocked_id)
);

create table if not exists public.call_sessions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  created_by uuid not null references public.profiles(id) on delete restrict,
  mode text not null,
  status text not null default 'ringing',
  created_at timestamptz not null default now(),
  started_at timestamptz null,
  ended_at timestamptz null,
  last_activity_at timestamptz not null default now(),
  ended_reason text null,
  participants jsonb not null default '{}'::jsonb,
  constraint call_sessions_mode_chk check (mode in ('audio', 'video')),
  constraint call_sessions_status_chk check (status in ('ringing', 'active', 'ended', 'missed', 'declined')),
  constraint call_sessions_ended_reason_chk check (
    ended_reason is null or ended_reason in ('no_answer', 'hangup', 'timeout', 'declined', 'error')
  ),
  constraint call_sessions_participants_object_chk check (jsonb_typeof(participants) = 'object'),
  constraint call_sessions_terminal_fields_chk check (
    (
      status in ('ended', 'missed', 'declined')
      and ended_at is not null
      and ended_reason is not null
    )
    or (
      status in ('ringing', 'active')
      and ended_reason is null
    )
  )
);

create table if not exists public.call_signals (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.call_sessions(id) on delete cascade,
  from_user_id uuid not null references public.profiles(id) on delete restrict,
  to_user_id uuid not null references public.profiles(id) on delete restrict,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint call_signals_distinct_participants_chk check (from_user_id <> to_user_id),
  constraint call_signals_type_chk check (type in ('offer', 'answer', 'ice', 'bye')),
  constraint call_signals_payload_object_chk check (jsonb_typeof(payload) = 'object')
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  client_id text null,
  content text not null default '',
  type text not null default 'text',
  created_at timestamptz not null default now(),
  edited_at timestamptz null,
  deleted_at timestamptz null,
  reply_to_id uuid null references public.messages(id) on delete set null,
  reply_to_snapshot jsonb null,
  call_id uuid null references public.call_sessions(id) on delete set null,
  payload jsonb null,
  constraint messages_type_chk check (type in ('text', 'image', 'video', 'file', 'call_event')),
  constraint messages_client_id_not_blank_chk check (client_id is null or btrim(client_id) <> ''),
  constraint messages_content_length_chk check (char_length(content) <= 4000),
  constraint messages_reply_snapshot_object_chk check (
    reply_to_snapshot is null or jsonb_typeof(reply_to_snapshot) = 'object'
  ),
  constraint messages_payload_object_chk check (
    payload is null or jsonb_typeof(payload) = 'object'
  ),
  constraint messages_no_empty_text_chk check (
    type <> 'text' or deleted_at is not null or btrim(coalesce(content, '')) <> ''
  )
);

create table if not exists public.attachments (
  message_id uuid primary key references public.messages(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  file_key text not null,
  original_key text null,
  thumb_key text null,
  mime_type text null,
  file_size bigint null,
  width integer null,
  height integer null,
  thumb_width integer null,
  thumb_height integer null,
  codec text null,
  duration_ms integer null,
  created_at timestamptz not null default now(),
  constraint attachments_file_key_prefix_chk check (
    file_key like 'attachments/%' or file_key like 'messages/%'
  ),
  constraint attachments_original_key_prefix_chk check (
    original_key is null or original_key like 'attachments/%' or original_key like 'messages/%'
  ),
  constraint attachments_thumb_key_prefix_chk check (
    thumb_key is null or thumb_key like 'attachments/%' or thumb_key like 'messages/%'
  ),
  constraint attachments_file_size_chk check (file_size is null or file_size > 0),
  constraint attachments_width_chk check (width is null or width > 0),
  constraint attachments_height_chk check (height is null or height > 0),
  constraint attachments_thumb_width_chk check (thumb_width is null or thumb_width > 0),
  constraint attachments_thumb_height_chk check (thumb_height is null or thumb_height > 0),
  constraint attachments_duration_chk check (duration_ms is null or duration_ms > 0)
);

create table if not exists public.message_reads (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  read_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

create table if not exists public.presence (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'online',
  activities jsonb not null default '[]'::jsonb,
  last_seen timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint presence_status_chk check (status in ('online', 'idle', 'dnd', 'invisible')),
  constraint presence_activities_array_chk check (jsonb_typeof(activities) = 'array')
);

create table if not exists public.user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  session_token text not null unique,
  auth_session_id uuid null,
  device_id text not null default gen_random_uuid()::text,
  client_type text not null default 'unknown',
  platform text not null default 'unknown',
  ip_address text not null,
  city text null,
  region text null,
  country text null,
  location_label text null,
  device text not null,
  os text not null,
  app_version text null,
  client_version text null,
  user_agent text null,
  suspicious boolean not null default false,
  suspicious_reason text null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at timestamptz null,
  revoked_at timestamptz null,
  constraint user_sessions_session_token_not_blank_chk check (btrim(session_token) <> ''),
  constraint user_sessions_device_id_length_chk check (char_length(device_id) between 1 and 128),
  constraint user_sessions_client_type_chk check (client_type in ('desktop', 'web', 'mobile', 'unknown')),
  constraint user_sessions_platform_length_chk check (char_length(platform) between 2 and 32),
  constraint user_sessions_ip_address_not_blank_chk check (btrim(ip_address) <> ''),
  constraint user_sessions_device_length_chk check (char_length(device) between 1 and 80),
  constraint user_sessions_os_length_chk check (char_length(os) between 1 and 80),
  constraint user_sessions_app_version_length_chk check (app_version is null or char_length(app_version) <= 32),
  constraint user_sessions_client_version_length_chk check (client_version is null or char_length(client_version) <= 32),
  constraint user_sessions_location_label_length_chk check (
    location_label is null or char_length(location_label) <= 240
  ),
  constraint user_sessions_user_agent_length_chk check (user_agent is null or char_length(user_agent) <= 512),
  constraint user_sessions_suspicious_reason_length_chk check (
    suspicious_reason is null or char_length(suspicious_reason) <= 240
  ),
  constraint user_sessions_time_order_chk check (ended_at is null or ended_at >= created_at)
);

create table if not exists public.media_uploads (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid null references public.conversations(id) on delete cascade,
  file_key text not null,
  kind text not null,
  sha256 text not null,
  content_type text not null,
  size_bytes bigint not null,
  status text not null default 'pending',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  constraint media_uploads_kind_chk check (
    kind in (
      'avatar',
      'banner',
      'message_image',
      'message_image_preview',
      'message_image_original',
      'message_video',
      'message_video_preview',
      'message_video_thumb',
      'message_file'
    )
  ),
  constraint media_uploads_file_key_prefix_chk check (
    file_key like 'avatars/%' or file_key like 'banners/%' or file_key like 'messages/%'
  ),
  constraint media_uploads_sha256_chk check (sha256 ~ '^[a-f0-9]{64}$'),
  constraint media_uploads_size_bytes_chk check (size_bytes > 0),
  constraint media_uploads_status_chk check (status in ('pending', 'uploaded', 'attached', 'deleted')),
  constraint media_uploads_metadata_object_chk check (jsonb_typeof(metadata) = 'object')
);

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

create table if not exists public.spotify_oauth_states (
  state text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  client_context text null,
  created_at timestamptz not null default now()
);

create table if not exists public.registration_attempts_by_ip (
  id bigserial primary key,
  ip_address text not null,
  fingerprint_hash text null,
  user_id uuid null references auth.users(id) on delete set null,
  email_domain text null,
  created_at timestamptz not null default now(),
  constraint registration_attempts_by_ip_ip_address_length_chk check (char_length(ip_address) between 2 and 128),
  constraint registration_attempts_by_ip_fingerprint_hash_length_chk check (
    fingerprint_hash is null or char_length(fingerprint_hash) between 16 and 128
  ),
  constraint registration_attempts_by_ip_email_domain_length_chk check (
    email_domain is null or char_length(email_domain) between 3 and 255
  )
);

create table if not exists public.captcha_failures_by_ip (
  id bigserial primary key,
  ip_address text not null,
  fingerprint_hash text null,
  reason text not null,
  created_at timestamptz not null default now(),
  constraint captcha_failures_by_ip_ip_address_length_chk check (char_length(ip_address) between 2 and 128),
  constraint captcha_failures_by_ip_reason_length_chk check (char_length(reason) between 3 and 120),
  constraint captcha_failures_by_ip_fingerprint_hash_length_chk check (
    fingerprint_hash is null or char_length(fingerprint_hash) between 16 and 128
  )
);

create table if not exists public.blocked_ips (
  ip_address text primary key,
  blocked_until timestamptz not null,
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint blocked_ips_ip_address_length_chk check (char_length(ip_address) between 2 and 128),
  constraint blocked_ips_reason_length_chk check (char_length(reason) between 3 and 120)
);

create table if not exists public.registration_attempts_by_fingerprint (
  id bigserial primary key,
  fingerprint_hash text not null,
  ip_address text not null,
  user_id uuid null references auth.users(id) on delete set null,
  email_domain text null,
  created_at timestamptz not null default now(),
  constraint registration_attempts_by_fingerprint_hash_length_chk check (
    char_length(fingerprint_hash) between 16 and 128
  ),
  constraint registration_attempts_by_fingerprint_ip_length_chk check (
    char_length(ip_address) between 2 and 128
  ),
  constraint registration_attempts_by_fingerprint_email_domain_length_chk check (
    email_domain is null or char_length(email_domain) between 3 and 255
  )
);

create table if not exists public.blocked_fingerprints (
  fingerprint_hash text primary key,
  blocked_until timestamptz not null,
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint blocked_fingerprints_hash_length_chk check (char_length(fingerprint_hash) between 16 and 128),
  constraint blocked_fingerprints_reason_length_chk check (char_length(reason) between 3 and 120)
);

create table if not exists public.registration_attempts_by_email_domain (
  id bigserial primary key,
  email_domain text not null,
  ip_address text not null,
  fingerprint_hash text null,
  user_id uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint registration_attempts_by_email_domain_domain_length_chk check (char_length(email_domain) between 3 and 255),
  constraint registration_attempts_by_email_domain_ip_length_chk check (char_length(ip_address) between 2 and 128),
  constraint registration_attempts_by_email_domain_fingerprint_hash_length_chk check (
    fingerprint_hash is null or char_length(fingerprint_hash) between 16 and 128
  )
);

create table if not exists public.suspicious_registration_events (
  id bigserial primary key,
  event_type text not null,
  ip_address text null,
  fingerprint_hash text null,
  email_domain text null,
  email_masked text null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint suspicious_registration_events_event_type_length_chk check (char_length(event_type) between 3 and 120),
  constraint suspicious_registration_events_ip_length_chk check (
    ip_address is null or char_length(ip_address) between 2 and 128
  ),
  constraint suspicious_registration_events_fingerprint_hash_length_chk check (
    fingerprint_hash is null or char_length(fingerprint_hash) between 16 and 128
  ),
  constraint suspicious_registration_events_email_domain_length_chk check (
    email_domain is null or char_length(email_domain) between 3 and 255
  ),
  constraint suspicious_registration_events_email_masked_length_chk check (
    email_masked is null or char_length(email_masked) between 3 and 255
  ),
  constraint suspicious_registration_events_details_object_chk check (jsonb_typeof(details) = 'object')
);

create table if not exists public.registration_rate_limit_leases (
  id uuid primary key default gen_random_uuid(),
  ip_address text not null,
  fingerprint_hash text not null,
  lease_status text not null default 'reserved',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  released_at timestamptz null,
  release_reason text null,
  constraint registration_rate_limit_leases_ip_length_chk check (char_length(ip_address) between 2 and 128),
  constraint registration_rate_limit_leases_fingerprint_length_chk check (
    char_length(fingerprint_hash) between 16 and 128
  ),
  constraint registration_rate_limit_leases_status_chk check (
    lease_status in ('reserved', 'consumed', 'released', 'expired')
  ),
  constraint registration_rate_limit_leases_release_reason_length_chk check (
    release_reason is null or char_length(release_reason) <= 120
  )
);

create or replace function public.normalize_profiles_row()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.username := regexp_replace(lower(btrim(coalesce(new.username, ''))), '^@+', '');
  if new.username = '' then
    raise exception 'username cannot be empty';
  end if;
  if not (new.username ~ '^[a-z0-9._]{3,32}$') then
    raise exception 'invalid username format';
  end if;

  new.status := coalesce(nullif(lower(btrim(coalesce(new.status, ''))), ''), 'invisible');
  if new.status not in ('online', 'idle', 'dnd', 'invisible') then
    raise exception 'invalid status format';
  end if;

  if new.display_name is not null then
    new.display_name := nullif(btrim(new.display_name), '');
  end if;
  if new.email is not null then
    new.email := nullif(lower(btrim(new.email)), '');
  end if;
  if new.avatar_url is not null then
    new.avatar_url := nullif(btrim(new.avatar_url), '');
  end if;
  if new.banner_url is not null then
    new.banner_url := nullif(btrim(new.banner_url), '');
  end if;
  if new.bio is not null then
    new.bio := nullif(btrim(new.bio), '');
  end if;
  if new.about is not null then
    new.about := nullif(btrim(new.about), '');
  end if;
  if new.bio is null and new.about is not null then
    new.bio := new.about;
  end if;
  if new.about is null and new.bio is not null then
    new.about := new.bio;
  end if;
  if new.bio is not null and new.about is not null and new.bio <> new.about then
    new.about := new.bio;
  end if;

  if new.public_id is not null then
    new.public_id := nullif(lower(regexp_replace(btrim(new.public_id), '[^a-z0-9_-]', '', 'g')), '');
  end if;
  if new.public_id is null then
    new.public_id := substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
  end if;
  if new.last_active is null then
    new.last_active := now();
  end if;

  return new;
end;
$$;

create or replace function public.normalize_users_row()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.username := regexp_replace(lower(btrim(coalesce(new.username, ''))), '^@+', '');
  if new.username = '' then
    raise exception 'username cannot be empty';
  end if;
  if not (new.username ~ '^[a-z0-9._]{3,32}$') then
    raise exception 'invalid username format';
  end if;

  new.status := coalesce(nullif(lower(btrim(coalesce(new.status, ''))), ''), 'invisible');
  if new.status not in ('online', 'idle', 'dnd', 'invisible') then
    raise exception 'invalid status format';
  end if;

  if new.display_name is not null then
    new.display_name := nullif(btrim(new.display_name), '');
  end if;
  if new.email is not null then
    new.email := nullif(lower(btrim(new.email)), '');
  end if;
  if new.avatar_url is not null then
    new.avatar_url := nullif(btrim(new.avatar_url), '');
  end if;
  if new.banner_url is not null then
    new.banner_url := nullif(btrim(new.banner_url), '');
  end if;
  if new.about is not null then
    new.about := nullif(btrim(new.about), '');
  end if;

  if new.public_id is not null then
    new.public_id := nullif(lower(regexp_replace(btrim(new.public_id), '[^a-z0-9_-]', '', 'g')), '');
  end if;
  if new.public_id is null then
    new.public_id := substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
  end if;
  if new.last_active is null then
    new.last_active := now();
  end if;

  return new;
end;
$$;

create or replace function public.touch_presence_row()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  new.last_seen := coalesce(new.last_seen, now());
  return new;
end;
$$;

create or replace function public.is_conversation_member(p_conversation_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.conversations c
    where c.id = p_conversation_id
      and c.type = 'dm'
      and (c.user1_id = p_user_id or c.user2_id = p_user_id)
  );
$$;

create or replace function public.is_message_author(p_message_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.messages m
    where m.id = p_message_id
      and m.sender_id = p_user_id
  );
$$;

create or replace function public.can_access_message(p_message_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.messages m
    where m.id = p_message_id
      and public.is_conversation_member(m.conversation_id, p_user_id)
  );
$$;

create or replace function public.can_access_call(p_call_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.call_sessions cs
    join public.conversations c on c.id = cs.conversation_id
    where cs.id = p_call_id
      and (c.user1_id = p_user_id or c.user2_id = p_user_id)
  );
$$;

create or replace function public.user_ids_are_blocked(user_a uuid, user_b uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.user_blocks ub
    where (ub.blocker_id = user_a and ub.blocked_id = user_b)
       or (ub.blocker_id = user_b and ub.blocked_id = user_a)
  );
$$;

create or replace function public.validate_message_integrity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  reply_conv uuid;
  call_conv uuid;
  conv_user1 uuid;
  conv_user2 uuid;
begin
  select c.user1_id, c.user2_id
    into conv_user1, conv_user2
  from public.conversations c
  where c.id = new.conversation_id;

  if conv_user1 is null then
    raise exception 'conversation % not found', new.conversation_id;
  end if;

  if new.sender_id is distinct from conv_user1 and new.sender_id is distinct from conv_user2 then
    raise exception 'sender_id must belong to the conversation';
  end if;

  if new.reply_to_id is not null then
    select m.conversation_id
      into reply_conv
    from public.messages m
    where m.id = new.reply_to_id;

    if reply_conv is null or reply_conv <> new.conversation_id then
      raise exception 'reply_to_id must belong to the same conversation';
    end if;
  end if;

  if new.call_id is not null then
    select cs.conversation_id
      into call_conv
    from public.call_sessions cs
    where cs.id = new.call_id;

    if call_conv is null or call_conv <> new.conversation_id then
      raise exception 'call_id must belong to the same conversation';
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.validate_attachment_integrity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  msg_conv uuid;
begin
  select m.conversation_id
    into msg_conv
  from public.messages m
  where m.id = new.message_id;

  if msg_conv is null then
    raise exception 'message_id % not found', new.message_id;
  end if;

  if new.conversation_id <> msg_conv then
    raise exception 'attachment conversation_id must match message conversation_id';
  end if;

  return new;
end;
$$;

create or replace function public.sync_users_to_profiles()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  insert into public.profiles (
    id,
    email,
    username,
    display_name,
    avatar_url,
    banner_url,
    bio,
    about,
    banner_color,
    profile_theme_primary_color,
    profile_theme_accent_color,
    avatar_key,
    avatar_hash,
    banner_key,
    banner_hash,
    status,
    last_active,
    public_id,
    spotify_connection,
    created_at,
    updated_at
  )
  values (
    new.id,
    new.email,
    new.username,
    new.display_name,
    new.avatar_url,
    new.banner_url,
    new.about,
    new.about,
    new.banner_color,
    new.profile_theme_primary_color,
    new.profile_theme_accent_color,
    new.avatar_key,
    new.avatar_hash,
    new.banner_key,
    new.banner_hash,
    coalesce(new.status, 'invisible'),
    coalesce(new.last_active, now()),
    new.public_id,
    new.spotify_connection,
    coalesce(new.created_at, now()),
    now()
  )
  on conflict (id) do update
  set
    email = excluded.email,
    username = excluded.username,
    display_name = excluded.display_name,
    avatar_url = excluded.avatar_url,
    banner_url = excluded.banner_url,
    bio = excluded.bio,
    about = excluded.about,
    banner_color = excluded.banner_color,
    profile_theme_primary_color = excluded.profile_theme_primary_color,
    profile_theme_accent_color = excluded.profile_theme_accent_color,
    avatar_key = excluded.avatar_key,
    avatar_hash = excluded.avatar_hash,
    banner_key = excluded.banner_key,
    banner_hash = excluded.banner_hash,
    status = excluded.status,
    last_active = excluded.last_active,
    public_id = excluded.public_id,
    spotify_connection = excluded.spotify_connection,
    updated_at = now();

  return new;
end;
$$;

create or replace function public.sync_profiles_to_users()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  insert into public.users (
    id,
    email,
    username,
    display_name,
    avatar_url,
    banner_url,
    about,
    avatar_key,
    avatar_hash,
    banner_key,
    banner_hash,
    status,
    last_active,
    public_id,
    banner_color,
    profile_theme_primary_color,
    profile_theme_accent_color,
    spotify_connection,
    created_at,
    updated_at
  )
  values (
    new.id,
    new.email,
    new.username,
    new.display_name,
    new.avatar_url,
    new.banner_url,
    coalesce(new.about, new.bio),
    new.avatar_key,
    new.avatar_hash,
    new.banner_key,
    new.banner_hash,
    coalesce(new.status, 'invisible'),
    coalesce(new.last_active, now()),
    new.public_id,
    new.banner_color,
    new.profile_theme_primary_color,
    new.profile_theme_accent_color,
    new.spotify_connection,
    coalesce(new.created_at, now()),
    now()
  )
  on conflict (id) do update
  set
    email = excluded.email,
    username = excluded.username,
    display_name = excluded.display_name,
    avatar_url = excluded.avatar_url,
    banner_url = excluded.banner_url,
    about = excluded.about,
    avatar_key = excluded.avatar_key,
    avatar_hash = excluded.avatar_hash,
    banner_key = excluded.banner_key,
    banner_hash = excluded.banner_hash,
    status = excluded.status,
    last_active = excluded.last_active,
    public_id = excluded.public_id,
    banner_color = excluded.banner_color,
    profile_theme_primary_color = excluded.profile_theme_primary_color,
    profile_theme_accent_color = excluded.profile_theme_accent_color,
    spotify_connection = excluded.spotify_connection,
    updated_at = now();

  return new;
end;
$$;

create or replace function public.list_mutual_friend_ids(p_other_user_id uuid)
returns table(friend_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with viewer as (
    select (select auth.uid()) as user_id
  ),
  viewer_friends as (
    select distinct
      case
        when fr.requester_id = viewer.user_id then fr.addressee_id
        else fr.requester_id
      end as friend_id
    from public.friend_requests fr
    cross join viewer
    where viewer.user_id is not null
      and fr.status = 'accepted'
      and (fr.requester_id = viewer.user_id or fr.addressee_id = viewer.user_id)
  ),
  other_friends as (
    select distinct
      case
        when fr.requester_id = p_other_user_id then fr.addressee_id
        else fr.requester_id
      end as friend_id
    from public.friend_requests fr
    where p_other_user_id is not null
      and fr.status = 'accepted'
      and (fr.requester_id = p_other_user_id or fr.addressee_id = p_other_user_id)
  )
  select vf.friend_id
  from viewer v
  join viewer_friends vf on true
  join other_friends ofr on ofr.friend_id = vf.friend_id
  where v.user_id is not null
    and p_other_user_id is not null
    and p_other_user_id <> v.user_id
  order by vf.friend_id;
$$;

create or replace function public.delete_user(user_id uuid default null)
returns boolean
language plpgsql
security definer
set search_path = public, auth, pg_temp
as $$
declare
  v_target uuid := coalesce(user_id, (select auth.uid()));
begin
  if v_target is null then
    return false;
  end if;

  if (select auth.uid()) is null or (select auth.uid()) <> v_target then
    raise exception 'forbidden';
  end if;

  delete from auth.users where id = v_target;
  return found;
end;
$$;

create or replace function public.registration_try_acquire_lease(
  p_ip_address text,
  p_fingerprint_hash text,
  p_now timestamptz default now(),
  p_ip_limit integer default 3,
  p_fingerprint_limit integer default 2,
  p_ip_window_seconds integer default 86400,
  p_fingerprint_window_seconds integer default 86400,
  p_lease_ttl_seconds integer default 1200
)
returns table (
  allowed boolean,
  reason text,
  lease_id uuid,
  ip_count integer,
  fingerprint_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_ip_window_start timestamptz := v_now - make_interval(secs => greatest(1, p_ip_window_seconds));
  v_fingerprint_window_start timestamptz := v_now - make_interval(secs => greatest(1, p_fingerprint_window_seconds));
  v_expires_at timestamptz := v_now + make_interval(secs => greatest(60, p_lease_ttl_seconds));
  v_ip_limit integer := greatest(1, p_ip_limit);
  v_fingerprint_limit integer := greatest(1, p_fingerprint_limit);
  v_ip_count integer := 0;
  v_fingerprint_count integer := 0;
  v_lease_id uuid;
  v_ip_lock_key bigint := hashtextextended('registration-ip:' || coalesce(p_ip_address, ''), 0);
  v_fingerprint_lock_key bigint := hashtextextended('registration-fingerprint:' || coalesce(p_fingerprint_hash, ''), 0);
begin
  if p_ip_address is null or btrim(p_ip_address) = '' then
    raise exception 'ip_address required';
  end if;
  if p_fingerprint_hash is null or btrim(p_fingerprint_hash) = '' then
    raise exception 'fingerprint_hash required';
  end if;

  if v_ip_lock_key <= v_fingerprint_lock_key then
    perform pg_advisory_xact_lock(v_ip_lock_key);
    perform pg_advisory_xact_lock(v_fingerprint_lock_key);
  else
    perform pg_advisory_xact_lock(v_fingerprint_lock_key);
    perform pg_advisory_xact_lock(v_ip_lock_key);
  end if;

  update public.registration_rate_limit_leases
  set lease_status = 'expired',
      released_at = coalesce(released_at, v_now),
      release_reason = coalesce(release_reason, 'lease_expired')
  where lease_status = 'reserved'
    and expires_at <= v_now
    and (ip_address = p_ip_address or fingerprint_hash = p_fingerprint_hash);

  select count(*)::integer
    into v_ip_count
  from public.registration_rate_limit_leases
  where ip_address = p_ip_address
    and created_at >= v_ip_window_start
    and (
      lease_status = 'consumed'
      or (lease_status = 'reserved' and expires_at > v_now)
    );

  if v_ip_count >= v_ip_limit then
    return query select false, 'ip_limit', null::uuid, v_ip_count, null::integer;
    return;
  end if;

  select count(*)::integer
    into v_fingerprint_count
  from public.registration_rate_limit_leases
  where fingerprint_hash = p_fingerprint_hash
    and created_at >= v_fingerprint_window_start
    and (
      lease_status = 'consumed'
      or (lease_status = 'reserved' and expires_at > v_now)
    );

  if v_fingerprint_count >= v_fingerprint_limit then
    return query select false, 'fingerprint_limit', null::uuid, v_ip_count, v_fingerprint_count;
    return;
  end if;

  insert into public.registration_rate_limit_leases (
    ip_address,
    fingerprint_hash,
    lease_status,
    expires_at
  )
  values (
    p_ip_address,
    p_fingerprint_hash,
    'reserved',
    v_expires_at
  )
  returning id into v_lease_id;

  return query
    select true, 'ok', v_lease_id, v_ip_count + 1, v_fingerprint_count + 1;
end;
$$;

create or replace function public.registration_release_lease(
  p_lease_id uuid,
  p_reason text default null,
  p_now timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_reason text := nullif(left(coalesce(p_reason, 'released'), 120), '');
  v_updated integer := 0;
begin
  if p_lease_id is null then
    return false;
  end if;

  update public.registration_rate_limit_leases
  set lease_status = 'released',
      released_at = v_now,
      release_reason = v_reason
  where id = p_lease_id
    and lease_status = 'reserved';

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

create or replace function public.registration_consume_lease(
  p_lease_id uuid,
  p_now timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_updated integer := 0;
begin
  if p_lease_id is null then
    return false;
  end if;

  update public.registration_rate_limit_leases
  set lease_status = 'consumed',
      consumed_at = v_now,
      expires_at = greatest(expires_at, v_now)
  where id = p_lease_id
    and lease_status = 'reserved'
    and expires_at > v_now;

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

create or replace function public.registration_cleanup_rate_limit_leases(
  p_now timestamptz default now(),
  p_retention_hours integer default 168
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_retention_start timestamptz := v_now - make_interval(hours => greatest(1, p_retention_hours));
  v_deleted integer := 0;
begin
  update public.registration_rate_limit_leases
  set lease_status = 'expired',
      released_at = coalesce(released_at, v_now),
      release_reason = coalesce(release_reason, 'lease_expired')
  where lease_status = 'reserved'
    and expires_at <= v_now;

  delete from public.registration_rate_limit_leases
  where lease_status in ('released', 'expired')
    and coalesce(released_at, created_at) < v_retention_start;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

drop index if exists public.idx_profiles_public_id;
drop index if exists public.idx_users_public_id;
drop index if exists public.idx_profiles_avatar_key;
drop index if exists public.idx_profiles_banner_key;
drop index if exists public.idx_call_sessions_created_by_status_created_at;
drop index if exists public.idx_call_signals_from_user_created_at;
drop index if exists public.idx_call_signals_to_user_created_at;
drop index if exists public.idx_user_blocks_blocked_id;
drop index if exists public.idx_user_blocks_blocker_created_at;
drop index if exists public.idx_messages_sender_created_id;
drop index if exists public.idx_messages_reply_to_id;
drop index if exists public.idx_messages_call_id;
drop index if exists public.idx_messages_created_at_brin;
drop index if exists public.idx_attachments_conversation_id;
drop index if exists public.idx_attachments_original_key;
drop index if exists public.idx_attachments_thumb_key;
drop index if exists public.idx_message_reads_user_id_message_id;
drop index if exists public.idx_message_reads_user_id_read_at;
drop index if exists public.idx_presence_updated_at;
drop index if exists public.idx_user_sessions_user_created_at;
drop index if exists public.idx_media_uploads_owner_status_last_seen;
drop index if exists public.idx_media_uploads_conversation_status_last_seen;
drop index if exists public.idx_spotify_oauth_tokens_expires_at;
drop index if exists public.idx_spotify_oauth_states_user_id;
drop index if exists public.idx_spotify_oauth_states_expires_at;
drop index if exists public.idx_registration_attempts_by_ip_created_at;
drop index if exists public.idx_registration_attempts_by_ip_user_id;
drop index if exists public.idx_captcha_failures_by_ip_created_at;
drop index if exists public.idx_blocked_ips_blocked_until;
drop index if exists public.idx_registration_attempts_by_fingerprint_user_id;
drop index if exists public.idx_blocked_fingerprints_blocked_until;
drop index if exists public.idx_registration_attempts_by_email_domain_user_id;
drop index if exists public.idx_suspicious_registration_events_event_created_at;
drop index if exists public.idx_suspicious_registration_events_ip_created_at;
drop index if exists public.idx_suspicious_registration_events_fingerprint_created_at;
drop index if exists public.idx_suspicious_registration_events_email_domain_created_at;

create unique index if not exists idx_profiles_username_ci
  on public.profiles (lower(username));

create unique index if not exists idx_profiles_email_ci
  on public.profiles (lower(email))
  where email is not null;

create unique index if not exists idx_users_username_ci
  on public.users (lower(username));

create unique index if not exists idx_users_email_ci
  on public.users (lower(email))
  where email is not null;

create unique index if not exists idx_conversations_user_pair_unique
  on public.conversations (user1_id, user2_id);

create index if not exists idx_conversations_user1_created_at
  on public.conversations (user1_id, created_at desc, id desc);

create index if not exists idx_conversations_user2_created_at
  on public.conversations (user2_id, created_at desc, id desc);

create unique index if not exists idx_friend_requests_pair_sym_unique
  on public.friend_requests (least(requester_id, addressee_id), greatest(requester_id, addressee_id));

create index if not exists idx_friend_requests_requester_status_created_at
  on public.friend_requests (requester_id, status, created_at desc, id desc);

create index if not exists idx_friend_requests_addressee_status_created_at
  on public.friend_requests (addressee_id, status, created_at desc, id desc);

create index if not exists idx_call_sessions_conversation_last_activity
  on public.call_sessions (conversation_id, last_activity_at desc, id desc);

create index if not exists idx_call_signals_call_created_at
  on public.call_signals (call_id, created_at desc, id desc);

create unique index if not exists idx_messages_sender_client_id_unique
  on public.messages (sender_id, client_id)
  where client_id is not null;

create index if not exists idx_messages_conversation_deleted_created_id
  on public.messages (conversation_id, deleted_at, created_at desc, id desc);

create index if not exists idx_attachments_file_key
  on public.attachments (file_key);

create unique index if not exists idx_user_sessions_auth_session_id
  on public.user_sessions (auth_session_id)
  where auth_session_id is not null;

create index if not exists idx_user_sessions_user_active_last_seen
  on public.user_sessions (user_id, last_seen_at desc)
  where ended_at is null and revoked_at is null;

create unique index if not exists idx_media_uploads_scope_conversation_unique
  on public.media_uploads (file_key, owner_user_id, conversation_id)
  where conversation_id is not null;

create unique index if not exists idx_media_uploads_scope_profile_unique
  on public.media_uploads (file_key, owner_user_id)
  where conversation_id is null;

create index if not exists idx_media_uploads_file_key
  on public.media_uploads (file_key);

create unique index if not exists idx_spotify_oauth_tokens_spotify_user_active
  on public.spotify_oauth_tokens (spotify_user_id)
  where revoked_at is null;

create index if not exists idx_registration_attempts_by_ip_lookup
  on public.registration_attempts_by_ip (ip_address, created_at desc);

create index if not exists idx_captcha_failures_by_ip_lookup
  on public.captcha_failures_by_ip (ip_address, created_at desc);

create index if not exists idx_registration_attempts_by_fingerprint_lookup
  on public.registration_attempts_by_fingerprint (fingerprint_hash, created_at desc);

create index if not exists idx_registration_attempts_by_fingerprint_ip
  on public.registration_attempts_by_fingerprint (ip_address, created_at desc);

create index if not exists idx_registration_attempts_by_email_domain_lookup
  on public.registration_attempts_by_email_domain (email_domain, created_at desc);

create index if not exists idx_registration_rate_limit_leases_ip_created
  on public.registration_rate_limit_leases (ip_address, created_at desc)
  where lease_status in ('reserved', 'consumed');

create index if not exists idx_registration_rate_limit_leases_fingerprint_created
  on public.registration_rate_limit_leases (fingerprint_hash, created_at desc)
  where lease_status in ('reserved', 'consumed');

create index if not exists idx_registration_rate_limit_leases_status_expires_at
  on public.registration_rate_limit_leases (lease_status, expires_at);

drop trigger if exists trg_profiles_normalize on public.profiles;
create trigger trg_profiles_normalize
before insert or update on public.profiles
for each row execute function public.normalize_profiles_row();

drop trigger if exists trg_profiles_set_updated_at on public.profiles;
create trigger trg_profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

drop trigger if exists trg_users_normalize on public.users;
create trigger trg_users_normalize
before insert or update on public.users
for each row execute function public.normalize_users_row();

drop trigger if exists trg_users_set_updated_at on public.users;
create trigger trg_users_set_updated_at
before update on public.users
for each row execute function public.set_updated_at();

drop trigger if exists trg_friend_requests_set_updated_at on public.friend_requests;
create trigger trg_friend_requests_set_updated_at
before update on public.friend_requests
for each row execute function public.set_updated_at();

drop trigger if exists touch_presence_row on public.presence;
drop trigger if exists trg_presence_touch_row on public.presence;
create trigger trg_presence_touch_row
before insert or update on public.presence
for each row execute function public.touch_presence_row();

drop trigger if exists trg_messages_validate_integrity on public.messages;
create trigger trg_messages_validate_integrity
before insert or update on public.messages
for each row execute function public.validate_message_integrity();

drop trigger if exists trg_attachments_validate_integrity on public.attachments;
create trigger trg_attachments_validate_integrity
before insert or update on public.attachments
for each row execute function public.validate_attachment_integrity();

drop trigger if exists trg_media_uploads_set_updated_at on public.media_uploads;
create trigger trg_media_uploads_set_updated_at
before update on public.media_uploads
for each row execute function public.set_updated_at();

drop trigger if exists trg_spotify_oauth_tokens_set_updated_at on public.spotify_oauth_tokens;
create trigger trg_spotify_oauth_tokens_set_updated_at
before update on public.spotify_oauth_tokens
for each row execute function public.set_updated_at();

drop trigger if exists trg_blocked_ips_set_updated_at on public.blocked_ips;
create trigger trg_blocked_ips_set_updated_at
before update on public.blocked_ips
for each row execute function public.set_updated_at();

drop trigger if exists trg_blocked_fingerprints_set_updated_at on public.blocked_fingerprints;
create trigger trg_blocked_fingerprints_set_updated_at
before update on public.blocked_fingerprints
for each row execute function public.set_updated_at();

drop trigger if exists trg_users_sync_to_profiles on public.users;
create trigger trg_users_sync_to_profiles
after insert or update on public.users
for each row execute function public.sync_users_to_profiles();

drop trigger if exists trg_profiles_sync_to_users on public.profiles;
create trigger trg_profiles_sync_to_users
after insert or update on public.profiles
for each row execute function public.sync_profiles_to_users();

alter table public.profiles enable row level security;
alter table public.users enable row level security;
alter table public.conversations enable row level security;
alter table public.friend_requests enable row level security;
alter table public.user_blocks enable row level security;
alter table public.call_sessions enable row level security;
alter table public.call_signals enable row level security;
alter table public.messages enable row level security;
alter table public.attachments enable row level security;
alter table public.message_reads enable row level security;
alter table public.presence enable row level security;
alter table public.user_sessions enable row level security;
alter table public.media_uploads enable row level security;
alter table public.spotify_oauth_tokens enable row level security;
alter table public.spotify_oauth_states enable row level security;
alter table public.registration_attempts_by_ip enable row level security;
alter table public.captcha_failures_by_ip enable row level security;
alter table public.blocked_ips enable row level security;
alter table public.registration_attempts_by_fingerprint enable row level security;
alter table public.blocked_fingerprints enable row level security;
alter table public.registration_attempts_by_email_domain enable row level security;
alter table public.suspicious_registration_events enable row level security;
alter table public.registration_rate_limit_leases enable row level security;

alter table public.profiles force row level security;
alter table public.users force row level security;
alter table public.conversations force row level security;
alter table public.friend_requests force row level security;
alter table public.user_blocks force row level security;
alter table public.call_sessions force row level security;
alter table public.call_signals force row level security;
alter table public.messages force row level security;
alter table public.attachments force row level security;
alter table public.message_reads force row level security;
alter table public.presence force row level security;
alter table public.user_sessions force row level security;
alter table public.media_uploads force row level security;
alter table public.spotify_oauth_tokens force row level security;
alter table public.spotify_oauth_states force row level security;
alter table public.registration_attempts_by_ip force row level security;
alter table public.captcha_failures_by_ip force row level security;
alter table public.blocked_ips force row level security;
alter table public.registration_attempts_by_fingerprint force row level security;
alter table public.blocked_fingerprints force row level security;
alter table public.registration_attempts_by_email_domain force row level security;
alter table public.suspicious_registration_events force row level security;
alter table public.registration_rate_limit_leases force row level security;

drop policy if exists profiles_select_self_or_visible on public.profiles;
create policy profiles_select_self_or_visible
on public.profiles
for select
to authenticated
using (
  (select auth.uid()) is not null
  and (
    id = (select auth.uid())
    or coalesce(friend_requests_allow_all, true)
    or coalesce(friend_requests_allow_friends_of_friends, true)
    or exists (
      select 1
      from public.friend_requests fr
      where fr.status = 'accepted'
        and (
          (fr.requester_id = (select auth.uid()) and fr.addressee_id = profiles.id)
          or (fr.addressee_id = (select auth.uid()) and fr.requester_id = profiles.id)
        )
    )
    or exists (
      select 1
      from public.conversations c
      where (c.user1_id = (select auth.uid()) and c.user2_id = profiles.id)
         or (c.user2_id = (select auth.uid()) and c.user1_id = profiles.id)
    )
  )
  and not public.user_ids_are_blocked((select auth.uid()), profiles.id)
);

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self
on public.profiles
for insert
to authenticated
with check (id = (select auth.uid()));

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self
on public.profiles
for update
to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

drop policy if exists users_select_self on public.users;
create policy users_select_self
on public.users
for select
to authenticated
using (id = (select auth.uid()));

drop policy if exists users_update_self on public.users;
create policy users_update_self
on public.users
for update
to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

drop policy if exists conversations_select_member on public.conversations;
create policy conversations_select_member
on public.conversations
for select
to authenticated
using (public.is_conversation_member(id, (select auth.uid())));

drop policy if exists conversations_insert_self on public.conversations;
create policy conversations_insert_self
on public.conversations
for insert
to authenticated
with check (
  (select auth.uid()) is not null
  and (
    (user1_id = (select auth.uid()) and user2_id <> (select auth.uid()))
    or
    (user2_id = (select auth.uid()) and user1_id <> (select auth.uid()))
  )
  and user1_id < user2_id
  and not public.user_ids_are_blocked(user1_id, user2_id)
);

drop policy if exists friend_requests_select_participant on public.friend_requests;
create policy friend_requests_select_participant
on public.friend_requests
for select
to authenticated
using ((select auth.uid()) in (requester_id, addressee_id));

drop policy if exists friend_requests_insert_requester on public.friend_requests;
create policy friend_requests_insert_requester
on public.friend_requests
for insert
to authenticated
with check (
  (select auth.uid()) = requester_id
  and requester_id <> addressee_id
  and not public.user_ids_are_blocked(requester_id, addressee_id)
);

drop policy if exists friend_requests_update_participant on public.friend_requests;
create policy friend_requests_update_participant
on public.friend_requests
for update
to authenticated
using ((select auth.uid()) in (requester_id, addressee_id))
with check ((select auth.uid()) in (requester_id, addressee_id));

drop policy if exists friend_requests_delete_participant on public.friend_requests;
create policy friend_requests_delete_participant
on public.friend_requests
for delete
to authenticated
using ((select auth.uid()) in (requester_id, addressee_id));

drop policy if exists user_blocks_self on public.user_blocks;
create policy user_blocks_self
on public.user_blocks
for all
to authenticated
using ((select auth.uid()) = blocker_id)
with check ((select auth.uid()) = blocker_id);

drop policy if exists call_sessions_select_member on public.call_sessions;
create policy call_sessions_select_member
on public.call_sessions
for select
to authenticated
using (public.is_conversation_member(conversation_id, (select auth.uid())));

drop policy if exists call_sessions_insert_member on public.call_sessions;
create policy call_sessions_insert_member
on public.call_sessions
for insert
to authenticated
with check (
  (select auth.uid()) = created_by
  and public.is_conversation_member(conversation_id, (select auth.uid()))
);

drop policy if exists call_sessions_update_member on public.call_sessions;
create policy call_sessions_update_member
on public.call_sessions
for update
to authenticated
using (public.is_conversation_member(conversation_id, (select auth.uid())))
with check (public.is_conversation_member(conversation_id, (select auth.uid())));

drop policy if exists call_sessions_delete_creator on public.call_sessions;
create policy call_sessions_delete_creator
on public.call_sessions
for delete
to authenticated
using (
  (select auth.uid()) = created_by
  and public.is_conversation_member(conversation_id, (select auth.uid()))
);

drop policy if exists call_signals_select_member on public.call_signals;
create policy call_signals_select_member
on public.call_signals
for select
to authenticated
using (
  public.can_access_call(call_id, (select auth.uid()))
  and ((select auth.uid()) = from_user_id or (select auth.uid()) = to_user_id)
);

drop policy if exists call_signals_insert_member on public.call_signals;
create policy call_signals_insert_member
on public.call_signals
for insert
to authenticated
with check (
  public.can_access_call(call_id, (select auth.uid()))
  and ((select auth.uid()) = from_user_id or (select auth.uid()) = to_user_id)
);

drop policy if exists messages_select_member on public.messages;
create policy messages_select_member
on public.messages
for select
to authenticated
using (
  (select auth.uid()) is not null
  and public.is_conversation_member(conversation_id, (select auth.uid()))
  and not exists (
    select 1
    from public.user_blocks ub
    where (ub.blocker_id = (select auth.uid()) and ub.blocked_id = messages.sender_id)
       or (ub.blocker_id = messages.sender_id and ub.blocked_id = (select auth.uid()))
  )
);

drop policy if exists messages_insert_sender_member on public.messages;
create policy messages_insert_sender_member
on public.messages
for insert
to authenticated
with check (
  (select auth.uid()) = sender_id
  and public.is_conversation_member(conversation_id, (select auth.uid()))
  and exists (
    select 1
    from public.conversations c
    where c.id = messages.conversation_id
      and not public.user_ids_are_blocked(c.user1_id, c.user2_id)
  )
);

drop policy if exists messages_update_sender_member on public.messages;
create policy messages_update_sender_member
on public.messages
for update
to authenticated
using (
  (select auth.uid()) = sender_id
  and public.is_conversation_member(conversation_id, (select auth.uid()))
  and exists (
    select 1
    from public.conversations c
    where c.id = messages.conversation_id
      and not public.user_ids_are_blocked(c.user1_id, c.user2_id)
  )
)
with check (
  (select auth.uid()) = sender_id
  and public.is_conversation_member(conversation_id, (select auth.uid()))
  and exists (
    select 1
    from public.conversations c
    where c.id = messages.conversation_id
      and not public.user_ids_are_blocked(c.user1_id, c.user2_id)
  )
);

drop policy if exists messages_delete_sender_member on public.messages;
create policy messages_delete_sender_member
on public.messages
for delete
to authenticated
using (
  (select auth.uid()) = sender_id
  and public.is_conversation_member(conversation_id, (select auth.uid()))
  and exists (
    select 1
    from public.conversations c
    where c.id = messages.conversation_id
      and not public.user_ids_are_blocked(c.user1_id, c.user2_id)
  )
);

drop policy if exists attachments_access_base on public.attachments;
create policy attachments_access_base
on public.attachments
as permissive
for all
to authenticated
using (public.can_access_message(message_id, (select auth.uid())))
with check (public.can_access_message(message_id, (select auth.uid())));

drop policy if exists attachments_write_author_insert on public.attachments;
create policy attachments_write_author_insert
on public.attachments
as restrictive
for insert
to authenticated
with check (public.is_message_author(message_id, (select auth.uid())));

drop policy if exists attachments_write_author_update on public.attachments;
create policy attachments_write_author_update
on public.attachments
as restrictive
for update
to authenticated
using (public.is_message_author(message_id, (select auth.uid())))
with check (public.is_message_author(message_id, (select auth.uid())));

drop policy if exists attachments_write_author_delete on public.attachments;
create policy attachments_write_author_delete
on public.attachments
as restrictive
for delete
to authenticated
using (public.is_message_author(message_id, (select auth.uid())));

drop policy if exists message_reads_self on public.message_reads;
create policy message_reads_self
on public.message_reads
for all
to authenticated
using (
  (select auth.uid()) = user_id
  and public.can_access_message(message_id, (select auth.uid()))
)
with check (
  (select auth.uid()) = user_id
  and public.can_access_message(message_id, (select auth.uid()))
);

drop policy if exists presence_select_relationship on public.presence;
create policy presence_select_relationship
on public.presence
for select
to authenticated
using (
  (select auth.uid()) is not null
  and (
    user_id = (select auth.uid())
    or exists (
      select 1
      from public.friend_requests fr
      where fr.status = 'accepted'
        and (
          (fr.requester_id = (select auth.uid()) and fr.addressee_id = presence.user_id)
          or (fr.addressee_id = (select auth.uid()) and fr.requester_id = presence.user_id)
        )
    )
    or exists (
      select 1
      from public.conversations c
      where (c.user1_id = (select auth.uid()) and c.user2_id = presence.user_id)
         or (c.user2_id = (select auth.uid()) and c.user1_id = presence.user_id)
    )
  )
  and not public.user_ids_are_blocked((select auth.uid()), presence.user_id)
);

drop policy if exists presence_insert_self on public.presence;
create policy presence_insert_self
on public.presence
for insert
to authenticated
with check (user_id = (select auth.uid()));

drop policy if exists presence_update_self on public.presence;
create policy presence_update_self
on public.presence
for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

drop policy if exists user_sessions_select_self on public.user_sessions;
create policy user_sessions_select_self
on public.user_sessions
for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists user_sessions_insert_self on public.user_sessions;
create policy user_sessions_insert_self
on public.user_sessions
for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists user_sessions_update_self on public.user_sessions;
create policy user_sessions_update_self
on public.user_sessions
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists media_uploads_select_owner on public.media_uploads;
create policy media_uploads_select_owner
on public.media_uploads
for select
to authenticated
using ((select auth.uid()) = owner_user_id);

drop policy if exists media_uploads_insert_owner on public.media_uploads;
create policy media_uploads_insert_owner
on public.media_uploads
for insert
to authenticated
with check (
  (select auth.uid()) = owner_user_id
  and (conversation_id is null or public.is_conversation_member(conversation_id, (select auth.uid())))
);

drop policy if exists media_uploads_update_owner on public.media_uploads;
create policy media_uploads_update_owner
on public.media_uploads
for update
to authenticated
using (
  (select auth.uid()) = owner_user_id
  and (conversation_id is null or public.is_conversation_member(conversation_id, (select auth.uid())))
)
with check (
  (select auth.uid()) = owner_user_id
  and (conversation_id is null or public.is_conversation_member(conversation_id, (select auth.uid())))
);

drop policy if exists media_uploads_delete_owner on public.media_uploads;
create policy media_uploads_delete_owner
on public.media_uploads
for delete
to authenticated
using ((select auth.uid()) = owner_user_id);

drop policy if exists spotify_oauth_tokens_service_role_all on public.spotify_oauth_tokens;
create policy spotify_oauth_tokens_service_role_all
on public.spotify_oauth_tokens
for all
to service_role
using (true)
with check (true);

drop policy if exists spotify_oauth_states_service_role_all on public.spotify_oauth_states;
create policy spotify_oauth_states_service_role_all
on public.spotify_oauth_states
for all
to service_role
using (true)
with check (true);

drop policy if exists registration_attempts_by_ip_service_role_all on public.registration_attempts_by_ip;
create policy registration_attempts_by_ip_service_role_all
on public.registration_attempts_by_ip
for all
to service_role
using (true)
with check (true);

drop policy if exists captcha_failures_by_ip_service_role_all on public.captcha_failures_by_ip;
create policy captcha_failures_by_ip_service_role_all
on public.captcha_failures_by_ip
for all
to service_role
using (true)
with check (true);

drop policy if exists blocked_ips_service_role_all on public.blocked_ips;
create policy blocked_ips_service_role_all
on public.blocked_ips
for all
to service_role
using (true)
with check (true);

drop policy if exists registration_attempts_by_fingerprint_service_role_all on public.registration_attempts_by_fingerprint;
create policy registration_attempts_by_fingerprint_service_role_all
on public.registration_attempts_by_fingerprint
for all
to service_role
using (true)
with check (true);

drop policy if exists blocked_fingerprints_service_role_all on public.blocked_fingerprints;
create policy blocked_fingerprints_service_role_all
on public.blocked_fingerprints
for all
to service_role
using (true)
with check (true);

drop policy if exists registration_attempts_by_email_domain_service_role_all on public.registration_attempts_by_email_domain;
create policy registration_attempts_by_email_domain_service_role_all
on public.registration_attempts_by_email_domain
for all
to service_role
using (true)
with check (true);

drop policy if exists suspicious_registration_events_service_role_all on public.suspicious_registration_events;
create policy suspicious_registration_events_service_role_all
on public.suspicious_registration_events
for all
to service_role
using (true)
with check (true);

drop policy if exists registration_rate_limit_leases_service_role_all on public.registration_rate_limit_leases;
create policy registration_rate_limit_leases_service_role_all
on public.registration_rate_limit_leases
for all
to service_role
using (true)
with check (true);

revoke all on schema public from public;
grant usage on schema public to anon;
grant usage on schema public to authenticated;
grant usage on schema public to service_role;

revoke all on all tables in schema public from public;
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;

grant all on all tables in schema public to service_role;

grant select, insert, update on table public.profiles to authenticated;
grant select, update on table public.users to authenticated;
grant select, insert on table public.conversations to authenticated;
grant select, insert, update, delete on table public.friend_requests to authenticated;
grant select, insert, delete on table public.user_blocks to authenticated;
grant select, insert, update, delete on table public.call_sessions to authenticated;
grant select, insert on table public.call_signals to authenticated;
grant select, insert, update, delete on table public.messages to authenticated;
grant select, insert, update, delete on table public.attachments to authenticated;
grant select, insert, update on table public.message_reads to authenticated;
grant select, insert, update on table public.presence to authenticated;
grant select, insert, update on table public.user_sessions to authenticated;
grant select, insert, update, delete on table public.media_uploads to authenticated;

revoke all on all sequences in schema public from public;
revoke all on all sequences in schema public from anon;
revoke all on all sequences in schema public from authenticated;
grant usage, select on all sequences in schema public to service_role;

revoke all on all functions in schema public from public;
revoke all on all functions in schema public from anon;
revoke all on all functions in schema public from authenticated;

grant execute on function public.is_conversation_member(uuid, uuid) to authenticated, service_role;
grant execute on function public.is_message_author(uuid, uuid) to authenticated, service_role;
grant execute on function public.can_access_message(uuid, uuid) to authenticated, service_role;
grant execute on function public.can_access_call(uuid, uuid) to authenticated, service_role;
grant execute on function public.user_ids_are_blocked(uuid, uuid) to authenticated, service_role;
grant execute on function public.list_mutual_friend_ids(uuid) to authenticated, service_role;
grant execute on function public.delete_user(uuid) to authenticated, service_role;

revoke all on function public.registration_try_acquire_lease(text, text, timestamptz, integer, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.registration_release_lease(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.registration_consume_lease(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.registration_cleanup_rate_limit_leases(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.registration_try_acquire_lease(text, text, timestamptz, integer, integer, integer, integer, integer) to service_role;
grant execute on function public.registration_release_lease(uuid, text, timestamptz) to service_role;
grant execute on function public.registration_consume_lease(uuid, timestamptz) to service_role;
grant execute on function public.registration_cleanup_rate_limit_leases(timestamptz, integer) to service_role;

do $$
declare
  rec record;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    for rec in
      select *
      from (
        values
          ('public', 'profiles'),
          ('public', 'conversations'),
          ('public', 'friend_requests'),
          ('public', 'user_blocks'),
          ('public', 'messages'),
          ('public', 'attachments'),
          ('public', 'message_reads'),
          ('public', 'presence'),
          ('public', 'call_sessions'),
          ('public', 'call_signals')
      ) as t(schema_name, table_name)
    loop
      begin
        execute format(
          'alter publication supabase_realtime add table %I.%I',
          rec.schema_name,
          rec.table_name
        );
      exception
        when duplicate_object then
          null;
      end;
    end loop;
  end if;
exception
  when undefined_object then
    null;
end;
$$;

commit;
