-- AI provider preferences are user-scoped. Secrets are never stored in this table.
create table if not exists public.ai_user_settings (
 user_id uuid primary key references auth.users(id) on delete cascade,
 provider text not null default 'ollama' check(provider in ('ollama','lmstudio','openai','moonshot','zai','openrouter','anthropic')),
 model_id text not null default 'llama3.2' check(length(model_id) between 1 and 120),
 fallback_enabled boolean not null default false,
 fallback_provider text not null default 'openai' check(fallback_provider in ('ollama','lmstudio','openai','moonshot','zai','openrouter','anthropic')),
 fallback_model text not null default 'gpt-4.1-mini' check(length(fallback_model) between 1 and 120),
 local_only boolean not null default false,
 max_monthly_runs integer not null default 100 check(max_monthly_runs between 1 and 10000),
 max_run_steps integer not null default 6 check(max_run_steps between 1 and 25),
 updated_at timestamptz not null default now(),
 constraint ai_local_provider_only check(not local_only or provider in ('ollama','lmstudio')),
 constraint ai_local_fallback_only check(not (local_only and fallback_enabled and fallback_provider not in ('ollama','lmstudio')))
);
alter table public.ai_user_settings enable row level security;
revoke all on public.ai_user_settings from public,anon;
grant select,insert,update,delete on public.ai_user_settings to authenticated;
grant select,insert,update,delete on public.ai_user_settings to service_role;
drop policy if exists ai_preferences_read on public.ai_user_settings;
create policy ai_preferences_read on public.ai_user_settings for select to authenticated using (user_id=(select auth.uid()));
drop policy if exists ai_preferences_insert on public.ai_user_settings;
create policy ai_preferences_insert on public.ai_user_settings for insert to authenticated with check(user_id=(select auth.uid()));
drop policy if exists ai_preferences_update on public.ai_user_settings;
create policy ai_preferences_update on public.ai_user_settings for update to authenticated using(user_id=(select auth.uid())) with check(user_id=(select auth.uid()));
drop policy if exists ai_preferences_delete on public.ai_user_settings;
create policy ai_preferences_delete on public.ai_user_settings for delete to authenticated using(user_id=(select auth.uid()));

create table if not exists public.ai_usage_events (
 id uuid primary key default gen_random_uuid(),
 run_id uuid references public.agent_runs(id) on delete set null,
 user_id uuid not null references auth.users(id) on delete cascade,
 provider text not null,
 model_id text not null,
 input_tokens integer not null default 0 check(input_tokens>=0),
 output_tokens integer not null default 0 check(output_tokens>=0),
 estimated_cost_usd numeric(12,6),
 duration_ms integer not null default 0 check(duration_ms>=0),
 success boolean not null,
 created_at timestamptz not null default now()
);
create index if not exists ai_usage_events_user_date_idx on public.ai_usage_events(user_id,created_at desc);
alter table public.ai_usage_events enable row level security;
revoke all on public.ai_usage_events from public,anon,authenticated;
grant select on public.ai_usage_events to authenticated;
grant select,insert,update,delete on public.ai_usage_events to service_role;
drop policy if exists ai_usage_self_read on public.ai_usage_events;
create policy ai_usage_self_read on public.ai_usage_events for select to authenticated using(user_id=(select auth.uid()));

create or replace function public.ai_monthly_usage()
returns jsonb language sql stable security invoker set search_path='' as $$
 select jsonb_build_object(
  'runs',count(*)::int,
  'inputTokens',coalesce(sum(input_tokens),0)::bigint,
  'outputTokens',coalesce(sum(output_tokens),0)::bigint,
  'estimatedCostUsd',coalesce(sum(estimated_cost_usd),0)
 ) from public.ai_usage_events
 where user_id=auth.uid() and created_at >= date_trunc('month',now())
$$;
revoke all on function public.ai_monthly_usage() from public,anon;
grant execute on function public.ai_monthly_usage() to authenticated;
