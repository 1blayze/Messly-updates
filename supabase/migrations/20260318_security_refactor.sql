begin;
create table if not exists public._backup_policies_20260318 (
  schemaname text not null,
  tablename text not null,
  policyname text not null,
  permissive text not null,
  roles text[] not null,
  cmd text not null,
  qual text,
  with_check text,
  backup_at timestamptz not null default now(),
  primary key (schemaname, tablename, policyname)
);

create table if not exists public._backup_table_grants_20260318 (
  table_schema text not null,
  table_name text not null,
  grantee text not null,
  privilege_type text not null,
  is_grantable boolean not null,
  backup_at timestamptz not null default now(),
  primary key (table_schema, table_name, grantee, privilege_type)
);

create table if not exists public._backup_rls_state_20260318 (
  schemaname text not null,
  tablename text not null,
  rls_enabled boolean not null,
  rls_forced boolean not null,
  backup_at timestamptz not null default now(),
  primary key (schemaname, tablename)
);

insert into public._backup_policies_20260318 (schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check)
select
  p.schemaname,
  p.tablename,
  p.policyname,
  p.permissive,
  p.roles,
  p.cmd,
  p.qual,
  p.with_check
from pg_policies p
where p.schemaname = 'public'
  and p.tablename in ('messages', 'profiles', 'presence')
on conflict do nothing;

insert into public._backup_table_grants_20260318 (table_schema, table_name, grantee, privilege_type, is_grantable)
select
  g.table_schema,
  g.table_name,
  g.grantee,
  g.privilege_type,
  (upper(g.is_grantable) = 'YES') as is_grantable
from information_schema.role_table_grants g
where g.table_schema = 'public'
  and g.table_name in ('messages', 'profiles', 'presence')
  and g.grantee in ('anon', 'authenticated', 'service_role', 'public')
on conflict do nothing;

insert into public._backup_rls_state_20260318 (schemaname, tablename, rls_enabled, rls_forced)
select
  n.nspname as schemaname,
  c.relname as tablename,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('messages', 'profiles', 'presence')
on conflict do nothing;

-- 2) Remove insecure/legacy policies (safe if missing)
drop policy if exists "allow all messages" on public.messages;
drop policy if exists "allow all presence" on public.presence;
drop policy if exists "allow all profiles" on public.profiles;

drop policy if exists "Users can read messages" on public.messages;
drop policy if exists "presence_select_authenticated" on public.presence;
drop policy if exists "profiles_select_authenticated" on public.profiles;

drop policy if exists "messages_select_member" on public.messages;
drop policy if exists "messages_insert_sender_member" on public.messages;
drop policy if exists "messages_update_sender_member" on public.messages;
drop policy if exists "messages_delete_sender_member" on public.messages;

drop policy if exists "profiles_select_self_or_relationship" on public.profiles;
drop policy if exists "profiles_insert_self" on public.profiles;
drop policy if exists "profiles_update_self" on public.profiles;

drop policy if exists "presence_select_relationship" on public.presence;
drop policy if exists "presence_insert_self" on public.presence;
drop policy if exists "presence_update_self" on public.presence;

-- 3) RLS safety baseline
alter table public.messages enable row level security;
alter table public.profiles enable row level security;
alter table public.presence enable row level security;

-- 4) Secure policies
-- Messages: only conversation members can read; only sender/member can write.
create policy "messages_select_member"
on public.messages
for select
to authenticated
using (
  (select auth.uid()) is not null
  and public.is_conversation_member(conversation_id, (select auth.uid()))
  and not exists (
    select 1
    from public.user_blocks ub
    where (ub.blocker_id = (select auth.uid()) and ub.blocked_id = messages.sender_id)
       or (ub.blocker_id = messages.sender_id and ub.blocked_id = (select auth.uid()))
  )
);

create policy "messages_insert_sender_member"
on public.messages
for insert
to authenticated
with check (
  (select auth.uid()) = sender_id
  and public.is_conversation_member(conversation_id, (select auth.uid()))
);

create policy "messages_update_sender_member"
on public.messages
for update
to authenticated
using (
  (select auth.uid()) = sender_id
  and public.is_conversation_member(conversation_id, (select auth.uid()))
)
with check (
  (select auth.uid()) = sender_id
  and public.is_conversation_member(conversation_id, (select auth.uid()))
);

create policy "messages_delete_sender_member"
on public.messages
for delete
to authenticated
using (
  (select auth.uid()) = sender_id
  and public.is_conversation_member(conversation_id, (select auth.uid()))
);

-- Profiles: self + accepted relationships or direct conversation participant.
create policy "profiles_select_self_or_relationship"
on public.profiles
for select
to authenticated
using (
  (select auth.uid()) is not null
  and (
    id = (select auth.uid())
    or exists (
      select 1
      from public.friend_requests fr
      where fr.status = 'accepted'
        and (
          (fr.requester_id = (select auth.uid()) and fr.addressee_id = profiles.id)
          or
          (fr.addressee_id = (select auth.uid()) and fr.requester_id = profiles.id)
        )
    )
    or exists (
      select 1
      from public.conversations c
      where (c.user1_id = (select auth.uid()) and c.user2_id = profiles.id)
         or (c.user2_id = (select auth.uid()) and c.user1_id = profiles.id)
    )
  )
  and not exists (
    select 1
    from public.user_blocks ub
    where (ub.blocker_id = (select auth.uid()) and ub.blocked_id = profiles.id)
       or (ub.blocker_id = profiles.id and ub.blocked_id = (select auth.uid()))
  )
);

create policy "profiles_insert_self"
on public.profiles
for insert
to authenticated
with check (id = (select auth.uid()));

create policy "profiles_update_self"
on public.profiles
for update
to authenticated
using (id = (select auth.uid()))
with check (id = (select auth.uid()));

-- Presence: self + accepted relationships or direct conversation participant.
create policy "presence_select_relationship"
on public.presence
for select
to authenticated
using (
  (select auth.uid()) is not null
  and (
    user_id = (select auth.uid())
    or exists (
      select 1
      from public.friend_requests fr
      where fr.status = 'accepted'
        and (
          (fr.requester_id = (select auth.uid()) and fr.addressee_id = presence.user_id)
          or
          (fr.addressee_id = (select auth.uid()) and fr.requester_id = presence.user_id)
        )
    )
    or exists (
      select 1
      from public.conversations c
      where (c.user1_id = (select auth.uid()) and c.user2_id = presence.user_id)
         or (c.user2_id = (select auth.uid()) and c.user1_id = presence.user_id)
    )
  )
  and not exists (
    select 1
    from public.user_blocks ub
    where (ub.blocker_id = (select auth.uid()) and ub.blocked_id = presence.user_id)
       or (ub.blocker_id = presence.user_id and ub.blocked_id = (select auth.uid()))
  )
);

create policy "presence_insert_self"
on public.presence
for insert
to authenticated
with check (user_id = (select auth.uid()));

create policy "presence_update_self"
on public.presence
for update
to authenticated
using (user_id = (select auth.uid()))
with check (user_id = (select auth.uid()));

-- Admin/security tables: keep RLS active and allow only service_role writes/reads.
drop policy if exists "spotify_oauth_tokens_service_role_all" on public.spotify_oauth_tokens;
create policy "spotify_oauth_tokens_service_role_all"
on public.spotify_oauth_tokens
for all
to service_role
using (true)
with check (true);

drop policy if exists "spotify_oauth_states_service_role_all" on public.spotify_oauth_states;
create policy "spotify_oauth_states_service_role_all"
on public.spotify_oauth_states
for all
to service_role
using (true)
with check (true);

drop policy if exists "registration_attempts_by_ip_service_role_all" on public.registration_attempts_by_ip;
create policy "registration_attempts_by_ip_service_role_all"
on public.registration_attempts_by_ip
for all
to service_role
using (true)
with check (true);

drop policy if exists "captcha_failures_by_ip_service_role_all" on public.captcha_failures_by_ip;
create policy "captcha_failures_by_ip_service_role_all"
on public.captcha_failures_by_ip
for all
to service_role
using (true)
with check (true);

drop policy if exists "blocked_ips_service_role_all" on public.blocked_ips;
create policy "blocked_ips_service_role_all"
on public.blocked_ips
for all
to service_role
using (true)
with check (true);

drop policy if exists "registration_attempts_by_fingerprint_service_role_all" on public.registration_attempts_by_fingerprint;
create policy "registration_attempts_by_fingerprint_service_role_all"
on public.registration_attempts_by_fingerprint
for all
to service_role
using (true)
with check (true);

drop policy if exists "blocked_fingerprints_service_role_all" on public.blocked_fingerprints;
create policy "blocked_fingerprints_service_role_all"
on public.blocked_fingerprints
for all
to service_role
using (true)
with check (true);

drop policy if exists "registration_attempts_by_email_domain_service_role_all" on public.registration_attempts_by_email_domain;
create policy "registration_attempts_by_email_domain_service_role_all"
on public.registration_attempts_by_email_domain
for all
to service_role
using (true)
with check (true);

drop policy if exists "suspicious_registration_events_service_role_all" on public.suspicious_registration_events;
create policy "suspicious_registration_events_service_role_all"
on public.suspicious_registration_events
for all
to service_role
using (true)
with check (true);

drop policy if exists "registration_rate_limit_leases_service_role_all" on public.registration_rate_limit_leases;
create policy "registration_rate_limit_leases_service_role_all"
on public.registration_rate_limit_leases
for all
to service_role
using (true)
with check (true);

-- 5) Privileges hardening
-- Keep service_role full access. Authenticated receives least-privilege grants required by app.
revoke all on table public.messages from public;
revoke all on table public.messages from anon;
revoke all on table public.messages from authenticated;
grant select, insert, update, delete on table public.messages to authenticated;
grant all on table public.messages to service_role;

revoke all on table public.profiles from public;
revoke all on table public.profiles from anon;
revoke all on table public.profiles from authenticated;
grant select, insert, update on table public.profiles to authenticated;
grant all on table public.profiles to service_role;

revoke all on table public.presence from public;
revoke all on table public.presence from anon;
revoke all on table public.presence from authenticated;
grant select, insert, update on table public.presence to authenticated;
grant all on table public.presence to service_role;

-- 6) Critical indexes (idempotent and duplicate-safe)
do $$
begin
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'messages'
      and indexdef ilike '%using btree (conversation_id)%'
  ) then
    execute 'create index idx_messages_conversation_id on public.messages(conversation_id)';
  end if;

  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'messages'
      and indexdef ilike '%using btree (sender_id)%'
  ) then
    execute 'create index idx_messages_sender_id on public.messages(sender_id)';
  end if;

  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'attachments'
      and indexdef ilike '%using btree (file_key)%'
  ) then
    execute 'create index idx_attachments_file_key on public.attachments(file_key)';
  end if;

  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'attachments'
      and indexdef ilike '%using btree (thumb_key)%'
  ) then
    execute 'create index idx_attachments_thumb_key on public.attachments(thumb_key)';
  end if;
end
$$;

-- 7) Extra protection
alter table public.messages force row level security;
alter table public.profiles force row level security;
alter table public.presence force row level security;

-- Validation guards (fail fast)
do $$
begin
  if exists (
    select 1
    from pg_policies p
    where p.schemaname = 'public'
      and p.tablename in ('messages', 'profiles', 'presence')
      and regexp_replace(coalesce(p.qual, ''), '[[:space:]]+', '', 'g') in ('true', '(true)')
  ) then
    raise exception 'Unsafe RLS predicate detected in messages/profiles/presence after migration.';
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'messages' and policyname = 'messages_select_member'
  ) then
    raise exception 'messages_select_member policy was not created.';
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'presence' and policyname = 'presence_select_relationship'
  ) then
    raise exception 'presence_select_relationship policy was not created.';
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_select_self_or_relationship'
  ) then
    raise exception 'profiles_select_self_or_relationship policy was not created.';
  end if;
end
$$;

commit;
