alter table public.conversations
  add column if not exists translation_mode text not null default 'chunked'
  check (translation_mode in ('chunked', 'live'));

create index if not exists conversations_user_mode_date_idx
  on public.conversations(user_id, translation_mode, created_at desc);

comment on column public.conversations.translation_mode is
  'Independent translation engine used by this conversation: chunked or live.';
