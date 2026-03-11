begin;

create table if not exists public.registration_attempts_by_ip (
  id bigserial primary key,
  ip_address text not null,
  fingerprint_hash text null,
  user_id uuid null references auth.users(id) on delete set null,
  email_domain text null,
  created_at timestamptz not null default now(),
  constraint registration_attempts_by_ip_ip_address_length_chk check (char_length(ip_address) between 2 and 128),
  constraint registration_attempts_by_ip_fingerprint_hash_length_chk check (
    fingerprint_hash is null or char_length(fingerprint_hash) between 16 and 128
  ),
  constraint registration_attempts_by_ip_email_domain_length_chk check (
    email_domain is null or char_length(email_domain) between 3 and 255
  )
);

create index if not exists registration_attempts_by_ip_lookup_idx
  on public.registration_attempts_by_ip (ip_address, created_at desc);

create index if not exists registration_attempts_by_ip_created_at_idx
  on public.registration_attempts_by_ip (created_at desc);

create table if not exists public.captcha_failures_by_ip (
  id bigserial primary key,
  ip_address text not null,
  fingerprint_hash text null,
  reason text not null,
  created_at timestamptz not null default now(),
  constraint captcha_failures_by_ip_ip_address_length_chk check (char_length(ip_address) between 2 and 128),
  constraint captcha_failures_by_ip_reason_length_chk check (char_length(reason) between 3 and 120),
  constraint captcha_failures_by_ip_fingerprint_hash_length_chk check (
    fingerprint_hash is null or char_length(fingerprint_hash) between 16 and 128
  )
);

create index if not exists captcha_failures_by_ip_lookup_idx
  on public.captcha_failures_by_ip (ip_address, created_at desc);

create index if not exists captcha_failures_by_ip_created_at_idx
  on public.captcha_failures_by_ip (created_at desc);

create table if not exists public.blocked_ips (
  ip_address text primary key,
  blocked_until timestamptz not null,
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint blocked_ips_ip_address_length_chk check (char_length(ip_address) between 2 and 128),
  constraint blocked_ips_reason_length_chk check (char_length(reason) between 3 and 120)
);

create index if not exists blocked_ips_active_idx
  on public.blocked_ips (blocked_until desc);

drop trigger if exists trg_blocked_ips_set_updated_at on public.blocked_ips;
create trigger trg_blocked_ips_set_updated_at
before update on public.blocked_ips
for each row execute function public.set_updated_at();

create table if not exists public.registration_attempts_by_fingerprint (
  id bigserial primary key,
  fingerprint_hash text not null,
  ip_address text not null,
  user_id uuid null references auth.users(id) on delete set null,
  email_domain text null,
  created_at timestamptz not null default now(),
  constraint registration_attempts_by_fingerprint_hash_length_chk check (
    char_length(fingerprint_hash) between 16 and 128
  ),
  constraint registration_attempts_by_fingerprint_ip_length_chk check (char_length(ip_address) between 2 and 128),
  constraint registration_attempts_by_fingerprint_email_domain_length_chk check (
    email_domain is null or char_length(email_domain) between 3 and 255
  )
);

create index if not exists registration_attempts_by_fingerprint_lookup_idx
  on public.registration_attempts_by_fingerprint (fingerprint_hash, created_at desc);

create index if not exists registration_attempts_by_fingerprint_ip_idx
  on public.registration_attempts_by_fingerprint (ip_address, created_at desc);

create table if not exists public.blocked_fingerprints (
  fingerprint_hash text primary key,
  blocked_until timestamptz not null,
  reason text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint blocked_fingerprints_hash_length_chk check (char_length(fingerprint_hash) between 16 and 128),
  constraint blocked_fingerprints_reason_length_chk check (char_length(reason) between 3 and 120)
);

create index if not exists blocked_fingerprints_active_idx
  on public.blocked_fingerprints (blocked_until desc);

drop trigger if exists trg_blocked_fingerprints_set_updated_at on public.blocked_fingerprints;
create trigger trg_blocked_fingerprints_set_updated_at
before update on public.blocked_fingerprints
for each row execute function public.set_updated_at();

create table if not exists public.registration_attempts_by_email_domain (
  id bigserial primary key,
  email_domain text not null,
  ip_address text not null,
  fingerprint_hash text null,
  user_id uuid null references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint registration_attempts_by_email_domain_domain_length_chk check (char_length(email_domain) between 3 and 255),
  constraint registration_attempts_by_email_domain_ip_length_chk check (char_length(ip_address) between 2 and 128),
  constraint registration_attempts_by_email_domain_fingerprint_hash_length_chk check (
    fingerprint_hash is null or char_length(fingerprint_hash) between 16 and 128
  )
);

create index if not exists registration_attempts_by_email_domain_lookup_idx
  on public.registration_attempts_by_email_domain (email_domain, created_at desc);

create table if not exists public.suspicious_registration_events (
  id bigserial primary key,
  event_type text not null,
  ip_address text null,
  fingerprint_hash text null,
  email_domain text null,
  email_masked text null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint suspicious_registration_events_event_type_length_chk check (char_length(event_type) between 3 and 120),
  constraint suspicious_registration_events_ip_length_chk check (
    ip_address is null or char_length(ip_address) between 2 and 128
  ),
  constraint suspicious_registration_events_fingerprint_hash_length_chk check (
    fingerprint_hash is null or char_length(fingerprint_hash) between 16 and 128
  ),
  constraint suspicious_registration_events_email_domain_length_chk check (
    email_domain is null or char_length(email_domain) between 3 and 255
  ),
  constraint suspicious_registration_events_email_masked_length_chk check (
    email_masked is null or char_length(email_masked) between 3 and 255
  )
);

create index if not exists suspicious_registration_events_event_idx
  on public.suspicious_registration_events (event_type, created_at desc);

create index if not exists suspicious_registration_events_ip_idx
  on public.suspicious_registration_events (ip_address, created_at desc);

create index if not exists suspicious_registration_events_fingerprint_idx
  on public.suspicious_registration_events (fingerprint_hash, created_at desc);

create index if not exists suspicious_registration_events_domain_idx
  on public.suspicious_registration_events (email_domain, created_at desc);

alter table public.registration_attempts_by_ip enable row level security;
alter table public.registration_attempts_by_ip force row level security;
alter table public.captcha_failures_by_ip enable row level security;
alter table public.captcha_failures_by_ip force row level security;
alter table public.blocked_ips enable row level security;
alter table public.blocked_ips force row level security;
alter table public.registration_attempts_by_fingerprint enable row level security;
alter table public.registration_attempts_by_fingerprint force row level security;
alter table public.blocked_fingerprints enable row level security;
alter table public.blocked_fingerprints force row level security;
alter table public.registration_attempts_by_email_domain enable row level security;
alter table public.registration_attempts_by_email_domain force row level security;
alter table public.suspicious_registration_events enable row level security;
alter table public.suspicious_registration_events force row level security;

revoke all on public.registration_attempts_by_ip from anon;
revoke all on public.registration_attempts_by_ip from authenticated;
revoke all on public.captcha_failures_by_ip from anon;
revoke all on public.captcha_failures_by_ip from authenticated;
revoke all on public.blocked_ips from anon;
revoke all on public.blocked_ips from authenticated;
revoke all on public.registration_attempts_by_fingerprint from anon;
revoke all on public.registration_attempts_by_fingerprint from authenticated;
revoke all on public.blocked_fingerprints from anon;
revoke all on public.blocked_fingerprints from authenticated;
revoke all on public.registration_attempts_by_email_domain from anon;
revoke all on public.registration_attempts_by_email_domain from authenticated;
revoke all on public.suspicious_registration_events from anon;
revoke all on public.suspicious_registration_events from authenticated;

commit;
