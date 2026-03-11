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
  constraint media_uploads_sha256_chk check (sha256 ~ '^[a-f0-9]{64}$'),
  constraint media_uploads_size_bytes_chk check (size_bytes > 0),
  constraint media_uploads_status_chk check (status in ('pending', 'uploaded', 'attached', 'deleted'))
);

create unique index if not exists media_uploads_scope_conversation_uidx
  on public.media_uploads (file_key, owner_user_id, conversation_id)
  where conversation_id is not null;

create unique index if not exists media_uploads_scope_profile_uidx
  on public.media_uploads (file_key, owner_user_id)
  where conversation_id is null;

create index if not exists media_uploads_file_key_idx
  on public.media_uploads (file_key);

create index if not exists media_uploads_owner_idx
  on public.media_uploads (owner_user_id, status, last_seen_at desc);

create index if not exists media_uploads_conversation_idx
  on public.media_uploads (conversation_id, status, last_seen_at desc)
  where conversation_id is not null;

alter table if exists public.media_uploads enable row level security;
alter table if exists public.media_uploads force row level security;

drop policy if exists media_uploads_select_owner on public.media_uploads;
create policy media_uploads_select_owner
on public.media_uploads
for select
to authenticated
using (auth.uid() = owner_user_id);

drop policy if exists media_uploads_insert_owner on public.media_uploads;
create policy media_uploads_insert_owner
on public.media_uploads
for insert
to authenticated
with check (auth.uid() = owner_user_id);

drop policy if exists media_uploads_update_owner on public.media_uploads;
create policy media_uploads_update_owner
on public.media_uploads
for update
to authenticated
using (auth.uid() = owner_user_id)
with check (auth.uid() = owner_user_id);

drop policy if exists media_uploads_delete_owner on public.media_uploads;
create policy media_uploads_delete_owner
on public.media_uploads
for delete
to authenticated
using (auth.uid() = owner_user_id);

grant select, insert, update, delete on public.media_uploads to authenticated;

alter table public.attachments drop constraint if exists attachments_file_key_prefix_chk;
alter table public.attachments
  add constraint attachments_file_key_prefix_chk
  check (file_key like 'attachments/%' or file_key like 'messages/%');

alter table public.attachments drop constraint if exists attachments_original_key_prefix_chk;
alter table public.attachments
  add constraint attachments_original_key_prefix_chk
  check (original_key is null or original_key like 'attachments/%' or original_key like 'messages/%');

alter table public.attachments drop constraint if exists attachments_thumb_key_prefix_chk;
alter table public.attachments
  add constraint attachments_thumb_key_prefix_chk
  check (thumb_key is null or thumb_key like 'attachments/%' or thumb_key like 'messages/%');

create index if not exists attachments_file_key_idx
  on public.attachments (file_key);

create index if not exists attachments_original_key_idx
  on public.attachments (original_key)
  where original_key is not null;

create index if not exists attachments_thumb_key_idx
  on public.attachments (thumb_key)
  where thumb_key is not null;

create index if not exists profiles_avatar_key_idx
  on public.profiles (avatar_key)
  where avatar_key is not null;

create index if not exists profiles_banner_key_idx
  on public.profiles (banner_key)
  where banner_key is not null;
