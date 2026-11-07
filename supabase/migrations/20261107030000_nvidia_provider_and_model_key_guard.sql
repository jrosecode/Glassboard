-- Add NVIDIA's hosted NIM inference as a cloud provider and block API credentials in model IDs.
alter table public.ai_user_settings drop constraint if exists ai_user_settings_provider_check;
alter table public.ai_user_settings add constraint ai_user_settings_provider_check check(provider in ('ollama','lmstudio','openai','moonshot','zai','openrouter','anthropic','nvidia'));
alter table public.ai_user_settings drop constraint if exists ai_user_settings_fallback_provider_check;
alter table public.ai_user_settings add constraint ai_user_settings_fallback_provider_check check(fallback_provider in ('ollama','lmstudio','openai','moonshot','zai','openrouter','anthropic','nvidia'));
alter table public.ai_provider_credentials drop constraint if exists ai_provider_credentials_provider_check;
alter table public.ai_provider_credentials add constraint ai_provider_credentials_provider_check check(provider in ('openai','moonshot','zai','openrouter','anthropic','nvidia'));

create or replace function public.ai_save_provider_key(p_provider text,p_key text)
returns void language plpgsql security definer set search_path='' as $$
declare uid uuid; sid uuid;
begin
 uid:=auth.uid();
 if uid is null then raise exception 'Authentication required' using errcode='42501'; end if;
 if p_provider not in ('openai','moonshot','zai','openrouter','anthropic','nvidia') then raise exception 'Unsupported provider'; end if;
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

-- Prevent accidental display of credentials as model names in any new settings update.
-- Apply only after sanitizing existing mistaken model values.
update public.ai_user_settings set provider='nvidia',model_id='meta/llama-3.1-70b-instruct',updated_at=now()
where provider='ollama' and (model_id like 'nvapi-%' or model_id like 'nvapi_%');
update public.ai_chat_messages set status='error',error='The selected Ollama model was an API key. Select NVIDIA in AI Settings, rotate and save the key securely, then send a new message.'
where role='assistant' and status='queued' and user_id in(select user_id from public.ai_user_settings where provider='nvidia')
and created_at<now()-interval '30 seconds';
alter table public.ai_user_settings drop constraint if exists ai_model_not_api_key;
alter table public.ai_user_settings add constraint ai_model_not_api_key check(
 model_id !~* '^(nvapi-|sk-|sk_|AIza|ghp_|glpat-|hf_)' and fallback_model !~* '^(nvapi-|sk-|sk_|AIza|ghp_|glpat-|hf_)'
);
