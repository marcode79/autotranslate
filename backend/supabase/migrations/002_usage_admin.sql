-- Phase 2: atomic usage counters and administrative reporting.
create table if not exists public.usage_periods (
  user_id uuid not null references public.profiles(id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  used_duration_ms bigint not null default 0,
  reserved_duration_ms bigint not null default 0,
  total_tokens bigint not null default 0,
  estimated_cost_micros bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, period_start)
);
alter table public.usage_periods enable row level security;
create policy "usage periods own read" on public.usage_periods for select using (auth.uid() = user_id);

create or replace function public.reserve_usage(p_user_id uuid, p_duration_ms integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare s public.subscriptions%rowtype; p public.plans%rowtype; u public.usage_periods%rowtype;
begin
  select * into s from public.subscriptions where user_id=p_user_id for update;
  if not found or s.status not in ('active','trialing') then return jsonb_build_object('allowed',false,'reason','subscription_inactive'); end if;
  select * into p from public.plans where id=s.plan_id and active=true;
  insert into public.usage_periods(user_id,period_start,period_end) values(p_user_id,s.current_period_start,s.current_period_end) on conflict do nothing;
  select * into u from public.usage_periods where user_id=p_user_id and period_start=s.current_period_start for update;
  if u.used_duration_ms+u.reserved_duration_ms+p_duration_ms > p.monthly_minutes*60000::bigint then return jsonb_build_object('allowed',false,'reason','minutes'); end if;
  if u.estimated_cost_micros >= p.monthly_cost_limit_micros then return jsonb_build_object('allowed',false,'reason','cost'); end if;
  update public.usage_periods set reserved_duration_ms=reserved_duration_ms+p_duration_ms,updated_at=now() where user_id=p_user_id and period_start=s.current_period_start;
  return jsonb_build_object('allowed',true,'periodStart',s.current_period_start);
end; $$;

create or replace function public.finalize_usage(p_user_id uuid,p_period_start timestamptz,p_reserved_ms integer,p_actual_ms integer,p_tokens integer,p_cost_micros bigint)
returns void language plpgsql security definer set search_path=public as $$
begin
 update public.usage_periods set reserved_duration_ms=greatest(0,reserved_duration_ms-p_reserved_ms),used_duration_ms=used_duration_ms+p_actual_ms,total_tokens=total_tokens+p_tokens,estimated_cost_micros=estimated_cost_micros+p_cost_micros,updated_at=now() where user_id=p_user_id and period_start=p_period_start;
end; $$;
create or replace function public.release_usage(p_user_id uuid,p_period_start timestamptz,p_reserved_ms integer)
returns void language plpgsql security definer set search_path=public as $$
begin update public.usage_periods set reserved_duration_ms=greatest(0,reserved_duration_ms-p_reserved_ms),updated_at=now() where user_id=p_user_id and period_start=p_period_start; end; $$;
revoke all on function public.reserve_usage(uuid,integer) from public,anon,authenticated;
revoke all on function public.finalize_usage(uuid,timestamptz,integer,integer,integer,bigint) from public,anon,authenticated;
revoke all on function public.release_usage(uuid,timestamptz,integer) from public,anon,authenticated;
grant execute on function public.reserve_usage(uuid,integer) to service_role;
grant execute on function public.finalize_usage(uuid,timestamptz,integer,integer,integer,bigint) to service_role;
grant execute on function public.release_usage(uuid,timestamptz,integer) to service_role;

create index if not exists segments_user_text_idx on public.conversation_segments using gin (to_tsvector('simple',coalesce(transcript,'')||' '||coalesce(translation,'')));
