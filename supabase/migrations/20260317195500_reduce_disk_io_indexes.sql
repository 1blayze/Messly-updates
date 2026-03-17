begin;

-- Cover foreign keys flagged by the performance advisor.
create index if not exists message_reads_message_id_idx
  on public.message_reads (message_id);

create index if not exists registration_attempts_by_email_domain_user_id_idx
  on public.registration_attempts_by_email_domain (user_id);

create index if not exists registration_attempts_by_fingerprint_user_id_idx
  on public.registration_attempts_by_fingerprint (user_id);

create index if not exists registration_attempts_by_ip_user_id_idx
  on public.registration_attempts_by_ip (user_id);

-- Drop duplicate message indexes only when their counterparts exist.
do $$
begin
  if to_regclass('public.messages_conversation_id_idx') is not null
     and to_regclass('public.idx_messages_conversation') is not null then
    drop index public.idx_messages_conversation;
  end if;

  if to_regclass('public.messages_sender_id_idx') is not null
     and to_regclass('public.idx_messages_sender') is not null then
    drop index public.idx_messages_sender;
  end if;
end $$;

commit;
