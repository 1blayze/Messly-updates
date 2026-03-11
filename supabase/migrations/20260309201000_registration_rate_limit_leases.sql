begin;

create table if not exists public.registration_rate_limit_leases (
  id uuid primary key default gen_random_uuid(),
  ip_address text not null,
  fingerprint_hash text not null,
  lease_status text not null default 'reserved',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz null,
  released_at timestamptz null,
  release_reason text null,
  constraint registration_rate_limit_leases_ip_length_chk check (char_length(ip_address) between 2 and 128),
  constraint registration_rate_limit_leases_fingerprint_length_chk check (
    char_length(fingerprint_hash) between 16 and 128
  ),
  constraint registration_rate_limit_leases_status_chk check (
    lease_status in ('reserved', 'consumed', 'released', 'expired')
  ),
  constraint registration_rate_limit_leases_release_reason_length_chk check (
    release_reason is null or char_length(release_reason) <= 120
  )
);

create index if not exists registration_rate_limit_leases_ip_created_idx
  on public.registration_rate_limit_leases (ip_address, created_at desc)
  where lease_status in ('reserved', 'consumed');

create index if not exists registration_rate_limit_leases_fingerprint_created_idx
  on public.registration_rate_limit_leases (fingerprint_hash, created_at desc)
  where lease_status in ('reserved', 'consumed');

create index if not exists registration_rate_limit_leases_status_expiry_idx
  on public.registration_rate_limit_leases (lease_status, expires_at);

create or replace function public.registration_try_acquire_lease(
  p_ip_address text,
  p_fingerprint_hash text,
  p_now timestamptz default now(),
  p_ip_limit integer default 3,
  p_fingerprint_limit integer default 2,
  p_ip_window_seconds integer default 86400,
  p_fingerprint_window_seconds integer default 86400,
  p_lease_ttl_seconds integer default 1200
)
returns table (
  allowed boolean,
  reason text,
  lease_id uuid,
  ip_count integer,
  fingerprint_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_ip_window_start timestamptz := v_now - make_interval(secs => greatest(1, p_ip_window_seconds));
  v_fingerprint_window_start timestamptz := v_now - make_interval(secs => greatest(1, p_fingerprint_window_seconds));
  v_expires_at timestamptz := v_now + make_interval(secs => greatest(60, p_lease_ttl_seconds));
  v_ip_limit integer := greatest(1, p_ip_limit);
  v_fingerprint_limit integer := greatest(1, p_fingerprint_limit);
  v_ip_count integer := 0;
  v_fingerprint_count integer := 0;
  v_lease_id uuid;
  v_ip_lock_key bigint := hashtextextended('registration-ip:' || coalesce(p_ip_address, ''), 0);
  v_fingerprint_lock_key bigint := hashtextextended('registration-fingerprint:' || coalesce(p_fingerprint_hash, ''), 0);
begin
  if p_ip_address is null or btrim(p_ip_address) = '' then
    raise exception 'ip_address required';
  end if;
  if p_fingerprint_hash is null or btrim(p_fingerprint_hash) = '' then
    raise exception 'fingerprint_hash required';
  end if;

  if v_ip_lock_key <= v_fingerprint_lock_key then
    perform pg_advisory_xact_lock(v_ip_lock_key);
    perform pg_advisory_xact_lock(v_fingerprint_lock_key);
  else
    perform pg_advisory_xact_lock(v_fingerprint_lock_key);
    perform pg_advisory_xact_lock(v_ip_lock_key);
  end if;

  update public.registration_rate_limit_leases
  set lease_status = 'expired',
      released_at = coalesce(released_at, v_now),
      release_reason = coalesce(release_reason, 'lease_expired')
  where lease_status = 'reserved'
    and expires_at <= v_now
    and (ip_address = p_ip_address or fingerprint_hash = p_fingerprint_hash);

  select count(*)::integer
    into v_ip_count
  from public.registration_rate_limit_leases
  where ip_address = p_ip_address
    and created_at >= v_ip_window_start
    and (
      lease_status = 'consumed'
      or (lease_status = 'reserved' and expires_at > v_now)
    );

  if v_ip_count >= v_ip_limit then
    return query select false, 'ip_limit', null::uuid, v_ip_count, null::integer;
    return;
  end if;

  select count(*)::integer
    into v_fingerprint_count
  from public.registration_rate_limit_leases
  where fingerprint_hash = p_fingerprint_hash
    and created_at >= v_fingerprint_window_start
    and (
      lease_status = 'consumed'
      or (lease_status = 'reserved' and expires_at > v_now)
    );

  if v_fingerprint_count >= v_fingerprint_limit then
    return query select false, 'fingerprint_limit', null::uuid, v_ip_count, v_fingerprint_count;
    return;
  end if;

  insert into public.registration_rate_limit_leases (
    ip_address,
    fingerprint_hash,
    lease_status,
    expires_at
  ) values (
    p_ip_address,
    p_fingerprint_hash,
    'reserved',
    v_expires_at
  )
  returning id into v_lease_id;

  return query
    select true, 'ok', v_lease_id, v_ip_count + 1, v_fingerprint_count + 1;
end;
$$;

create or replace function public.registration_release_lease(
  p_lease_id uuid,
  p_reason text default null,
  p_now timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_reason text := nullif(left(coalesce(p_reason, 'released'), 120), '');
  v_updated integer := 0;
begin
  if p_lease_id is null then
    return false;
  end if;

  update public.registration_rate_limit_leases
  set lease_status = 'released',
      released_at = v_now,
      release_reason = v_reason
  where id = p_lease_id
    and lease_status = 'reserved';

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

create or replace function public.registration_consume_lease(
  p_lease_id uuid,
  p_now timestamptz default now()
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_updated integer := 0;
begin
  if p_lease_id is null then
    return false;
  end if;

  update public.registration_rate_limit_leases
  set lease_status = 'consumed',
      consumed_at = v_now,
      expires_at = greatest(expires_at, v_now)
  where id = p_lease_id
    and lease_status = 'reserved'
    and expires_at > v_now;

  get diagnostics v_updated = row_count;
  return v_updated > 0;
end;
$$;

create or replace function public.registration_cleanup_rate_limit_leases(
  p_now timestamptz default now(),
  p_retention_hours integer default 168
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_retention_start timestamptz := v_now - make_interval(hours => greatest(1, p_retention_hours));
  v_deleted integer := 0;
begin
  update public.registration_rate_limit_leases
  set lease_status = 'expired',
      released_at = coalesce(released_at, v_now),
      release_reason = coalesce(release_reason, 'lease_expired')
  where lease_status = 'reserved'
    and expires_at <= v_now;

  delete from public.registration_rate_limit_leases
  where lease_status in ('released', 'expired')
    and coalesce(released_at, created_at) < v_retention_start;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.registration_try_acquire_lease(text, text, timestamptz, integer, integer, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.registration_release_lease(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.registration_consume_lease(uuid, timestamptz) from public, anon, authenticated;
revoke all on function public.registration_cleanup_rate_limit_leases(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.registration_try_acquire_lease(text, text, timestamptz, integer, integer, integer, integer, integer) to service_role;
grant execute on function public.registration_release_lease(uuid, text, timestamptz) to service_role;
grant execute on function public.registration_consume_lease(uuid, timestamptz) to service_role;
grant execute on function public.registration_cleanup_rate_limit_leases(timestamptz, integer) to service_role;

alter table public.registration_rate_limit_leases enable row level security;
alter table public.registration_rate_limit_leases force row level security;
revoke all on public.registration_rate_limit_leases from anon;
revoke all on public.registration_rate_limit_leases from authenticated;

commit;
