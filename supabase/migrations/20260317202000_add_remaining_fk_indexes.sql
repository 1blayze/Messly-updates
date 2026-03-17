begin;

create index if not exists conversation_members_added_by_idx
  on public.conversation_members (added_by);

create index if not exists conversations_created_by_idx
  on public.conversations (created_by);

commit;
