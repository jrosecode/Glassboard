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
  'workerOnline',coalesce(ready_beat>now()-interval '90 seconds',false),
  'lastWorkerHeartbeat',last_beat,
  'queuedRuns',coalesce(queued_count,0),
  'runningRuns',coalesce(running_count,0),
  'oldestQueuedAt',oldest_queued
 );
end $$;
revoke all on function public.agent_runtime_health() from public,anon;
grant execute on function public.agent_runtime_health() to authenticated,service_role;