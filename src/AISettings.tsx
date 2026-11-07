import {useEffect,useState} from 'react';
import {Bot,Cloud,HardDrive,ShieldCheck,RefreshCw,Save,Activity,KeyRound,AlertTriangle} from 'lucide-react';
import type {SupabaseRepository,AISettingsData,AIProvider} from './supabase';
import {DEFAULT_AI_SETTINGS} from './supabase';

const providers:{value:AIProvider;label:string;type:string;hint:string;models:string[]}[]=[
 {value:'ollama',label:'Ollama',type:'Local',hint:'Runs on a connected worker computer with Ollama. No public port required.',models:['llama3.2','qwen3:4b','qwen3:8b']},
 {value:'lmstudio',label:'LM Studio',type:'Local',hint:'Runs on a connected worker computer with the LM Studio server.',models:['local-model']},
 {value:'openai',label:'OpenAI',type:'Cloud API',hint:'Requires OPENAI_API_KEY on the private worker.',models:['gpt-4.1-mini','gpt-4.1']},
 {value:'moonshot',label:'Moonshot / Kimi',type:'Cloud API',hint:'Requires MOONSHOT_API_KEY on the private worker.',models:['kimi-k3','kimi-k2.6']},
 {value:'zai',label:'Z.ai / GLM',type:'Cloud API',hint:'Requires ZAI_API_KEY on the private worker.',models:['glm-4.7','glm-4.5']},
 {value:'openrouter',label:'OpenRouter',type:'Cloud API',hint:'Requires OPENROUTER_API_KEY on the private worker.',models:['openai/gpt-4.1-mini','anthropic/claude-sonnet-4.5']},
 {value:'anthropic',label:'Anthropic',type:'Cloud API',hint:'Requires ANTHROPIC_API_KEY on the private worker.',models:['claude-sonnet-4-5']},
 {value:'nvidia',label:'NVIDIA NIM',type:'Cloud API',hint:'Use an NVIDIA API key from build.nvidia.com. Cloud chat needs no local worker; model availability may change.',models:['mistralai/mistral-large-4-1t-a52b']}
];
const local=(p:AIProvider)=>p==='ollama'||p==='lmstudio';
export function AISettings({repo,userId}:{repo:SupabaseRepository|null;userId:string}){
 const [settings,setSettings]=useState<AISettingsData>({...DEFAULT_AI_SETTINGS});
 const [busy,setBusy]=useState(false),[loading,setLoading]=useState(true);
 const [notice,setNotice]=useState(''),[error,setError]=useState('');
 const [health,setHealth]=useState<{workerOnline:boolean;queuedRuns:number;runningRuns:number}|null>(null);
 const [usage,setUsage]=useState<{runs:number;inputTokens:number;outputTokens:number;estimatedCostUsd:number}|null>(null);
 const [custom,setCustom]=useState(false);
 const [keyInput,setKeyInput]=useState('');const [storedKeys,setStoredKeys]=useState<string[]>([]);const [keyBusy,setKeyBusy]=useState(false);
 useEffect(()=>{let active=true;if(!repo){setLoading(false);return}
  void Promise.all([repo.getAISettings(userId),repo.aiWorkerHealth(),repo.aiMonthlyUsage(),repo.aiProviderKeys()]).then(([saved,worker,metrics,keys])=>{if(active){setSettings(saved);setHealth(worker);setUsage(metrics);setStoredKeys(keys);setCustom(!providers.find(p=>p.value===saved.provider)?.models.includes(saved.model_id))}}).catch(e=>{if(active)setError(e instanceof Error?e.message:'Could not load AI settings')}).finally(()=>{if(active)setLoading(false)});
  return()=>{active=false};
 },[repo,userId]);
 const update=(patch:Partial<AISettingsData>)=>{setNotice('');setError('');setSettings(s=>({...s,...patch}))};
 const pickProvider=(value:AIProvider)=>{const item=providers.find(p=>p.value===value)!;setKeyInput('');setCustom(false);update({provider:value,model_id:item.models[0],local_only:local(value)?settings.local_only:false,fallback_enabled:settings.local_only&&local(value)?false:settings.fallback_enabled})};
 const save=async()=>{if(!repo){setError('Connect Glassboard to save AI preferences');return}setBusy(true);setError('');setNotice('');try{
  if(settings.local_only&&(!local(settings.provider)||settings.fallback_enabled&&!local(settings.fallback_provider)))throw new Error('Local-only processing requires a local model and no cloud fallback');
  await repo.saveAISettings(userId,settings);setNotice('AI settings saved. Future queued jobs will use these preferences.');
 }catch(e){setError(e instanceof Error?e.message:'Could not save AI settings')}finally{setBusy(false)}};
 const storeKey=async()=>{if(!repo||!keyInput.trim())return;setKeyBusy(true);setError('');setNotice('');try{await repo.saveProviderKey(settings.provider,keyInput);setKeyInput('');setStoredKeys(await repo.aiProviderKeys());setNotice('API key saved securely in Supabase Vault. The key will not be displayed again.')}catch(e){setError(e instanceof Error?e.message:'Could not save API key')}finally{setKeyBusy(false)}};
 const revokeKey=async()=>{if(!repo)return;setKeyBusy(true);setError('');setNotice('');try{await repo.revokeProviderKey(settings.provider);setStoredKeys(await repo.aiProviderKeys());setKeyInput('');setNotice('Provider key revoked.')}catch(e){setError(e instanceof Error?e.message:'Could not revoke API key')}finally{setKeyBusy(false)}};
 const current=providers.find(p=>p.value===settings.provider)!;
 return <div className="ai-settings">
  <div className="ai-settings-intro"><div className="ai-settings-icon"><Bot size={21}/></div><div><h2>AI Providers & Models</h2><p>Choose how Glassboard executes tasks. Cloud chat runs securely through Supabase; local models and AI tasks need a connected worker.</p></div></div>
  {loading?<p role="status">Loading AI configuration…</p>:<>
   <section className="ai-settings-section"><div className="ai-section-heading"><Cloud size={17}/><div><h3>Primary provider</h3><p>Which AI system should run your queued cards?</p></div></div>
    <div className="ai-provider-grid">{providers.map(p=><button type="button" key={p.value} className={settings.provider===p.value?'ai-provider-option selected':'ai-provider-option'} aria-pressed={settings.provider===p.value} onClick={()=>pickProvider(p.value)}><strong>{p.label}</strong><small>{p.type}</small></button>)}</div>
    <div className="ai-field"><label htmlFor="ai-model">Model</label><select id="ai-model" value={custom?'__custom__':settings.model_id} onChange={e=>{if(e.target.value==='__custom__'){setCustom(true);update({model_id:''})}else{setCustom(false);update({model_id:e.target.value})}}}>{current.models.map(m=><option value={m} key={m}>{m}</option>)}{!current.models.includes(settings.model_id)&&!custom&&<option value={settings.model_id}>{settings.model_id}</option>}<option value="__custom__">Custom model ID…</option></select></div>
    {custom&&<div className="ai-field"><label htmlFor="ai-custom-model">Custom model ID</label><input id="ai-custom-model" autoComplete="off" maxLength={120} value={settings.model_id} placeholder="Model ID registered with this provider" onChange={e=>update({model_id:e.target.value})}/></div>}
    <p className="ai-settings-hint"><KeyRound size={14}/>{current.hint} Cloud providers can use an encrypted account API key below or a key configured on the worker.</p>
   </section>
   <section className="ai-settings-section"><div className="ai-section-heading"><KeyRound size={17}/><div><h3>API connections</h3><p>Encrypted provider credentials stored in Supabase Vault. Glassboard never displays saved keys.</p></div></div>
    {local(settings.provider)?<p className="ai-settings-hint"><HardDrive size={14}/>Local providers connect through a running worker on your own computer. API keys are not needed for these local connections.</p>:<>
      <div className="ai-worker-status"><span className={storedKeys.includes(settings.provider)?'ai-status-dot online':'ai-status-dot'}/><strong>{storedKeys.includes(settings.provider)?'Account key saved':'No account key saved'}</strong><span>{current.label}</span></div>
      <div className="ai-field"><label htmlFor="ai-api-key">API key for {current.label}</label><input id="ai-api-key" type="password" autoComplete="new-password" spellCheck={false} value={keyInput} onChange={e=>setKeyInput(e.target.value)} placeholder="Paste new key (never shown after saving)" maxLength={512}/></div>
      <div className="ai-key-actions"><button type="button" disabled={keyBusy||keyInput.trim().length<10} onClick={()=>void storeKey()}>{keyBusy?'Updating…':'Save encrypted key'}</button>{storedKeys.includes(settings.provider)&&<button type="button" disabled={keyBusy} onClick={()=>void revokeKey()}>Revoke saved key</button>}</div>
      <p className="ai-settings-hint"><ShieldCheck size={14}/>Only trusted backend services can retrieve your key for an authorized job. Changing providers does not delete existing saved credentials.</p>
     </>}
   </section>
   <section className="ai-settings-section"><div className="ai-section-heading"><RefreshCw size={17}/><div><h3>Reliability & fallback</h3><p>Choose what happens when your primary model is unavailable.</p></div></div>
    <label className="ai-toggle"><div><strong>Automatic fallback</strong><small>Retry with an approved backup provider if the primary call fails.</small></div><input type="checkbox" checked={settings.fallback_enabled} disabled={settings.local_only} onChange={e=>update({fallback_enabled:e.target.checked})}/></label>
    {settings.fallback_enabled&&<div className="ai-two-col"><div className="ai-field"><label htmlFor="ai-fallback-provider">Backup provider</label><select id="ai-fallback-provider" value={settings.fallback_provider} onChange={e=>{const p=e.target.value as AIProvider;update({fallback_provider:p,fallback_model:providers.find(x=>x.value===p)!.models[0]})}}>{providers.map(p=><option key={p.value} value={p.value}>{p.label}</option>)}</select></div><div className="ai-field"><label htmlFor="ai-fallback-model">Backup model</label><input id="ai-fallback-model" maxLength={120} value={settings.fallback_model} onChange={e=>update({fallback_model:e.target.value})}/></div></div>}
    <label className="ai-toggle"><div><strong>Local-only processing</strong><small>Prevent cloud fallback. Requires a connected Ollama or LM Studio worker.</small></div><input type="checkbox" checked={settings.local_only} disabled={!local(settings.provider)} onChange={e=>update({local_only:e.target.checked,fallback_enabled:e.target.checked?false:settings.fallback_enabled})}/></label>
   </section>
   <section className="ai-settings-section"><div className="ai-section-heading"><ShieldCheck size={17}/><div><h3>Usage & safeguards</h3><p>Set limits and review this month's recorded model usage.</p></div></div>
    <div className="ai-two-col"><div className="ai-field"><label htmlFor="ai-monthly-limit">Personal monthly job limit</label><input type="number" id="ai-monthly-limit" min="1" max="10000" value={settings.max_monthly_runs} onChange={e=>update({max_monthly_runs:Number(e.target.value)})}/></div><div className="ai-field"><label htmlFor="ai-steps-limit">Maximum tool steps (future workflows)</label><input id="ai-steps-limit" type="number" min="1" max="25" value={settings.max_run_steps} onChange={e=>update({max_run_steps:Number(e.target.value)})}/></div></div>
    <div className="ai-metrics"><div><strong>{usage?.runs??'—'}</strong><small>Metered calls this month</small></div><div><strong>{usage?Number(usage.inputTokens+usage.outputTokens).toLocaleString():'—'}</strong><small>Tokens processed</small></div><div><strong>{usage?.estimatedCostUsd?'$'+usage.estimatedCostUsd.toFixed(4):'Not priced'}</strong><small>Provider cost estimate</small></div></div>
    <p className="ai-settings-hint"><AlertTriangle size={14}/>Usage metering is available for updated workers. API prices and local-compute costs are not yet automatically reconciled.</p>
   </section>
   <section className="ai-settings-section"><div className="ai-section-heading"><Activity size={17}/><div><h3>Worker status</h3><p>Background processing requires a running worker with its provider configured.</p></div></div><div className="ai-worker-status"><span className={health?.workerOnline?'ai-status-dot online':'ai-status-dot'}/><strong>{health?.workerOnline?'Worker online':'Worker offline'}</strong><span>{health?.queuedRuns??0} queued · {health?.runningRuns??0} running</span></div><p className="ai-settings-hint"><HardDrive size={14}/>For local AI, the worker and its model server must run on the same trusted network. Glassboard never publishes your local model server directly.</p></section>
   {error&&<p role="alert" className="ai-settings-error">{error}</p>}
   {notice&&<p role="status" className="ai-settings-success">{notice}</p>}
   <div className="ai-settings-footer"><button type="button" className="ai-save-button" disabled={busy||!settings.model_id.trim()} onClick={()=>void save()}><Save size={16}/>{busy?'Saving…':'Save AI settings'}</button></div>
  </>}
 </div>
}
