-- rollback_security.sql
-- Restores policies, grants, and RLS flags captured by 20260318_security_refactor.sql.

begin;

do $$
declare
  rec record;
  roles_sql text;
  using_sql text;
  check_sql text;
begin
  if to_regclass('public._backup_policies_20260318') is null then
    raise exception 'Backup table public._backup_policies_20260318 not found. Aborting rollback.';
  end if;

  if not exists (
    select 1
    from public._backup_policies_20260318
    where schemaname = 'public'
      and tablename in ('messages', 'profiles', 'presence')
  ) then
    raise exception 'No backup policies found for target tables. Aborting rollback.';
  end if;

  -- Drop current policies on target tables.
  for rec in
    select p.schemaname, p.tablename, p.policyname
    from pg_policies p
    where p.schemaname = 'public'
      and p.tablename in ('messages', 'profiles', 'presence')
  loop
    execute format('drop policy if exists %I on %I.%I;', rec.policyname, rec.schemaname, rec.tablename);
  end loop;

  -- Recreate backed-up policies.
  for rec in
    select *
    from public._backup_policies_20260318
    where schemaname = 'public'
      and tablename in ('messages', 'profiles', 'presence')
    order by tablename, policyname
  loop
    select string_agg(quote_ident(r), ', ')
      into roles_sql
    from unnest(rec.roles) as r;

    if roles_sql is null or btrim(roles_sql) = '' then
      roles_sql := 'public';
    end if;

    using_sql := case
      when rec.qual is null or btrim(rec.qual) = '' then ''
      else format(' USING (%s)', rec.qual)
    end;

    check_sql := case
      when rec.with_check is null or btrim(rec.with_check) = '' then ''
      else format(' WITH CHECK (%s)', rec.with_check)
    end;

    execute format(
      'create policy %I on %I.%I as %s for %s to %s%s%s;',
      rec.policyname,
      rec.schemaname,
      rec.tablename,
      rec.permissive,
      rec.cmd,
      roles_sql,
      using_sql,
      check_sql
    );
  end loop;
end
$$;

do $$
declare
  rec record;
begin
  if to_regclass('public._backup_table_grants_20260318') is null then
    raise exception 'Backup table public._backup_table_grants_20260318 not found. Aborting rollback.';
  end if;

  -- Reset grants to a neutral baseline on target tables.
  revoke all on table public.messages from public, anon, authenticated, service_role;
  revoke all on table public.profiles from public, anon, authenticated, service_role;
  revoke all on table public.presence from public, anon, authenticated, service_role;

  -- Restore captured grants.
  for rec in
    select *
    from public._backup_table_grants_20260318
    where table_schema = 'public'
      and table_name in ('messages', 'profiles', 'presence')
    order by table_name, grantee, privilege_type
  loop
    execute format(
      'grant %s on table %I.%I to %I%s;',
      rec.privilege_type,
      rec.table_schema,
      rec.table_name,
      rec.grantee,
      case when rec.is_grantable then ' with grant option' else '' end
    );
  end loop;
end
$$;

do $$
declare
  rec record;
begin
  if to_regclass('public._backup_rls_state_20260318') is null then
    raise exception 'Backup table public._backup_rls_state_20260318 not found. Aborting rollback.';
  end if;

  for rec in
    select *
    from public._backup_rls_state_20260318
    where schemaname = 'public'
      and tablename in ('messages', 'profiles', 'presence')
  loop
    if rec.rls_enabled then
      execute format('alter table %I.%I enable row level security;', rec.schemaname, rec.tablename);
    else
      execute format('alter table %I.%I disable row level security;', rec.schemaname, rec.tablename);
    end if;

    if rec.rls_forced then
      execute format('alter table %I.%I force row level security;', rec.schemaname, rec.tablename);
    else
      execute format('alter table %I.%I no force row level security;', rec.schemaname, rec.tablename);
    end if;
  end loop;
end
$$;

commit;
