-- Permit authenticated Edge Function to claim only a specific user-owned queued reply.
create or replace function public.ai_chat_claim_specific(p_id uuid,p_worker_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.ai_chat_messages%rowtype;
begin
 if auth.role()<>'service_role' then raise exception 'Service role required'; end if;
 select * into v from public.ai_chat_messages
 where id=p_id and role='assistant' and (status='queued' or (status='running' and lease_until < now()))
 for update skip locked;
 if not found then return null; end if;
 update public.ai_chat_messages
 set status='running',worker_id=p_worker_id,lease_until=now()+interval '4 minutes',error=null where id=v.id;
 return jsonb_build_object('id',v.id,'user_id',v.user_id,'board_id',v.board_id);
end $$;
revoke all on function public.ai_chat_claim_specific(uuid,text) from public,anon,authenticated;
grant execute on function public.ai_chat_claim_specific(uuid,text) to service_role;
