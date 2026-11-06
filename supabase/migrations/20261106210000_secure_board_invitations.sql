-- Reproducible secure sharing invitation schema. Applied to Renova on 2026-11-06.
create table if not exists public.board_email_invitations(
 id uuid primary key default gen_random_uuid(),
 board_id uuid not null references public.boards(id) on delete cascade,
 email text not null,
 role public.board_role not null default 'member',
 token_hash bytea not null unique,
 created_by uuid not null references auth.users(id),
 created_at timestamptz not null default now(),
 expires_at timestamptz not null default(now()+interval '7 days'),
 accepted_at timestamptz,
 revoked_at timestamptz,
 constraint invite_email_length check(length(email) between 3 and 254),
 constraint invite_lifecycle check(not(accepted_at is not null and revoked_at is not null))
);
create index if not exists board_email_invitations_board_idx on public.board_email_invitations(board_id,created_at desc);
create unique index if not exists board_email_invitations_active_email_idx on public.board_email_invitations(board_id,lower(email))
 where accepted_at is null and revoked_at is null;
alter table public.board_email_invitations enable row level security;
revoke all on public.board_email_invitations from public,anon,authenticated;
grant all on public.board_email_invitations to service_role;

CREATE OR REPLACE FUNCTION public.accept_board_email_invitation(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare invitation public.board_email_invitations%rowtype; account_email text; confirmed timestamptz;
begin
 if auth.uid() is null then raise exception 'Sign in to accept an invitation' using errcode='42501';end if;
 if length(coalesce(p_token,''))<>64 or p_token !~ '^[0-9a-fA-F]+$' then raise exception 'Invitation is invalid or expired';end if;
 select * into invitation from public.board_email_invitations
 where token_hash=extensions.digest(lower(p_token),'sha256') and revoked_at is null and accepted_at is null and expires_at>now()
 for update;
 if invitation.id is null then raise exception 'Invitation is invalid or expired';end if;
 select lower(u.email),u.email_confirmed_at into account_email,confirmed from auth.users u where u.id=auth.uid();
 if account_email is distinct from invitation.email or confirmed is null then
   raise exception 'Sign in with the invited, verified email address' using errcode='42501';
 end if;
 if not public.can_access_board(invitation.board_id) then
  insert into public.board_members(board_id,user_id,role) values(invitation.board_id,auth.uid(),invitation.role)
  on conflict(board_id,user_id) do update set role=excluded.role;
 end if;
 update public.board_email_invitations set accepted_at=now() where id=invitation.id;
 return jsonb_build_object('status','accessible','boardId',invitation.board_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.board_share_link_status(p_board_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare active_since timestamptz;
begin
 if auth.uid() is null or not public.can_manage_board(p_board_id) then raise exception 'Board management denied' using errcode='42501';end if;
 select max(created_at) into active_since from public.board_share_links where board_id=p_board_id and revoked_at is null;
 return jsonb_build_object('active',active_since is not null,'createdAt',active_since);
end $function$
;

CREATE OR REPLACE FUNCTION public.create_board_email_invitation(p_board_id uuid, p_email text, p_role board_role DEFAULT 'member'::board_role)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare normalized text:=lower(trim(p_email)); raw_token text:=encode(extensions.gen_random_bytes(32),'hex');
 expiry timestamptz:=now()+interval '7 days'; invitation_id uuid;
begin
 if auth.uid() is null or not public.can_manage_board(p_board_id) then raise exception 'Board management denied' using errcode='42501';end if;
 if normalized !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(normalized)>254 then raise exception 'Enter a valid email address';end if;
 if p_role not in ('member','admin') then raise exception 'Invalid invitation role';end if;
 if exists(select 1 from public.boards b join public.workspace_members wm on wm.workspace_id=b.workspace_id
 where b.id=p_board_id and lower((select u.email from auth.users u where u.id=wm.user_id))=normalized)
 or exists(select 1 from public.board_members bm join auth.users u on u.id=bm.user_id where bm.board_id=p_board_id and lower(u.email)=normalized)
 then raise exception 'This person already has access to the board';end if;
 -- Expired invitations no longer block a fresh invitation for the same address.
 update public.board_email_invitations set revoked_at=now()
 where board_id=p_board_id and lower(email)=normalized and accepted_at is null and revoked_at is null;
 insert into public.board_email_invitations(board_id,email,role,token_hash,created_by,expires_at)
 values(p_board_id,normalized,p_role,extensions.digest(raw_token,'sha256'),auth.uid(),expiry) returning id into invitation_id;
 return jsonb_build_object('id',invitation_id,'token',raw_token,'email',normalized,'role',p_role,'expiresAt',expiry);
end $function$
;

CREATE OR REPLACE FUNCTION public.list_board_email_invitations(p_board_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 if auth.uid() is null or not public.can_manage_board(p_board_id) then raise exception 'Board management denied' using errcode='42501';end if;
 return coalesce((select jsonb_agg(jsonb_build_object(
 'id',i.id,'email',i.email,'role',i.role,'createdAt',i.created_at,'expiresAt',i.expires_at,
 'status',case when i.accepted_at is not null then 'accepted' when i.revoked_at is not null then 'revoked' when i.expires_at<=now() then 'expired' else 'pending' end
 ) order by i.created_at desc)
 from public.board_email_invitations i where i.board_id=p_board_id),'[]'::jsonb);
end $function$
;

CREATE OR REPLACE FUNCTION public.revoke_board_email_invitation(p_board_id uuid, p_invitation_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 if auth.uid() is null or not public.can_manage_board(p_board_id) then raise exception 'Board management denied' using errcode='42501';end if;
 update public.board_email_invitations set revoked_at=now()
 where id=p_invitation_id and board_id=p_board_id and accepted_at is null and revoked_at is null;
 if not found then raise exception 'Pending invitation not found';end if;
end $function$
;

CREATE OR REPLACE FUNCTION public.revoke_board_share_link(p_board_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 if auth.uid() is null or not public.can_manage_board(p_board_id) then raise exception 'Board management denied' using errcode='42501';end if;
 with revoked as (
  update public.board_share_links set revoked_at=now() where board_id=p_board_id and revoked_at is null returning id
 )
 delete from public.board_join_requests where share_link_id in (select id from revoked);
end $function$
;


revoke all on function public.get_board_sharing(uuid) from public,anon;
revoke all on function public.create_board_share_link(uuid) from public,anon;
revoke all on function public.request_board_access(text) from public,anon;
revoke all on function public.resolve_board_join_request(uuid,uuid,boolean,public.board_role) from public,anon;
revoke all on function public.update_board_member(uuid,uuid,public.board_role) from public,anon;
revoke all on function public.create_board_email_invitation(uuid,text,public.board_role) from public,anon;
revoke all on function public.list_board_email_invitations(uuid) from public,anon;
revoke all on function public.revoke_board_email_invitation(uuid,uuid) from public,anon;
revoke all on function public.accept_board_email_invitation(text) from public,anon;
revoke all on function public.board_share_link_status(uuid) from public,anon;
revoke all on function public.revoke_board_share_link(uuid) from public,anon;
grant execute on function public.create_board_email_invitation(uuid,text,public.board_role),
 public.list_board_email_invitations(uuid),public.revoke_board_email_invitation(uuid,uuid),
 public.accept_board_email_invitation(text),public.board_share_link_status(uuid),public.revoke_board_share_link(uuid)
 to authenticated;
