import {useEffect,useRef,useState,type FormEvent} from 'react';
import {Bot,Send,X,RefreshCw,Settings2} from 'lucide-react';
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
 useEffect(()=>{
  let alive=true;
  setMessages([]);setError('');setLoading(true);setSettings(null);
  if(!repo){setLoading(false);return}
  const refresh=async()=>{
   try{
    const [items,options]=await Promise.all([repo.aiChatMessages(boardId),repo.getAISettings(userId)]);
    if(alive){setMessages(items);setSettings(options);setError('')}
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
  if(!repo||!text||sending||busy)return;
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
     <div className="ai-chat-bubble">
      {message.status==='queued'||message.status==='running'?<span className="ai-chat-pending"><RefreshCw size={14}/>{message.status==='queued'?'Waiting for an AI worker…':'Generating a response…'}</span>:
      message.status==='error'?<span role="alert">AI error: {message.error||'Could not generate a response'}</span>:
      <span className="ai-chat-message-text">{message.content}</span>}
     </div>
     {message.role==='assistant'&&message.provider&&message.status==='done'&&<small>{message.provider} · {message.model_id}</small>}
    </div>)}
    <div ref={bottomRef}/>
   </div>
   <form className="ai-chat-composer" onSubmit={send}>
    {error&&<p role="alert" className="ai-chat-error">{error}</p>}
    {!repo&&<p className="ai-chat-error">Connect Supabase to chat with your AI model.</p>}
    <div className="ai-chat-compose-row">
     <textarea aria-label="Message AI" placeholder="Ask your AI anything…" rows={2} maxLength={4000} value={draft} disabled={!repo||sending||busy} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();e.currentTarget.form?.requestSubmit()}}}/>
     <button type="submit" aria-label="Send message" title="Send message" disabled={!repo||!draft.trim()||sending||busy}><Send size={19}/></button>
    </div>
    <small>{busy?'Wait for the current reply before sending another message.':'Enter to send · Shift+Enter for a new line'}</small>
   </form>
  </section>
 </div>;
}
