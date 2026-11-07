-- Board AI chat: private, queued conversations through the existing AI worker.
create table if not exists public.ai_chat_messages (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 board_id uuid not null references public.boards(id) on delete cascade,
 role text not null check(role in ('user','assistant')),
 content text not null default '' check(length(content)<=20000),
 status text not null default 'done' check(status in ('queued','running','done','error')),
 error text,
 provider text,
 model_id text,
 worker_id text,
 lease_until timestamptz,
 created_at timestamptz not null default now()
);
create index if not exists ai_chat_messages_conversation_idx on public.ai_chat_messages(user_id,board_id,created_at,id);
create index if not exists ai_chat_messages_queue_idx on public.ai_chat_messages(created_at) where role='assistant' and status in ('queued','running');
alter table public.ai_chat_messages enable row level security;
revoke all on public.ai_chat_messages from public,anon,authenticated;
grant select on public.ai_chat_messages to authenticated;
grant select,insert,update on public.ai_chat_messages to service_role;
drop policy if exists ai_chat_self_read on public.ai_chat_messages;
create policy ai_chat_self_read on public.ai_chat_messages for select to authenticated
 using(user_id=(select auth.uid()) and exists(
  select 1 from public.boards b where b.id=board_id and public.can_access_board(b.id)
 ));
-- Authenticated users cannot write the table directly or forge assistant responses.
create or replace function public.ai_chat_send(p_board_id uuid,p_content text)
returns uuid language plpgsql security definer set search_path='' as $$
declare
 v_user uuid:=auth.uid();
 v_reply uuid;
 v_last timestamptz;
begin
 if v_user is null then raise exception 'Sign in to use AI chat'; end if;
 if trim(coalesce(p_content,''))='' or length(p_content)>4000 then raise exception 'Message must be between 1 and 4000 characters'; end if;
 if not public.can_access_board(p_board_id) then raise exception 'Board is not accessible'; end if;
 -- Serialize message submissions per user and board. Avoid duplicate queued turns.
 perform pg_advisory_xact_lock(hashtextextended(v_user::text||':'||p_board_id::text,0));
 if exists(select 1 from public.ai_chat_messages where user_id=v_user and board_id=p_board_id
    and role='assistant' and status in ('queued','running')) then
   raise exception 'Please wait for the current AI reply';
 end if;
 select max(created_at) into v_last from public.ai_chat_messages
 where user_id=v_user and board_id=p_board_id and role='user';
 if v_last is not null and v_last > now()-interval '1 second' then
  raise exception 'Please wait a moment before sending again';
 end if;
 insert into public.ai_chat_messages(user_id,board_id,role,content,status)
 values(v_user,p_board_id,'user',trim(p_content),'done');
 insert into public.ai_chat_messages(user_id,board_id,role,content,status)
 values(v_user,p_board_id,'assistant','','queued') returning id into v_reply;
 return v_reply;
end $$;
revoke all on function public.ai_chat_send(uuid,text) from public,anon;
grant execute on function public.ai_chat_send(uuid,text) to authenticated;

create or replace function public.ai_chat_claim(p_worker_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.ai_chat_messages%rowtype;
begin
 if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
 select * into v from public.ai_chat_messages
 where role='assistant' and (status='queued' or (status='running' and lease_until < now()))
 order by created_at,id for update skip locked limit 1;
 if not found then return null; end if;
 update public.ai_chat_messages set status='running',worker_id=p_worker_id,lease_until=now()+interval '4 minutes',error=null
 where id=v.id;
 return jsonb_build_object('id',v.id,'user_id',v.user_id,'board_id',v.board_id);
end $$;
revoke all on function public.ai_chat_claim(text) from public,anon,authenticated;
grant execute on function public.ai_chat_claim(text) to service_role;

create or replace function public.ai_chat_complete(
 p_id uuid,p_worker_id text,p_content text,p_provider text,p_model_id text,p_error text default null
) returns void language plpgsql security definer set search_path='' as $$
begin
 if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
 update public.ai_chat_messages
 set status=case when p_error is null then 'done' else 'error' end,
 content=case when p_error is null then left(p_content,20000) else '' end,
 error=case when p_error is not null then left(p_error,1500) else null end,
 provider=p_provider,model_id=p_model_id,worker_id=null,lease_until=null
 where id=p_id and role='assistant' and status='running' and worker_id=p_worker_id;
 if not found then raise exception 'Chat lease expired or belongs to another worker'; end if;
end $$;
revoke all on function public.ai_chat_complete(uuid,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.ai_chat_complete(uuid,text,text,text,text,text) to service_role;
