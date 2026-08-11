-- Administrators keep full usage accounting, but are not constrained by plan quotas.
create or replace function public.reserve_usage(p_user_id uuid,p_duration_ms integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
 s public.subscriptions%rowtype;
 p public.plans%rowtype;
 u public.usage_periods%rowtype;
 d public.daily_usage_counters%rowtype;
 profile_status text;
 profile_role text;
 today date:=current_date;
begin
 select access_status,role into profile_status,profile_role
 from public.profiles where id=p_user_id for update;

 if profile_status<>'approved' then
  return jsonb_build_object('allowed',false,'reason','access_'||coalesce(profile_status,'unknown'));
 end if;

 select * into s from public.subscriptions where user_id=p_user_id for update;
 if not found or s.status not in('active','trialing') then
  return jsonb_build_object('allowed',false,'reason','subscription_inactive');
 end if;

 select * into p from public.plans where id=s.plan_id and active=true;
 insert into public.usage_periods(user_id,period_start,period_end)
 values(p_user_id,s.current_period_start,s.current_period_end) on conflict do nothing;
 insert into public.daily_usage_counters(user_id,usage_day)
 values(p_user_id,today) on conflict do nothing;

 select * into u from public.usage_periods
 where user_id=p_user_id and period_start=s.current_period_start for update;
 select * into d from public.daily_usage_counters
 where user_id=p_user_id and usage_day=today for update;

 if u.updated_at<now()-interval '15 minutes' then
  u.reserved_duration_ms:=0;
  update public.usage_periods set reserved_duration_ms=0
  where user_id=p_user_id and period_start=s.current_period_start;
 end if;
 if d.updated_at<now()-interval '15 minutes' then
  d.reserved_duration_ms:=0;
  update public.daily_usage_counters set reserved_duration_ms=0
  where user_id=p_user_id and usage_day=today;
 end if;

 -- Admin usage is still reserved/finalized below so minutes, tokens and cost remain
 -- visible in usage_periods, daily_usage_counters and ai_usage_events.
 if profile_role<>'admin' then
  if u.used_duration_ms+u.reserved_duration_ms+p_duration_ms>p.monthly_minutes*60000::bigint then
   return jsonb_build_object('allowed',false,'reason','minutes');
  end if;
  if d.used_duration_ms+d.reserved_duration_ms+p_duration_ms>p.daily_minutes*60000::bigint then
   return jsonb_build_object('allowed',false,'reason','daily_minutes');
  end if;
  if u.estimated_cost_micros>=p.monthly_cost_limit_micros then
   return jsonb_build_object('allowed',false,'reason','cost');
  end if;
 end if;

 update public.usage_periods
 set reserved_duration_ms=reserved_duration_ms+p_duration_ms,updated_at=now()
 where user_id=p_user_id and period_start=s.current_period_start;
 update public.daily_usage_counters
 set reserved_duration_ms=reserved_duration_ms+p_duration_ms,updated_at=now()
 where user_id=p_user_id and usage_day=today;

 return jsonb_build_object(
  'allowed',true,
  'periodStart',s.current_period_start,
  'usageDay',today,
  'unlimited',profile_role='admin'
 );
end;$$;

revoke all on function public.reserve_usage(uuid,integer) from public,anon,authenticated;
grant execute on function public.reserve_usage(uuid,integer) to service_role;
