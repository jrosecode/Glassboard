begin;

create type public.list_kind as enum ('normal','ai');
create type public.task_type as enum ('task','project','subtask','milestone');
create type public.agent_status as enum ('queued','running','awaiting_approval','blocked','completed','failed','cancelled');
create type public.planning_status as enum ('queued','processing','ready','approved','rejected','failed','materialized');

alter table public.lists add column kind public.list_kind not null default 'normal';
create unique index lists_one_ai_per_board on public.lists(board_id) where kind = 'ai';
alter table public.cards add column parent_id uuid references public.cards(id) on delete cascade;
alter table public.cards add column task_type public.task_type not null default 'task';
alter table public.cards add column blocked_reason text;
alter table public.cards add column acceptance_criteria text not null default '';
alter table public.cards add column effort smallint check(effort between 1 and 100);
alter table public.cards add column source text not null default 'manual' check(source in ('manual','voice','ai','recurring'));
alter table public.cards add column completed_at timestamptz;
alter table public.cards add column recurrence text check(recurrence in ('daily','weekly','monthly'));
alter table public.cards add column approval_status text check(approval_status in ('pending','approved','rejected'));

alter table public.card_dependencies add column created_at timestamptz not null default now();
create table public.activity_events (
  id uuid primary key default gen_random_uuid(), board_id uuid not null references public.boards(id) on delete cascade,
  card_id uuid references public.cards(id) on delete cascade, actor_id uuid references public.profiles(id),
  event_type text not null check(length(event_type) between 1 and 80), payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.notifications add column event_id uuid references public.activity_events(id) on delete cascade;
alter table public.notifications add column deep_link text not null default '/';
create index productivity_notifications_unread_idx on public.notifications(user_id,created_at desc) where read_at is null;
create table public.notification_preferences (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  in_app boolean not null default true, email boolean not null default false, due_reminders boolean not null default true,
  agent_updates boolean not null default true, updated_at timestamptz not null default now()
);
create table public.planning_requests (
  id uuid primary key default gen_random_uuid(), board_id uuid not null references public.boards(id) on delete cascade,
  requested_by uuid not null references public.profiles(id), status public.planning_status not null default 'queued',
  prompt text not null check(length(prompt) between 1 and 4000), model text, proposal jsonb, result_metadata jsonb not null default '{}'::jsonb,
  idempotency_key text not null check(length(idempotency_key)<=120), approved_at timestamptz, created_at timestamptz not null default now(),
  unique(requested_by,idempotency_key)
);
create table public.agent_runs (
  id uuid primary key default gen_random_uuid(), board_id uuid not null references public.boards(id) on delete cascade,
  card_id uuid not null references public.cards(id) on delete cascade, requested_by uuid not null references public.profiles(id),
  status public.agent_status not null default 'queued', requires_approval boolean not null default true,
  connector text not null default 'hermes', input jsonb not null default '{}'::jsonb, result jsonb, error text,
  idempotency_key text not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(requested_by,idempotency_key)
);
create table public.agent_events (
  id uuid primary key default gen_random_uuid(), run_id uuid not null references public.agent_runs(id) on delete cascade,
  status public.agent_status not null, detail jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create table public.reminders (
  id uuid primary key default gen_random_uuid(), card_id uuid not null references public.cards(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade, remind_at timestamptz not null, delivered_at timestamptz,
  created_at timestamptz not null default now()
);
create table public.recurring_rules (
  id uuid primary key default gen_random_uuid(), card_id uuid not null unique references public.cards(id) on delete cascade,
  cadence text not null check(cadence in ('daily','weekly','monthly')), next_at timestamptz not null, active boolean not null default true
);
create table public.email_reminder_queue (
  id uuid primary key default gen_random_uuid(), reminder_id uuid not null unique references public.reminders(id) on delete cascade,
  recipient_user_id uuid not null references public.profiles(id), status text not null default 'pending' check(status in ('pending','processing','sent','failed','cancelled')),
  attempts smallint not null default 0 check(attempts between 0 and 10), available_at timestamptz not null default now(), last_error text
);

create table public.planning_materialized_items (
  request_id uuid not null references public.planning_requests(id) on delete cascade,
  item_key text not null, card_id uuid not null references public.cards(id) on delete cascade,
  primary key(request_id,item_key)
);

create or replace function public.capture_card_activity() returns trigger
language plpgsql security definer set search_path = ''
as $$declare event_name text; target public.cards; begin
  target:=case when tg_op='DELETE' then old else new end;
  event_name:=case when tg_op='INSERT' then 'card.created' when tg_op='DELETE' then 'card.deleted' when old.completed is distinct from new.completed then case when new.completed then 'card.completed' else 'card.reopened' end when old.list_id is distinct from new.list_id then 'card.moved' when old.due_at is distinct from new.due_at then 'card.due_changed' when old.approval_status is distinct from new.approval_status then 'card.approval_changed' else 'card.updated' end;
  insert into public.activity_events(board_id,card_id,actor_id,event_type,payload) values(target.board_id,case when tg_op='DELETE' then null else target.id end,auth.uid(),event_name,jsonb_build_object('cardId',target.id,'title',target.title));
  return case when tg_op='DELETE' then old else new end;
end$$;
create or replace function public.capture_related_activity() returns trigger
language plpgsql security definer set search_path = ''
as $$declare target_card uuid; target_board uuid; event_name text; begin
  target_card:=coalesce(new.card_id,old.card_id); select board_id into target_board from public.cards where id=target_card;
  event_name:=case tg_table_name when 'card_members' then 'card.assignment_changed' when 'comments' then 'card.comment_changed' else 'card.attachment_changed' end;
  insert into public.activity_events(board_id,card_id,actor_id,event_type,payload) values(target_board,target_card,auth.uid(),event_name,jsonb_build_object('operation',tg_op));
  return case when tg_op='DELETE' then old else new end;
end$$;
create or replace function public.fan_out_activity_notification() returns trigger
language plpgsql security definer set search_path = ''
as $$begin
  insert into public.notifications(user_id,board_id,card_id,kind,title,event_id,deep_link)
  select cm.user_id,new.board_id,new.card_id,new.event_type,replace(new.event_type,'.',' '),new.id,'/?card='||new.card_id::text from public.card_members cm
  where cm.card_id=new.card_id and cm.user_id is distinct from new.actor_id and coalesce((select np.in_app from public.notification_preferences np where np.user_id=cm.user_id),true);
  return new;
end$$;
create trigger productivity_card_activity after insert or update or delete on public.cards for each row execute function public.capture_card_activity();
create trigger productivity_assignment_activity after insert or update or delete on public.card_members for each row execute function public.capture_related_activity();
create trigger productivity_comment_activity after insert or update or delete on public.comments for each row execute function public.capture_related_activity();
create trigger productivity_attachment_activity after insert or update or delete on public.attachments for each row execute function public.capture_related_activity();
create trigger productivity_notification_fanout after insert on public.activity_events for each row execute function public.fan_out_activity_notification();

alter table public.card_dependencies enable row level security;
alter table public.activity_events enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.planning_requests enable row level security;
alter table public.agent_runs enable row level security;
alter table public.agent_events enable row level security;
alter table public.reminders enable row level security;
alter table public.recurring_rules enable row level security;
alter table public.email_reminder_queue enable row level security;

create policy activity_events_member_read on public.activity_events for select to authenticated using(public.can_access_board(board_id));
create policy notifications_self_all on public.notifications for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
create policy notification_preferences_self_all on public.notification_preferences for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
create policy planning_requests_requester_or_manager_read on public.planning_requests for select to authenticated
using(public.can_access_board(board_id) and (requested_by = auth.uid() or public.can_manage_board(board_id)));
create policy agent_runs_requester_or_manager_read on public.agent_runs for select to authenticated
using(public.can_access_board(board_id) and (requested_by = auth.uid() or public.can_manage_board(board_id)));
create policy reminders_self_board_all on public.reminders for all to authenticated
using(user_id = auth.uid() and public.can_access_board(public.card_board(card_id)))
with check(user_id = auth.uid() and public.can_access_board(public.card_board(card_id)));
create policy recurring_rules_board_all on public.recurring_rules for all to authenticated
using(public.can_access_board(public.card_board(card_id)))
with check(public.can_access_board(public.card_board(card_id)));
create policy agent_events_member_read on public.agent_events for select to authenticated using(exists(select 1 from public.agent_runs r where r.id=run_id and public.can_access_board(r.board_id)));
create policy dependencies_member_all on public.card_dependencies for all to authenticated using(exists(select 1 from public.cards c where c.id=card_id and public.can_access_board(c.board_id))) with check(exists(select 1 from public.cards c where c.id=card_id and public.can_access_board(c.board_id)));

create or replace function public.enforce_ai_list_entry() returns trigger language plpgsql security definer set search_path='' as $$begin
  if exists(select 1 from public.lists where id=new.list_id and kind='ai') and coalesce(current_setting('app.queue_card_for_ai',true),'')<>'on' then raise exception 'Cards must enter the AI list through queue_card_for_ai'; end if;
  return new;
end$$;
create trigger cards_ai_entry_guard before insert or update of list_id on public.cards for each row execute function public.enforce_ai_list_entry();
create or replace function public.cancel_agent_when_leaving_ai() returns trigger language plpgsql security definer set search_path='' as $$begin
  if exists(select 1 from public.lists where id=old.list_id and kind='ai') and not exists(select 1 from public.lists where id=new.list_id and kind='ai') then update public.agent_runs set status='cancelled',updated_at=now() where card_id=new.id and status in ('queued','running','blocked','awaiting_approval'); end if; return new;
end$$;
create trigger cards_ai_exit_cancel after update of list_id on public.cards for each row execute function public.cancel_agent_when_leaving_ai();

create or replace function public.create_planning_request(p_board_id uuid,p_prompt text,p_idempotency_key text,p_model text default null) returns public.planning_requests
language plpgsql security definer set search_path = ''
as $$declare request public.planning_requests; begin
  if auth.uid() is null or not public.can_access_board(p_board_id) then raise exception 'Planning request access denied' using errcode='42501'; end if;
  if length(trim(p_prompt)) not between 1 and 4000 then raise exception 'Invalid planning prompt'; end if;
  if length(p_idempotency_key) not between 1 and 120 then raise exception 'Invalid idempotency key'; end if;
  if p_model is not null and length(p_model)>120 then raise exception 'Invalid model'; end if;
  insert into public.planning_requests(board_id,requested_by,status,prompt,model,idempotency_key)
  values(p_board_id,auth.uid(),'queued',trim(p_prompt),coalesce(nullif(trim(p_model),''),'local-ollama'),p_idempotency_key)
  on conflict(requested_by,idempotency_key) do update set prompt=public.planning_requests.prompt
  returning * into request;
  if request.board_id<>p_board_id then raise exception 'Idempotency key belongs to another board'; end if;
  return request;
end$$;

create or replace function public.set_card_dependencies(p_card_id uuid,p_dependency_ids uuid[]) returns void
language plpgsql security definer set search_path = ''
as $$declare target_board uuid; dependency_id uuid; begin
  select board_id into target_board from public.cards where id=p_card_id;
  if target_board is null or not public.can_access_board(target_board) then raise exception 'Card access denied' using errcode='42501'; end if;
  if p_card_id=any(coalesce(p_dependency_ids,'{}'::uuid[])) then raise exception 'A card cannot depend on itself'; end if;
  if exists(select 1 from unnest(coalesce(p_dependency_ids,'{}'::uuid[])) id left join public.cards c on c.id=id where c.id is null or c.board_id<>target_board) then raise exception 'Dependencies must be cards on the same board'; end if;
  foreach dependency_id in array coalesce(p_dependency_ids,'{}'::uuid[]) loop
    if exists(with recursive chain(id) as (select dependency_id union select d.depends_on_card_id from public.card_dependencies d join chain on d.card_id=chain.id) select 1 from chain where id=p_card_id) then raise exception 'Dependency cycle'; end if;
  end loop;
  delete from public.card_dependencies where card_id=p_card_id;
  insert into public.card_dependencies(card_id,depends_on_card_id) select p_card_id,id from unnest(coalesce(p_dependency_ids,'{}'::uuid[])) id on conflict do nothing;
end$$;

create or replace function public.queue_card_for_ai(p_card_id uuid,p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare target public.cards; ai_list uuid; run_id uuid; run_status public.agent_status; existing public.agent_runs;
begin
  if length(p_idempotency_key) not between 1 and 120 then raise exception 'Invalid idempotency key'; end if;
  select * into target from public.cards where id=p_card_id for update;
  if target.id is null or not public.can_access_board(target.board_id) then raise exception 'Card access denied' using errcode='42501'; end if;
  select * into existing from public.agent_runs where requested_by=auth.uid() and idempotency_key=p_idempotency_key for update;
  if existing.id is not null and existing.card_id <> p_card_id then raise exception 'Idempotency key belongs to another card'; end if;
  if existing.id is not null then
    select id into ai_list from public.lists where id=(select list_id from public.cards where id=p_card_id) and kind='ai';
    return jsonb_build_object('listId',ai_list,'runId',existing.id,'status',existing.status);
  end if;
  perform pg_advisory_xact_lock(hashtextextended(target.board_id::text,0));
  select id into ai_list from public.lists where board_id=target.board_id and kind='ai';
  if ai_list is null then
    insert into public.lists(board_id,title,position,kind)
    values(target.board_id,'AI Assistant',(select coalesce(max(position),0)+1 from public.lists where board_id=target.board_id),'ai')
    returning id into ai_list;
  end if;
  perform set_config('app.queue_card_for_ai','on',true);
  update public.cards set list_id=ai_list where id=p_card_id;
  insert into public.agent_runs(board_id,card_id,requested_by,idempotency_key)
  values(target.board_id,p_card_id,auth.uid(),p_idempotency_key)
  returning id,status into run_id,run_status;
  return jsonb_build_object('listId',ai_list,'runId',run_id,'status',run_status);
end$$;

create or replace function public.set_notification_read(p_notification_id uuid,p_read boolean) returns void
language sql security definer set search_path = ''
as $$ update public.notifications set read_at=case when p_read then now() else null end where id=p_notification_id and user_id=auth.uid() $$;
create or replace function public.mark_all_notifications_read() returns void
language sql security definer set search_path = ''
as $$ update public.notifications set read_at=now() where user_id=auth.uid() and read_at is null $$;

create or replace function public.resolve_planning_request(p_request_id uuid,p_approve boolean,p_proposal jsonb default null) returns public.planning_status
language plpgsql security definer set search_path = ''
as $$declare request public.planning_requests; next_status public.planning_status; begin
  select * into request from public.planning_requests where id=p_request_id for update;
  if request.id is null or not public.can_access_board(request.board_id) or (request.requested_by<>auth.uid() and not public.can_manage_board(request.board_id)) then raise exception 'Planning request access denied' using errcode='42501'; end if;
  if request.status<>'ready' then raise exception 'Planning request is not ready'; end if;
  if p_approve and p_proposal is not null and (jsonb_typeof(p_proposal->'lists')<>'array' or jsonb_array_length(p_proposal->'lists') not between 1 and 50) then raise exception 'Invalid planning proposal'; end if;
  next_status:=case when p_approve then 'approved'::public.planning_status else 'rejected'::public.planning_status end;
  update public.planning_requests set status=next_status,proposal=case when p_approve then coalesce(p_proposal,proposal) else proposal end,approved_at=case when p_approve then now() else null end where id=p_request_id;
  return next_status;
end$$;

create or replace function public.control_agent_run(p_run_id uuid,p_action text) returns public.agent_status
language plpgsql security definer set search_path = ''
as $$declare run public.agent_runs; next_status public.agent_status; begin
  if p_action not in ('approve','reject','cancel','retry') then raise exception 'Invalid agent action'; end if;
  select * into run from public.agent_runs where id=p_run_id for update;
  if run.id is null or not public.can_access_board(run.board_id) or (run.requested_by<>auth.uid() and not public.can_manage_board(run.board_id)) then raise exception 'Agent run access denied' using errcode='42501'; end if;
  if p_action='approve' and run.status='awaiting_approval' then next_status:='completed';
  elsif p_action='reject' and run.status='awaiting_approval' then next_status:='cancelled';
  elsif p_action='cancel' and run.status in ('queued','running','blocked','awaiting_approval') then next_status:='cancelled';
  elsif p_action='retry' and run.status='failed' then next_status:='queued';
  else raise exception 'Invalid agent state transition'; end if;
  update public.agent_runs set status=next_status,updated_at=now() where id=p_run_id;
  insert into public.agent_events(run_id,status,detail) values(p_run_id,next_status,jsonb_build_object('action',p_action,'actorId',auth.uid()));
  return next_status;
end$$;

create or replace function public.approve_and_materialize_plan(p_request_id uuid,p_proposal jsonb) returns public.planning_status
language plpgsql security definer set search_path=''
as $$declare request public.planning_requests; list_row record; card_row record; target_list uuid; created_card uuid; item_key text; begin
  select * into request from public.planning_requests where id=p_request_id for update;
  if request.id is null or not public.can_access_board(request.board_id) or (request.requested_by<>auth.uid() and not public.can_manage_board(request.board_id)) then raise exception 'Planning request access denied' using errcode='42501'; end if;
  if request.status='materialized' then return request.status; end if;
  if request.status<>'ready' or jsonb_typeof(p_proposal->'lists')<>'array' or jsonb_array_length(p_proposal->'lists') not between 1 and 50 then raise exception 'Invalid planning proposal'; end if;
  for list_row in select value,ordinality from jsonb_array_elements(p_proposal->'lists') with ordinality loop
    if length(trim(list_row.value->>'title')) not between 1 and 120 or jsonb_typeof(list_row.value->'cards')<>'array' or jsonb_array_length(list_row.value->'cards')>200 then raise exception 'Invalid planning list'; end if;
    insert into public.lists(board_id,title,position,kind) values(request.board_id,trim(list_row.value->>'title'),(select coalesce(max(position),0)+1 from public.lists where board_id=request.board_id),'normal') returning id into target_list;
    for card_row in select value,ordinality from jsonb_array_elements(list_row.value->'cards') with ordinality loop
      item_key:=list_row.ordinality::text||':'||card_row.ordinality::text;
      if length(trim(card_row.value->>'title')) not between 1 and 240 then raise exception 'Invalid planning card'; end if;
      if not exists(select 1 from public.planning_materialized_items i where i.request_id=p_request_id and i.item_key=item_key) then
        insert into public.cards(board_id,list_id,title,description,priority,position,source) values(request.board_id,target_list,trim(card_row.value->>'title'),coalesce(card_row.value->>'description',''),coalesce((card_row.value->>'priority')::public.card_priority,'medium'),(select coalesce(max(position),0)+1 from public.cards where list_id=target_list),'ai') returning id into created_card;
        insert into public.planning_materialized_items(request_id,item_key,card_id) values(p_request_id,item_key,created_card);
      end if;
    end loop;
  end loop;
  update public.planning_requests set status='materialized',proposal=p_proposal,approved_at=now() where id=p_request_id;
  return 'materialized';
end$$;

create or replace function public.convert_checklist_to_subtasks(p_card_id uuid) returns integer
language plpgsql security definer set search_path=''
as $$declare parent public.cards; item jsonb; created integer:=0; begin
  select * into parent from public.cards where id=p_card_id for update;
  if parent.id is null or not public.can_access_board(parent.board_id) then raise exception 'Card access denied' using errcode='42501'; end if;
  for item in select value from jsonb_array_elements(parent.checklist) loop
    if length(trim(item->>'text')) between 1 and 240 then insert into public.cards(board_id,list_id,title,description,priority,position,completed,completed_at,parent_id,task_type,source) values(parent.board_id,parent.list_id,trim(item->>'text'),'',parent.priority,(select coalesce(max(position),0)+1 from public.cards where list_id=parent.list_id),coalesce((item->>'done')::boolean,false),case when coalesce((item->>'done')::boolean,false) then now() else null end,parent.id,'subtask','manual'); created:=created+1; end if;
  end loop;
  update public.cards set checklist='[]'::jsonb where id=p_card_id; return created;
end$$;

create or replace function public.upsert_card_reminder(p_card_id uuid,p_remind_at timestamptz) returns uuid
language plpgsql security definer set search_path=''
as $$declare reminder_id uuid; begin
  if not public.can_access_board(public.card_board(p_card_id)) then raise exception 'Card access denied' using errcode='42501'; end if;
  delete from public.reminders where card_id=p_card_id and user_id=auth.uid();
  if p_remind_at is null then return null; end if;
  insert into public.reminders(card_id,user_id,remind_at) values(p_card_id,auth.uid(),p_remind_at) returning id into reminder_id; return reminder_id;
end$$;
create or replace function public.upsert_recurring_rule(p_card_id uuid,p_cadence text,p_next_at timestamptz) returns uuid
language plpgsql security definer set search_path=''
as $$declare rule_id uuid; begin
  if not public.can_access_board(public.card_board(p_card_id)) then raise exception 'Card access denied' using errcode='42501'; end if;
  if p_cadence is null then delete from public.recurring_rules where card_id=p_card_id; return null; end if;
  if p_cadence not in ('daily','weekly','monthly') or p_next_at is null then raise exception 'Invalid recurring rule'; end if;
  insert into public.recurring_rules(card_id,cadence,next_at) values(p_card_id,p_cadence,p_next_at) on conflict(card_id) do update set cadence=excluded.cadence,next_at=excluded.next_at,active=true returning id into rule_id; return rule_id;
end$$;
create or replace function public.claim_productivity_work(p_worker_id text) returns jsonb
language plpgsql security definer set search_path=''
as $$declare run public.agent_runs; request public.planning_requests; begin
  select * into run from public.agent_runs where status='queued' order by created_at for update skip locked limit 1;
  if run.id is not null then update public.agent_runs set status='running',updated_at=now() where id=run.id; insert into public.agent_events(run_id,status,detail) values(run.id,'running',jsonb_build_object('worker',p_worker_id)); return jsonb_build_object('kind','agent','id',run.id,'input',run.input); end if;
  select * into request from public.planning_requests where status='queued' order by created_at for update skip locked limit 1;
  if request.id is not null then update public.planning_requests set status='processing',result_metadata=jsonb_build_object('worker',p_worker_id) where id=request.id; return jsonb_build_object('kind','planning','id',request.id,'prompt',request.prompt); end if;
  return null;
end$$;
create or replace function public.complete_agent_run(p_run_id uuid,p_result jsonb) returns void language plpgsql security definer set search_path='' as $$begin update public.agent_runs set status=case when requires_approval then 'awaiting_approval' else 'completed' end,result=p_result,updated_at=now() where id=p_run_id and status='running'; if not found then raise exception 'Run is not claimed'; end if; end$$;
create or replace function public.complete_planning_request(p_request_id uuid,p_proposal jsonb,p_model text) returns void language plpgsql security definer set search_path='' as $$begin if jsonb_typeof(p_proposal->'lists')<>'array' then raise exception 'Invalid proposal'; end if; update public.planning_requests set status='ready',proposal=p_proposal,model=left(p_model,120) where id=p_request_id and status='processing'; if not found then raise exception 'Request is not claimed'; end if; end$$;
create or replace function public.fail_productivity_work(p_kind text,p_id uuid,p_error text) returns void language plpgsql security definer set search_path='' as $$begin if p_kind='agent' then update public.agent_runs set status='failed',error=left(p_error,2000),updated_at=now() where id=p_id and status='running'; elsif p_kind='planning' then update public.planning_requests set status='failed',result_metadata=jsonb_build_object('error',left(p_error,2000)) where id=p_id; else raise exception 'Invalid work kind'; end if; end$$;
create or replace function public.enqueue_due_reminders(p_now timestamptz default now()) returns integer language plpgsql security definer set search_path='' as $$declare count integer; begin insert into public.email_reminder_queue(reminder_id,recipient_user_id) select r.id,r.user_id from public.reminders r join public.notification_preferences p on p.user_id=r.user_id and p.email where r.delivered_at is null and r.remind_at<=p_now on conflict(reminder_id) do nothing; get diagnostics count=row_count; return count; end$$;
create or replace function public.generate_recurring_cards(p_now timestamptz default now()) returns integer language plpgsql security definer set search_path='' as $$declare rule record; source public.cards; count integer:=0; next_date date; begin for rule in select * from public.recurring_rules where active and next_at<=p_now for update skip locked loop select * into source from public.cards where id=rule.card_id; insert into public.cards(board_id,list_id,title,description,priority,position,due_at,source,parent_id,task_type,acceptance_criteria,effort) values(source.board_id,source.list_id,source.title,source.description,source.priority,(select coalesce(max(position),0)+1 from public.cards where list_id=source.list_id),rule.next_at,'recurring',source.parent_id,source.task_type,source.acceptance_criteria,source.effort); next_date:=case rule.cadence when 'daily' then rule.next_at::date+1 when 'weekly' then rule.next_at::date+7 else (date_trunc('month',rule.next_at)+interval '2 month - 1 day')::date end; update public.recurring_rules set next_at=next_date where id=rule.id; count:=count+1; end loop; return count; end$$;

revoke all on function public.capture_card_activity() from public;
revoke all on function public.enforce_ai_list_entry() from public;
revoke all on function public.cancel_agent_when_leaving_ai() from public;
revoke all on function public.capture_related_activity() from public;
revoke all on function public.fan_out_activity_notification() from public;
revoke all on function public.queue_card_for_ai(uuid,text) from public;
revoke all on function public.create_planning_request(uuid,text,text,text) from public;
revoke all on function public.set_card_dependencies(uuid,uuid[]) from public;
revoke all on function public.set_notification_read(uuid,boolean) from public;
revoke all on function public.mark_all_notifications_read() from public;
revoke all on function public.resolve_planning_request(uuid,boolean,jsonb) from public;
revoke all on function public.control_agent_run(uuid,text) from public;
revoke all on function public.approve_and_materialize_plan(uuid,jsonb) from public;
revoke all on function public.convert_checklist_to_subtasks(uuid) from public;
grant execute on function public.queue_card_for_ai(uuid,text) to authenticated;
grant execute on function public.create_planning_request(uuid,text,text,text) to authenticated;
grant execute on function public.set_card_dependencies(uuid,uuid[]) to authenticated;
grant execute on function public.set_notification_read(uuid,boolean) to authenticated;
grant execute on function public.mark_all_notifications_read() to authenticated;
grant execute on function public.resolve_planning_request(uuid,boolean,jsonb) to authenticated;
grant execute on function public.control_agent_run(uuid,text) to authenticated;
grant execute on function public.approve_and_materialize_plan(uuid,jsonb) to authenticated;
grant execute on function public.convert_checklist_to_subtasks(uuid) to authenticated;
revoke all on function public.upsert_card_reminder(uuid,timestamptz) from public;
revoke all on function public.upsert_recurring_rule(uuid,text,timestamptz) from public;
grant execute on function public.upsert_card_reminder(uuid,timestamptz) to authenticated;
grant execute on function public.upsert_recurring_rule(uuid,text,timestamptz) to authenticated;
revoke all on function public.claim_productivity_work(text) from public;
revoke all on function public.complete_agent_run(uuid,jsonb) from public;
revoke all on function public.complete_planning_request(uuid,jsonb,text) from public;
revoke all on function public.fail_productivity_work(text,uuid,text) from public;
revoke all on function public.enqueue_due_reminders(timestamptz) from public;
revoke all on function public.generate_recurring_cards(timestamptz) from public;
grant execute on function public.claim_productivity_work(text) to service_role;
grant execute on function public.complete_agent_run(uuid,jsonb) to service_role;
grant execute on function public.complete_planning_request(uuid,jsonb,text) to service_role;
grant execute on function public.fail_productivity_work(text,uuid,text) to service_role;
grant execute on function public.enqueue_due_reminders(timestamptz) to service_role;
grant execute on function public.generate_recurring_cards(timestamptz) to service_role;
revoke insert on public.planning_requests from authenticated;
revoke insert on public.agent_runs from authenticated;
do $$begin alter publication supabase_realtime add table public.activity_events; exception when duplicate_object then null; end$$;
do $$begin alter publication supabase_realtime add table public.agent_runs; exception when duplicate_object then null; end$$;
commit;
