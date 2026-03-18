create or replace function public.update_group_dm(
  p_conversation_id uuid,
  p_name text default null,
  p_avatar_url text default null,
  p_clear_avatar boolean default false
)
returns setof public.conversations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  normalized_name text;
  normalized_avatar_url text;
  updated_conversation public.conversations%rowtype;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated';
  end if;

  select *
  into updated_conversation
  from public.conversations
  where id = p_conversation_id
    and type = 'group_dm'
  limit 1;

  if updated_conversation.id is null then
    raise exception 'group_dm_not_found';
  end if;

  if not public.is_conversation_member(p_conversation_id, auth.uid()) then
    raise exception 'forbidden';
  end if;

  normalized_name := nullif(btrim(coalesce(p_name, '')), '');
  normalized_avatar_url := nullif(btrim(coalesce(p_avatar_url, '')), '');

  update public.conversations
  set
    name = normalized_name,
    avatar_url = case
      when coalesce(p_clear_avatar, false) then null
      when normalized_avatar_url is not null then normalized_avatar_url
      else avatar_url
    end
  where id = p_conversation_id
  returning * into updated_conversation;

  return query
  select *
  from public.conversations
  where id = updated_conversation.id;
end;
$$;

create or replace function public.leave_group_dm(
  p_conversation_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_conversation public.conversations%rowtype;
  remaining_members integer;
  next_owner_id uuid;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated';
  end if;

  select *
  into target_conversation
  from public.conversations
  where id = p_conversation_id
    and type = 'group_dm'
  limit 1;

  if target_conversation.id is null then
    raise exception 'group_dm_not_found';
  end if;

  if not public.is_conversation_member(p_conversation_id, auth.uid()) then
    raise exception 'forbidden';
  end if;

  delete from public.conversation_members
  where conversation_id = p_conversation_id
    and user_id = auth.uid();

  select count(*)
  into remaining_members
  from public.conversation_members
  where conversation_id = p_conversation_id;

  if remaining_members <= 0 then
    delete from public.conversations
    where id = p_conversation_id;
  elsif target_conversation.created_by = auth.uid() then
    select cm.user_id
    into next_owner_id
    from public.conversation_members cm
    where cm.conversation_id = p_conversation_id
    order by cm.created_at asc, cm.user_id asc
    limit 1;

    update public.conversations
    set created_by = next_owner_id
    where id = p_conversation_id;
  end if;

  return p_conversation_id;
end;
$$;

create or replace function public.add_group_dm_members(
  p_conversation_id uuid,
  p_participant_ids uuid[]
)
returns setof public.conversations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_conversation public.conversations%rowtype;
  normalized_participant_ids uuid[];
  total_members integer;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated';
  end if;

  select *
  into target_conversation
  from public.conversations
  where id = p_conversation_id
    and type = 'group_dm'
  limit 1;

  if target_conversation.id is null then
    raise exception 'group_dm_not_found';
  end if;

  if not public.is_conversation_member(p_conversation_id, auth.uid()) then
    raise exception 'forbidden';
  end if;

  normalized_participant_ids := array(
    select distinct participant_id
    from unnest(coalesce(p_participant_ids, array[]::uuid[])) as participant_id
    where participant_id is not null
      and not public.is_conversation_member(p_conversation_id, participant_id)
    order by participant_id
  );

  if coalesce(array_length(normalized_participant_ids, 1), 0) <= 0 then
    return query
    select *
    from public.conversations
    where id = p_conversation_id;
    return;
  end if;

  select count(*)
  into total_members
  from public.conversation_members
  where conversation_id = p_conversation_id;

  total_members := total_members + coalesce(array_length(normalized_participant_ids, 1), 0);
  if total_members > 10 then
    raise exception 'group dm supports at most 10 participants';
  end if;

  insert into public.conversation_members (conversation_id, user_id, added_by)
  select p_conversation_id, participant_id, auth.uid()
  from unnest(normalized_participant_ids) as participant_id
  on conflict (conversation_id, user_id) do nothing;

  return query
  select *
  from public.conversations
  where id = p_conversation_id;
end;
$$;

create or replace function public.remove_group_dm_member(
  p_conversation_id uuid,
  p_user_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_conversation public.conversations%rowtype;
  remaining_members integer;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated';
  end if;

  select *
  into target_conversation
  from public.conversations
  where id = p_conversation_id
    and type = 'group_dm'
  limit 1;

  if target_conversation.id is null then
    raise exception 'group_dm_not_found';
  end if;

  if target_conversation.created_by is distinct from auth.uid() then
    raise exception 'forbidden';
  end if;

  if p_user_id is null or p_user_id = auth.uid() then
    raise exception 'invalid_member';
  end if;

  if not public.is_conversation_member(p_conversation_id, p_user_id) then
    raise exception 'member_not_found';
  end if;

  delete from public.conversation_members
  where conversation_id = p_conversation_id
    and user_id = p_user_id;

  select count(*)
  into remaining_members
  from public.conversation_members
  where conversation_id = p_conversation_id;

  if remaining_members <= 0 then
    delete from public.conversations
    where id = p_conversation_id;
  end if;

  return p_conversation_id;
end;
$$;

create or replace function public.transfer_group_dm_owner(
  p_conversation_id uuid,
  p_new_owner_id uuid
)
returns setof public.conversations
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_conversation public.conversations%rowtype;
begin
  if auth.uid() is null then
    raise exception 'unauthenticated';
  end if;

  select *
  into target_conversation
  from public.conversations
  where id = p_conversation_id
    and type = 'group_dm'
  limit 1;

  if target_conversation.id is null then
    raise exception 'group_dm_not_found';
  end if;

  if target_conversation.created_by is distinct from auth.uid() then
    raise exception 'forbidden';
  end if;

  if p_new_owner_id is null or p_new_owner_id = auth.uid() then
    raise exception 'invalid_owner';
  end if;

  if not public.is_conversation_member(p_conversation_id, p_new_owner_id) then
    raise exception 'member_not_found';
  end if;

  update public.conversations
  set created_by = p_new_owner_id
  where id = p_conversation_id
  returning * into target_conversation;

  return query
  select *
  from public.conversations
  where id = target_conversation.id;
end;
$$;

revoke all on function public.update_group_dm(uuid, text, text, boolean) from public;
revoke all on function public.leave_group_dm(uuid) from public;
revoke all on function public.add_group_dm_members(uuid, uuid[]) from public;
revoke all on function public.remove_group_dm_member(uuid, uuid) from public;
revoke all on function public.transfer_group_dm_owner(uuid, uuid) from public;

grant execute on function public.update_group_dm(uuid, text, text, boolean) to authenticated;
grant execute on function public.leave_group_dm(uuid) to authenticated;
grant execute on function public.add_group_dm_members(uuid, uuid[]) to authenticated;
grant execute on function public.remove_group_dm_member(uuid, uuid) to authenticated;
grant execute on function public.transfer_group_dm_owner(uuid, uuid) to authenticated;
