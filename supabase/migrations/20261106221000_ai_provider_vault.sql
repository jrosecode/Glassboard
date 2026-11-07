-- Encrypted per-user provider credentials using Supabase Vault.
create table if not exists public.ai_provider_credentials (
 user_id uuid not null references auth.users(id) on delete cascade,
 provider text not null check(provider in ('openai','moonshot','zai','openrouter','anthropic')),
 secret_id uuid not null unique,
 updated_at timestamptz not null default now(),
 primary key(user_id,provider)
);
alter table public.ai_provider_credentials enable row level security;
revoke all on public.ai_provider_credentials from public,anon,authenticated;
grant select on public.ai_provider_credentials to authenticated;
grant all on public.ai_provider_credentials to service_role;
drop policy if exists ai_provider_credentials_self on public.ai_provider_credentials;
create policy ai_provider_credentials_self on public.ai_provider_credentials for select to authenticated using(user_id=(select auth.uid()));

create or replace function public.ai_save_provider_key(p_provider text,p_key text)
returns void language plpgsql security definer set search_path='' as $$
declare uid uuid; sid uuid;
begin
 uid:=auth.uid();
 if uid is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if p_provider not in ('openai','moonshot','zai','openrouter','anthropic') then raise exception 'Unsupported provider'; end if;
 if p_key is null or length(btrim(p_key)) not between 10 and 512 then raise exception 'API key must contain 10 to 512 characters'; end if;
 select secret_id into sid from public.ai_provider_credentials where user_id=uid and provider=p_provider for update;
 if sid is null then
  sid:=vault.create_secret(btrim(p_key));
  insert into public.ai_provider_credentials(user_id,provider,secret_id) values(uid,p_provider,sid);
 else
  perform vault.update_secret(sid,btrim(p_key));
  update public.ai_provider_credentials set updated_at=now() where user_id=uid and provider=p_provider;
 end if;
end $$;
revoke all on function public.ai_save_provider_key(text,text) from public,anon;
grant execute on function public.ai_save_provider_key(text,text) to authenticated;

create or replace function public.ai_revoke_provider_key(p_provider text)
returns void language plpgsql security definer set search_path='' as $$
declare uid uuid; sid uuid;
begin
 uid:=auth.uid();
 if uid is null then raise exception 'Authentication required' using errcode='42501'; end if;
 select secret_id into sid from public.ai_provider_credentials where user_id=uid and provider=p_provider for update;
 if sid is null then return; end if;
 delete from public.ai_provider_credentials where user_id=uid and provider=p_provider;
 delete from vault.secrets where id=sid;
end $$;
revoke all on function public.ai_revoke_provider_key(text) from public,anon;
grant execute on function public.ai_revoke_provider_key(text) to authenticated;

-- This is callable exclusively by the service-role worker, never authenticated browser clients.
create or replace function public.ai_worker_provider_key(p_user_id uuid,p_provider text)
returns text language sql security definer set search_path='' as $$
 select v.decrypted_secret
 from public.ai_provider_credentials c
 join vault.decrypted_secrets v on v.id=c.secret_id
 where c.user_id=p_user_id and c.provider=p_provider
 limit 1
$$;
revoke all on function public.ai_worker_provider_key(uuid,text) from public,anon,authenticated;
grant execute on function public.ai_worker_provider_key(uuid,text) to service_role;
