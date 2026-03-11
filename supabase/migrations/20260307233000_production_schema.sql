begin;

-- ---------------------------------------------------------
-- Helpers for chat authorization (idempotent)
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

revoke all on function public.is_conversation_member(uuid, uuid) from public;
revoke all on function public.can_access_message(uuid, uuid) from public;
revoke all on function public.can_access_call(uuid, uuid) from public;
revoke all on function public.is_message_author(uuid, uuid) from public;
grant execute on function public.is_conversation_member(uuid, uuid) to authenticated;
grant execute on function public.can_access_message(uuid, uuid) to authenticated;
grant execute on function public.can_access_call(uuid, uuid) to authenticated;
grant execute on function public.is_message_author(uuid, uuid) to authenticated;

-- ---------------------------------------------------------
-- Table renames
-- ---------------------------------------------------------
do $$
begin
  if to_regclass('public.presence') is not null and to_regclass('public.user_presence') is null then
    alter table public.presence rename to user_presence;
  end if;
end $$;

do $$
begin
  if to_regclass('public.call_signals') is not null and to_regclass('public.call_signaling') is null then
    alter table public.call_signals rename to call_signaling;
  end if;
end $$;

-- ---------------------------------------------------------
-- friend_requests naming normalization (requester/addressee -> sender/receiver)
-- ---------------------------------------------------------
do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'friend_requests'
      and column_name = 'requester_id'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'friend_requests'
      and column_name = 'sender_id'
  ) then
    alter table public.friend_requests rename column requester_id to sender_id;
  end if;

  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'friend_requests'
      and column_name = 'addressee_id'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'friend_requests'
      and column_name = 'receiver_id'
  ) then
    alter table public.friend_requests rename column addressee_id to receiver_id;
  end if;
end $$;

-- ---------------------------------------------------------
-- Constraint and index naming normalization
-- ---------------------------------------------------------
do $$
begin
  if to_regclass('public.user_presence') is not null then
    if exists (
      select 1
      from pg_constraint
      where conrelid = 'public.user_presence'::regclass
        and conname = 'presence_pkey'
    ) then
      alter table public.user_presence rename constraint presence_pkey to user_presence_pkey;
    end if;

    if exists (
      select 1
      from pg_constraint
      where conrelid = 'public.user_presence'::regclass
        and conname = 'presence_status_check'
    ) then
      alter table public.user_presence rename constraint presence_status_check to user_presence_status_check;
    end if;
  end if;
end $$;

do $$
begin
  if to_regclass('public.call_signaling') is not null then
    if exists (
      select 1
      from pg_constraint
      where conrelid = 'public.call_signaling'::regclass
        and conname = 'call_signals_pkey'
    ) then
      alter table public.call_signaling rename constraint call_signals_pkey to call_signaling_pkey;
    end if;

    if exists (
      select 1
      from pg_constraint
      where conrelid = 'public.call_signaling'::regclass
        and conname = 'call_signals_distinct_participants_chk'
    ) then
      alter table public.call_signaling
        rename constraint call_signals_distinct_participants_chk to call_signaling_distinct_participants_chk;
    end if;

    if exists (
      select 1
      from pg_constraint
      where conrelid = 'public.call_signaling'::regclass
        and conname = 'call_signals_payload_object_chk'
    ) then
      alter table public.call_signaling
        rename constraint call_signals_payload_object_chk to call_signaling_payload_object_chk;
    end if;

    if exists (
      select 1
      from pg_constraint
      where conrelid = 'public.call_signaling'::regclass
        and conname = 'call_signals_type_check'
    ) then
      alter table public.call_signaling rename constraint call_signals_type_check to call_signaling_type_check;
    end if;

    if exists (
      select 1
      from pg_constraint
      where conrelid = 'public.call_signaling'::regclass
        and conname = 'call_signals_call_id_fkey'
    ) then
      alter table public.call_signaling rename constraint call_signals_call_id_fkey to call_signaling_call_id_fkey;
    end if;

    if exists (
      select 1
      from pg_constraint
      where conrelid = 'public.call_signaling'::regclass
        and conname = 'call_signals_from_user_id_fkey'
    ) then
      alter table public.call_signaling
        rename constraint call_signals_from_user_id_fkey to call_signaling_from_user_id_fkey;
    end if;

    if exists (
      select 1
      from pg_constraint
      where conrelid = 'public.call_signaling'::regclass
        and conname = 'call_signals_to_user_id_fkey'
    ) then
      alter table public.call_signaling
        rename constraint call_signals_to_user_id_fkey to call_signaling_to_user_id_fkey;
    end if;
  end if;
end $$;

alter index if exists public.presence_updated_at_idx rename to user_presence_updated_at_idx;
alter index if exists public.call_signals_call_id_idx rename to call_signaling_call_id_idx;
alter index if exists public.call_signals_from_user_id_idx rename to call_signaling_from_user_id_idx;
alter index if exists public.call_signals_to_user_id_idx rename to call_signaling_to_user_id_idx;
alter index if exists public.friend_requests_addressee_idx rename to friend_requests_receiver_idx;
alter index if exists public.friend_requests_requester_idx rename to friend_requests_sender_idx;
alter index if exists public.message_reads_user_id_idx rename to message_reads_user_idx;
alter index if exists public.friend_requests_pair_sym_unique_idx rename to friend_requests_pair_sym_uidx;

-- ---------------------------------------------------------
-- Referential integrity and constraints
-- ---------------------------------------------------------
do $$
begin
  if to_regclass('public.user_presence') is not null then
    alter table public.user_presence drop constraint if exists presence_user_id_fkey;
    alter table public.user_presence drop constraint if exists user_presence_user_id_fkey;

    alter table public.user_presence
      add constraint user_presence_user_id_fkey
      foreign key (user_id) references public.profiles(id) on delete cascade;

    alter table public.user_presence drop constraint if exists user_presence_status_check;
    alter table public.user_presence
      add constraint user_presence_status_check
      check (
        status in ('online', 'idle', 'dnd', 'offline', 'invisible')
      );

    alter table public.user_presence drop constraint if exists user_presence_activities_array_chk;
    alter table public.user_presence
      add constraint user_presence_activities_array_chk
      check (jsonb_typeof(activities) = 'array');
  end if;
end $$;

do $$
begin
  if to_regclass('public.friend_requests') is not null
     and exists (
       select 1
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'friend_requests'
         and column_name = 'sender_id'
     )
     and exists (
       select 1
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'friend_requests'
         and column_name = 'receiver_id'
     ) then
    alter table public.friend_requests drop constraint if exists friend_requests_requester_id_fkey;
    alter table public.friend_requests drop constraint if exists friend_requests_addressee_id_fkey;
    alter table public.friend_requests drop constraint if exists friend_requests_sender_id_fkey;
    alter table public.friend_requests drop constraint if exists friend_requests_receiver_id_fkey;

    alter table public.friend_requests drop constraint if exists friend_requests_distinct_users_chk;
    alter table public.friend_requests drop constraint if exists friend_requests_sender_receiver_chk;

    alter table public.friend_requests
      add constraint friend_requests_sender_receiver_chk check (sender_id <> receiver_id);

    alter table public.friend_requests
      add constraint friend_requests_sender_id_fkey
      foreign key (sender_id) references public.profiles(id) on delete cascade;

    alter table public.friend_requests
      add constraint friend_requests_receiver_id_fkey
      foreign key (receiver_id) references public.profiles(id) on delete cascade;

    alter table public.friend_requests drop constraint if exists friend_requests_sender_receiver_key;
    alter table public.friend_requests
      add constraint friend_requests_sender_receiver_key unique (sender_id, receiver_id);
  end if;
end $$;

do $$
begin
  if to_regclass('public.message_reads') is not null then
    alter table public.message_reads drop constraint if exists message_reads_pkey;
    alter table public.message_reads
      add constraint message_reads_pkey primary key (user_id, message_id);
  end if;
end $$;

do $$
begin
  if to_regclass('public.messages') is not null then
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.messages'::regclass
        and conname = 'messages_sender_id_fkey'
    ) then
      alter table public.messages
        add constraint messages_sender_id_fkey
        foreign key (sender_id) references public.profiles(id) on delete cascade;
    end if;

    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.messages'::regclass
        and conname = 'messages_conversation_id_fkey'
    ) then
      alter table public.messages
        add constraint messages_conversation_id_fkey
        foreign key (conversation_id) references public.conversations(id) on delete cascade;
    end if;
  end if;

  if to_regclass('public.message_reads') is not null then
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.message_reads'::regclass
        and conname = 'message_reads_user_id_fkey'
    ) then
      alter table public.message_reads
        add constraint message_reads_user_id_fkey
        foreign key (user_id) references public.profiles(id) on delete cascade;
    end if;

    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.message_reads'::regclass
        and conname = 'message_reads_message_id_fkey'
    ) then
      alter table public.message_reads
        add constraint message_reads_message_id_fkey
        foreign key (message_id) references public.messages(id) on delete cascade;
    end if;
  end if;

  if to_regclass('public.attachments') is not null then
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.attachments'::regclass
        and conname = 'attachments_message_id_fkey'
    ) then
      alter table public.attachments
        add constraint attachments_message_id_fkey
        foreign key (message_id) references public.messages(id) on delete cascade;
    end if;
  end if;

  if to_regclass('public.user_blocks') is not null then
    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.user_blocks'::regclass
        and conname = 'user_blocks_blocker_id_fkey'
    ) then
      alter table public.user_blocks
        add constraint user_blocks_blocker_id_fkey
        foreign key (blocker_id) references public.profiles(id) on delete cascade;
    end if;

    if not exists (
      select 1 from pg_constraint
      where conrelid = 'public.user_blocks'::regclass
        and conname = 'user_blocks_blocked_id_fkey'
    ) then
      alter table public.user_blocks
        add constraint user_blocks_blocked_id_fkey
        foreign key (blocked_id) references public.profiles(id) on delete cascade;
    end if;
  end if;
end $$;

-- ---------------------------------------------------------
-- Performance indexes
-- ---------------------------------------------------------
drop index if exists public.messages_conversation_created_idx;
drop index if exists public.messages_conversation_created_at_idx;
create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at desc);

create index if not exists message_reads_user_idx
  on public.message_reads (user_id);

create index if not exists friend_requests_receiver_idx
  on public.friend_requests (receiver_id);

create index if not exists user_presence_user_idx
  on public.user_presence (user_id);

-- ---------------------------------------------------------
-- RLS: enforce for all listed tables
-- ---------------------------------------------------------
alter table if exists public.attachments enable row level security;
alter table if exists public.call_sessions enable row level security;
alter table if exists public.call_signaling enable row level security;
alter table if exists public.conversations enable row level security;
alter table if exists public.friend_requests enable row level security;
alter table if exists public.message_reads enable row level security;
alter table if exists public.messages enable row level security;
alter table if exists public.user_presence enable row level security;
alter table if exists public.profiles enable row level security;
alter table if exists public.user_blocks enable row level security;
alter table if exists public.user_sessions enable row level security;

alter table if exists public.attachments force row level security;
alter table if exists public.call_sessions force row level security;
alter table if exists public.call_signaling force row level security;
alter table if exists public.conversations force row level security;
alter table if exists public.friend_requests force row level security;
alter table if exists public.message_reads force row level security;
alter table if exists public.messages force row level security;
alter table if exists public.user_presence force row level security;
alter table if exists public.profiles force row level security;
alter table if exists public.user_blocks force row level security;
alter table if exists public.user_sessions force row level security;

-- Drop all policies from target tables to rebuild a deterministic policy set.
do $$
declare
  v_policy record;
begin
  for v_policy in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'attachments',
        'call_sessions',
        'call_signaling',
        'conversations',
        'friend_requests',
        'message_reads',
        'messages',
        'user_presence',
        'profiles',
        'user_blocks',
        'user_sessions'
      )
  loop
    execute format('drop policy if exists %I on %I.%I', v_policy.policyname, v_policy.schemaname, v_policy.tablename);
  end loop;
end $$;

-- messages
create policy messages_select_member
on public.messages
for select
to authenticated
using (
  auth.uid() is not null
  and public.is_conversation_member(conversation_id, auth.uid())
);

create policy messages_insert_author
on public.messages
for insert
to authenticated
with check (
  auth.uid() is not null
  and auth.uid() = sender_id
  and public.is_conversation_member(conversation_id, auth.uid())
);

create policy messages_update_author
on public.messages
for update
to authenticated
using (
  auth.uid() is not null
  and auth.uid() = sender_id
  and public.is_conversation_member(conversation_id, auth.uid())
)
with check (
  auth.uid() is not null
  and auth.uid() = sender_id
  and public.is_conversation_member(conversation_id, auth.uid())
);

create policy messages_delete_author
on public.messages
for delete
to authenticated
using (
  auth.uid() is not null
  and auth.uid() = sender_id
  and public.is_conversation_member(conversation_id, auth.uid())
);

-- conversations
create policy conversations_select_member
on public.conversations
for select
to authenticated
using (
  auth.uid() is not null
  and (user1_id = auth.uid() or user2_id = auth.uid())
);

create policy conversations_insert_self
on public.conversations
for insert
to authenticated
with check (
  auth.uid() is not null
  and user1_id <> user2_id
  and user1_id < user2_id
  and (user1_id = auth.uid() or user2_id = auth.uid())
);

-- attachments
create policy attachments_select_member
on public.attachments
for select
to authenticated
using (
  auth.uid() is not null
  and public.can_access_message(message_id, auth.uid())
);

create policy attachments_insert_author
on public.attachments
for insert
to authenticated
with check (
  auth.uid() is not null
  and public.is_message_author(message_id, auth.uid())
);

create policy attachments_update_author
on public.attachments
for update
to authenticated
using (
  auth.uid() is not null
  and public.is_message_author(message_id, auth.uid())
)
with check (
  auth.uid() is not null
  and public.is_message_author(message_id, auth.uid())
);

create policy attachments_delete_author
on public.attachments
for delete
to authenticated
using (
  auth.uid() is not null
  and public.is_message_author(message_id, auth.uid())
);

-- message_reads
create policy message_reads_select_self
on public.message_reads
for select
to authenticated
using (
  auth.uid() is not null
  and auth.uid() = user_id
  and public.can_access_message(message_id, auth.uid())
);

create policy message_reads_insert_self
on public.message_reads
for insert
to authenticated
with check (
  auth.uid() is not null
  and auth.uid() = user_id
  and public.can_access_message(message_id, auth.uid())
);

create policy message_reads_update_self
on public.message_reads
for update
to authenticated
using (
  auth.uid() is not null
  and auth.uid() = user_id
  and public.can_access_message(message_id, auth.uid())
)
with check (
  auth.uid() is not null
  and auth.uid() = user_id
  and public.can_access_message(message_id, auth.uid())
);

create policy message_reads_delete_self
on public.message_reads
for delete
to authenticated
using (
  auth.uid() is not null
  and auth.uid() = user_id
  and public.can_access_message(message_id, auth.uid())
);

-- friend_requests
create policy friend_requests_select_participant
on public.friend_requests
for select
to authenticated
using (
  auth.uid() is not null
  and (auth.uid() = sender_id or auth.uid() = receiver_id)
);

create policy friend_requests_insert_sender
on public.friend_requests
for insert
to authenticated
with check (
  auth.uid() is not null
  and auth.uid() = sender_id
  and sender_id <> receiver_id
);

create policy friend_requests_update_participant
on public.friend_requests
for update
to authenticated
using (
  auth.uid() is not null
  and (auth.uid() = sender_id or auth.uid() = receiver_id)
)
with check (
  auth.uid() is not null
  and (auth.uid() = sender_id or auth.uid() = receiver_id)
);

create policy friend_requests_delete_participant
on public.friend_requests
for delete
to authenticated
using (
  auth.uid() is not null
  and (auth.uid() = sender_id or auth.uid() = receiver_id)
);

-- user_presence
create policy user_presence_select_authenticated
on public.user_presence
for select
to authenticated
using (true);

create policy user_presence_insert_self
on public.user_presence
for insert
to authenticated
with check (
  auth.uid() is not null
  and auth.uid() = user_id
);

create policy user_presence_update_self
on public.user_presence
for update
to authenticated
using (
  auth.uid() is not null
  and auth.uid() = user_id
)
with check (
  auth.uid() is not null
  and auth.uid() = user_id
);

create policy user_presence_delete_self
on public.user_presence
for delete
to authenticated
using (
  auth.uid() is not null
  and auth.uid() = user_id
);

-- profiles
create policy profiles_select_authenticated
on public.profiles
for select
to authenticated
using (true);

create policy profiles_insert_self
on public.profiles
for insert
to authenticated
with check (
  auth.uid() is not null
  and auth.uid() = id
);

create policy profiles_update_self
on public.profiles
for update
to authenticated
using (
  auth.uid() is not null
  and auth.uid() = id
)
with check (
  auth.uid() is not null
  and auth.uid() = id
);

-- user_blocks
create policy user_blocks_select_self
on public.user_blocks
for select
to authenticated
using (
  auth.uid() is not null
  and auth.uid() = blocker_id
);

create policy user_blocks_insert_self
on public.user_blocks
for insert
to authenticated
with check (
  auth.uid() is not null
  and auth.uid() = blocker_id
);

create policy user_blocks_delete_self
on public.user_blocks
for delete
to authenticated
using (
  auth.uid() is not null
  and auth.uid() = blocker_id
);

-- user_sessions
create policy user_sessions_select_self
on public.user_sessions
for select
to authenticated
using (
  auth.uid() is not null
  and auth.uid() = user_id
);

create policy user_sessions_insert_self
on public.user_sessions
for insert
to authenticated
with check (
  auth.uid() is not null
  and auth.uid() = user_id
);

create policy user_sessions_update_self
on public.user_sessions
for update
to authenticated
using (
  auth.uid() is not null
  and auth.uid() = user_id
)
with check (
  auth.uid() is not null
  and auth.uid() = user_id
);

create policy user_sessions_delete_self
on public.user_sessions
for delete
to authenticated
using (
  auth.uid() is not null
  and auth.uid() = user_id
);

-- call_sessions
create policy call_sessions_select_member
on public.call_sessions
for select
to authenticated
using (
  auth.uid() is not null
  and public.is_conversation_member(conversation_id, auth.uid())
);

create policy call_sessions_insert_member
on public.call_sessions
for insert
to authenticated
with check (
  auth.uid() is not null
  and auth.uid() = created_by
  and public.is_conversation_member(conversation_id, auth.uid())
);

create policy call_sessions_update_member
on public.call_sessions
for update
to authenticated
using (
  auth.uid() is not null
  and public.is_conversation_member(conversation_id, auth.uid())
)
with check (
  auth.uid() is not null
  and public.is_conversation_member(conversation_id, auth.uid())
);

create policy call_sessions_delete_creator
on public.call_sessions
for delete
to authenticated
using (
  auth.uid() is not null
  and auth.uid() = created_by
  and public.is_conversation_member(conversation_id, auth.uid())
);

-- call_signaling
create policy call_signaling_select_member
on public.call_signaling
for select
to authenticated
using (
  auth.uid() is not null
  and public.can_access_call(call_id, auth.uid())
  and (auth.uid() = from_user_id or auth.uid() = to_user_id)
);

create policy call_signaling_insert_member
on public.call_signaling
for insert
to authenticated
with check (
  auth.uid() is not null
  and public.can_access_call(call_id, auth.uid())
  and auth.uid() = from_user_id
  and from_user_id <> to_user_id
);

create policy call_signaling_delete_member
on public.call_signaling
for delete
to authenticated
using (
  auth.uid() is not null
  and public.can_access_call(call_id, auth.uid())
  and (auth.uid() = from_user_id or auth.uid() = to_user_id)
);

-- ---------------------------------------------------------
-- Explicit privileges for authenticated role
-- ---------------------------------------------------------
grant select, insert, update, delete on public.messages to authenticated;
grant select, insert, update, delete on public.message_reads to authenticated;
grant select, insert, update, delete on public.user_presence to authenticated;
grant select, insert, update, delete on public.conversations to authenticated;
grant select, insert, update, delete on public.friend_requests to authenticated;
grant select, insert, update, delete on public.call_sessions to authenticated;
grant select, insert, update, delete on public.call_signaling to authenticated;
grant select, insert, update, delete on public.attachments to authenticated;
grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.user_blocks to authenticated;
grant select, insert, update, delete on public.user_sessions to authenticated;

-- ---------------------------------------------------------
-- Supabase Realtime publication
-- ---------------------------------------------------------
do $$
begin
  if to_regclass('public.presence') is not null
     and exists (
       select 1
       from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'presence'
     ) then
    alter publication supabase_realtime drop table public.presence;
  end if;
end $$;

do $$
begin
  if to_regclass('public.messages') is not null
     and not exists (
       select 1
       from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'messages'
     ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;

do $$
begin
  if to_regclass('public.message_reads') is not null
     and not exists (
       select 1
       from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'message_reads'
     ) then
    alter publication supabase_realtime add table public.message_reads;
  end if;
end $$;

do $$
begin
  if to_regclass('public.user_presence') is not null
     and not exists (
       select 1
       from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'user_presence'
     ) then
    alter publication supabase_realtime add table public.user_presence;
  end if;
end $$;

commit;
