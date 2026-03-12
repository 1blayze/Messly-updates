begin;

alter table public.user_sessions
  add column if not exists device_id text,
  add column if not exists client_type text not null default 'unknown',
  add column if not exists platform text not null default 'unknown',
  add column if not exists app_version text null,
  add column if not exists location_label text null;

update public.user_sessions
set device_id = 'legacy:' || id::text
where device_id is null or btrim(device_id) = '';

update public.user_sessions
set client_type = case
  when lower(coalesce(device, '')) like '%electron%'
    or lower(coalesce(device, '')) like '%messly desktop%'
    or lower(coalesce(os, '')) in ('windows', 'mac', 'macos', 'linux', 'win32', 'darwin')
    then 'desktop'
  when lower(coalesce(os, '')) in ('android', 'ios', 'ipados')
    or lower(coalesce(device, '')) like '%mobile%'
    then 'mobile'
  when lower(coalesce(device, '')) like '%chrome%'
    or lower(coalesce(device, '')) like '%edge%'
    or lower(coalesce(device, '')) like '%firefox%'
    or lower(coalesce(device, '')) like '%opera%'
    or lower(coalesce(device, '')) like '%safari%'
    or lower(coalesce(device, '')) like '%browser%'
    then 'web'
  else coalesce(nullif(client_type, ''), 'unknown')
end
where client_type is null or btrim(client_type) = '' or client_type = 'unknown';

update public.user_sessions
set platform = case
  when lower(coalesce(os, '')) in ('windows', 'win32') then 'windows'
  when lower(coalesce(os, '')) in ('mac', 'macos', 'darwin') then 'macos'
  when lower(coalesce(os, '')) = 'linux' then 'linux'
  when lower(coalesce(os, '')) in ('android') then 'android'
  when lower(coalesce(os, '')) in ('ios', 'ipados') then 'ios'
  when lower(coalesce(client_type, '')) = 'web' then 'browser'
  else coalesce(nullif(platform, ''), 'unknown')
end
where platform is null or btrim(platform) = '' or platform = 'unknown';

update public.user_sessions
set app_version = coalesce(app_version, client_version)
where app_version is null and client_version is not null;

update public.user_sessions
set location_label = nullif(
  concat_ws(
    ', ',
    nullif(btrim(city), ''),
    nullif(btrim(region), ''),
    nullif(btrim(country), '')
  ),
  ''
)
where location_label is null or btrim(location_label) = '';

alter table public.user_sessions
  alter column device_id set default gen_random_uuid()::text,
  alter column device_id set not null,
  alter column client_type set default 'unknown',
  alter column client_type set not null,
  alter column platform set default 'unknown',
  alter column platform set not null;

alter table public.user_sessions
  drop constraint if exists user_sessions_device_id_length_chk,
  drop constraint if exists user_sessions_client_type_chk,
  drop constraint if exists user_sessions_platform_length_chk,
  drop constraint if exists user_sessions_app_version_length_chk,
  drop constraint if exists user_sessions_location_label_length_chk;

alter table public.user_sessions
  add constraint user_sessions_device_id_length_chk
    check (char_length(device_id) between 1 and 128),
  add constraint user_sessions_client_type_chk
    check (client_type in ('desktop', 'web', 'mobile', 'unknown')),
  add constraint user_sessions_platform_length_chk
    check (char_length(platform) between 2 and 32),
  add constraint user_sessions_app_version_length_chk
    check (app_version is null or char_length(app_version) <= 32),
  add constraint user_sessions_location_label_length_chk
    check (location_label is null or char_length(location_label) <= 240);

commit;
