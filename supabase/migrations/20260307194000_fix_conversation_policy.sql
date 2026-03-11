-- Simplify conversation select RLS: allow rows where the current user is a participant.

drop policy if exists conversations_select_member on public.conversations;
create policy conversations_select_member
on public.conversations
for select
to authenticated
using (
  (user1_id = (select auth.uid())) or (user2_id = (select auth.uid()))
);
