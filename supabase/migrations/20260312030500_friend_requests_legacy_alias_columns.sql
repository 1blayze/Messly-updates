begin;

alter table if exists public.friend_requests
  add column if not exists requester_id uuid,
  add column if not exists addressee_id uuid;

update public.friend_requests
set requester_id = sender_id
where requester_id is null or requester_id is distinct from sender_id;

update public.friend_requests
set addressee_id = receiver_id
where addressee_id is null or addressee_id is distinct from receiver_id;

create or replace function public.sync_friend_requests_legacy_alias_columns()
returns trigger
language plpgsql
as $$
begin
  if new.sender_id is null then
    new.sender_id := new.requester_id;
  end if;

  if new.receiver_id is null then
    new.receiver_id := new.addressee_id;
  end if;

  if new.requester_id is null then
    new.requester_id := new.sender_id;
  end if;

  if new.addressee_id is null then
    new.addressee_id := new.receiver_id;
  end if;

  if new.sender_id is not null then
    new.requester_id := new.sender_id;
  end if;

  if new.receiver_id is not null then
    new.addressee_id := new.receiver_id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_friend_requests_sync_legacy_alias_columns on public.friend_requests;
create trigger trg_friend_requests_sync_legacy_alias_columns
before insert or update on public.friend_requests
for each row
execute function public.sync_friend_requests_legacy_alias_columns();

create index if not exists friend_requests_requester_idx on public.friend_requests (requester_id);
create index if not exists friend_requests_addressee_idx on public.friend_requests (addressee_id);

commit;
