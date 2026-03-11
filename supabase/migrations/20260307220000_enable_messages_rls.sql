begin;

alter table public.messages enable row level security;
alter table public.messages force row level security;

-- Remove legacy policies to keep a single, predictable policy set.
drop policy if exists messages_select_member on public.messages;
drop policy if exists messages_insert_author_member on public.messages;
drop policy if exists messages_update_author on public.messages;
drop policy if exists messages_delete_author on public.messages;

drop policy if exists "Users can read messages" on public.messages;
create policy "Users can read messages"
on public.messages
for select
to authenticated
using (true);

drop policy if exists "Users can insert messages" on public.messages;
create policy "Users can insert messages"
on public.messages
for insert
to authenticated
with check (auth.uid() = sender_id);

drop policy if exists "Users can update their messages" on public.messages;
create policy "Users can update their messages"
on public.messages
for update
to authenticated
using (auth.uid() = sender_id)
with check (auth.uid() = sender_id);

drop policy if exists "Users can delete their messages" on public.messages;
create policy "Users can delete their messages"
on public.messages
for delete
to authenticated
using (auth.uid() = sender_id);

grant select, insert, update, delete on public.messages to authenticated;

create index if not exists idx_messages_conversation
on public.messages(conversation_id);

create index if not exists idx_messages_sender
on public.messages(sender_id);

create index if not exists idx_messages_created
on public.messages(created_at);

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
