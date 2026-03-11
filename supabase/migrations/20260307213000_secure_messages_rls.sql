begin;

-- ---------------------------------------------------------
-- Helper para validar participação na conversa
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

revoke all on function public.is_conversation_member(uuid, uuid) from public;
grant execute on function public.is_conversation_member(uuid, uuid) to authenticated;

-- ---------------------------------------------------------
-- RLS de messages
-- ---------------------------------------------------------
alter table public.messages enable row level security;
alter table public.messages force row level security;

drop policy if exists messages_select_member on public.messages;
create policy messages_select_member
on public.messages
for select
to authenticated
using (
  auth.uid() is not null
  and public.is_conversation_member(conversation_id, auth.uid())
);

drop policy if exists messages_insert_author_member on public.messages;
create policy messages_insert_author_member
on public.messages
for insert
to authenticated
with check (
  auth.uid() is not null
  and auth.uid() = sender_id
  and public.is_conversation_member(conversation_id, auth.uid())
);

drop policy if exists messages_update_author on public.messages;
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

drop policy if exists messages_delete_author on public.messages;
create policy messages_delete_author
on public.messages
for delete
to authenticated
using (
  auth.uid() is not null
  and auth.uid() = sender_id
  and public.is_conversation_member(conversation_id, auth.uid())
);

grant select, insert, update, delete on public.messages to authenticated;

-- ---------------------------------------------------------
-- Índices para workload de chat
-- ---------------------------------------------------------
create index if not exists messages_conversation_created_at_idx
  on public.messages (conversation_id, created_at desc, id desc);

create index if not exists messages_sender_created_at_idx
  on public.messages (sender_id, created_at desc, id desc);

create index if not exists messages_created_at_brin_idx
  on public.messages using brin (created_at);

-- ---------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;

commit;
