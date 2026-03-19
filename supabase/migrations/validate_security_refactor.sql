-- validate_security_refactor.sql
-- Post-deploy validation for 20260318_security_refactor.sql

begin;

do $$
begin
  if exists (
    select 1
    from pg_policies p
    where p.schemaname = 'public'
      and p.tablename in ('messages', 'profiles', 'presence')
      and regexp_replace(coalesce(p.qual, ''), '[[:space:]]+', '', 'g') in ('true', '(true)')
  ) then
    raise exception 'Validation failed: found permissive true policy in critical tables.';
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'messages' and policyname = 'messages_select_member'
  ) then
    raise exception 'Validation failed: messages_select_member missing.';
  end if;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'profiles'
      and policyname in ('profiles_select_self_or_relationship', 'profiles_select_self_or_visible')
  ) then
    raise exception 'Validation failed: profile select policy missing.';
  end if;

  if not exists (
    select 1 from pg_policies where schemaname = 'public' and tablename = 'presence' and policyname = 'presence_select_relationship'
  ) then
    raise exception 'Validation failed: presence_select_relationship missing.';
  end if;

  if exists (
    select 1
    from information_schema.role_table_grants g
    where g.table_schema = 'public'
      and g.table_name in ('messages', 'profiles', 'presence')
      and g.grantee = 'anon'
      and g.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
  ) then
    raise exception 'Validation failed: anon still has table privileges on critical tables.';
  end if;

  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and tablename = 'attachments'
      and indexdef ilike '%using btree (file_key)%'
  ) then
    raise exception 'Validation failed: attachment file_key index not found.';
  end if;

  if exists (
    select 1
    from (
      values
        ('blocked_fingerprints'),
        ('blocked_ips'),
        ('captcha_failures_by_ip'),
        ('registration_attempts_by_email_domain'),
        ('registration_attempts_by_fingerprint'),
        ('registration_attempts_by_ip'),
        ('registration_rate_limit_leases'),
        ('spotify_oauth_states'),
        ('spotify_oauth_tokens'),
        ('suspicious_registration_events')
    ) as t(tablename)
    where not exists (
      select 1
      from pg_policies p
      where p.schemaname = 'public'
        and p.tablename = t.tablename
    )
  ) then
    raise exception 'Validation failed: one or more admin tables are RLS-enabled without policy.';
  end if;

end
$$;

commit;
