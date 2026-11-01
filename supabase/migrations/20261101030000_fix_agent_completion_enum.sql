begin;

create or replace function public.complete_agent_run(p_run_id uuid,p_result jsonb,p_worker_id text) returns void
language plpgsql security definer set search_path=''
as $$
declare run public.agent_runs;
begin
  update public.agent_runs
  set status=case when requires_approval then 'awaiting_approval'::public.agent_status else 'completed'::public.agent_status end,
      result=p_result,error=null,lease_expires_at=null,worker_id=null,updated_at=now()
  where id=p_run_id and status='running' and worker_id=p_worker_id and lease_expires_at>now()
  returning * into run;
  if run.id is null then raise exception 'Run lease is not owned by this worker or has expired'; end if;
  insert into public.agent_events(run_id,status,detail)
  values(run.id,run.status,jsonb_build_object('worker',p_worker_id,'transition','complete'));
  insert into public.notifications(user_id,board_id,card_id,kind,title,deep_link)
  select run.requested_by,run.board_id,run.card_id,'agent.ready','Agent result ready','/?card='||run.card_id::text
  where coalesce((select p.in_app and p.agent_updates from public.notification_preferences p where p.user_id=run.requested_by),true);
end$$;

revoke all on function public.complete_agent_run(uuid,jsonb,text) from public;
grant execute on function public.complete_agent_run(uuid,jsonb,text) to service_role;

commit;
