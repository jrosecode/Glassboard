#!/usr/bin/env node
import {randomUUID} from 'node:crypto';
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
 try{
  const response=await fetch(`${OLLAMA_URL}/api/tags`,{signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error(`Ollama health: ${response.status}`);
  const json=await response.json();
  const modelNames=(json.models??[]).map(item=>item.name||item.model);
  const resolved=MODEL.includes(':')?MODEL:`${MODEL}:latest`;
  modelAvailable=modelNames.includes(MODEL)||modelNames.includes(resolved);
  if(!modelAvailable)console.error(`Ollama model ${MODEL} is not installed; queued work remains unclaimed`);
 }catch(e){modelAvailable=false;console.error('AI model is unavailable; queued tasks are preserved:',String(e))}
 return modelAvailable;
}
async function heartbeat(status){
 if(status!==reportedStatus || Date.now()-reportedAt>30000){
  await rpc('report_agent_worker_heartbeat',{p_worker_id:WORKER_ID,p_status:status});
  reportedAt=Date.now();reportedStatus=status;
 }
}

async function rpc(name,body={}){const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{method:'POST',headers,body:JSON.stringify(body)});if(!response.ok)throw new Error(`${name}: ${response.status} ${await response.text()}`);const text=await response.text();return text?JSON.parse(text):null}
async function ollama(prompt,json=false){const response=await fetch(`${OLLAMA_URL}/api/generate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:MODEL,prompt,stream:false,format:json?'json':undefined})});if(!response.ok)throw new Error(`Ollama: ${response.status} ${await response.text()}`);const result=await response.json();return result.response}
async function processWork(work,workerId){const heartbeat=setInterval(()=>void rpc('renew_productivity_lease',{p_kind:work.kind,p_id:work.id,p_worker_id:workerId}).catch(error=>console.error('Lease renewal failed',error)),60000);try{if(work.kind==='agent'){const response=await ollama(`Complete this Glassboard card safely. Return concise JSON with summary and suggestedChanges.\n${JSON.stringify(work.input)}`,true);await rpc('complete_agent_run',{p_run_id:work.id,p_result:JSON.parse(response),p_worker_id:workerId})}else{const response=await ollama(`Create a Glassboard plan as JSON: {"title":string,"lists":[{"title":string,"cards":[{"title":string,"priority":"low|medium|high|urgent","description":string}]}]}.\nPrompt: ${work.prompt}`,true);await rpc('complete_planning_request',{p_request_id:work.id,p_proposal:JSON.parse(response),p_model:MODEL,p_worker_id:workerId})}}catch(error){await rpc('fail_productivity_work',{p_kind:work.kind,p_id:work.id,p_error:String(error instanceof Error?error.message:error).slice(0,2000),p_worker_id:workerId});throw error}finally{clearInterval(heartbeat)}}
async function processEmail(job,workerId){const heartbeat=setInterval(()=>void rpc('renew_email_reminder_lease',{p_queue_id:job.id,p_worker_id:workerId}).catch(error=>console.error('Lease renewal failed',error)),60000);try{if(!EMAIL_DELIVERY_URL)throw new Error('EMAIL_DELIVERY_URL is not configured');await rpc('renew_email_reminder_lease',{p_queue_id:job.id,p_worker_id:workerId});const authorized=await rpc('authorize_email_reminder_delivery',{p_queue_id:job.id,p_worker_id:workerId});if(!authorized)return;const payload={recipientEmail:authorized.recipientEmail,cardTitle:authorized.cardTitle,remindAt:authorized.remindAt,cardId:authorized.cardId};const response=await fetch(EMAIL_DELIVERY_URL,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':job.id},body:JSON.stringify(payload)});if(!response.ok)throw new Error(`Email delivery: ${response.status} ${await response.text()}`);await rpc('complete_email_reminder',{p_queue_id:job.id,p_worker_id:workerId})}catch(error){await rpc('fail_email_reminder',{p_queue_id:job.id,p_error:String(error instanceof Error?error.message:error).slice(0,2000),p_worker_id:workerId});throw error}finally{clearInterval(heartbeat)}}
async function tick(){const workerId=WORKER_ID;await rpc('enqueue_due_reminders',{});await rpc('generate_recurring_cards',{});const ready=await checkModel();await heartbeat(ready?'ready':'unavailable');const work=ready?await rpc('claim_productivity_work',{p_worker_id:workerId}):null;if(work){await processWork(work,workerId);return true}const email=await rpc('claim_email_reminder',{p_worker_id:workerId});if(email){await processEmail(email,workerId);return true}return false}
while(true){try{const worked=await tick();if(ONCE)break;if(!worked)await new Promise(resolve=>setTimeout(resolve,POLL_MS))}catch(error){console.error(error);if(ONCE)process.exitCode=1;else await new Promise(resolve=>setTimeout(resolve,POLL_MS));if(ONCE)break}}
