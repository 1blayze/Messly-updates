-- Conversation read cursors for unread counts + notifications
-- production-safe / idempotent

begin;

create table if not exists public.conversation_reads (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint conversation_reads_pkey primary key (conversation_id, user_id)
);

alter table if exists public.conversation_reads
  add column if not exists conversation_id uuid,
  add column if not exists user_id uuid,
  add column if not exists last_read_at timestamptz,
  add column if not exists updated_at timestamptz;

alter table if exists public.conversation_reads
  alter column last_read_at set default now(),
  alter column updated_at set default now();

update public.conversation_reads
set
  last_read_at = coalesce(last_read_at, now()),
  updated_at = coalesce(updated_at, now())
where
  last_read_at is null
  or updated_at is null;

do $$
begin
  if to_regclass('public.conversation_reads') is null then
    return;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'conversation_reads_pkey'
      and conrelid = 'public.conversation_reads'::regclass
  ) then
    alter table public.conversation_reads
      add constraint conversation_reads_pkey primary key (conversation_id, user_id);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'conversation_reads_conversation_id_fkey'
      and conrelid = 'public.conversation_reads'::regclass
  ) then
    alter table public.conversation_reads
      add constraint conversation_reads_conversation_id_fkey
      foreign key (conversation_id) references public.conversations(id) on delete cascade;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'conversation_reads_user_id_fkey'
      and conrelid = 'public.conversation_reads'::regclass
  ) then
    alter table public.conversation_reads
      add constraint conversation_reads_user_id_fkey
      foreign key (user_id) references public.users(id) on delete cascade;
  end if;
end $$;

create index if not exists idx_conversation_reads_user_last_read
on public.conversation_reads (user_id, last_read_at desc);

grant select, insert, update on table public.conversation_reads to authenticated;
grant all privileges on table public.conversation_reads to service_role;

commit;
