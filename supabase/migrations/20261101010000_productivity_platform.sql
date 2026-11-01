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
  attempts smallint not null default 0, available_at timestamptz not null default now(), lease_expires_at timestamptz, worker_id text,
  idempotency_key text not null check(length(idempotency_key)<=120), approved_at timestamptz, created_at timestamptz not null default now(),
  unique(requested_by,idempotency_key)
);
create table public.agent_runs (
  id uuid primary key default gen_random_uuid(), board_id uuid not null references public.boards(id) on delete cascade,
  card_id uuid not null references public.cards(id) on delete cascade, requested_by uuid not null references public.profiles(id),
  status public.agent_status not null default 'queued', requires_approval boolean not null default true,
  connector text not null default 'hermes', input jsonb not null default '{}'::jsonb, result jsonb, error text,
  idempotency_key text not null, attempts smallint not null default 0, available_at timestamptz not null default now(), lease_expires_at timestamptz, worker_id text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(requested_by,idempotency_key)
);
create unique index agent_runs_one_active_per_card on public.agent_runs(card_id) where status in ('queued','running','awaiting_approval','blocked');
create table public.agent_events (
  id uuid primary key default gen_random_uuid(), run_id uuid not null references public.agent_runs(id) on delete cascade,
  status public.agent_status not null, detail jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
create table public.reminders (
  id uuid primary key default gen_random_uuid(), card_id uuid not null references public.cards(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade, remind_at timestamptz not null, delivered_at timestamptz, in_app_delivered_at timestamptz,
  created_at timestamptz not null default now(), unique(card_id,user_id)
);
create table public.recurring_rules (
  id uuid primary key default gen_random_uuid(), card_id uuid not null unique references public.cards(id) on delete cascade,
  cadence text not null check(cadence in ('daily','weekly','monthly')), next_at timestamptz not null, monthly_anchor_day smallint check(monthly_anchor_day between 1 and 31), active boolean not null default true,
  check(cadence<>'monthly' or monthly_anchor_day is not null)
);
create table public.email_reminder_queue (
  id uuid primary key default gen_random_uuid(), reminder_id uuid not null unique references public.reminders(id) on delete cascade,
  recipient_user_id uuid not null references public.profiles(id), status text not null default 'pending' check(status in ('pending','processing','sent','failed','cancelled')),
  attempts smallint not null default 0 check(attempts between 0 and 10), available_at timestamptz not null default now(), lease_expires_at timestamptz, worker_id text, delivered_at timestamptz, last_error text
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
  if target_board is null then return old; end if;
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
drop trigger if exists card_activity on public.cards;
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
alter table public.planning_materialized_items enable row level security;
revoke all on public.planning_materialized_items from authenticated;

create policy activity_events_member_read on public.activity_events for select to authenticated using(public.can_access_board(board_id));
drop policy if exists card_members_member on public.card_members;
create policy card_members_member_read on public.card_members for select to authenticated using(public.can_access_board(public.card_board(card_id)));
revoke insert,update,delete on public.card_members from authenticated;
drop policy if exists notifications_self on public.notifications;
drop policy if exists notifications_self_all on public.notifications;
create policy notifications_self_read on public.notifications for select to authenticated using(user_id=auth.uid());
revoke insert,update,delete on public.notifications from authenticated;
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
create policy agent_events_requester_or_manager_read on public.agent_events for select to authenticated using(exists(select 1 from public.agent_runs r where r.id=run_id and public.can_access_board(r.board_id) and (r.requested_by=auth.uid() or public.can_manage_board(r.board_id))));
create policy lists_ai_delete_guard on public.lists as restrictive for delete to authenticated using(kind<>'ai');
drop policy if exists deps_member on public.card_dependencies;
create policy dependencies_member_all on public.card_dependencies for all to authenticated
using(exists(select 1 from public.cards c join public.cards d on d.id=depends_on_card_id where c.id=card_id and c.board_id=d.board_id and public.can_access_board(c.board_id)))
with check(exists(select 1 from public.cards c join public.cards d on d.id=depends_on_card_id where c.id=card_id and c.board_id=d.board_id and public.can_access_board(c.board_id)));

create or replace function public.validate_recurring_rule_card() returns trigger language plpgsql security definer set search_path='' as $$begin
  perform pg_advisory_xact_lock(hashtextextended(public.card_board(new.card_id)::text,0));
  if new.active and exists(select 1 from public.cards c join public.lists l on l.id=c.list_id where c.id=new.card_id and l.kind='ai') then raise exception 'AI list cards cannot recur'; end if;
  return new;
end$$;
create trigger recurring_rules_card_guard before insert or update on public.recurring_rules for each row execute function public.validate_recurring_rule_card();

create or replace function public.validate_card_dependency() returns trigger language plpgsql security definer set search_path='' as $$
declare source_board uuid; dependency_board uuid;
begin
  select board_id into source_board from public.cards where id=new.card_id for update;
  if source_board is null then raise exception 'Dependencies must reference existing cards'; end if;
  perform pg_advisory_xact_lock(hashtextextended(source_board::text,42));
  select board_id into source_board from public.cards where id=new.card_id;
  select board_id into dependency_board from public.cards where id=new.depends_on_card_id;
  if source_board is null or dependency_board is null or source_board<>dependency_board then raise exception 'Dependencies must be cards on the same board'; end if;
  if exists(with recursive chain(id) as (select new.depends_on_card_id union select d.depends_on_card_id from public.card_dependencies d join chain on d.card_id=chain.id) select 1 from chain where id=new.card_id) then raise exception 'Dependency cycle'; end if;
  return new;
end$$;
create trigger card_dependencies_guard before insert or update on public.card_dependencies for each row execute function public.validate_card_dependency();

create or replace function public.validate_card_hierarchy() returns trigger language plpgsql security definer set search_path='' as $$
declare parent_board uuid;
begin
  if new.parent_id is null then return new; end if;
  if new.parent_id=new.id then raise exception 'Hierarchy cycle'; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.board_id::text,42));
  select board_id into parent_board from public.cards where id=new.parent_id;
  if parent_board is null or parent_board<>new.board_id then raise exception 'Parent must be on the same board'; end if;
  if exists(with recursive ancestors(id) as (select new.parent_id union select c.parent_id from public.cards c join ancestors a on c.id=a.id where c.parent_id is not null) select 1 from ancestors where id=new.id) then raise exception 'Hierarchy cycle'; end if;
  return new;
end$$;
create trigger cards_hierarchy_guard before insert or update of parent_id,board_id on public.cards for each row execute function public.validate_card_hierarchy();

create or replace function public.validate_card_checklist() returns trigger language plpgsql set search_path='' as $$
declare item jsonb;
begin
  if jsonb_typeof(new.checklist) is distinct from 'array' or octet_length(new.checklist::text)>65536 then raise exception 'Card checklist must be an array no larger than 64 KiB'; end if;
  if jsonb_array_length(new.checklist)>100 then raise exception 'Card checklist exceeds 100 items'; end if;
  for item in select value from jsonb_array_elements(new.checklist) loop
    if jsonb_typeof(item) is distinct from 'object' or length(trim(coalesce(item->>'text',''))) not between 1 and 240 or (item ? 'done' and jsonb_typeof(item->'done') is distinct from 'boolean') then raise exception 'Checklist item text or completion state is invalid'; end if;
  end loop;
  return new;
end$$;
create trigger cards_checklist_guard before insert or update of checklist on public.cards for each row execute function public.validate_card_checklist();

create or replace function public.validate_card_board_change() returns trigger language plpgsql security definer set search_path='' as $$
declare lock_board uuid;
begin
  if new.board_id is not distinct from old.board_id and new.list_id is not distinct from old.list_id then return new; end if;
  if new.board_id is distinct from old.board_id then
    for lock_board in select distinct value from unnest(array[old.board_id,new.board_id]) value order by value loop
      perform pg_advisory_xact_lock(hashtextextended(lock_board::text,42));
    end loop;
  else
    perform pg_advisory_xact_lock(hashtextextended(new.board_id::text,42));
  end if;
  if not exists(select 1 from public.lists l where l.id=new.list_id and l.board_id=new.board_id) then raise exception 'Card list must be on the same board'; end if;
  if new.board_id is distinct from old.board_id and exists(select 1 from public.card_dependencies d join public.cards other on other.id=case when d.card_id=new.id then d.depends_on_card_id else d.card_id end where (d.card_id=new.id or d.depends_on_card_id=new.id) and other.board_id<>new.board_id) then raise exception 'Card board change would strand dependencies'; end if;
  if new.board_id is distinct from old.board_id and exists(select 1 from public.cards child where child.parent_id=new.id and child.board_id<>new.board_id) then raise exception 'Card board change would strand children'; end if;
  if exists(select 1 from public.agent_runs run where run.card_id=new.id and run.board_id<>new.board_id) then raise exception 'Card board change would desynchronize agent runs'; end if;
  return new;
end$$;
create trigger cards_board_guard before update of board_id,list_id on public.cards for each row execute function public.validate_card_board_change();

create or replace function public.validate_list_board_change() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.kind='ai' and new.board_id is distinct from old.board_id then raise exception 'AI list cannot move between boards'; end if;
  if new.board_id is distinct from old.board_id and exists(select 1 from public.cards c where c.list_id=new.id) then raise exception 'list board change would strand cards'; end if;
  return new;
end$$;
create trigger lists_board_guard before update of board_id on public.lists for each row execute function public.validate_list_board_change();

create or replace function public.validate_agent_run_board() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from public.cards c join public.lists l on l.id=c.list_id where c.id=new.card_id and c.board_id=new.board_id and l.board_id=new.board_id and l.kind='ai') then raise exception 'Agent run card must be in the AI list on the same board'; end if;
  return new;
end$$;
create trigger agent_runs_board_guard before insert or update of board_id,card_id on public.agent_runs for each row execute function public.validate_agent_run_board();

create or replace function public.enforce_ai_list_kind() returns trigger language plpgsql security definer set search_path='' as $$begin
  if (tg_op='INSERT' and new.kind='ai') or (tg_op='UPDATE' and old.kind is distinct from new.kind) then
    if coalesce(current_setting('app.queue_card_for_ai',true),'')<>'on' then raise exception 'AI list kind is managed by queue_card_for_ai'; end if;
  end if;
  return new;
end$$;
create trigger lists_ai_kind_guard before insert or update of kind on public.lists for each row execute function public.enforce_ai_list_kind();

create or replace function public.enforce_ai_list_entry() returns trigger language plpgsql security definer set search_path='' as $$begin
  if not exists(select 1 from public.lists where id=new.list_id and board_id=new.board_id) then raise exception 'Card list must be on the same board'; end if;
  if exists(select 1 from public.lists where id=new.list_id and kind='ai') and coalesce(current_setting('app.queue_card_for_ai',true),'')<>'on' then raise exception 'Cards must enter the AI list through queue_card_for_ai'; end if;
  return new;
end$$;
create trigger cards_ai_entry_guard before insert or update of list_id on public.cards for each row execute function public.enforce_ai_list_entry();
create or replace function public.cancel_agent_when_leaving_ai() returns trigger language plpgsql security definer set search_path='' as $$begin
  if exists(select 1 from public.lists where id=old.list_id and kind='ai') and not exists(select 1 from public.lists where id=new.list_id and kind='ai') then with cancelled as (update public.agent_runs set status='cancelled',updated_at=now(),lease_expires_at=null,worker_id=null where card_id=new.id and status in ('queued','running','blocked','awaiting_approval') returning id) insert into public.agent_events(run_id,status,detail) select id,'cancelled',jsonb_build_object('transition','left_ai_list') from cancelled; end if; return new;
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
as $$declare target_board uuid; begin
  if cardinality(p_dependency_ids)>100 then raise exception 'Too many card dependencies (maximum 100)'; end if;
  select board_id into target_board from public.cards where id=p_card_id for update;
  if target_board is null then raise exception 'Card access denied' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(target_board::text,42));
  select board_id into target_board from public.cards where id=p_card_id;
  if target_board is null or not public.can_access_board(target_board) then raise exception 'Card access denied' using errcode='42501'; end if;
  if p_card_id=any(coalesce(p_dependency_ids,'{}'::uuid[])) then raise exception 'A card cannot depend on itself'; end if;
  if exists(select 1 from unnest(coalesce(p_dependency_ids,'{}'::uuid[])) id left join public.cards c on c.id=id where c.id is null or c.board_id<>target_board) then raise exception 'Dependencies must be cards on the same board'; end if;
  delete from public.card_dependencies where card_id=p_card_id;
  insert into public.card_dependencies(card_id,depends_on_card_id) select p_card_id,id from unnest(coalesce(p_dependency_ids,'{}'::uuid[])) id on conflict do nothing;
end$$;

create or replace function public.set_card_assignees(p_card_id uuid,p_user_ids uuid[]) returns void
language plpgsql security definer set search_path=''
as $$declare target_board uuid; target_workspace uuid; begin
  if cardinality(p_user_ids)>100 then raise exception 'Too many card assignees (maximum 100)'; end if;
  select c.board_id,b.workspace_id into target_board,target_workspace from public.cards c join public.boards b on b.id=c.board_id where c.id=p_card_id for update of c;
  if target_board is null then raise exception 'Card access denied' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(target_board::text,42));
  select c.board_id,b.workspace_id into target_board,target_workspace from public.cards c join public.boards b on b.id=c.board_id where c.id=p_card_id;
  if target_board is null or not public.can_access_board(target_board) then raise exception 'Card access denied' using errcode='42501'; end if;
  if exists(select 1 from unnest(coalesce(p_user_ids,'{}'::uuid[])) requested_user where not exists(select 1 from public.workspace_members wm where wm.workspace_id=target_workspace and wm.user_id=requested_user) and not exists(select 1 from public.board_members bm where bm.board_id=target_board and bm.user_id=requested_user)) then raise exception 'Assignees must be workspace or board members'; end if;
  delete from public.card_members where card_id=p_card_id;
  insert into public.card_members(card_id,user_id) select p_card_id,requested_user from unnest(coalesce(p_user_ids,'{}'::uuid[])) requested_user on conflict do nothing;
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
  if existing.id is null then select * into existing from public.agent_runs where card_id=p_card_id and status in ('queued','running','awaiting_approval','blocked') for update; end if;
  if existing.id is not null then
    select id into ai_list from public.lists where id=(select list_id from public.cards where id=p_card_id) and kind='ai';
    if ai_list is null then return jsonb_build_object('listId',null,'runId',existing.id,'status',existing.status); end if;
    return jsonb_build_object('listId',ai_list,'runId',existing.id,'status',existing.status);
  end if;
  perform pg_advisory_xact_lock(hashtextextended(target.board_id::text,0));
  if exists(select 1 from public.recurring_rules where card_id=p_card_id and active) then raise exception 'Recurring cards cannot enter the AI list'; end if;
  perform set_config('app.queue_card_for_ai','on',true);
  select id into ai_list from public.lists where board_id=target.board_id and kind='ai';
  if ai_list is null then
    insert into public.lists(board_id,title,position,kind)
    values(target.board_id,'AI Assistant',(select coalesce(max(position),0)+1 from public.lists where board_id=target.board_id),'ai')
    returning id into ai_list;
  end if;
  update public.cards set list_id=ai_list where id=p_card_id;
  insert into public.agent_runs(board_id,card_id,requested_by,idempotency_key,input)
  values(target.board_id,p_card_id,auth.uid(),p_idempotency_key,jsonb_build_object('cardId',target.id,'title',target.title,'description',target.description,'acceptanceCriteria',target.acceptance_criteria))
  returning id,status into run_id,run_status;
  return jsonb_build_object('listId',ai_list,'runId',run_id,'status',run_status);
end$$;

create or replace function public.set_notification_read(p_notification_id uuid,p_read boolean) returns void
language sql security definer set search_path = ''
as $$ update public.notifications set read_at=case when p_read then now() else null end where id=p_notification_id and user_id=auth.uid() $$;
create or replace function public.mark_all_notifications_read() returns void
language sql security definer set search_path = ''
as $$ update public.notifications set read_at=now() where user_id=auth.uid() and read_at is null $$;
create or replace function public.set_notification_preferences(p_in_app boolean,p_email boolean,p_due_reminders boolean,p_agent_updates boolean) returns public.notification_preferences
language plpgsql security definer set search_path=''
as $$declare preferences public.notification_preferences; begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  insert into public.notification_preferences(user_id,in_app,email,due_reminders,agent_updates)
  values(auth.uid(),p_in_app,p_email,p_due_reminders,p_agent_updates)
  on conflict(user_id) do update set in_app=excluded.in_app,email=excluded.email,due_reminders=excluded.due_reminders,agent_updates=excluded.agent_updates,updated_at=now()
  returning * into preferences;
  if not p_email or not p_due_reminders then
    update public.email_reminder_queue set status='cancelled',lease_expires_at=null,worker_id=null
    where recipient_user_id=auth.uid() and status in ('pending','processing');
  end if;
  return preferences;
end$$;

create or replace function public.validate_planning_proposal(p_proposal jsonb) returns void
language plpgsql set search_path=''
as $$declare total_cards integer; begin
  if p_proposal is null or octet_length(p_proposal::text)>1048576 then raise exception 'Planning proposal exceeds 1 MiB'; end if;
  if jsonb_typeof(p_proposal) is distinct from 'object' or jsonb_typeof(p_proposal->'lists') is distinct from 'array' then raise exception 'Planning proposal must contain a lists array'; end if;
  if jsonb_array_length(p_proposal->'lists') not between 1 and 25 then raise exception 'Planning proposal must contain 1 to 25 lists'; end if;
  if length(coalesce(p_proposal->>'title',''))>240 or length(coalesce(p_proposal->>'description',''))>10000 then raise exception 'Planning proposal title or description is too long'; end if;
  if exists(select 1 from jsonb_array_elements(p_proposal->'lists') as proposed_lists(list_value) where jsonb_typeof(list_value) is distinct from 'object' or length(trim(coalesce(list_value->>'title',''))) not between 1 and 120 or jsonb_typeof(list_value->'cards') is distinct from 'array') then raise exception 'Planning list must have a title and cards array'; end if;
  if exists(select 1 from jsonb_array_elements(p_proposal->'lists') as proposed_lists(list_value) where jsonb_array_length(list_value->'cards')>100) then raise exception 'Planning list exceeds 100 cards'; end if;
  select coalesce(sum(jsonb_array_length(list_value->'cards')),0) into total_cards from jsonb_array_elements(p_proposal->'lists') as proposed_lists(list_value);
  if total_cards>500 then raise exception 'Planning proposal exceeds 500 cards'; end if;
  if total_cards=0 then raise exception 'Planning proposal must contain at least one card'; end if;
  if exists(select 1 from jsonb_array_elements(p_proposal->'lists') as proposed_lists(list_value) cross join lateral jsonb_array_elements(list_value->'cards') as proposed_cards(card_value) where jsonb_typeof(card_value) is distinct from 'object' or length(trim(coalesce(card_value->>'title',''))) not between 1 and 240 or length(coalesce(card_value->>'description',''))>10000 or coalesce(card_value->>'priority','medium') not in ('low','medium','high','urgent')) then raise exception 'Planning card title, description, or priority is invalid'; end if;
end$$;

create or replace function public.resolve_planning_request(p_request_id uuid,p_approve boolean,p_proposal jsonb default null) returns public.planning_status
language plpgsql security definer set search_path = ''
as $$declare request public.planning_requests; next_status public.planning_status; approved_proposal jsonb; begin
  select * into request from public.planning_requests where id=p_request_id for update;
  if request.id is null or not public.can_access_board(request.board_id) or (request.requested_by<>auth.uid() and not public.can_manage_board(request.board_id)) then raise exception 'Planning request access denied' using errcode='42501'; end if;
  if request.status<>'ready' then raise exception 'Planning request is not ready'; end if;
  next_status:=case when p_approve then 'approved'::public.planning_status else 'rejected'::public.planning_status end;
  if p_approve then
    approved_proposal:=coalesce(p_proposal,request.proposal);
    perform public.validate_planning_proposal(approved_proposal);
    update public.planning_requests set status='approved',proposal=approved_proposal,approved_at=now() where id=p_request_id;
  else
    update public.planning_requests set status='rejected',approved_at=null where id=p_request_id;
  end if;
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
  update public.agent_runs set status=next_status,attempts=case when p_action='retry' then 0 else attempts end,available_at=case when p_action='retry' then now() else available_at end,lease_expires_at=null,worker_id=null,updated_at=now() where id=p_run_id;
  insert into public.agent_events(run_id,status,detail) values(p_run_id,next_status,jsonb_build_object('action',p_action,'actorId',auth.uid()));
  return next_status;
end$$;

create or replace function public.approve_and_materialize_plan(p_request_id uuid,p_proposal jsonb) returns public.planning_status
language plpgsql security definer set search_path=''
as $$declare request public.planning_requests; list_row record; card_row record; target_list uuid; created_card uuid; item_key text; begin
  select * into request from public.planning_requests where id=p_request_id for update;
  if request.id is null or not public.can_access_board(request.board_id) or (request.requested_by<>auth.uid() and not public.can_manage_board(request.board_id)) then raise exception 'Planning request access denied' using errcode='42501'; end if;
  if request.status='materialized' then return request.status; end if;
  if request.status not in ('ready','approved') then raise exception 'Planning request is not ready for materialization'; end if;
  perform public.validate_planning_proposal(p_proposal);
  for list_row in select value,ordinality from jsonb_array_elements(p_proposal->'lists') with ordinality loop
    insert into public.lists(board_id,title,position,kind) values(request.board_id,trim(list_row.value->>'title'),(select coalesce(max(position),0)+1 from public.lists where board_id=request.board_id),'normal') returning id into target_list;
    for card_row in select value,ordinality from jsonb_array_elements(list_row.value->'cards') with ordinality loop
      item_key:=list_row.ordinality::text||':'||card_row.ordinality::text;
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
  if jsonb_typeof(parent.checklist) is distinct from 'array' or octet_length(parent.checklist::text)>65536 then raise exception 'Card checklist must be an array no larger than 64 KiB'; end if;
  if jsonb_array_length(parent.checklist)>100 then raise exception 'Card checklist exceeds 100 items'; end if;
  if exists(select 1 from jsonb_array_elements(parent.checklist) checklist_items(item) where jsonb_typeof(item) is distinct from 'object' or length(trim(coalesce(item->>'text',''))) not between 1 and 240 or (item ? 'done' and jsonb_typeof(item->'done') is distinct from 'boolean')) then raise exception 'Checklist item text or completion state is invalid'; end if;
  for item in select value from jsonb_array_elements(parent.checklist) loop
    insert into public.cards(board_id,list_id,title,description,priority,position,completed,completed_at,parent_id,task_type,source) values(parent.board_id,parent.list_id,trim(item->>'text'),'',parent.priority,(select coalesce(max(position),0)+1 from public.cards where list_id=parent.list_id),coalesce((item->>'done')::boolean,false),case when coalesce((item->>'done')::boolean,false) then now() else null end,parent.id,'subtask','manual'); created:=created+1;
  end loop;
  update public.cards set checklist='[]'::jsonb where id=p_card_id; return created;
end$$;

create or replace function public.upsert_card_reminder(p_card_id uuid,p_remind_at timestamptz) returns uuid
language plpgsql security definer set search_path=''
as $$declare saved_reminder_id uuid; begin
  if not public.can_access_board(public.card_board(p_card_id)) then raise exception 'Card access denied' using errcode='42501'; end if;
  if p_remind_at is null then delete from public.reminders where card_id=p_card_id and user_id=auth.uid(); return null; end if;
  insert into public.reminders(card_id,user_id,remind_at) values(p_card_id,auth.uid(),p_remind_at) on conflict(card_id,user_id) do update set remind_at=excluded.remind_at,delivered_at=null,in_app_delivered_at=null returning id into saved_reminder_id; delete from public.email_reminder_queue q where q.reminder_id=saved_reminder_id; return saved_reminder_id;
end$$;
create or replace function public.upsert_recurring_rule(p_card_id uuid,p_cadence text,p_next_at timestamptz) returns uuid
language plpgsql security definer set search_path=''
as $$declare rule_id uuid; begin
  if not public.can_access_board(public.card_board(p_card_id)) then raise exception 'Card access denied' using errcode='42501'; end if;
  if p_cadence is null then delete from public.recurring_rules where card_id=p_card_id; return null; end if;
  if p_cadence not in ('daily','weekly','monthly') or p_next_at is null then raise exception 'Invalid recurring rule'; end if;
  insert into public.recurring_rules(card_id,cadence,next_at,monthly_anchor_day) values(p_card_id,p_cadence,p_next_at,extract(day from p_next_at)::int) on conflict(card_id) do update set cadence=excluded.cadence,next_at=excluded.next_at,monthly_anchor_day=excluded.monthly_anchor_day,active=true returning id into rule_id; return rule_id;
end$$;
create or replace function public.claim_productivity_work(p_worker_id text) returns jsonb
language plpgsql security definer set search_path=''
as $$declare run public.agent_runs; request public.planning_requests; begin
  with expired as (update public.agent_runs set status=case when attempts>=5 then 'failed'::public.agent_status else 'queued'::public.agent_status end,lease_expires_at=null,worker_id=null,error=case when attempts>=5 then coalesce(error,'Worker lease expired') else error end,updated_at=now() where status='running' and lease_expires_at<now() returning id,status) insert into public.agent_events(run_id,status,detail) select id,status,jsonb_build_object('transition','lease_expired') from expired where status='failed';
  select * into run from public.agent_runs where status='queued' and attempts<5 and available_at<=now() order by available_at,created_at for update skip locked limit 1;
  if run.id is not null then update public.agent_runs set status='running',attempts=attempts+1,lease_expires_at=now()+interval '5 minutes',worker_id=p_worker_id,updated_at=now() where id=run.id; insert into public.agent_events(run_id,status,detail) values(run.id,'running',jsonb_build_object('worker',p_worker_id)); return jsonb_build_object('kind','agent','id',run.id,'input',run.input); end if;
  update public.planning_requests set status=case when attempts>=5 then 'failed'::public.planning_status else 'queued'::public.planning_status end,lease_expires_at=null,worker_id=null,result_metadata=case when attempts>=5 then result_metadata||jsonb_build_object('error','Worker lease expired') else result_metadata end where status='processing' and lease_expires_at<now();
  select * into request from public.planning_requests where status='queued' and attempts<5 and available_at<=now() order by available_at,created_at for update skip locked limit 1;
  if request.id is not null then update public.planning_requests set status='processing',attempts=attempts+1,lease_expires_at=now()+interval '5 minutes',worker_id=p_worker_id where id=request.id; return jsonb_build_object('kind','planning','id',request.id,'prompt',request.prompt); end if;
  return null;
end$$;
create or replace function public.renew_productivity_lease(p_kind text,p_id uuid,p_worker_id text) returns void language plpgsql security definer set search_path='' as $$begin if p_kind='agent' then update public.agent_runs set lease_expires_at=now()+interval '5 minutes' where id=p_id and status='running' and worker_id=p_worker_id and lease_expires_at>now(); elsif p_kind='planning' then update public.planning_requests set lease_expires_at=now()+interval '5 minutes' where id=p_id and status='processing' and worker_id=p_worker_id and lease_expires_at>now(); else raise exception 'Invalid work kind'; end if; if not found then raise exception 'Work lease is not owned by this worker or has expired'; end if; end$$;
create or replace function public.complete_agent_run(p_run_id uuid,p_result jsonb,p_worker_id text) returns void language plpgsql security definer set search_path='' as $$declare run public.agent_runs; begin update public.agent_runs set status=case when requires_approval then 'awaiting_approval' else 'completed' end,result=p_result,error=null,lease_expires_at=null,worker_id=null,updated_at=now() where id=p_run_id and status='running' and worker_id=p_worker_id and lease_expires_at>now() returning * into run; if run.id is null then raise exception 'Run lease is not owned by this worker or has expired'; end if; insert into public.agent_events(run_id,status,detail) values(run.id,run.status,jsonb_build_object('worker',p_worker_id,'transition','complete')); insert into public.notifications(user_id,board_id,card_id,kind,title,deep_link) select run.requested_by,run.board_id,run.card_id,'agent.ready','Agent result ready','/?card='||run.card_id::text where coalesce((select p.in_app and p.agent_updates from public.notification_preferences p where p.user_id=run.requested_by),true); end$$;
create or replace function public.complete_planning_request(p_request_id uuid,p_proposal jsonb,p_model text,p_worker_id text) returns void
language plpgsql security definer set search_path=''
as $$declare request public.planning_requests; begin
  perform public.validate_planning_proposal(p_proposal);
  update public.planning_requests set status='ready',proposal=p_proposal,model=left(p_model,120),lease_expires_at=null,worker_id=null where id=p_request_id and status='processing' and worker_id=p_worker_id and lease_expires_at>now() returning * into request;
  if request.id is null then raise exception 'Request lease is not owned by this worker or has expired'; end if;
  insert into public.notifications(user_id,board_id,kind,title,deep_link) select request.requested_by,request.board_id,'planning.ready','Planning proposal ready','/?planning='||request.id::text where coalesce((select p.in_app from public.notification_preferences p where p.user_id=request.requested_by),true);
end$$;
create or replace function public.fail_productivity_work(p_kind text,p_id uuid,p_error text,p_worker_id text) returns void language plpgsql security definer set search_path=''
as $$declare next_status public.agent_status; begin
  if p_kind='agent' then
    update public.agent_runs set status=case when attempts<5 then 'queued'::public.agent_status else 'failed'::public.agent_status end,error=left(p_error,2000),available_at=now()+(power(2,least(attempts,8))::text||' minutes')::interval,lease_expires_at=null,worker_id=null,updated_at=now()
    where id=p_id and status='running' and worker_id=p_worker_id and lease_expires_at>now()
    returning status into next_status;
    if found then insert into public.agent_events(run_id,status,detail) values(p_id,next_status,jsonb_build_object('worker',p_worker_id,'transition','fail','error',left(p_error,2000))); end if;
  elsif p_kind='planning' then
    update public.planning_requests set status=case when attempts<5 then 'queued'::public.planning_status else 'failed'::public.planning_status end,result_metadata=result_metadata||jsonb_build_object('error',left(p_error,2000)),available_at=now()+(power(2,least(attempts,8))::text||' minutes')::interval,lease_expires_at=null,worker_id=null
    where id=p_id and status='processing' and worker_id=p_worker_id and lease_expires_at>now();
  else raise exception 'Invalid work kind'; end if;
  if not found then raise exception 'Work lease is not owned by this worker or has expired'; end if;
end$$;
create or replace function public.enqueue_due_reminders(p_now timestamptz default now()) returns integer language plpgsql security definer set search_path='' as $$declare count integer; begin with due as (select r.id from public.reminders r left join public.notification_preferences p on p.user_id=r.user_id where r.in_app_delivered_at is null and r.remind_at<=p_now and coalesce(p.in_app,true) and coalesce(p.due_reminders,true) for update of r skip locked), claimed as (update public.reminders r set in_app_delivered_at=p_now from due where r.id=due.id returning r.*) insert into public.notifications(user_id,board_id,card_id,kind,title,deep_link) select r.user_id,c.board_id,c.id,'reminder.due',c.title||' is due','/?card='||c.id::text from claimed r join public.cards c on c.id=r.card_id; insert into public.email_reminder_queue(reminder_id,recipient_user_id) select r.id,r.user_id from public.reminders r join public.notification_preferences p on p.user_id=r.user_id and p.email and p.due_reminders where r.delivered_at is null and r.remind_at<=p_now on conflict(reminder_id) do nothing; get diagnostics count=row_count; return count; end$$;
create or replace function public.claim_email_reminder(p_worker_id text) returns jsonb language plpgsql security definer set search_path='' as $$declare job public.email_reminder_queue; begin update public.email_reminder_queue set status=case when attempts>=10 then 'failed' else 'pending' end,lease_expires_at=null,worker_id=null where status='processing' and lease_expires_at<now(); select q.* into job from public.email_reminder_queue q join public.reminders r on r.id=q.reminder_id join public.notification_preferences p on p.user_id=q.recipient_user_id where q.status='pending' and q.available_at<=now() and q.attempts<10 and r.remind_at<=now() and p.email and p.due_reminders order by q.available_at for update of q skip locked limit 1; if job.id is null then return null; end if; update public.email_reminder_queue set status='processing',attempts=attempts+1,lease_expires_at=now()+interval '5 minutes',worker_id=p_worker_id where id=job.id returning * into job; return jsonb_build_object('id',job.id); end$$;
create or replace function public.authorize_email_reminder_delivery(p_queue_id uuid,p_worker_id text) returns jsonb language plpgsql security definer set search_path='' as $$declare job public.email_reminder_queue; preferences public.notification_preferences; payload jsonb; begin select * into job from public.email_reminder_queue where id=p_queue_id; if job.id is null then raise exception 'Email reminder does not exist'; end if; select * into preferences from public.notification_preferences p where p.user_id=job.recipient_user_id for update; select * into job from public.email_reminder_queue where id=p_queue_id for update; if job.status='cancelled' then return null; end if; if job.status<>'processing' or job.worker_id<>p_worker_id or job.lease_expires_at<=now() then raise exception 'Email reminder lease is not owned by this worker or has expired'; end if; if preferences.user_id is null or not preferences.email or not preferences.due_reminders then update public.email_reminder_queue set status='cancelled',lease_expires_at=null,worker_id=null where id=job.id; return null; end if; select jsonb_build_object('recipientEmail',u.email,'cardId',c.id,'cardTitle',c.title,'remindAt',r.remind_at) into payload from public.reminders r join public.cards c on c.id=r.card_id join auth.users u on u.id=job.recipient_user_id where r.id=job.reminder_id; return payload; end$$;
create or replace function public.renew_email_reminder_lease(p_queue_id uuid,p_worker_id text) returns void language plpgsql security definer set search_path='' as $$begin update public.email_reminder_queue set lease_expires_at=now()+interval '5 minutes' where id=p_queue_id and status='processing' and worker_id=p_worker_id and lease_expires_at>now(); if not found then raise exception 'email reminder lease is not owned by this worker or has expired'; end if; end$$;
create or replace function public.complete_email_reminder(p_queue_id uuid,p_worker_id text) returns void language plpgsql security definer set search_path='' as $$declare rid uuid; begin update public.email_reminder_queue set status='sent',delivered_at=now(),lease_expires_at=null,worker_id=null,last_error=null where id=p_queue_id and status='processing' and worker_id=p_worker_id and lease_expires_at>now() returning reminder_id into rid; if rid is null then raise exception 'Email reminder lease is not owned by this worker or has expired'; end if; update public.reminders set delivered_at=now() where id=rid; end$$;
create or replace function public.fail_email_reminder(p_queue_id uuid,p_error text,p_worker_id text) returns void language plpgsql security definer set search_path='' as $$begin update public.email_reminder_queue set status=case when attempts>=10 then 'failed' else 'pending' end,available_at=now()+(power(2,least(attempts,8))::text||' minutes')::interval,lease_expires_at=null,worker_id=null,last_error=left(p_error,2000) where id=p_queue_id and status='processing' and worker_id=p_worker_id and lease_expires_at>now(); if not found then raise exception 'Email reminder lease is not owned by this worker or has expired'; end if; end$$;
create or replace function public.generate_recurring_cards(p_now timestamptz default now()) returns integer language plpgsql security definer set search_path='' as $$declare rule record; source public.cards; count integer:=0; next_occurrence timestamptz; created_card uuid; begin for rule in select * from public.recurring_rules where active and next_at<=p_now for update skip locked loop select * into source from public.cards where id=rule.card_id; insert into public.cards(board_id,list_id,title,description,priority,position,due_at,source,parent_id,task_type,acceptance_criteria,effort,checklist,custom_fields) values(source.board_id,source.list_id,source.title,source.description,source.priority,(select coalesce(max(position),0)+1 from public.cards where list_id=source.list_id),rule.next_at,'recurring',source.parent_id,source.task_type,source.acceptance_criteria,source.effort,source.checklist,source.custom_fields) returning id into created_card; insert into public.card_members(card_id,user_id) select created_card,user_id from public.card_members where card_id=source.id on conflict do nothing; insert into public.card_labels(card_id,label_id) select created_card,label_id from public.card_labels where card_id=source.id on conflict do nothing; insert into public.notifications(user_id,board_id,card_id,kind,title,deep_link) select cm.user_id,source.board_id,created_card,'recurrence.created',source.title||' created','/?card='||created_card::text from public.card_members cm left join public.notification_preferences p on p.user_id=cm.user_id where cm.card_id=source.id and coalesce(p.in_app,true); next_occurrence:=case rule.cadence when 'daily' then rule.next_at+interval '1 day' when 'weekly' then rule.next_at+interval '7 days' else make_date(extract(year from rule.next_at+interval '1 month')::int,extract(month from rule.next_at+interval '1 month')::int,least(coalesce(rule.monthly_anchor_day,extract(day from rule.next_at)::int),extract(day from date_trunc('month',rule.next_at+interval '2 month')-interval '1 day')::int))+rule.next_at::time end; update public.recurring_rules set next_at=next_occurrence,monthly_anchor_day=coalesce(monthly_anchor_day,extract(day from rule.next_at)::int) where id=rule.id; count:=count+1; end loop; return count; end$$;

revoke all on function public.capture_card_activity() from public;
revoke all on function public.enforce_ai_list_entry() from public;
revoke all on function public.enforce_ai_list_kind() from public;
revoke all on function public.validate_card_dependency() from public;
revoke all on function public.validate_card_hierarchy() from public;
revoke all on function public.validate_card_checklist() from public;
revoke all on function public.validate_card_board_change() from public;
revoke all on function public.validate_list_board_change() from public;
revoke all on function public.validate_agent_run_board() from public;
revoke all on function public.validate_recurring_rule_card() from public;
revoke all on function public.cancel_agent_when_leaving_ai() from public;
revoke all on function public.capture_related_activity() from public;
revoke all on function public.fan_out_activity_notification() from public;
revoke all on function public.queue_card_for_ai(uuid,text) from public;
revoke all on function public.create_planning_request(uuid,text,text,text) from public;
revoke all on function public.set_card_dependencies(uuid,uuid[]) from public;
revoke all on function public.set_card_assignees(uuid,uuid[]) from public;
revoke all on function public.set_notification_read(uuid,boolean) from public;
revoke all on function public.mark_all_notifications_read() from public;
revoke all on function public.set_notification_preferences(boolean,boolean,boolean,boolean) from public;
revoke all on function public.validate_planning_proposal(jsonb) from public;
revoke all on function public.resolve_planning_request(uuid,boolean,jsonb) from public;
revoke all on function public.control_agent_run(uuid,text) from public;
revoke all on function public.approve_and_materialize_plan(uuid,jsonb) from public;
revoke all on function public.convert_checklist_to_subtasks(uuid) from public;
grant execute on function public.queue_card_for_ai(uuid,text) to authenticated;
grant execute on function public.create_planning_request(uuid,text,text,text) to authenticated;
grant execute on function public.set_card_dependencies(uuid,uuid[]) to authenticated;
grant execute on function public.set_card_assignees(uuid,uuid[]) to authenticated;
grant execute on function public.set_notification_read(uuid,boolean) to authenticated;
grant execute on function public.mark_all_notifications_read() to authenticated;
grant execute on function public.set_notification_preferences(boolean,boolean,boolean,boolean) to authenticated;
grant execute on function public.resolve_planning_request(uuid,boolean,jsonb) to authenticated;
grant execute on function public.control_agent_run(uuid,text) to authenticated;
grant execute on function public.approve_and_materialize_plan(uuid,jsonb) to authenticated;
grant execute on function public.convert_checklist_to_subtasks(uuid) to authenticated;
revoke all on function public.upsert_card_reminder(uuid,timestamptz) from public;
revoke all on function public.upsert_recurring_rule(uuid,text,timestamptz) from public;
grant execute on function public.upsert_card_reminder(uuid,timestamptz) to authenticated;
grant execute on function public.upsert_recurring_rule(uuid,text,timestamptz) to authenticated;
revoke all on function public.claim_productivity_work(text) from public;
revoke all on function public.renew_productivity_lease(text,uuid,text) from public;
revoke all on function public.complete_agent_run(uuid,jsonb,text) from public;
revoke all on function public.complete_planning_request(uuid,jsonb,text,text) from public;
revoke all on function public.fail_productivity_work(text,uuid,text,text) from public;
revoke all on function public.enqueue_due_reminders(timestamptz) from public;
revoke all on function public.generate_recurring_cards(timestamptz) from public;
revoke all on function public.claim_email_reminder(text) from public;
revoke all on function public.authorize_email_reminder_delivery(uuid,text) from public;
revoke all on function public.renew_email_reminder_lease(uuid,text) from public;
revoke all on function public.complete_email_reminder(uuid,text) from public;
revoke all on function public.fail_email_reminder(uuid,text,text) from public;
grant execute on function public.claim_productivity_work(text) to service_role;
grant execute on function public.renew_productivity_lease(text,uuid,text) to service_role;
grant execute on function public.complete_agent_run(uuid,jsonb,text) to service_role;
grant execute on function public.complete_planning_request(uuid,jsonb,text,text) to service_role;
grant execute on function public.fail_productivity_work(text,uuid,text,text) to service_role;
grant execute on function public.enqueue_due_reminders(timestamptz) to service_role;
grant execute on function public.generate_recurring_cards(timestamptz) to service_role;
grant execute on function public.claim_email_reminder(text) to service_role;
grant execute on function public.authorize_email_reminder_delivery(uuid,text) to service_role;
grant execute on function public.renew_email_reminder_lease(uuid,text) to service_role;
grant execute on function public.complete_email_reminder(uuid,text) to service_role;
grant execute on function public.fail_email_reminder(uuid,text,text) to service_role;
revoke insert on public.planning_requests from authenticated;
revoke insert on public.agent_runs from authenticated;
do $$begin alter publication supabase_realtime add table public.activity_events; exception when duplicate_object then null; end$$;
do $$begin alter publication supabase_realtime add table public.agent_runs; exception when duplicate_object then null; end$$;
commit;
