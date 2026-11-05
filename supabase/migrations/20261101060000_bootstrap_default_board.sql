begin;

create index if not exists workspace_members_user_workspace_idx
on public.workspace_members(user_id,workspace_id);

create or replace function public.ensure_default_board()
returns public.boards
language plpgsql
security definer
set search_path=''
as $$
declare
  caller_id uuid:=auth.uid();
  existing_board public.boards;
  created_workspace uuid;
begin
  if caller_id is null then
    raise exception 'Authentication required' using errcode='42501';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(caller_id::text,0));

  select b.* into existing_board
  from public.boards b
  where b.workspace_id in (
    select wm.workspace_id from public.workspace_members wm where wm.user_id=caller_id
  ) or b.id in (
    select bm.board_id from public.board_members bm where bm.user_id=caller_id
  )
  order by b.updated_at desc,b.id
  limit 1;

  if existing_board.id is not null then
    return existing_board;
  end if;

  if not exists(select 1 from public.profiles p where p.id=caller_id) then
    raise exception 'Profile is not available' using errcode='42501';
  end if;

  insert into public.workspaces(name,owner_id)
  values('My workspace',caller_id)
  returning id into created_workspace;

  insert into public.boards(workspace_id,title,created_by)
  values(created_workspace,'My board',caller_id)
  returning * into existing_board;

  return existing_board;
end$$;

revoke all on function public.ensure_default_board() from public,anon,authenticated;
grant execute on function public.ensure_default_board() to authenticated;

commit;
