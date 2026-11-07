import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Bot,Send,X,Settings2,UserRound} from 'lucide-react';
import type {AIChatMessage,SupabaseRepository,AISettingsData} from './supabase';

export function AIChat({repo,userId,boardId,onClose,onSettings}:{repo:SupabaseRepository|null;userId:string;boardId:string;onClose:()=>void;onSettings:()=>void}){
 const [messages,setMessages]=useState<AIChatMessage[]>([]);
 const [draft,setDraft]=useState('');
 const [loading,setLoading]=useState(true);
 const [sending,setSending]=useState(false);
 const [error,setError]=useState('');
 const [settings,setSettings]=useState<AISettingsData|null>(null);
 const bottomRef=useRef<HTMLDivElement>(null);
 const busy=messages.some(m=>m.role==='assistant'&&(m.status==='queued'||m.status==='running'));
 const providerMissing=Boolean(settings&&(settings.provider==='ollama'||settings.provider==='lmstudio'));
 const modelLooksLikeKey=Boolean(settings&&/^(nvapi-|sk-|sk_|AIza|ghp_|glpat-|hf_)/i.test(settings.model_id));
 useEffect(()=>{
  let alive=true;
  setMessages([]);setError('');setLoading(true);setSettings(null);
  if(!repo){setLoading(false);return}
  const refresh=async()=>{
   try{
    const [items,options]=await Promise.all([repo.aiChatMessages(boardId),repo.getAISettings(userId)]);
    if(alive){setMessages(items);setSettings(options)}
   }catch(cause){if(alive)setError(cause instanceof Error?cause.message:'Unable to load chat')}
   finally{if(alive)setLoading(false)}
  };
  void refresh();
  const timer=setInterval(()=>{if(document.visibilityState!=='hidden')void refresh()},2500);
  return()=>{alive=false;clearInterval(timer)};
 },[repo,userId,boardId]);
 useEffect(()=>{bottomRef.current?.scrollIntoView({block:'end',behavior:'smooth'})},[messages.length,messages[messages.length-1]?.status]);
 const send=async(event:FormEvent)=>{
  event.preventDefault();
  const text=draft.trim();
  if(!repo||!text||sending||busy||providerMissing||modelLooksLikeKey)return;
  setSending(true);setError('');
  try{
   const replyId=await repo.aiChatSend(boardId,text);
   setDraft('');
   setMessages(await repo.aiChatMessages(boardId));
   await repo.aiChatGenerate(replyId);
   setMessages(await repo.aiChatMessages(boardId));
  }catch(cause){setError(cause instanceof Error?cause.message:'Unable to send message')}
  finally{setSending(false)}
 };
 return <div className="ai-chat-backdrop" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}>
  <section className="ai-chat-panel" role="dialog" aria-modal="true" aria-label="Chat with AI" onKeyDown={e=>{if(e.key==='Escape')onClose()}}>
   <header className="ai-chat-header">
    <div className="ai-chat-header-icon"><Bot size={19}/></div>
    <div className="ai-chat-heading"><h2>Chat with AI</h2><p>{settings?settings.provider+' · '+settings.model_id:'Your selected AI model'}</p></div>
    <button type="button" aria-label="Configure AI model" title="AI settings" onClick={onSettings}><Settings2 size={18}/></button>
    <button type="button" aria-label="Close AI chat" onClick={onClose}><X size={20}/></button>
   </header>
   <div className="ai-chat-history" aria-live="polite" aria-busy={loading}>
    {!messages.length&&!loading&&<div className="ai-chat-welcome"><Bot size={30}/><h3>How can I help?</h3><p>Chat directly with your selected model. Your conversation is private to your account on this board.</p></div>}
    {loading&&<p className="ai-chat-note">Loading conversation…</p>}
    {messages.map(message=><div key={message.id} className={'ai-chat-turn '+message.role}>
     <div className="ai-chat-sender">
      <span className="ai-chat-sender-icon" aria-hidden="true">{message.role==='user'?<UserRound size={13}/>:<Bot size={14}/>}</span>
      <strong>{message.role==='user'?'You':'Glassboard AI'}</strong>
     </div>
     <div className={'ai-chat-bubble'+(message.status==='error'?' ai-chat-bubble-error':'')}>
      {message.status==='queued'||message.status==='running'?
       <span className="ai-chat-typing" role="status" aria-label="AI is preparing a reply">
        <span className="ai-chat-typing-dots" aria-hidden="true"><i/><i/><i/></span>
        <span className="ai-chat-sr-only">AI is typing</span>
       </span>:
      message.status==='error'?<span role="alert">{message.error||'The AI could not generate a response.'}</span>:
      <span className="ai-chat-message-text">{message.content}</span>}
     </div>
     {message.role==='assistant'&&message.provider&&message.status==='done'&&<small>{message.provider} · {message.model_id}</small>}
    </div>)}
    <div ref={bottomRef}/>
   </div>
   <form className="ai-chat-composer" onSubmit={send}>
    {providerMissing&&<p role="alert" className="ai-chat-error">A local model requires an online AI worker. Select a cloud provider in AI Settings to chat directly.</p>}
    {modelLooksLikeKey&&<p role="alert" className="ai-chat-error">An API key was entered as the model name. Change the model in AI Settings and save a newly rotated key under API connections.</p>}
    {error&&<p role="alert" className="ai-chat-error">{error}</p>}
    {!repo&&<p className="ai-chat-error">Connect Supabase to chat with your AI model.</p>}
    <div className="ai-chat-compose-row">
     <textarea aria-label="Message AI" placeholder="Ask your AI anything…" rows={2} maxLength={4000} value={draft} disabled={!repo||sending||busy||providerMissing||modelLooksLikeKey} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();e.currentTarget.form?.requestSubmit()}}}/>
     <button type="submit" className="ai-chat-send-button" aria-label="Send message" title="Send message" disabled={!repo||!draft.trim()||sending||busy||providerMissing||modelLooksLikeKey}><Send size={17}/><span>Send</span></button>
    </div>
    <small>{busy?'Wait for the current reply before sending another message.':'Enter to send · Shift+Enter for a new line'}</small>
   </form>
  </section>
 </div>;
}
