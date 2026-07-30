create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  full_name text,
  avatar_url text,
  role text not null default 'user' check (role in ('user','admin')),
  stripe_customer_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.plans (
  id text primary key,
  name text not null,
  monthly_minutes integer not null,
  monthly_cost_limit_micros bigint not null,
  price_cents integer not null default 0,
  stripe_price_id text,
  active boolean not null default true
);
insert into public.plans(id,name,monthly_minutes,monthly_cost_limit_micros,price_cents) values
  ('free','Prueba',60,1000000,0), ('pro','Profesional',1200,15000000,0)
on conflict (id) do nothing;
create table if not exists public.subscriptions (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  plan_id text not null references public.plans(id) default 'free',
  status text not null default 'active',
  stripe_subscription_id text unique,
  current_period_start timestamptz not null default date_trunc('month',now()),
  current_period_end timestamptz not null default date_trunc('month',now()) + interval '1 month',
  updated_at timestamptz not null default now()
);
create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade,
  title text not null default 'Nueva conversación', source_language text not null, target_language text not null,
  started_at timestamptz not null default now(), ended_at timestamptz, created_at timestamptz not null default now()
);
create index if not exists conversations_user_date_idx on public.conversations(user_id,created_at desc);
create table if not exists public.conversation_segments (
  id uuid primary key default gen_random_uuid(), conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade, transcript text not null, translation text not null,
  detected_language text, audio_duration_ms integer not null default 0, created_at timestamptz not null default now()
);
create index if not exists segments_conversation_date_idx on public.conversation_segments(conversation_id,created_at);
create table if not exists public.ai_usage_events (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null, model text not null,
  prompt_tokens integer not null default 0, output_tokens integer not null default 0, thinking_tokens integer not null default 0,
  total_tokens integer not null default 0, audio_tokens integer not null default 0, text_input_tokens integer not null default 0,
  audio_duration_ms integer not null default 0, estimated_cost_micros bigint not null default 0,
  price_snapshot jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create index if not exists usage_user_date_idx on public.ai_usage_events(user_id,created_at desc);

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$
begin
  insert into public.profiles(id,email,full_name,avatar_url) values(new.id,new.email,new.raw_user_meta_data->>'full_name',new.raw_user_meta_data->>'avatar_url') on conflict do nothing;
  insert into public.subscriptions(user_id,plan_id) values(new.id,'free') on conflict do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

alter table public.profiles enable row level security; alter table public.subscriptions enable row level security;
alter table public.conversations enable row level security; alter table public.conversation_segments enable row level security; alter table public.ai_usage_events enable row level security;
create policy "profiles own read" on public.profiles for select using(auth.uid()=id);
create policy "subscriptions own read" on public.subscriptions for select using(auth.uid()=user_id);
create policy "conversations own read" on public.conversations for select using(auth.uid()=user_id);
create policy "segments own read" on public.conversation_segments for select using(auth.uid()=user_id);
create policy "usage own read" on public.ai_usage_events for select using(auth.uid()=user_id);
