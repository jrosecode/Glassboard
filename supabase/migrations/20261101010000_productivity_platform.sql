begin;

create type public.list_kind as enum ('normal','ai');
create type public.task_type as enum ('task','project','subtask','milestone');
create type public.agent_status as enum ('queued','running','awaiting_approval','blocked','completed','failed','cancelled');
create type public.planning_status as enum ('queued','ready','approved','rejected','failed','materialized');

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
create policy planning_requests_member_read on public.planning_requests for select to authenticated using(public.can_access_board(board_id));
create policy planning_requests_member_insert on public.planning_requests for insert to authenticated with check(requested_by=auth.uid() and public.can_access_board(board_id));
create policy agent_runs_member_read on public.agent_runs for select to authenticated using(public.can_access_board(board_id));
create policy agent_runs_member_insert on public.agent_runs for insert to authenticated with check(requested_by=auth.uid() and public.can_access_board(board_id));
create policy reminders_self_all on public.reminders for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
create policy agent_events_member_read on public.agent_events for select to authenticated using(exists(select 1 from public.agent_runs r where r.id=run_id and public.can_access_board(r.board_id)));
create policy dependencies_member_all on public.card_dependencies for all to authenticated using(exists(select 1 from public.cards c where c.id=card_id and public.can_access_board(c.board_id))) with check(exists(select 1 from public.cards c where c.id=card_id and public.can_access_board(c.board_id)));

create or replace function public.queue_card_for_ai(p_card_id uuid,p_idempotency_key text) returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare target public.cards; ai_list uuid; run_id uuid;
begin
  if length(p_idempotency_key) not between 1 and 120 then raise exception 'Invalid idempotency key'; end if;
  select * into target from public.cards where id=p_card_id for update;
  if target.id is null or not public.can_access_board(target.board_id) then raise exception 'Card access denied' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(target.board_id::text,0));
  select id into ai_list from public.lists where board_id=target.board_id and kind='ai';
  if ai_list is null then
    insert into public.lists(board_id,title,position,kind)
    values(target.board_id,'AI Assistant',(select coalesce(max(position),0)+1 from public.lists where board_id=target.board_id),'ai')
    returning id into ai_list;
  end if;
  update public.cards set list_id=ai_list where id=p_card_id;
  insert into public.agent_runs(board_id,card_id,requested_by,idempotency_key)
  values(target.board_id,p_card_id,auth.uid(),p_idempotency_key)
  on conflict(requested_by,idempotency_key) do update set updated_at=public.agent_runs.updated_at
  returning id into run_id;
  return jsonb_build_object('listId',ai_list,'runId',run_id,'status','queued');
end$$;

create or replace function public.set_notification_read(p_notification_id uuid,p_read boolean) returns void
language sql security definer set search_path = ''
as $$ update public.notifications set read_at=case when p_read then now() else null end where id=p_notification_id and user_id=auth.uid() $$;
create or replace function public.mark_all_notifications_read() returns void
language sql security definer set search_path = ''
as $$ update public.notifications set read_at=now() where user_id=auth.uid() and read_at is null $$;

create or replace function public.resolve_planning_request(p_request_id uuid,p_approve boolean) returns public.planning_status
language plpgsql security definer set search_path = ''
as $$declare request public.planning_requests; next_status public.planning_status; begin
  select * into request from public.planning_requests where id=p_request_id for update;
  if request.id is null or (request.requested_by<>auth.uid() and not public.can_manage_board(request.board_id)) then raise exception 'Planning request access denied' using errcode='42501'; end if;
  if request.status<>'ready' then raise exception 'Planning request is not ready'; end if;
  next_status:=case when p_approve then 'approved'::public.planning_status else 'rejected'::public.planning_status end;
  update public.planning_requests set status=next_status,approved_at=case when p_approve then now() else null end where id=p_request_id;
  return next_status;
end$$;

create or replace function public.control_agent_run(p_run_id uuid,p_action text) returns public.agent_status
language plpgsql security definer set search_path = ''
as $$declare run public.agent_runs; next_status public.agent_status; begin
  if p_action not in ('approve','reject','cancel','retry') then raise exception 'Invalid agent action'; end if;
  select * into run from public.agent_runs where id=p_run_id for update;
  if run.id is null or (run.requested_by<>auth.uid() and not public.can_manage_board(run.board_id)) then raise exception 'Agent run access denied' using errcode='42501'; end if;
  if p_action='approve' and run.status='awaiting_approval' then next_status:='completed';
  elsif p_action='reject' and run.status='awaiting_approval' then next_status:='cancelled';
  elsif p_action='cancel' and run.status in ('queued','running','blocked','awaiting_approval') then next_status:='cancelled';
  elsif p_action='retry' and run.status='failed' then next_status:='queued';
  else raise exception 'Invalid agent state transition'; end if;
  update public.agent_runs set status=next_status,updated_at=now() where id=p_run_id;
  insert into public.agent_events(run_id,status,detail) values(p_run_id,next_status,jsonb_build_object('action',p_action,'actorId',auth.uid()));
  return next_status;
end$$;

revoke all on function public.capture_card_activity() from public;
revoke all on function public.capture_related_activity() from public;
revoke all on function public.fan_out_activity_notification() from public;
revoke all on function public.queue_card_for_ai(uuid,text) from public;
revoke all on function public.set_notification_read(uuid,boolean) from public;
revoke all on function public.mark_all_notifications_read() from public;
revoke all on function public.resolve_planning_request(uuid,boolean) from public;
revoke all on function public.control_agent_run(uuid,text) from public;
grant execute on function public.queue_card_for_ai(uuid,text) to authenticated;
grant execute on function public.set_notification_read(uuid,boolean) to authenticated;
grant execute on function public.mark_all_notifications_read() to authenticated;
grant execute on function public.resolve_planning_request(uuid,boolean) to authenticated;
grant execute on function public.control_agent_run(uuid,text) to authenticated;
alter publication supabase_realtime add table public.activity_events;
alter publication supabase_realtime add table public.notifications;
alter publication supabase_realtime add table public.agent_runs;
commit;
