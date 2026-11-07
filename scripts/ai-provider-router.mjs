// Model-independent inference adapter. Provider endpoints are fixed and cannot be supplied by end users.
const PROVIDERS={
 openai:{base:'https://api.openai.com/v1',key:'OPENAI_API_KEY',defaultModel:'gpt-4.1-mini'},
 moonshot:{base:'https://api.moonshot.ai/v1',key:'MOONSHOT_API_KEY',defaultModel:'kimi-k2.5'},
 zai:{base:'https://api.z.ai/api/paas/v4',key:'ZAI_API_KEY',defaultModel:'glm-4.7'},
 openrouter:{base:'https://openrouter.ai/api/v1',key:'OPENROUTER_API_KEY',defaultModel:'openai/gpt-4.1-mini'},
 ollama:{base:'http://127.0.0.1:11434/v1',key:null,defaultModel:'llama3.2'},
 lmstudio:{base:'http://127.0.0.1:1234/v1',key:null,defaultModel:'local-model'},
 anthropic:{base:'https://api.anthropic.com',key:'ANTHROPIC_API_KEY',defaultModel:'claude-sonnet-4-5'}
};
export const providerNames=Object.keys(PROVIDERS);
export function providerAvailable(name,env=process.env){
 const item=PROVIDERS[name];
 return Boolean(item&&(!item.key||env[item.key]));
}
export function resolveProvider(name,env=process.env){
 const item=PROVIDERS[name];
 if(!item)throw new Error('Unsupported AI provider');
 if(item.key&&!env[item.key])throw new Error(`Provider ${name} is not configured on this worker`);
 // Never accept arbitrary URLs from preferences. Private model URLs are server-managed only.
 const url=name==='ollama'?(env.OLLAMA_URL||'http://127.0.0.1:11434'):name==='lmstudio'?(env.LMSTUDIO_URL||'http://127.0.0.1:1234'):item.base;
 return {base:(name==='ollama'||name==='lmstudio'?url.replace(/\\/$/,'')+'/v1':url),key:item.key?env[item.key]:null,defaultModel:item.defaultModel};
}
async function responseBody(res){
 const raw=await res.text();
 if(!res.ok)throw new Error(`AI provider HTTP ${res.status}: ${raw.slice(0,350)}`);
 try{return JSON.parse(raw)}catch{throw new Error('AI provider returned invalid JSON')}
}
export async function generate({provider,model,prompt,json=false,env=process.env,signal}){
 const config=resolveProvider(provider,env);
 const modelId=model||config.defaultModel;
 const start=Date.now();
 if(provider==='anthropic'){
  const data=await responseBody(await fetch(config.base+'/v1/messages',{method:'POST',signal,headers:{'x-api-key':config.key,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model:modelId,max_tokens:2048,messages:[{role:'user',content:json?prompt+'\\nReturn only valid JSON.':prompt}]})}));
  return {text:(data.content||[]).filter(v=>v.type==='text').map(v=>v.text).join(''),model:modelId,provider,inputTokens:data.usage?.input_tokens||0,outputTokens:data.usage?.output_tokens||0,durationMs:Date.now()-start};
 }
 const data=await responseBody(await fetch(config.base+'/chat/completions',{method:'POST',signal,headers:{'content-type':'application/json',...(config.key?{Authorization:`Bearer ${config.key}`}:{})},body:JSON.stringify({model:modelId,messages:[{role:'user',content:prompt}],temperature:0.2,...(json?{response_format:{type:'json_object'}}:{})})}));
 const text=data.choices?.[0]?.message?.content;
 if(typeof text!=='string'||!text.trim())throw new Error('Provider returned an empty response');
 return {text,model:modelId,provider,inputTokens:data.usage?.prompt_tokens||0,outputTokens:data.usage?.completion_tokens||0,durationMs:Date.now()-start};
}
export async function generateWithFallback({settings,prompt,json=false,env=process.env,signal}){
 const primary={provider:settings.provider,model:settings.model_id};
 try{return await generate({...primary,prompt,json,env,signal})}
 catch(error){
  if(!settings.fallback_enabled||settings.local_only||settings.fallback_provider===settings.provider&&settings.fallback_model===settings.model_id)throw error;
  if(!providerAvailable(settings.fallback_provider,env))throw error;
  try{return await generate({provider:settings.fallback_provider,model:settings.fallback_model,prompt,json,env,signal})}
  catch(fallbackError){throw new Error(`Primary and fallback providers failed: ${String(error)}; ${String(fallbackError)}`)}
 }
}
