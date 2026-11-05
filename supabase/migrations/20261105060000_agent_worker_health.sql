-- Agent worker observability. Only service-role workers can update health.
create table if not exists public.agent_worker_health (
 worker_id text primary key check(length(worker_id) between 1 and 150),
 status text not null check(status in ('ready','unavailable')),
 last_seen_at timestamptz not null default now()
);
alter table public.agent_worker_health enable row level security;
revoke all on public.agent_worker_health from public,anon,authenticated;
grant select,insert,update,delete on public.agent_worker_health to service_role;

create or replace function public.report_agent_worker_heartbeat(p_worker_id text,p_status text)
returns void language plpgsql security definer set search_path='' as $$
begin
 if length(p_worker_id) not between 1 and 150 or p_status not in ('ready','unavailable') then raise exception 'Invalid heartbeat'; end if;
 insert into public.agent_worker_health(worker_id,status,last_seen_at)
 values(p_worker_id,p_status,now())
 on conflict(worker_id) do update set status=excluded.status,last_seen_at=now();
 delete from public.agent_worker_health where last_seen_at<now()-interval '14 days';
end $$;
revoke all on function public.report_agent_worker_heartbeat(text,text) from public,anon,authenticated;
grant execute on function public.report_agent_worker_heartbeat(text,text) to service_role;

create or replace function public.agent_runtime_health()
returns jsonb language plpgsql security definer set search_path='' as $$
declare last_beat timestamptz; ready_beat timestamptz;
        queued_count integer; running_count integer; oldest_queued timestamptz;
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
 select max(last_seen_at),max(last_seen_at) filter(where status='ready')
 into last_beat,ready_beat from public.agent_worker_health;
 select count(*) filter(where status='queued'),count(*) filter(where status='running'),
 min(created_at) filter(where status='queued')
 into queued_count,running_count,oldest_queued
 from public.agent_runs where public.can_access_board(board_id);
 return jsonb_build_object(
  'workerOnline',ready_beat>now()-interval '90 seconds',
  'lastWorkerHeartbeat',last_beat,
  'queuedRuns',coalesce(queued_count,0),
  'runningRuns',coalesce(running_count,0),
  'oldestQueuedAt',oldest_queued
 );
end $$;
revoke all on function public.agent_runtime_health() from public,anon;
grant execute on function public.agent_runtime_health() to authenticated,service_role;
