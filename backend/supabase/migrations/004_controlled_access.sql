-- Phase 4: controlled access, invitations and daily abuse limits.
alter table public.profiles add column if not exists access_status text not null default 'pending';
alter table public.profiles add column if not exists approved_at timestamptz;
alter table public.profiles add column if not exists approved_by uuid references public.profiles(id) on delete set null;
alter table public.profiles add column if not exists rejection_reason text;
alter table public.profiles drop constraint if exists profiles_access_status_check;
alter table public.profiles add constraint profiles_access_status_check check(access_status in('pending','approved','rejected','suspended'));
-- Preserve access for every account created before this controlled-access rollout.
update public.profiles set access_status='approved',approved_at=coalesce(approved_at,now()) where access_status='pending';

alter table public.plans add column if not exists daily_minutes integer not null default 20;
update public.plans set daily_minutes=case id when 'free' then 20 else 240 end;

create table if not exists public.invite_codes(
 id uuid primary key default gen_random_uuid(),code_hash text not null unique,email text,
 default_plan_id text not null references public.plans(id) default 'free',
 expires_at timestamptz not null,used_at timestamptz,used_by uuid references public.profiles(id) on delete set null,
 created_by uuid references public.profiles(id) on delete set null,created_at timestamptz not null default now(),
 revoked_at timestamptz
);
create index if not exists invite_codes_active_idx on public.invite_codes(expires_at) where used_at is null and revoked_at is null;
alter table public.invite_codes enable row level security;

create table if not exists public.daily_usage_counters(
 user_id uuid not null references public.profiles(id) on delete cascade,usage_day date not null,
 used_duration_ms bigint not null default 0,reserved_duration_ms bigint not null default 0,
 updated_at timestamptz not null default now(),primary key(user_id,usage_day)
);
alter table public.daily_usage_counters enable row level security;
create policy "daily usage own read" on public.daily_usage_counters for select using(auth.uid()=user_id);

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path=public as $$
begin
 insert into public.profiles(id,email,full_name,avatar_url,access_status) values(new.id,new.email,new.raw_user_meta_data->>'full_name',new.raw_user_meta_data->>'avatar_url','pending') on conflict do nothing;
 insert into public.subscriptions(user_id,plan_id) values(new.id,'free') on conflict do nothing;
 return new;
end; $$;

create or replace function public.redeem_invite(p_user_id uuid,p_code_hash text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare i public.invite_codes%rowtype; user_email text;
begin
 select email into user_email from public.profiles where id=p_user_id for update;
 select * into i from public.invite_codes where code_hash=p_code_hash for update;
 if not found or i.used_at is not null or i.revoked_at is not null or i.expires_at<=now() then return jsonb_build_object('ok',false,'reason','invalid');end if;
 if i.email is not null and lower(i.email)<>lower(user_email) then return jsonb_build_object('ok',false,'reason','email_mismatch');end if;
 update public.invite_codes set used_at=now(),used_by=p_user_id where id=i.id;
 update public.profiles set access_status='approved',approved_at=now(),rejection_reason=null,updated_at=now() where id=p_user_id;
 update public.subscriptions set plan_id=i.default_plan_id,status='active',updated_at=now() where user_id=p_user_id;
 return jsonb_build_object('ok',true,'planId',i.default_plan_id);
end; $$;
revoke all on function public.redeem_invite(uuid,text) from public,anon,authenticated;grant execute on function public.redeem_invite(uuid,text) to service_role;

create or replace function public.reserve_usage(p_user_id uuid,p_duration_ms integer)
returns jsonb language plpgsql security definer set search_path=public as $$
declare s public.subscriptions%rowtype;p public.plans%rowtype;u public.usage_periods%rowtype;d public.daily_usage_counters%rowtype;status text;today date:=current_date;
begin
 select access_status into status from public.profiles where id=p_user_id for update;
 if status<>'approved' then return jsonb_build_object('allowed',false,'reason','access_'||coalesce(status,'unknown'));end if;
 select * into s from public.subscriptions where user_id=p_user_id for update;
 if not found or s.status not in('active','trialing') then return jsonb_build_object('allowed',false,'reason','subscription_inactive');end if;
 select * into p from public.plans where id=s.plan_id and active=true;
 insert into public.usage_periods(user_id,period_start,period_end) values(p_user_id,s.current_period_start,s.current_period_end) on conflict do nothing;
 insert into public.daily_usage_counters(user_id,usage_day) values(p_user_id,today) on conflict do nothing;
 select * into u from public.usage_periods where user_id=p_user_id and period_start=s.current_period_start for update;
 select * into d from public.daily_usage_counters where user_id=p_user_id and usage_day=today for update;
 if u.updated_at<now()-interval '15 minutes' then u.reserved_duration_ms:=0;update public.usage_periods set reserved_duration_ms=0 where user_id=p_user_id and period_start=s.current_period_start;end if;
 if d.updated_at<now()-interval '15 minutes' then d.reserved_duration_ms:=0;update public.daily_usage_counters set reserved_duration_ms=0 where user_id=p_user_id and usage_day=today;end if;
 if u.used_duration_ms+u.reserved_duration_ms+p_duration_ms>p.monthly_minutes*60000::bigint then return jsonb_build_object('allowed',false,'reason','minutes');end if;
 if d.used_duration_ms+d.reserved_duration_ms+p_duration_ms>p.daily_minutes*60000::bigint then return jsonb_build_object('allowed',false,'reason','daily_minutes');end if;
 if u.estimated_cost_micros>=p.monthly_cost_limit_micros then return jsonb_build_object('allowed',false,'reason','cost');end if;
 update public.usage_periods set reserved_duration_ms=reserved_duration_ms+p_duration_ms,updated_at=now() where user_id=p_user_id and period_start=s.current_period_start;
 update public.daily_usage_counters set reserved_duration_ms=reserved_duration_ms+p_duration_ms,updated_at=now() where user_id=p_user_id and usage_day=today;
 return jsonb_build_object('allowed',true,'periodStart',s.current_period_start,'usageDay',today);
end;$$;

create or replace function public.finalize_usage_v2(p_user_id uuid,p_period_start timestamptz,p_usage_day date,p_reserved_ms integer,p_actual_ms integer,p_tokens integer,p_cost_micros bigint)
returns void language plpgsql security definer set search_path=public as $$ begin
 update public.usage_periods set reserved_duration_ms=greatest(0,reserved_duration_ms-p_reserved_ms),used_duration_ms=used_duration_ms+p_actual_ms,total_tokens=total_tokens+p_tokens,estimated_cost_micros=estimated_cost_micros+p_cost_micros,updated_at=now() where user_id=p_user_id and period_start=p_period_start;
 update public.daily_usage_counters set reserved_duration_ms=greatest(0,reserved_duration_ms-p_reserved_ms),used_duration_ms=used_duration_ms+p_actual_ms,updated_at=now() where user_id=p_user_id and usage_day=p_usage_day;
end;$$;
create or replace function public.release_usage_v2(p_user_id uuid,p_period_start timestamptz,p_usage_day date,p_reserved_ms integer)
returns void language plpgsql security definer set search_path=public as $$ begin
 update public.usage_periods set reserved_duration_ms=greatest(0,reserved_duration_ms-p_reserved_ms),updated_at=now() where user_id=p_user_id and period_start=p_period_start;
 update public.daily_usage_counters set reserved_duration_ms=greatest(0,reserved_duration_ms-p_reserved_ms),updated_at=now() where user_id=p_user_id and usage_day=p_usage_day;
end;$$;
revoke all on function public.reserve_usage(uuid,integer) from public,anon,authenticated;grant execute on function public.reserve_usage(uuid,integer) to service_role;
revoke all on function public.finalize_usage_v2(uuid,timestamptz,date,integer,integer,integer,bigint) from public,anon,authenticated;grant execute on function public.finalize_usage_v2(uuid,timestamptz,date,integer,integer,integer,bigint) to service_role;
revoke all on function public.release_usage_v2(uuid,timestamptz,date,integer) from public,anon,authenticated;grant execute on function public.release_usage_v2(uuid,timestamptz,date,integer) to service_role;
