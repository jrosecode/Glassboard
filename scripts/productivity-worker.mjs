#!/usr/bin/env node
import {randomUUID} from 'node:crypto';
import {generateWithFallback,providerAvailable} from './ai-provider-router.mjs';
/* global process, console, fetch, setTimeout, setInterval, clearInterval */
const required=['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'];
for(const key of required)if(!process.env[key]){console.error(`Missing ${key}`);process.exit(2)}
const SUPABASE_URL=process.env.SUPABASE_URL.replace(/\/$/,'');
const SUPABASE_SERVICE_ROLE_KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;
const OLLAMA_URL=(process.env.OLLAMA_URL??'http://127.0.0.1:11434').replace(/\/$/,'');
const MODEL=process.env.OLLAMA_MODEL??'llama3.2';
const EMAIL_DELIVERY_URL=process.env.EMAIL_DELIVERY_URL;
const POLL_MS=Number(process.env.WORKER_POLL_MS??2000);
const ONCE=process.argv.includes('--once');
const WORKER_ID=`${process.env.WORKER_ID??'local'}-${process.pid}-${randomUUID()}`;
const headers={apikey:SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,'Content-Type':'application/json'};
const MODEL_CHECK_MS=30000;
let modelCheckedAt=0,modelAvailable=false,reportedAt=0,reportedStatus='';
async function checkModel(){
 if(Date.now()-modelCheckedAt<MODEL_CHECK_MS)return modelAvailable;
 modelCheckedAt=Date.now();
 if(['openai','moonshot','zai','openrouter','anthropic'].some(p=>providerAvailable(p))){modelAvailable=true;return true}
 try{
  const response=await fetch(`${SUPABASE_URL}/rest/v1/ai_provider_credentials?select=provider&limit=1`,{headers,signal:AbortSignal.timeout(5000)});
  if(response.ok&&(await response.json()).length){modelAvailable=true;return true}
 }catch{/* BYOK lookup unavailable; continue to local provider check. */}
 const endpoints=[
  {name:'Ollama',url:`${OLLAMA_URL}/api/tags`,modelsKey:'models'},
  {name:'LM Studio',url:`${(process.env.LMSTUDIO_URL||'http://127.0.0.1:1234').replace(/[/]$/,'')}/v1/models`,modelsKey:'data'}
 ];
 for(const endpoint of endpoints){
  try{
   const response=await fetch(endpoint.url,{signal:AbortSignal.timeout(5000)});
   if(!response.ok)continue;
   const body=await response.json();
   if(Array.isArray(body[endpoint.modelsKey])&&body[endpoint.modelsKey].length){
    modelAvailable=true;return true;
   }
  }catch{/* Try next local provider. */}
 }
 modelAvailable=false;console.error('No configured cloud provider or reachable local model server; queue will remain pending');
 return false;
}
async function heartbeat(status){
 if(status!==reportedStatus || Date.now()-reportedAt>30000){
  await rpc('report_agent_worker_heartbeat',{p_worker_id:WORKER_ID,p_status:status});
  reportedAt=Date.now();reportedStatus=status;
 }
}

async function rpc(name,body={}){const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{method:'POST',headers,body:JSON.stringify(body)});if(!response.ok)throw new Error(`${name}: ${response.status} ${await response.text()}`);const text=await response.text();return text?JSON.parse(text):null}
async function tableGet(table,filter,select='*'){
 const url=new URL(`${SUPABASE_URL}/rest/v1/${table}`);
 url.searchParams.set('select',select);
 for(const [key,value] of Object.entries(filter))url.searchParams.set(key,'eq.'+String(value));
 const response=await fetch(url,{headers,signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw new Error(`Cannot load ${table}: ${response.status}`);
 return (await response.json())[0]||null;
}
async function tablePost(table,payload){
 const response=await fetch(`${SUPABASE_URL}/rest/v1/${table}`,{method:'POST',headers:{...headers,Prefer:'return=minimal'},body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw new Error(`Cannot record ${table}: ${response.status}`);
}
async function userSettings(kind,runId){
 const record=await tableGet(kind==='agent'?'agent_runs':'planning_requests',{id:runId},'requested_by');
 if(!record?.requested_by)throw new Error('Queued job is missing its requester');
 const settings=await tableGet('ai_user_settings',{user_id:record.requested_by});
 return {userId:record.requested_by,settings:settings||{
  provider:process.env.AI_DEFAULT_PROVIDER||'ollama',
  model_id:process.env.AI_DEFAULT_MODEL||MODEL,
  fallback_enabled:false,fallback_provider:'openai',fallback_model:'gpt-4.1-mini',
  local_only:false,max_monthly_runs:100,max_run_steps:6
 }};
}
async function usageThisMonth(userId){
 const start=new Date();start.setUTCDate(1);start.setUTCHours(0,0,0,0);
 const url=new URL(`${SUPABASE_URL}/rest/v1/ai_usage_events`);
 url.searchParams.set('select','id');url.searchParams.set('limit','1');url.searchParams.set('user_id','eq.'+userId);
 url.searchParams.set('created_at','gte.'+start.toISOString());
 const response=await fetch(url,{headers:{...headers,Prefer:'count=exact'},signal:AbortSignal.timeout(12000)});
 if(!response.ok)throw new Error('Cannot verify monthly AI budget');
 return Number(response.headers.get('content-range')?.split('/')[1]||0);
}
const PROVIDER_KEYS={openai:'OPENAI_API_KEY',moonshot:'MOONSHOT_API_KEY',zai:'ZAI_API_KEY',openrouter:'OPENROUTER_API_KEY',anthropic:'ANTHROPIC_API_KEY'};
async function credentialsFor(userId,settings){
 const env={...process.env};
 for(const provider of new Set([settings.provider,...(settings.fallback_enabled&&!settings.local_only?[settings.fallback_provider]:[])])){
  const envName=PROVIDER_KEYS[provider];
  if(!envName)continue;
  // The encrypted Vault key belongs to the task requester and is never returned to the browser.
  const key=await rpc('ai_worker_provider_key',{p_user_id:userId,p_provider:provider});
  if(typeof key==='string'&&key)env[envName]=key;
 }
 return env;
}
async function processWork(work,workerId){
 const lease=setInterval(()=>void rpc('renew_productivity_lease',{p_kind:work.kind,p_id:work.id,p_worker_id:workerId}).catch(error=>console.error('Lease renewal failed',error)),60000);
 try{
  const {userId,settings}=await userSettings(work.kind,work.id);
  if(await usageThisMonth(userId)>=settings.max_monthly_runs)throw new Error('Monthly AI task allowance reached');
  const prompt=work.kind==='agent'
   ?`Complete this Glassboard card safely. Return concise JSON with summary and suggestedChanges. You cannot directly execute external actions.\\n${JSON.stringify(work.input)}`
   :`Create a Glassboard plan as JSON: {"title":string,"lists":[{"title":string,"cards":[{"title":string,"priority":"low|medium|high|urgent","description":string}]}]}.\\nPrompt: ${work.prompt}`;
  const modelEnvironment=await credentialsFor(userId,settings);
  const result=await generateWithFallback({settings,prompt,json:true,env:modelEnvironment,signal:AbortSignal.timeout(180000)});
  // Count actual model usage, not an estimated fixed credit amount.
  await tablePost('ai_usage_events',{run_id:work.kind==='agent'?work.id:null,user_id:userId,provider:result.provider,model_id:result.model,input_tokens:result.inputTokens,output_tokens:result.outputTokens,duration_ms:result.durationMs,success:true});
  let parsed;
  try{parsed=JSON.parse(result.text)}catch{throw new Error('AI provider response is not valid JSON')}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new Error('AI provider returned an invalid proposal');
  if(work.kind==='agent')await rpc('complete_agent_run',{p_run_id:work.id,p_result:parsed,p_worker_id:workerId});
  else await rpc('complete_planning_request',{p_request_id:work.id,p_proposal:parsed,p_model:result.model,p_worker_id:workerId});
 }catch(error){
  await rpc('fail_productivity_work',{p_kind:work.kind,p_id:work.id,p_error:String(error instanceof Error?error.message:error).slice(0,2000),p_worker_id:workerId});
  throw error;
 }finally{clearInterval(lease)}
}
async function processEmail(job,workerId){const heartbeat=setInterval(()=>void rpc('renew_email_reminder_lease',{p_queue_id:job.id,p_worker_id:workerId}).catch(error=>console.error('Lease renewal failed',error)),60000);try{if(!EMAIL_DELIVERY_URL)throw new Error('EMAIL_DELIVERY_URL is not configured');await rpc('renew_email_reminder_lease',{p_queue_id:job.id,p_worker_id:workerId});const authorized=await rpc('authorize_email_reminder_delivery',{p_queue_id:job.id,p_worker_id:workerId});if(!authorized)return;const payload={recipientEmail:authorized.recipientEmail,cardTitle:authorized.cardTitle,remindAt:authorized.remindAt,cardId:authorized.cardId};const response=await fetch(EMAIL_DELIVERY_URL,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':job.id},body:JSON.stringify(payload)});if(!response.ok)throw new Error(`Email delivery: ${response.status} ${await response.text()}`);await rpc('complete_email_reminder',{p_queue_id:job.id,p_worker_id:workerId})}catch(error){await rpc('fail_email_reminder',{p_queue_id:job.id,p_error:String(error instanceof Error?error.message:error).slice(0,2000),p_worker_id:workerId});throw error}finally{clearInterval(heartbeat)}}
async function tick(){const workerId=WORKER_ID;await rpc('enqueue_due_reminders',{});await rpc('generate_recurring_cards',{});const ready=await checkModel();await heartbeat(ready?'ready':'unavailable');const work=ready?await rpc('claim_productivity_work',{p_worker_id:workerId}):null;if(work){await processWork(work,workerId);return true}const email=await rpc('claim_email_reminder',{p_worker_id:workerId});if(email){await processEmail(email,workerId);return true}return false}
while(true){try{const worked=await tick();if(ONCE)break;if(!worked)await new Promise(resolve=>setTimeout(resolve,POLL_MS))}catch(error){console.error(error);if(ONCE)process.exitCode=1;else await new Promise(resolve=>setTimeout(resolve,POLL_MS));if(ONCE)break}}
