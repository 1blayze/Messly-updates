-- ---------------------------------------------------------
-- Group DMs
-- ---------------------------------------------------------

alter table public.conversations
  add column if not exists type text,
  add column if not exists created_by uuid null references public.profiles(id) on delete set null,
  add column if not exists name text null,
  add column if not exists avatar_url text null;

update public.conversations
set type = 'dm'
where type is null or btrim(type) = '';

update public.conversations
set created_by = coalesce(created_by, user1_id, user2_id)
where created_by is null;

alter table public.conversations
  alter column type set default 'dm',
  alter column type set not null,
  alter column user1_id drop not null,
  alter column user2_id drop not null;

drop constraint if exists conversations_distinct_users_chk on public.conversations;
drop constraint if exists conversations_user_order_chk on public.conversations;
alter table public.conversations
  drop constraint if exists conversations_shape_chk;

alter table public.conversations
  add constraint conversations_shape_chk
  check (
    (
      type = 'dm'
      and user1_id is not null
      and user2_id is not null
      and user1_id <> user2_id
      and user1_id < user2_id
    )
    or
    (
      type = 'group_dm'
      and user1_id is null
      and user2_id is null
    )
  );

drop index if exists conversations_pair_unique;
create unique index if not exists conversations_pair_unique
  on public.conversations(user1_id, user2_id)
  where type = 'dm' and user1_id is not null and user2_id is not null;

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  added_by uuid null references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index if not exists conversation_members_user_id_idx
  on public.conversation_members(user_id, conversation_id);

insert into public.conversation_members (conversation_id, user_id, added_by)
select c.id, c.user1_id, coalesce(c.created_by, c.user1_id)
from public.conversations c
where c.type = 'dm'
  and c.user1_id is not null
on conflict (conversation_id, user_id) do nothing;

insert into public.conversation_members (conversation_id, user_id, added_by)
select c.id, c.user2_id, coalesce(c.created_by, c.user2_id)
from public.conversations c
where c.type = 'dm'
  and c.user2_id is not null
on conflict (conversation_id, user_id) do nothing;

create or replace function public.sync_dm_conversation_members()
returns trigger
language plpgsql
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

drop trigger if exists trg_sync_dm_conversation_members on public.conversations;
create trigger trg_sync_dm_conversation_members
after insert or update of type, user1_id, user2_id, created_by on public.conversations
for each row execute function public.sync_dm_conversation_members();

create or replace function public.validate_message_integrity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  reply_conv uuid;
begin
  if not public.is_conversation_member(new.conversation_id, new.sender_id) then
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
    from public.conversation_members cm
    where cm.conversation_id = p_conversation_id
      and cm.user_id = p_user_id
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
    join public.conversation_members cm
      on cm.conversation_id = m.conversation_id
    where m.id = p_message_id
      and cm.user_id = p_user_id
  );
$$;

create or replace function public.create_group_dm(
  p_participant_ids uuid[],
  p_name text default null
)
returns setof public.conversations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  normalized_participant_ids uuid[];
  normalized_name text;
  participant_count integer;
  created_conversation public.conversations%rowtype;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated';
  end if;

  normalized_participant_ids := array(
    select distinct participant_id
    from unnest(coalesce(p_participant_ids, array[]::uuid[]) || auth.uid()) as participant_id
    where participant_id is not null
    order by participant_id
  );

  participant_count := coalesce(array_length(normalized_participant_ids, 1), 0);
  if participant_count < 2 then
    raise exception 'group dm requires at least 2 participants';
  end if;

  if participant_count > 10 then
    raise exception 'group dm supports at most 10 participants';
  end if;

  normalized_name := nullif(btrim(coalesce(p_name, '')), '');

  insert into public.conversations (
    type,
    created_by,
    name,
    avatar_url,
    user1_id,
    user2_id
  )
  values (
    'group_dm',
    auth.uid(),
    normalized_name,
    null,
    null,
    null
  )
  returning * into created_conversation;

  insert into public.conversation_members (conversation_id, user_id, added_by)
  select created_conversation.id, participant_id, auth.uid()
  from unnest(normalized_participant_ids) as participant_id
  on conflict (conversation_id, user_id) do nothing;

  return query
  select *
  from public.conversations
  where id = created_conversation.id;
end;
$$;

alter table public.conversation_members enable row level security;
alter table public.conversation_members force row level security;

drop policy if exists conversation_members_select_member on public.conversation_members;
create policy conversation_members_select_member
on public.conversation_members
for select
to authenticated
using (
  (select auth.uid()) is not null
  and (select public.is_conversation_member(conversation_id, (select auth.uid())))
);

drop policy if exists conversations_insert_self on public.conversations;
create policy conversations_insert_self
on public.conversations
for insert
to authenticated
with check (
  (select auth.uid()) is not null
  and created_by = (select auth.uid())
  and type = 'dm'
  and user1_id is not null
  and user2_id is not null
  and user1_id <> user2_id
  and user1_id < user2_id
  and ((select auth.uid()) in (user1_id, user2_id))
);

revoke all on function public.create_group_dm(uuid[], text) from public;
grant execute on function public.create_group_dm(uuid[], text) to authenticated;
grant select on public.conversation_members to authenticated;
