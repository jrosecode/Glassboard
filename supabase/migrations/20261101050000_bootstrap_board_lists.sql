begin;

create or replace function public.bootstrap_board_lists()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
declare
  previous_queue_setting text:=coalesce(current_setting('app.queue_card_for_ai',true),'');
begin
  perform set_config('app.queue_card_for_ai','on',true);

  insert into public.lists(board_id,title,position,kind)
  select new.id,'New list',1,'normal'::public.list_kind
  where not exists (
    select 1 from public.lists where board_id=new.id and kind='normal'
  );

  insert into public.lists(board_id,title,position,kind)
  select new.id,'AI',coalesce((select max(position) from public.lists where board_id=new.id),0)+1,'ai'::public.list_kind
  where not exists (
    select 1 from public.lists where board_id=new.id and kind='ai'
  );

  perform set_config('app.queue_card_for_ai',previous_queue_setting,true);
  return new;
end$$;

revoke all on function public.bootstrap_board_lists() from public,anon,authenticated;

drop trigger if exists boards_bootstrap_lists on public.boards;
create trigger boards_bootstrap_lists
after insert on public.boards
for each row execute function public.bootstrap_board_lists();

lock table public.lists in share row exclusive mode;

do $$
declare
  target_board uuid;
  previous_queue_setting text:=coalesce(current_setting('app.queue_card_for_ai',true),'');
begin
  perform set_config('app.queue_card_for_ai','on',true);
  for target_board in select id from public.boards order by id loop
    insert into public.lists(board_id,title,position,kind)
    select target_board,'New list',coalesce((select max(l.position) from public.lists l where l.board_id=target_board),0)+1,'normal'::public.list_kind
    where not exists (
      select 1 from public.lists l where l.board_id=target_board and l.kind='normal'
    );

    insert into public.lists(board_id,title,position,kind)
    select target_board,'AI',coalesce((select max(l.position) from public.lists l where l.board_id=target_board),0)+1,'ai'::public.list_kind
    where not exists (
      select 1 from public.lists l where l.board_id=target_board and l.kind='ai'
    );
  end loop;
  perform set_config('app.queue_card_for_ai',previous_queue_setting,true);
end$$;

drop policy if exists lists_member on public.lists;
drop policy if exists lists_member_read on public.lists;
create policy lists_member_read on public.lists for select to authenticated
using (public.can_access_board(board_id));
drop policy if exists lists_member_update on public.lists;
create policy lists_member_update on public.lists for update to authenticated
using (public.can_access_board(board_id))
with check (public.can_access_board(board_id));
drop policy if exists lists_member_delete on public.lists;
create policy lists_member_delete on public.lists for delete to authenticated
using (public.can_access_board(board_id));
drop policy if exists lists_ai_delete_guard on public.lists;
create policy lists_ai_delete_guard on public.lists as restrictive for delete to authenticated
using (kind<>'ai');
revoke insert on public.lists from authenticated;

create or replace function public.validate_list_board_change()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if new.board_id is distinct from old.board_id then
    raise exception 'List cannot move between boards';
  end if;
  return new;
end$$;

revoke all on function public.validate_list_board_change() from public,anon,authenticated;

create or replace function public.create_board_list(p_board_id uuid,p_title text)
returns public.lists
language plpgsql
security definer
set search_path=''
as $$
declare
  clean_title text:=btrim(coalesce(p_title,''));
  next_position numeric(20,8);
  created public.lists;
begin
  if not public.can_access_board(p_board_id) then
    raise exception 'Board access denied' using errcode='42501';
  end if;
  if not (length(clean_title) between 1 and 120) then
    raise exception 'List name must be between 1 and 120 characters';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_board_id::text,0));
  if not public.can_access_board(p_board_id) then
    raise exception 'Board access denied' using errcode='42501';
  end if;

  if (select count(*) from public.lists where board_id=p_board_id)>=50 then
    raise exception 'A board can have at most 50 lists';
  end if;

  select coalesce(max(position),0)+1 into next_position
  from public.lists
  where board_id=p_board_id;

  insert into public.lists(board_id,title,position,kind)
  values(p_board_id,clean_title,next_position,'normal')
  returning * into created;

  return created;
end$$;

revoke all on function public.create_board_list(uuid,text) from public,anon,authenticated;
grant execute on function public.create_board_list(uuid,text) to authenticated;

create or replace function public.approve_and_materialize_plan(p_request_id uuid,p_proposal jsonb)
returns public.planning_status
language plpgsql
security definer
set search_path=''
as $$
declare
  request public.planning_requests;
  list_row record;
  card_row record;
  target_list uuid;
  created_card uuid;
  item_key text;
begin
  select * into request from public.planning_requests where id=p_request_id for update;
  if request.id is null or not public.can_access_board(request.board_id) or (request.requested_by<>auth.uid() and not public.can_manage_board(request.board_id)) then
    raise exception 'Planning request access denied' using errcode='42501';
  end if;
  if request.status='materialized' then return request.status; end if;
  if request.status not in ('ready','approved') then raise exception 'Planning request is not ready for materialization'; end if;
  perform public.validate_planning_proposal(p_proposal);

  perform pg_advisory_xact_lock(hashtextextended(request.board_id::text,0));
  if not public.can_access_board(request.board_id) or (request.requested_by<>auth.uid() and not public.can_manage_board(request.board_id)) then
    raise exception 'Planning request access denied' using errcode='42501';
  end if;

  for list_row in select value,ordinality from jsonb_array_elements(p_proposal->'lists') with ordinality loop
    insert into public.lists(board_id,title,position,kind)
    values(request.board_id,trim(list_row.value->>'title'),(select coalesce(max(position),0)+1 from public.lists where board_id=request.board_id),'normal')
    returning id into target_list;
    for card_row in select value,ordinality from jsonb_array_elements(list_row.value->'cards') with ordinality loop
      item_key:=list_row.ordinality::text||':'||card_row.ordinality::text;
      if not exists(select 1 from public.planning_materialized_items i where i.request_id=p_request_id and i.item_key=item_key) then
        insert into public.cards(board_id,list_id,title,description,priority,position,source)
        values(request.board_id,target_list,trim(card_row.value->>'title'),coalesce(card_row.value->>'description',''),coalesce((card_row.value->>'priority')::public.card_priority,'medium'),(select coalesce(max(position),0)+1 from public.cards where list_id=target_list),'ai')
        returning id into created_card;
        insert into public.planning_materialized_items(request_id,item_key,card_id) values(p_request_id,item_key,created_card);
      end if;
    end loop;
  end loop;
  update public.planning_requests set status='materialized',proposal=p_proposal,approved_at=now() where id=p_request_id;
  return 'materialized';
end$$;

revoke all on function public.approve_and_materialize_plan(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.approve_and_materialize_plan(uuid,jsonb) to authenticated;

create or replace function public.enforce_list_position_update()
returns trigger
language plpgsql
security definer
set search_path=''
as $$
begin
  if old.position is distinct from new.position
     and coalesce(current_setting('app.reorder_board_list',true),'')<>'on' then
    raise exception 'List position is managed by reorder_board_list';
  end if;
  return new;
end$$;

revoke all on function public.enforce_list_position_update() from public,anon,authenticated;
drop trigger if exists lists_position_update_guard on public.lists;
create trigger lists_position_update_guard
before update of position on public.lists
for each row execute function public.enforce_list_position_update();

create or replace function public.reorder_board_list(p_list_id uuid,p_position numeric)
returns void
language plpgsql
security definer
set search_path=''
as $$
declare
  target_board uuid;
  previous_setting text:=coalesce(current_setting('app.reorder_board_list',true),'');
begin
  select board_id into target_board from public.lists where id=p_list_id;
  if target_board is null or not public.can_access_board(target_board) then
    raise exception 'List access denied' using errcode='42501';
  end if;
  if p_position is null then
    raise exception 'List position is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(target_board::text,0));
  select board_id into target_board from public.lists where id=p_list_id;
  if target_board is null or not public.can_access_board(target_board) then
    raise exception 'List access denied' using errcode='42501';
  end if;

  perform set_config('app.reorder_board_list','on',true);
  update public.lists set position=p_position where id=p_list_id;
  perform set_config('app.reorder_board_list',previous_setting,true);
end$$;

revoke all on function public.reorder_board_list(uuid,numeric) from public,anon,authenticated;
grant execute on function public.reorder_board_list(uuid,numeric) to authenticated;

commit;
