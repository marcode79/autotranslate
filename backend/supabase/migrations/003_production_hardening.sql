-- Phase 3: production hardening, audit and reporting.
create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  actor_user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  target_type text not null,
  target_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_log_created_idx on public.audit_log(created_at desc);
alter table public.audit_log enable row level security;

create table if not exists public.stripe_webhook_events (
  id text primary key,
  event_type text not null,
  processed_at timestamptz not null default now()
);
alter table public.stripe_webhook_events enable row level security;

alter table public.plans add column if not exists description text;
alter table public.plans add column if not exists currency text not null default 'usd';
update public.plans set description=case id when 'free' then 'Para probar AutoTranslate' else 'Para reuniones y equipos frecuentes' end where description is null;

-- A crashed request can leave reserved minutes behind. If a period has not been
-- touched for 15 minutes, the next reservation safely discards that stale amount.
create or replace function public.reserve_usage(p_user_id uuid, p_duration_ms integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare s public.subscriptions%rowtype; p public.plans%rowtype; u public.usage_periods%rowtype;
begin
  select * into s from public.subscriptions where user_id=p_user_id for update;
  if not found or s.status not in ('active','trialing') then return jsonb_build_object('allowed',false,'reason','subscription_inactive'); end if;
  select * into p from public.plans where id=s.plan_id and active=true;
  insert into public.usage_periods(user_id,period_start,period_end) values(p_user_id,s.current_period_start,s.current_period_end) on conflict do nothing;
  select * into u from public.usage_periods where user_id=p_user_id and period_start=s.current_period_start for update;
  if u.updated_at < now()-interval '15 minutes' and u.reserved_duration_ms > 0 then
    update public.usage_periods set reserved_duration_ms=0,updated_at=now() where user_id=p_user_id and period_start=s.current_period_start;
    u.reserved_duration_ms:=0;
  end if;
  if u.used_duration_ms+u.reserved_duration_ms+p_duration_ms > p.monthly_minutes*60000::bigint then return jsonb_build_object('allowed',false,'reason','minutes'); end if;
  if u.estimated_cost_micros >= p.monthly_cost_limit_micros then return jsonb_build_object('allowed',false,'reason','cost'); end if;
  update public.usage_periods set reserved_duration_ms=reserved_duration_ms+p_duration_ms,updated_at=now() where user_id=p_user_id and period_start=s.current_period_start;
  return jsonb_build_object('allowed',true,'periodStart',s.current_period_start);
end; $$;
revoke all on function public.reserve_usage(uuid,integer) from public,anon,authenticated;
grant execute on function public.reserve_usage(uuid,integer) to service_role;

create or replace view public.daily_usage with (security_invoker=true) as
select user_id,date_trunc('day',created_at) as day,count(*) as requests,
 sum(audio_duration_ms)::bigint as duration_ms,sum(total_tokens)::bigint as total_tokens,
 sum(estimated_cost_micros)::bigint as estimated_cost_micros
from public.ai_usage_events group by user_id,date_trunc('day',created_at);
