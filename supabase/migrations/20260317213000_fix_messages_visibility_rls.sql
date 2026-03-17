begin;

-- Backfill membership rows for legacy conversations.
insert into public.conversation_members (conversation_id, user_id, added_by)
select c.id, c.user1_id, coalesce(c.created_by, c.user1_id)
from public.conversations c
where c.user1_id is not null
on conflict (conversation_id, user_id) do nothing;

insert into public.conversation_members (conversation_id, user_id, added_by)
select c.id, c.user2_id, coalesce(c.created_by, c.user2_id)
from public.conversations c
where c.user2_id is not null
on conflict (conversation_id, user_id) do nothing;

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

create or replace function public.sync_dm_conversation_members()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.type = 'dm' and new.user1_id is not null and new.user2_id is not null then
    insert into public.conversation_members (conversation_id, user_id, added_by)
    values
      (new.id, new.user1_id, coalesce(new.created_by, new.user1_id)),
      (new.id, new.user2_id, coalesce(new.created_by, new.user2_id))
    on conflict (conversation_id, user_id) do nothing;

    delete from public.conversation_members
    where conversation_id = new.id
      and user_id not in (new.user1_id, new.user2_id);
  end if;

  return new;
end;
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

commit;
