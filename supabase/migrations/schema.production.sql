-- =========================================================
-- Supabase auth-first schema (produção)
-- =========================================================
begin;

-- ---------------------------------------------------------
-- Extensões
-- ---------------------------------------------------------
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

-- ---------------------------------------------------------
-- Função utilitária global
-- ---------------------------------------------------------
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

-- ---------------------------------------------------------
-- Tratamento seguro do legado Firebase
-- ---------------------------------------------------------
drop table if exists public.user_identities;
drop table if exists public.users_legacy_media_backup;

do $$
begin
  if exists (
    select 1
    from pg_class
    where relname = 'users'
      and relnamespace = 'public'::regnamespace
  ) then
    raise exception 'Tabela legada public.users ainda existe; remova manualmente após backup para concluir a migração.';
  end if;
end $$;

drop function if exists public.current_firebase_uid();
drop function if exists public.current_app_user_id();
drop function if exists public.is_anon_compat_request();

do $$
begin
  perform set_config('messly.enable_anon_users_compat', 'false', false);
exception
  when others then null;
end $$;

-- ---------------------------------------------------------
-- Perfis
-- ---------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text null,
  username text not null,
  display_name text null,
  avatar_url text null,
  banner_url text null,
  bio text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_username_format_chk check (username ~ '^[a-z0-9._]{3,32}$'),
  constraint profiles_username_lower_chk check (username = lower(username)),
  constraint profiles_email_lower_chk check (email is null or email = lower(email))
);

create unique index if not exists profiles_username_unique_ci_idx
  on public.profiles (lower(username));

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

  return new;
end;
$$;

drop trigger if exists trg_profiles_normalize on public.profiles;
create trigger trg_profiles_normalize
before insert or update on public.profiles
for each row execute function public.normalize_profiles_row();

drop trigger if exists trg_profiles_set_updated_at on public.profiles;
create trigger trg_profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------
-- Sessões
-- ---------------------------------------------------------
create table if not exists public.user_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  session_token text not null unique,
  ip_address text not null,
  city text null,
  region text null,
  country text null,
  device text not null,
  os text not null,
  client_version text null,
  user_agent text null,
  suspicious boolean not null default false,
  suspicious_reason text null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at timestamptz null,
  constraint user_sessions_session_token_not_blank_chk check (btrim(session_token) <> ''),
  constraint user_sessions_ip_address_not_blank_chk check (btrim(ip_address) <> ''),
  constraint user_sessions_device_length_chk check (char_length(device) between 1 and 80),
  constraint user_sessions_os_length_chk check (char_length(os) between 1 and 80),
  constraint user_sessions_client_version_length_chk check (client_version is null or char_length(client_version) <= 32),
  constraint user_sessions_user_agent_length_chk check (user_agent is null or char_length(user_agent) <= 512),
  constraint user_sessions_suspicious_reason_length_chk check (suspicious_reason is null or char_length(suspicious_reason) <= 240),
  constraint user_sessions_time_order_chk check (ended_at is null or ended_at >= created_at)
);

-- sem índice extra aqui por enquanto: o advisor costuma marcar como unused
-- adicione depois se o workload real pedir

-- ---------------------------------------------------------
-- Conversas 1:1
-- ---------------------------------------------------------
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user1_id uuid not null references public.profiles(id) on delete cascade,
  user2_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint conversations_distinct_users_chk check (user1_id <> user2_id),
  constraint conversations_user_order_chk check (user1_id < user2_id)
);

create unique index if not exists conversations_pair_unique
  on public.conversations(user1_id, user2_id);

-- índices opcionais removidos para evitar unused index até existir workload real

-- ---------------------------------------------------------
-- Friend requests
-- ---------------------------------------------------------
create table if not exists public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  addressee_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint friend_requests_distinct_users_chk check (requester_id <> addressee_id)
);

create unique index if not exists friend_requests_pair_sym_unique_idx
  on public.friend_requests (least(requester_id, addressee_id), greatest(requester_id, addressee_id));

drop trigger if exists trg_friend_requests_set_updated_at on public.friend_requests;
create trigger trg_friend_requests_set_updated_at
before update on public.friend_requests
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------
-- User blocks
-- ---------------------------------------------------------
create table if not exists public.user_blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint user_blocks_distinct_users_chk check (blocker_id <> blocked_id)
);

-- ---------------------------------------------------------
-- Messages
-- ---------------------------------------------------------
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  client_id text null,
  content text not null default '',
  type text not null default 'text' check (type in ('text', 'image', 'video', 'file', 'call_event')),
  created_at timestamptz not null default now(),
  edited_at timestamptz null,
  deleted_at timestamptz null,
  reply_to_id uuid null references public.messages(id) on delete set null,
  reply_to_snapshot jsonb null,
  call_id uuid null,
  payload jsonb null,
  constraint messages_content_length_chk check (char_length(content) <= 4000),
  constraint messages_client_id_not_blank_chk check (client_id is null or btrim(client_id) <> ''),
  constraint messages_reply_snapshot_object_chk check (reply_to_snapshot is null or jsonb_typeof(reply_to_snapshot) = 'object'),
  constraint messages_payload_object_chk check (payload is null or jsonb_typeof(payload) = 'object'),
  constraint messages_no_empty_text_chk check (
    type <> 'text' or deleted_at is not null or btrim(coalesce(content, '')) <> ''
  )
);

create index if not exists messages_conversation_id_idx
  on public.messages(conversation_id);

create index if not exists messages_call_id_idx
  on public.messages(call_id);

create unique index if not exists messages_client_sender_uidx
  on public.messages(sender_id, client_id)
  where client_id is not null;

-- ---------------------------------------------------------
-- Attachments
-- ---------------------------------------------------------
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
  constraint attachments_file_key_prefix_chk check (file_key like 'attachments/%'),
  constraint attachments_original_key_prefix_chk check (original_key is null or original_key like 'attachments/%'),
  constraint attachments_thumb_key_prefix_chk check (thumb_key is null or thumb_key like 'attachments/%'),
  constraint attachments_file_size_chk check (file_size is null or file_size > 0),
  constraint attachments_width_chk check (width is null or width > 0),
  constraint attachments_height_chk check (height is null or height > 0),
  constraint attachments_thumb_width_chk check (thumb_width is null or thumb_width > 0),
  constraint attachments_thumb_height_chk check (thumb_height is null or thumb_height > 0),
  constraint attachments_duration_chk check (duration_ms is null or duration_ms > 0)
);

-- sem índice em attachments.conversation_id por padrão

-- ---------------------------------------------------------
-- Message reads
-- ---------------------------------------------------------
create table if not exists public.message_reads (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  read_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

-- sem índice em user_id por padrão

-- ---------------------------------------------------------
-- Calls
-- ---------------------------------------------------------
create table if not exists public.call_sessions (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  created_by uuid not null references public.profiles(id) on delete restrict,
  mode text not null check (mode in ('audio', 'video')),
  status text not null default 'ringing' check (status in ('ringing', 'active', 'ended', 'missed', 'declined')),
  created_at timestamptz not null default now(),
  started_at timestamptz null,
  ended_at timestamptz null,
  last_activity_at timestamptz not null default now(),
  ended_reason text null check (ended_reason in ('no_answer', 'hangup', 'timeout', 'declined', 'error')),
  participants jsonb not null default '{}'::jsonb,
  constraint call_sessions_participants_object_chk check (jsonb_typeof(participants) = 'object'),
  constraint call_sessions_terminal_fields_chk check (
    (status in ('ended', 'missed', 'declined') and ended_at is not null and ended_reason is not null)
    or (status in ('ringing', 'active') and ended_reason is null)
  )
);

create index if not exists call_sessions_conversation_id_idx
  on public.call_sessions(conversation_id);

create table if not exists public.call_signals (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.call_sessions(id) on delete cascade,
  from_user_id uuid not null references public.profiles(id) on delete restrict,
  to_user_id uuid not null references public.profiles(id) on delete restrict,
  type text not null check (type in ('offer', 'answer', 'ice', 'bye')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint call_signals_distinct_participants_chk check (from_user_id <> to_user_id),
  constraint call_signals_payload_object_chk check (jsonb_typeof(payload) = 'object')
);

create index if not exists call_signals_call_id_idx
  on public.call_signals(call_id);

-- FK de call_id adicionada após existir call_sessions
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'messages_call_id_fkey'
  ) then
    alter table public.messages
      add constraint messages_call_id_fkey
      foreign key (call_id) references public.call_sessions(id) on delete set null;
  end if;
end $$;

-- ---------------------------------------------------------
-- Triggers de integridade
-- ---------------------------------------------------------
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

drop trigger if exists trg_messages_validate_integrity on public.messages;
create trigger trg_messages_validate_integrity
before insert or update on public.messages
for each row execute function public.validate_message_integrity();

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

drop trigger if exists trg_attachments_validate_integrity on public.attachments;
create trigger trg_attachments_validate_integrity
before insert or update on public.attachments
for each row execute function public.validate_attachment_integrity();

-- ---------------------------------------------------------
-- Funções auxiliares para RLS
-- ---------------------------------------------------------
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
    join public.conversations c on c.id = m.conversation_id
    where m.id = p_message_id
      and (c.user1_id = p_user_id or c.user2_id = p_user_id)
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

revoke all on function public.is_conversation_member(uuid, uuid) from public;
revoke all on function public.is_message_author(uuid, uuid) from public;
revoke all on function public.can_access_message(uuid, uuid) from public;
revoke all on function public.can_access_call(uuid, uuid) from public;

grant execute on function public.is_conversation_member(uuid, uuid) to authenticated;
grant execute on function public.is_message_author(uuid, uuid) to authenticated;
grant execute on function public.can_access_message(uuid, uuid) to authenticated;
grant execute on function public.can_access_call(uuid, uuid) to authenticated;

-- ---------------------------------------------------------
-- RLS
-- ---------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.user_sessions enable row level security;
alter table public.conversations enable row level security;
alter table public.friend_requests enable row level security;
alter table public.user_blocks enable row level security;
alter table public.messages enable row level security;
alter table public.attachments enable row level security;
alter table public.message_reads enable row level security;
alter table public.call_sessions enable row level security;
alter table public.call_signals enable row level security;

alter table public.profiles force row level security;
alter table public.user_sessions force row level security;
alter table public.conversations force row level security;
alter table public.friend_requests force row level security;
alter table public.user_blocks force row level security;
alter table public.messages force row level security;
alter table public.attachments force row level security;
alter table public.message_reads force row level security;
alter table public.call_sessions force row level security;
alter table public.call_signals force row level security;

-- Perfis
drop policy if exists profiles_select_authenticated on public.profiles;
create policy profiles_select_authenticated
on public.profiles
for select
to authenticated
using (true);

drop policy if exists profiles_insert_self on public.profiles;
create policy profiles_insert_self
on public.profiles
for insert
to authenticated
with check (((select auth.uid()) = id));

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self
on public.profiles
for update
to authenticated
using (((select auth.uid()) = id))
with check (((select auth.uid()) = id));

-- User sessions
drop policy if exists user_sessions_select_self on public.user_sessions;
create policy user_sessions_select_self
on public.user_sessions
for select
to authenticated
using (((select auth.uid()) = user_id));

drop policy if exists user_sessions_insert_self on public.user_sessions;
create policy user_sessions_insert_self
on public.user_sessions
for insert
to authenticated
with check (((select auth.uid()) = user_id));

drop policy if exists user_sessions_update_self on public.user_sessions;
create policy user_sessions_update_self
on public.user_sessions
for update
to authenticated
using (((select auth.uid()) = user_id))
with check (((select auth.uid()) = user_id));

-- Conversations
drop policy if exists conversations_select_member on public.conversations;
create policy conversations_select_member
on public.conversations
for select
to authenticated
using (((select public.is_conversation_member(id, (select auth.uid())))));

drop policy if exists conversations_insert_self on public.conversations;
create policy conversations_insert_self
on public.conversations
for insert
to authenticated
with check (
  ((select auth.uid()) is not null)
  and (
    (user1_id = (select auth.uid()) and user2_id <> (select auth.uid()))
    or
    (user2_id = (select auth.uid()) and user1_id <> (select auth.uid()))
  )
  and user1_id < user2_id
);

-- Friend requests
drop policy if exists friend_requests_select_participant on public.friend_requests;
create policy friend_requests_select_participant
on public.friend_requests
for select
to authenticated
using (((select auth.uid()) in (requester_id, addressee_id)));

drop policy if exists friend_requests_insert_requester on public.friend_requests;
create policy friend_requests_insert_requester
on public.friend_requests
for insert
to authenticated
with check (
  ((select auth.uid()) = requester_id)
  and requester_id <> addressee_id
);

drop policy if exists friend_requests_update_participant on public.friend_requests;
create policy friend_requests_update_participant
on public.friend_requests
for update
to authenticated
using (((select auth.uid()) in (requester_id, addressee_id)))
with check (((select auth.uid()) in (requester_id, addressee_id)));

drop policy if exists friend_requests_delete_participant on public.friend_requests;
create policy friend_requests_delete_participant
on public.friend_requests
for delete
to authenticated
using (((select auth.uid()) in (requester_id, addressee_id)));

-- User blocks
drop policy if exists user_blocks_self on public.user_blocks;
drop policy if exists user_blocks_select_self on public.user_blocks;
drop policy if exists user_blocks_insert_self on public.user_blocks;
drop policy if exists user_blocks_delete_self on public.user_blocks;

create policy user_blocks_self
on public.user_blocks
as permissive
for all
to authenticated
using (((select auth.uid()) = blocker_id))
with check (((select auth.uid()) = blocker_id));

-- Messages
drop policy if exists messages_select_member on public.messages;
create policy messages_select_member
on public.messages
for select
to authenticated
using (((select public.is_conversation_member(conversation_id, (select auth.uid())))));

drop policy if exists messages_insert_author_member on public.messages;
create policy messages_insert_author_member
on public.messages
for insert
to authenticated
with check (
  ((select auth.uid()) = sender_id)
  and ((select public.is_conversation_member(conversation_id, (select auth.uid()))))
);

drop policy if exists messages_update_author on public.messages;
create policy messages_update_author
on public.messages
for update
to authenticated
using (((select auth.uid()) = sender_id))
with check (
  ((select auth.uid()) = sender_id)
  and ((select public.is_conversation_member(conversation_id, (select auth.uid()))))
);

-- Attachments
drop policy if exists attachments_access_base on public.attachments;
drop policy if exists attachments_write_author_insert on public.attachments;
drop policy if exists attachments_write_author_update on public.attachments;
drop policy if exists attachments_write_author_delete on public.attachments;
drop policy if exists attachments_select_member on public.attachments;
drop policy if exists attachments_insert_author on public.attachments;
drop policy if exists attachments_update_author on public.attachments;
drop policy if exists attachments_delete_author on public.attachments;
drop policy if exists attachments_mutate_author on public.attachments;

create policy attachments_access_base
on public.attachments
as permissive
for all
to authenticated
using (
  ((select public.can_access_message(message_id, (select auth.uid()))))
)
with check (
  ((select public.can_access_message(message_id, (select auth.uid()))))
);

create policy attachments_write_author_insert
on public.attachments
as restrictive
for insert
to authenticated
with check (
  ((select public.is_message_author(message_id, (select auth.uid()))))
);

create policy attachments_write_author_update
on public.attachments
as restrictive
for update
to authenticated
using (
  ((select public.is_message_author(message_id, (select auth.uid()))))
)
with check (
  ((select public.is_message_author(message_id, (select auth.uid()))))
);

create policy attachments_write_author_delete
on public.attachments
as restrictive
for delete
to authenticated
using (
  ((select public.is_message_author(message_id, (select auth.uid()))))
);

-- Message reads
drop policy if exists message_reads_self on public.message_reads;
drop policy if exists message_reads_select_self on public.message_reads;
drop policy if exists message_reads_insert_self on public.message_reads;
drop policy if exists message_reads_update_self on public.message_reads;

create policy message_reads_self
on public.message_reads
as permissive
for all
to authenticated
using (
  ((select auth.uid()) = user_id)
  and ((select public.can_access_message(message_id, (select auth.uid()))))
)
with check (
  ((select auth.uid()) = user_id)
  and ((select public.can_access_message(message_id, (select auth.uid()))))
);

-- Call sessions
drop policy if exists call_sessions_select_member on public.call_sessions;
create policy call_sessions_select_member
on public.call_sessions
for select
to authenticated
using (((select public.is_conversation_member(conversation_id, (select auth.uid())))));

drop policy if exists call_sessions_insert_member on public.call_sessions;
create policy call_sessions_insert_member
on public.call_sessions
for insert
to authenticated
with check (
  ((select auth.uid()) = created_by)
  and ((select public.is_conversation_member(conversation_id, (select auth.uid()))))
);

drop policy if exists call_sessions_update_member on public.call_sessions;
create policy call_sessions_update_member
on public.call_sessions
for update
to authenticated
using (((select public.is_conversation_member(conversation_id, (select auth.uid())))))
with check (((select public.is_conversation_member(conversation_id, (select auth.uid())))));

drop policy if exists call_sessions_delete_creator on public.call_sessions;
drop policy if exists call_sessions_delete_member on public.call_sessions;
create policy call_sessions_delete_creator
on public.call_sessions
for delete
to authenticated
using (
  ((select auth.uid()) = created_by)
  and ((select public.is_conversation_member(conversation_id, (select auth.uid()))))
);

-- Call signals
drop policy if exists call_signals_select_member on public.call_signals;
drop policy if exists call_signals_member on public.call_signals;
create policy call_signals_select_member
on public.call_signals
for select
to authenticated
using (
  ((select public.can_access_call(call_id, (select auth.uid()))))
  and ((select auth.uid()) in (from_user_id, to_user_id))
);

drop policy if exists call_signals_insert_member on public.call_signals;
create policy call_signals_insert_member
on public.call_signals
for insert
to authenticated
with check (
  ((select public.can_access_call(call_id, (select auth.uid()))))
  and ((select auth.uid()) in (from_user_id, to_user_id))
);

-- ---------------------------------------------------------
-- Grants
-- ---------------------------------------------------------
revoke all on schema public from public;
grant usage on schema public to authenticated;

grant select, insert, update on public.profiles to authenticated;
grant select, insert, update on public.user_sessions to authenticated;
grant select, insert on public.conversations to authenticated;
grant select, insert, update, delete on public.friend_requests to authenticated;
grant select, insert, delete on public.user_blocks to authenticated;
grant select, insert, update on public.messages to authenticated;
grant select, insert, update, delete on public.attachments to authenticated;
grant select, insert, update on public.message_reads to authenticated;
grant select, insert, update, delete on public.call_sessions to authenticated;
grant select, insert on public.call_signals to authenticated;

commit;