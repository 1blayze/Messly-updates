-- Add optional columns used by the app to the profiles table (idempotent)

alter table public.profiles
  add column if not exists about text,
  add column if not exists banner_color text,
  add column if not exists profile_theme_primary_color text,
  add column if not exists profile_theme_accent_color text,
  add column if not exists friend_requests_allow_all boolean default true,
  add column if not exists friend_requests_allow_friends_of_friends boolean default true;
