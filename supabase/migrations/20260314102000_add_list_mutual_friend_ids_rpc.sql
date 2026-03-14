begin;

create or replace function public.list_mutual_friend_ids(p_other_user_id uuid)
returns table(friend_id uuid)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with viewer as (
    select auth.uid() as user_id
  ),
  viewer_friends as (
    select distinct
      case
        when fr.sender_id = viewer.user_id then fr.receiver_id
        else fr.sender_id
      end as friend_id
    from public.friend_requests fr
    cross join viewer
    where viewer.user_id is not null
      and fr.status = 'accepted'
      and (fr.sender_id = viewer.user_id or fr.receiver_id = viewer.user_id)
  ),
  other_friends as (
    select distinct
      case
        when fr.sender_id = p_other_user_id then fr.receiver_id
        else fr.sender_id
      end as friend_id
    from public.friend_requests fr
    where p_other_user_id is not null
      and fr.status = 'accepted'
      and (fr.sender_id = p_other_user_id or fr.receiver_id = p_other_user_id)
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

revoke all on function public.list_mutual_friend_ids(uuid) from public;
grant execute on function public.list_mutual_friend_ids(uuid) to authenticated;

commit;
