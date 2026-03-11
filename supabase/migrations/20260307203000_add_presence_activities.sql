alter table if exists public.presence
add column if not exists activities jsonb not null default '[]'::jsonb;

update public.presence
set activities = '[]'::jsonb
where activities is null;
