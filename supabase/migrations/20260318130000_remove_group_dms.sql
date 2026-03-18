begin;

with group_conversations as (
  select id
  from public.conversations
  where coalesce(type, 'dm') <> 'dm'
)
delete from public.messages
where conversation_id in (select id from group_conversations);

with group_conversations as (
  select id
  from public.conversations
  where coalesce(type, 'dm') <> 'dm'
)
delete from public.conversations
where id in (select id from group_conversations);

drop trigger if exists trg_sync_dm_conversation_members on public.conversations;
drop function if exists public.sync_dm_conversation_members();

drop function if exists public.create_group_dm(uuid[], text);
drop function if exists public.update_group_dm(uuid, text, text, boolean);
drop function if exists public.leave_group_dm(uuid);
drop function if exists public.add_group_dm_members(uuid, uuid[]);
drop function if exists public.remove_group_dm_member(uuid, uuid);
drop function if exists public.transfer_group_dm_owner(uuid, uuid);

alter table public.conversations
  drop constraint if exists conversations_shape_chk;

alter table public.conversations
  add constraint conversations_shape_chk
  check (
    coalesce(type, 'dm') = 'dm'
    and user1_id is not null
    and user2_id is not null
    and user1_id <> user2_id
    and user1_id < user2_id
  );

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
      and coalesce(c.type, 'dm') = 'dm'
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
    where m.id = p_message_id
      and public.is_conversation_member(m.conversation_id, p_user_id)
  );
$$;

grant execute on function public.is_conversation_member(uuid, uuid) to authenticated;
grant execute on function public.can_access_message(uuid, uuid) to authenticated;

do $$
begin
  if exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'conversation_members'
  ) then
    alter publication supabase_realtime drop table public.conversation_members;
  end if;
end $$;

drop table if exists public.conversation_members;

commit;
