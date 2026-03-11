-- Add nullable media columns expected by the app (idempotent)
alter table public.profiles
  add column if not exists avatar_key text,
  add column if not exists avatar_hash text,
  add column if not exists banner_key text,
  add column if not exists banner_hash text;
