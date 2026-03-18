begin;

create or replace function public.is_conversation_member(p_conversation_id uuid, p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.conversation_members cm
    where cm.conversation_id = p_conversation_id
      and cm.user_id = p_user_id
  ) or exists (
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
    where m.id = p_message_id
      and public.is_conversation_member(m.conversation_id, p_user_id)
  );
$$;

drop policy if exists conversations_select_member on public.conversations;
create policy conversations_select_member
on public.conversations
for select
to authenticated
using (
  auth.uid() is not null
  and public.is_conversation_member(id, auth.uid())
);

grant execute on function public.is_conversation_member(uuid, uuid) to authenticated;
grant execute on function public.can_access_message(uuid, uuid) to authenticated;
grant select on public.conversation_members to authenticated;

do $$
begin
  if to_regclass('public.conversations') is not null
     and not exists (
       select 1
       from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'conversations'
     ) then
    alter publication supabase_realtime add table public.conversations;
  end if;
end $$;

do $$
begin
  if to_regclass('public.conversation_members') is not null
     and not exists (
       select 1
       from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename = 'conversation_members'
     ) then
    alter publication supabase_realtime add table public.conversation_members;
  end if;
end $$;

commit;
