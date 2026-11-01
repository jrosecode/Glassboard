#!/usr/bin/env node
/* global process, console, fetch, setTimeout */
const required=['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY'];
for(const key of required)if(!process.env[key]){console.error(`Missing ${key}`);process.exit(2)}
const SUPABASE_URL=process.env.SUPABASE_URL.replace(/\/$/,'');
const SUPABASE_SERVICE_ROLE_KEY=process.env.SUPABASE_SERVICE_ROLE_KEY;
const OLLAMA_URL=(process.env.OLLAMA_URL??'http://127.0.0.1:11434').replace(/\/$/,'');
const MODEL=process.env.OLLAMA_MODEL??'llama3.2';
const POLL_MS=Number(process.env.WORKER_POLL_MS??2000);
const ONCE=process.argv.includes('--once');
const headers={apikey:SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,'Content-Type':'application/json'};
async function rpc(name,body={}){const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`,{method:'POST',headers,body:JSON.stringify(body)});if(!response.ok)throw new Error(`${name}: ${response.status} ${await response.text()}`);const text=await response.text();return text?JSON.parse(text):null}
async function ollama(prompt,json=false){const response=await fetch(`${OLLAMA_URL}/api/generate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:MODEL,prompt,stream:false,format:json?'json':undefined})});if(!response.ok)throw new Error(`Ollama: ${response.status} ${await response.text()}`);const result=await response.json();return result.response}
async function processWork(work){try{if(work.kind==='agent'){const response=await ollama(`Complete this Glassboard card safely. Return concise JSON with summary and suggestedChanges.\n${JSON.stringify(work.input)}`,true);await rpc('complete_agent_run',{p_run_id:work.id,p_result:JSON.parse(response)})}else{const response=await ollama(`Create a Glassboard plan as JSON: {"title":string,"lists":[{"title":string,"cards":[{"title":string,"priority":"low|medium|high|urgent","description":string}]}]}.\nPrompt: ${work.prompt}`,true);await rpc('complete_planning_request',{p_request_id:work.id,p_proposal:JSON.parse(response),p_model:MODEL})}}catch(error){await rpc('fail_productivity_work',{p_kind:work.kind,p_id:work.id,p_error:String(error instanceof Error?error.message:error).slice(0,2000)});throw error}}
async function tick(){const work=await rpc('claim_productivity_work',{p_worker_id:process.env.WORKER_ID??`local-${process.pid}`});if(!work)return false;await processWork(work);return true}
while(true){try{const worked=await tick();if(ONCE)break;if(!worked)await new Promise(resolve=>setTimeout(resolve,POLL_MS))}catch(error){console.error(error);if(ONCE)process.exitCode=1;else await new Promise(resolve=>setTimeout(resolve,POLL_MS));if(ONCE)break}}
