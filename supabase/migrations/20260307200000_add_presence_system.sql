create table if not exists public.presence (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'online' check (status in ('online', 'idle', 'dnd', 'invisible')),
  last_seen timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.touch_presence_row()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  new.last_seen := coalesce(new.last_seen, now());
  return new;
end;
$$;

drop trigger if exists touch_presence_row on public.presence;
create trigger touch_presence_row
before insert or update on public.presence
for each row
execute function public.touch_presence_row();

create index if not exists presence_updated_at_idx on public.presence (updated_at desc);

alter table if exists public.presence enable row level security;
alter table if exists public.presence force row level security;

drop policy if exists presence_select_authenticated on public.presence;
create policy presence_select_authenticated
on public.presence
for select
to authenticated
using (true);

drop policy if exists presence_insert_self on public.presence;
create policy presence_insert_self
on public.presence
for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists presence_update_self on public.presence;
create policy presence_update_self
on public.presence
for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'presence'
  ) then
    alter publication supabase_realtime add table public.presence;
  end if;
end
$$;
