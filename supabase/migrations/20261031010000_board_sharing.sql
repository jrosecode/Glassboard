begin;

create type public.board_role as enum ('member','admin');

create table public.board_members (
  board_id uuid not null references public.boards(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.board_role not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (board_id,user_id)
);
create table public.board_invites (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.boards(id) on delete cascade,
  email text not null check (email=lower(email) and email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  role public.board_role not null default 'member',
  invited_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  unique(board_id,email)
);
create table public.board_share_links (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.boards(id) on delete cascade,
  token_hash bytea not null unique,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create table public.board_join_requests (
  id uuid primary key default gen_random_uuid(),
  board_id uuid not null references public.boards(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  share_link_id uuid not null references public.board_share_links(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique(board_id,user_id)
);
create index board_members_user_idx on public.board_members(user_id,board_id);
create index board_invites_email_idx on public.board_invites(email);
create index board_join_requests_board_idx on public.board_join_requests(board_id,created_at);

create or replace function public.can_access_board(bid uuid) returns boolean
language sql stable security definer set search_path=''
as $$
  select exists(
    select 1 from public.boards b
    join public.workspace_members wm on wm.workspace_id=b.workspace_id
    where b.id=bid and wm.user_id=auth.uid()
  ) or exists(
    select 1 from public.board_members bm
    where bm.board_id=bid and bm.user_id=auth.uid()
  )
$$;

create or replace function public.can_manage_board(bid uuid) returns boolean
language sql stable security definer set search_path=''
as $$
  select exists(
    select 1 from public.boards b
    join public.workspaces w on w.id=b.workspace_id
    where b.id=bid and w.owner_id=auth.uid()
  ) or exists(
    select 1 from public.board_members bm
    where bm.board_id=bid and bm.user_id=auth.uid() and bm.role='admin'
  )
$$;

alter table public.board_members enable row level security;
alter table public.board_invites enable row level security;
alter table public.board_share_links enable row level security;
alter table public.board_join_requests enable row level security;
create policy board_members_read on public.board_members for select to authenticated using(public.can_access_board(board_id));
create policy boards_shared_select on public.boards for select to authenticated using(exists(select 1 from public.board_members bm where bm.board_id=boards.id and bm.user_id=auth.uid()));
create policy board_invites_manage_read on public.board_invites for select to authenticated using(public.can_manage_board(board_id));
create policy board_share_links_manage_read on public.board_share_links for select to authenticated using(public.can_manage_board(board_id));
create policy board_join_requests_read on public.board_join_requests for select to authenticated using(user_id=auth.uid() or public.can_manage_board(board_id));

create or replace function public.get_board_sharing(p_board_id uuid) returns jsonb
language plpgsql stable security definer set search_path=''
as $$
declare result jsonb;
begin
  if not public.can_access_board(p_board_id) then raise exception 'Board access denied' using errcode='42501'; end if;
  select jsonb_build_object(
    'members',coalesce((select jsonb_agg(member order by (member->>'role')='owner' desc,member->>'displayName') from (
      select jsonb_build_object('userId',p.id,'displayName',p.display_name,'email',u.email,'avatarUrl',p.avatar_url,'role','owner','isSelf',p.id=auth.uid()) member
      from public.boards b join public.workspaces w on w.id=b.workspace_id join public.profiles p on p.id=w.owner_id join auth.users u on u.id=p.id where b.id=p_board_id
      union all
      select jsonb_build_object('userId',p.id,'displayName',p.display_name,'email',u.email,'avatarUrl',p.avatar_url,'role',bm.role,'isSelf',p.id=auth.uid())
      from public.board_members bm join public.profiles p on p.id=bm.user_id join auth.users u on u.id=p.id
      where bm.board_id=p_board_id and not exists(select 1 from public.boards b join public.workspaces w on w.id=b.workspace_id where b.id=p_board_id and w.owner_id=bm.user_id)
    ) members), '[]'::jsonb),
    'invites',case when public.can_manage_board(p_board_id) then coalesce((select jsonb_agg(jsonb_build_object('id',i.id,'email',i.email,'role',i.role,'status','pending') order by i.created_at) from public.board_invites i where i.board_id=p_board_id),'[]'::jsonb) else '[]'::jsonb end,
    'requests',case when public.can_manage_board(p_board_id) then coalesce((select jsonb_agg(jsonb_build_object('id',r.id,'displayName',p.display_name,'email',u.email,'requestedAt',r.created_at) order by r.created_at) from public.board_join_requests r join public.profiles p on p.id=r.user_id join auth.users u on u.id=r.user_id where r.board_id=p_board_id),'[]'::jsonb) else '[]'::jsonb end,
    'shareUrl',null,
    'canManage',public.can_manage_board(p_board_id)
  ) into result;
  return result;
end$$;

create or replace function public.invite_board_member(p_board_id uuid,p_identity text,p_role public.board_role default 'member') returns jsonb
language plpgsql security definer set search_path=''
as $$
declare target uuid; normalized text:=lower(trim(p_identity)); matches integer;
begin
  if not public.can_manage_board(p_board_id) then raise exception 'Board management denied' using errcode='42501'; end if;
  select count(*),(array_agg(p.id))[1] into matches,target from public.profiles p left join auth.users u on u.id=p.id where lower(u.email)=normalized or lower(p.display_name)=normalized;
  if matches>1 then raise exception 'Name is ambiguous; use an email address'; end if;
  if target is not null then
    insert into public.board_members(board_id,user_id,role) values(p_board_id,target,p_role) on conflict(board_id,user_id) do update set role=excluded.role;
    delete from public.board_invites where board_id=p_board_id and email=normalized;
  else
    if normalized !~ '^[^@[:space:]]+@[^@[:space:]]+$' then raise exception 'No user found; enter an email address'; end if;
    insert into public.board_invites(board_id,email,role,invited_by) values(p_board_id,normalized,p_role,auth.uid()) on conflict(board_id,email) do update set role=excluded.role,invited_by=auth.uid();
  end if;
  return public.get_board_sharing(p_board_id);
end$$;

create or replace function public.create_board_share_link(p_board_id uuid) returns text
language plpgsql security definer set search_path=''
as $$declare raw_token text:=encode(gen_random_bytes(32),'hex');begin
  if not public.can_manage_board(p_board_id) then raise exception 'Board management denied' using errcode='42501'; end if;
  update public.board_share_links set revoked_at=now() where board_id=p_board_id and revoked_at is null;
  insert into public.board_share_links(board_id,token_hash,created_by) values(p_board_id,digest(raw_token,'sha256'),auth.uid());
  return raw_token;
end$$;

create or replace function public.request_board_access(p_token text) returns uuid
language plpgsql security definer set search_path=''
as $$declare link public.board_share_links;begin
  select * into link from public.board_share_links where token_hash=digest(p_token,'sha256') and revoked_at is null;
  if link.id is null then raise exception 'Share link is invalid or expired'; end if;
  if public.can_access_board(link.board_id) then return link.board_id; end if;
  insert into public.board_join_requests(board_id,user_id,share_link_id) values(link.board_id,auth.uid(),link.id) on conflict(board_id,user_id) do update set share_link_id=excluded.share_link_id,created_at=now();
  return link.board_id;
end$$;

create or replace function public.resolve_board_join_request(p_board_id uuid,p_request_id uuid,p_approve boolean,p_role public.board_role default 'member') returns jsonb
language plpgsql security definer set search_path=''
as $$declare target uuid;begin
  if not public.can_manage_board(p_board_id) then raise exception 'Board management denied' using errcode='42501'; end if;
  delete from public.board_join_requests where id=p_request_id and board_id=p_board_id returning user_id into target;
  if target is null then raise exception 'Join request not found'; end if;
  if p_approve then insert into public.board_members(board_id,user_id,role) values(p_board_id,target,p_role) on conflict(board_id,user_id) do update set role=excluded.role; end if;
  return public.get_board_sharing(p_board_id);
end$$;

create or replace function public.update_board_member(p_board_id uuid,p_user_id uuid,p_role public.board_role) returns jsonb
language plpgsql security definer set search_path=''
as $$begin
  if not public.can_manage_board(p_board_id) then raise exception 'Board management denied' using errcode='42501'; end if;
  if exists(select 1 from public.boards b join public.workspaces w on w.id=b.workspace_id where b.id=p_board_id and w.owner_id=p_user_id) then raise exception 'The board owner cannot be changed'; end if;
  if p_role is null then delete from public.board_members where board_id=p_board_id and user_id=p_user_id; else update public.board_members set role=p_role where board_id=p_board_id and user_id=p_user_id; end if;
  return public.get_board_sharing(p_board_id);
end$$;

create or replace function public.handle_new_user() returns trigger security definer set search_path=''
language plpgsql as $$begin
  insert into public.profiles(id,display_name) values(new.id,coalesce(new.raw_user_meta_data->>'name',split_part(new.email,'@',1)));
  insert into public.user_settings(user_id) values(new.id);
  insert into public.board_members(board_id,user_id,role) select i.board_id,new.id,i.role from public.board_invites i where i.email=lower(new.email) on conflict(board_id,user_id) do update set role=excluded.role;
  delete from public.board_invites where email=lower(new.email);
  return new;
end$$;

revoke all on function public.get_board_sharing(uuid) from public;
revoke all on function public.invite_board_member(uuid,text,public.board_role) from public;
revoke all on function public.create_board_share_link(uuid) from public;
revoke all on function public.request_board_access(text) from public;
revoke all on function public.resolve_board_join_request(uuid,uuid,boolean,public.board_role) from public;
revoke all on function public.update_board_member(uuid,uuid,public.board_role) from public;
grant execute on function public.get_board_sharing(uuid) to authenticated;
grant execute on function public.invite_board_member(uuid,text,public.board_role) to authenticated;
grant execute on function public.create_board_share_link(uuid) to authenticated;
grant execute on function public.request_board_access(text) to authenticated;
grant execute on function public.resolve_board_join_request(uuid,uuid,boolean,public.board_role) to authenticated;
grant execute on function public.update_board_member(uuid,uuid,public.board_role) to authenticated;

commit;
