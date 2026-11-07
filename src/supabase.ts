import {createClient,type SupabaseClient} from '@supabase/supabase-js'; import type {Board,Card,List,Workspace} from './domain';
import type {BoardRole,BoardSharing} from './sharing';
export const config={url:import.meta.env.VITE_SUPABASE_URL as string|undefined,key:import.meta.env.VITE_SUPABASE_ANON_KEY as string|undefined};
export const isConfigured=Boolean(config.url&&config.key&&!config.key.includes('your-'));
export const supabase:SupabaseClient|null=isConfigured?createClient(config.url!,config.key!,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}}):null;
const fail=(error:{message:string}|null)=>{if(error)throw new Error(error.message)};
export type AIProvider='ollama'|'lmstudio'|'openai'|'moonshot'|'zai'|'openrouter'|'anthropic'|'nvidia';
export type AISettingsData={provider:AIProvider;model_id:string;fallback_enabled:boolean;fallback_provider:AIProvider;fallback_model:string;local_only:boolean;max_monthly_runs:number;max_run_steps:number};
export const DEFAULT_AI_SETTINGS:AISettingsData={provider:'ollama',model_id:'llama3.2',fallback_enabled:false,fallback_provider:'openai',fallback_model:'gpt-4.1-mini',local_only:false,max_monthly_runs:100,max_run_steps:6};
export type AIChatMessage={id:string;user_id:string;board_id:string;role:'user'|'assistant';content:string;status:'queued'|'running'|'done'|'error';error:string|null;provider:string|null;model_id:string|null;created_at:string};
export class SupabaseRepository {constructor(private db:SupabaseClient){ } 
 async aiChatMessages(boardId:string):Promise<AIChatMessage[]>{
  const {data,error}=await this.db.from('ai_chat_messages').select('id,user_id,board_id,role,content,status,error,provider,model_id,created_at').eq('board_id',boardId).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(200);
  fail(error);return ((data??[]) as AIChatMessage[]).reverse();
 }
 async aiChatGenerate(replyId:string):Promise<void>{
  const {data,error}=await this.db.functions.invoke('ai-chat',{body:{replyId}});
  if(error){
   let detail='';
   const context=(error as {context?:Response}).context;
   if(context&&typeof context.json==='function'){
    try{const body=await context.json() as {error?:string};if(typeof body?.error==='string')detail=body.error}catch{/* Keep the generic transport failure. */}
   }
   throw new Error(detail||error.message||'Unable to contact AI provider');
  }
  if(data?.error)throw new Error(String(data.error));
 }
 async aiChatSend(boardId:string,content:string):Promise<string>{
  const message=content.trim();
  if(!message||message.length>4000)throw new Error('Messages must be between 1 and 4000 characters');
  const {data,error}=await this.db.rpc('ai_chat_send',{p_board_id:boardId,p_content:message});fail(error);return data as string;
 }

 async getAISettings(userId:string):Promise<AISettingsData>{
  const {data,error}=await this.db.from('ai_user_settings').select('provider,model_id,fallback_enabled,fallback_provider,fallback_model,local_only,max_monthly_runs,max_run_steps').eq('user_id',userId).maybeSingle();
  fail(error);return data?{...DEFAULT_AI_SETTINGS,...data}:DEFAULT_AI_SETTINGS;
 }
 async saveAISettings(userId:string,settings:AISettingsData):Promise<void>{
  if(/^(nvapi-|sk-|sk_|AIza|ghp_|glpat-|hf_)/i.test(settings.model_id)||/^(nvapi-|sk-|sk_|AIza|ghp_|glpat-|hf_)/i.test(settings.fallback_model))throw new Error('An API key was entered as a model name. Choose a model ID and save the key under API connections.');
  if(!settings.model_id.trim()||settings.model_id.length>120||!settings.fallback_model.trim()||settings.fallback_model.length>120)throw new Error('Model IDs must be 1 to 120 characters');
  const {error}=await this.db.from('ai_user_settings').upsert({user_id:userId,...settings,updated_at:new Date().toISOString()},{onConflict:'user_id'});
  fail(error);
 }
 async aiMonthlyUsage():Promise<{runs:number;inputTokens:number;outputTokens:number;estimatedCostUsd:number}>{
  const {data,error}=await this.db.rpc('ai_monthly_usage');fail(error);
  return {runs:Number(data?.runs??0),inputTokens:Number(data?.inputTokens??0),outputTokens:Number(data?.outputTokens??0),estimatedCostUsd:Number(data?.estimatedCostUsd??0)};
 }
 async aiProviderKeys():Promise<string[]>{
  const {data,error}=await this.db.from('ai_provider_credentials').select('provider');
  fail(error);
  return (data??[]).map((r:{provider:string})=>r.provider);
 }
 async saveProviderKey(provider:AIProvider,key:string):Promise<void>{
  if(!['openai','moonshot','zai','openrouter','anthropic','nvidia'].includes(provider))throw new Error('Cloud provider required');
  const {error}=await this.db.rpc('ai_save_provider_key',{p_provider:provider,p_key:key});
  fail(error);
 }
 async revokeProviderKey(provider:AIProvider):Promise<void>{
  const {error}=await this.db.rpc('ai_revoke_provider_key',{p_provider:provider});
  fail(error);
 }
 async aiWorkerHealth():Promise<{workerOnline:boolean;queuedRuns:number;runningRuns:number}>{
  const {data,error}=await this.db.rpc('agent_runtime_health');fail(error);
  return {workerOnline:Boolean(data?.workerOnline),queuedRuns:Number(data?.queuedRuns??0),runningRuns:Number(data?.runningRuns??0)};
 }

 async workspaces(){const {data,error}=await this.db.from('workspaces').select('*').order('created_at');fail(error);return data as Workspace[]}
 async boards(){const {data,error}=await this.db.from('boards').select('*').order('updated_at',{ascending:false});fail(error);return (data??[]).map((b:any)=>({id:b.id,title:b.title,description:b.description??'',background:b.background,favorite:b.is_favorite,workspaceId:b.workspace_id,updatedAt:b.updated_at})) as Board[]}
 async ensureDefaultBoard(){const {data,error}=await this.db.rpc('ensure_default_board');fail(error);const b=data as any;return {id:b.id,title:b.title,description:b.description??'',background:b.background,favorite:b.is_favorite,workspaceId:b.workspace_id,updatedAt:b.updated_at} as Board}
 async lists(boardId:string){const {data,error}=await this.db.from('lists').select('*').eq('board_id',boardId).order('position');fail(error);return (data??[]).map((l:any)=>({...l,boardId:l.board_id,collapsed:l.is_collapsed,kind:l.kind??'normal',color:l.color??null,isPinned:!!l.is_pinned,isWatched:!!l.is_watched,isArchived:!!l.is_archived,automationTrigger:l.automation_trigger??null,automationSort:l.automation_sort??null})) as List[]}
 async createList(boardId:string,title:string){const clean=title.trim();if(!clean)throw new Error('List name is required');if(clean.length>120)throw new Error('List names can have at most 120 characters');const {data,error}=await this.db.rpc('create_board_list',{p_board_id:boardId,p_title:clean});fail(error);const list=data as any;return {id:list.id,boardId:list.board_id,title:list.title,position:Number(list.position),collapsed:list.is_collapsed,kind:list.kind??'normal',color:list.color??null,isPinned:!!list.is_pinned,isWatched:!!list.is_watched,isArchived:!!list.is_archived,automationTrigger:list.automation_trigger??null,automationSort:list.automation_sort??null} as List}
 async cards(boardId:string){const {data,error}=await this.db.from('cards').select('*,card_labels(label:labels(name)),card_members(user_id),attachments(id,name,storage_path,mime_type),card_dependencies!card_id(depends_on_card_id),comments(id,body,created_at,author:profiles!comments_author_id_fkey(display_name)),agent_runs(id,status,result,error,requires_approval,created_at),reminders(remind_at),recurring_rules(cadence,next_at)').eq('board_id',boardId).order('position');fail(error);return Promise.all((data??[]).map(async(c:any)=>{const attachments=await Promise.all((c.attachments??[]).map(async(a:any)=>{const {data:signed}=await this.db.storage.from('attachments').createSignedUrl(a.storage_path,3600);return {id:a.id,name:a.name,path:a.storage_path,mimeType:a.mime_type,signedUrl:signed?.signedUrl}}));const run=(c.agent_runs??[]).sort((a:any,b:any)=>String(b.created_at??'').localeCompare(String(a.created_at??'')))[0];const comments=(c.comments??[]).map((comment:any)=>({id:comment.id,body:comment.body,author:comment.author?.display_name??'Unknown',createdAt:comment.created_at})).sort((a:any,b:any)=>String(a.createdAt).localeCompare(String(b.createdAt)));return {id:c.id,boardId:c.board_id,listId:c.list_id,title:c.title,description:c.description??'',priority:c.priority,labels:(c.card_labels??[]).map((x:any)=>x.label.name),dueDate:c.due_at?.slice(0,10)??null,reminderAt:c.reminders?.[0]?.remind_at??null,completed:c.completed,isArchived:!!c.is_archived,position:Number(c.position),assignees:(c.card_members??[]).map((member:any)=>member.user_id),checklist:c.checklist??[],comments,customFields:c.custom_fields??{},dependencies:(c.card_dependencies??[]).map((d:any)=>d.depends_on_card_id),attachments,parentId:c.parent_id,taskType:c.task_type,blockedReason:c.blocked_reason,acceptanceCriteria:c.acceptance_criteria,effort:c.effort,source:c.source,completedAt:c.completed_at,approvalStatus:c.approval_status,agentRun:run?{id:run.id,status:run.status,result:run.result,error:run.error,requiresApproval:run.requires_approval}:null,recurrence:c.recurring_rules?.[0]?.cadence??null,recurrenceNextAt:c.recurring_rules?.[0]?.next_at??null,updatedAt:c.updated_at}})) as Promise<Card[]>}
 async createCard(boardId:string,listId:string,title:string,position:number,options:{dueAt?:string|null;source?:Card['source']}={}){const {data,error}=await this.db.from('cards').insert({board_id:boardId,list_id:listId,title,position,...(options.dueAt!==undefined?{due_at:options.dueAt}:{}),...(options.source?{source:options.source}:{})}).select().single();fail(error);return data}
 async patchCard(id:string,patch:Record<string,unknown>){const {error}=await this.db.from('cards').update(patch).eq('id',id);fail(error)}
 async addComment(cardId:string,body:string){
  const clean=body.trim();
  if(!clean)throw new Error('Comment cannot be empty');
  if(!this.db.auth?.getUser){
    const {error}=await this.db.from('comments').insert({card_id:cardId,body:clean});
    fail(error);
    return;
  }
  const {data:identity,error:identityError}=await this.db.auth.getUser();
  if(identityError||!identity.user)throw new Error('Your sign-in session has expired. Sign in again before posting a comment.');
  const authorId=identity.user.id;
  const insert=()=>this.db.from('comments').insert({card_id:cardId,author_id:authorId,body:clean});
  let {error}=await insert();
  if(error&&/row.level security|permission denied/i.test(error.message)){
    const {data:refreshed,error:refreshError}=await this.db.auth.refreshSession();
    if(refreshError||!refreshed.session)throw new Error('Your session no longer has permission to post comments. Sign in again, then retry.');
    const {data:verified,error:verifyError}=await this.db.auth.getUser();
    if(verifyError||verified.user?.id!==authorId)throw new Error('Your account session changed. Sign in again before posting this comment.');
    ({error}=await insert());
    if(error&&/row.level security|permission denied/i.test(error.message))throw new Error('Comment not posted. Your account does not currently have write access to this board. Refresh the page or ask the board owner to review access.');
  }
  fail(error);
}
 async deleteCard(id:string){const {error}=await this.db.from('cards').delete().eq('id',id);fail(error)}
 async reorderCard(id:string,listId:string,position:number){await this.patchCard(id,{list_id:listId,position})}
 async toggleList(id:string,collapsed:boolean){const {error}=await this.db.from('lists').update({is_collapsed:collapsed}).eq('id',id);fail(error)}
 async reorderList(id:string,position:number){const {error}=await this.db.rpc('reorder_board_list',{p_list_id:id,p_position:position});fail(error)}
 async updateListMetadata(id:string,patch:{color?:string|null;isPinned?:boolean;isWatched?:boolean;isArchived?:boolean;automationTrigger?:'on_add'|'daily'|'weekly'|null;automationSort?:'title'|'due'|'priority'|null}){const change:Record<string,unknown>={};if('color' in patch)change.color=patch.color;if('isPinned' in patch)change.is_pinned=patch.isPinned;if('isWatched' in patch)change.is_watched=patch.isWatched;if('isArchived' in patch)change.is_archived=patch.isArchived;if('automationTrigger' in patch)change.automation_trigger=patch.automationTrigger;if('automationSort' in patch)change.automation_sort=patch.automationSort;const {error}=await this.db.from('lists').update(change).eq('id',id);fail(error)}
 async deleteList(id:string){const {error}=await this.db.from('lists').delete().eq('id',id);fail(error)}
 async renameList(id:string,title:string){const {error}=await this.db.from('lists').update({title}).eq('id',id);fail(error)}
 async toggleFavorite(id:string,value:boolean){const {error}=await this.db.rpc('update_board_metadata',{p_board_id:id,p_title:null,p_is_favorite:value});fail(error)}
 async renameBoard(id:string,title:string){const {error}=await this.db.rpc('update_board_metadata',{p_board_id:id,p_title:title,p_is_favorite:null});fail(error)}
 async setCardLabels(cardId:string,names:string[]){const clean=[...new Set(names.map(n=>n.trim()).filter(Boolean))];if(clean.length>20)throw new Error('A card can have at most 20 labels');if(clean.some(name=>name.length>50))throw new Error('Labels can have at most 50 characters');const {error}=await this.db.rpc('set_card_labels',{p_card_id:cardId,p_names:clean});fail(error)}
 async upload(cardId:string,file:File){if(!['image/png','image/jpeg','image/webp','application/pdf'].includes(file.type))throw new Error('Use a PNG, JPEG, WebP, or PDF file');const path=`${cardId}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;const {error}=await this.db.storage.from('attachments').upload(path,file);fail(error);const {data, error:insertError}=await this.db.from('attachments').insert({card_id:cardId,name:file.name,storage_path:path,size_bytes:file.size,mime_type:file.type}).select().single();fail(insertError);const {data:signed}=await this.db.storage.from('attachments').createSignedUrl(path,3600);return {id:data.id,name:data.name,path:data.storage_path,mimeType:data.mime_type,signedUrl:signed?.signedUrl}}
 async boardSharing(boardId:string){const {data,error}=await this.db.rpc('get_board_sharing',{p_board_id:boardId});fail(error);return data as unknown as BoardSharing}

 async createBoardShareLink(boardId:string){const {data,error}=await this.db.rpc('create_board_share_link',{p_board_id:boardId});fail(error);return `${window.location.origin}${window.location.pathname}?share=${String(data)}`}
 async boardShareLinkStatus(boardId:string){const {data,error}=await this.db.rpc('board_share_link_status',{p_board_id:boardId});fail(error);return data as unknown as {active:boolean;createdAt:string|null}}
 async revokeBoardShareLink(boardId:string){const {error}=await this.db.rpc('revoke_board_share_link',{p_board_id:boardId});fail(error)}
 async createBoardEmailInvitation(boardId:string,email:string,role:BoardRole){const {data,error}=await this.db.rpc('create_board_email_invitation',{p_board_id:boardId,p_email:email.trim().toLowerCase(),p_role:role});fail(error);const result=data as unknown as {id:string;token:string;email:string;role:BoardRole;expiresAt:string};return {...result,url:`${window.location.origin}${window.location.pathname}?invite=${result.token}`}}
 async boardEmailInvitations(boardId:string){const {data,error}=await this.db.rpc('list_board_email_invitations',{p_board_id:boardId});fail(error);return data as unknown as {id:string;email:string;role:BoardRole;createdAt:string;expiresAt:string;status:'pending'|'accepted'|'expired'|'revoked'}[]}
 async revokeBoardEmailInvitation(boardId:string,invitationId:string){const {error}=await this.db.rpc('revoke_board_email_invitation',{p_board_id:boardId,p_invitation_id:invitationId});fail(error)}
 async acceptBoardEmailInvitation(token:string){const {data,error}=await this.db.rpc('accept_board_email_invitation',{p_token:token});fail(error);return data as unknown as {status:'accessible';boardId:string}}
 async resolveBoardJoinRequest(boardId:string,requestId:string,approve:boolean,role:BoardRole){const {data,error}=await this.db.rpc('resolve_board_join_request',{p_board_id:boardId,p_request_id:requestId,p_approve:approve,p_role:role});fail(error);return data as unknown as BoardSharing}
 async updateBoardMember(boardId:string,userId:string,role:BoardRole|null){const {data,error}=await this.db.rpc('update_board_member',{p_board_id:boardId,p_user_id:userId,p_role:role});fail(error);return data as unknown as BoardSharing}
 async requestBoardAccess(token:string){const {data,error}=await this.db.rpc('request_board_access',{p_token:token});fail(error);return data as unknown as {status:'accessible'|'requested';boardId:string}}
 async queueCardForAi(cardId:string,idempotencyKey:string){if(!idempotencyKey||idempotencyKey.length>120)throw new Error('Invalid idempotency key');const {data,error}=await this.db.rpc('queue_card_for_ai',{p_card_id:cardId,p_idempotency_key:idempotencyKey});fail(error);return data as unknown as {listId:string|null;runId:string;status:string}}
 async notifications(){const {data,error}=await this.db.from('notifications').select('*').eq('user_id',(await this.db.auth?.getUser?.())?.data?.user?.id??'').order('created_at',{ascending:false});fail(error);return data??[]}
 async setNotificationRead(id:string,read=true){const {error}=await this.db.rpc('set_notification_read',{p_notification_id:id,p_read:read});fail(error)}
 async markAllNotificationsRead(){const {error}=await this.db.rpc('mark_all_notifications_read');fail(error)}
 async notificationPreferences(){const userId=(await this.db.auth.getUser()).data.user?.id;if(!userId)return {inApp:true,email:false,dueReminders:true,agentUpdates:true};const {data,error}=await this.db.from('notification_preferences').select('*').eq('user_id',userId).maybeSingle();fail(error);return {inApp:data?.in_app??true,email:data?.email??false,dueReminders:data?.due_reminders??true,agentUpdates:data?.agent_updates??true}}
 async setNotificationPreferences(preferences:{inApp:boolean;email:boolean;dueReminders:boolean;agentUpdates:boolean}){const {data,error}=await this.db.rpc('set_notification_preferences',{p_in_app:preferences.inApp,p_email:preferences.email,p_due_reminders:preferences.dueReminders,p_agent_updates:preferences.agentUpdates});fail(error);return data}
 async currentUserId(){return (await this.db.auth.getUser()).data.user?.id??null}
 async resolvePlanningRequest(id:string,approve:boolean,proposal:unknown=null){const {data,error}=await this.db.rpc('resolve_planning_request',{p_request_id:id,p_approve:approve,p_proposal:proposal});fail(error);return data as string}
 async approveAndMaterializePlan(id:string,proposal:unknown){const {data,error}=await this.db.rpc('approve_and_materialize_plan',{p_request_id:id,p_proposal:proposal});fail(error);return data as string}
 async convertChecklistToSubtasks(cardId:string){const {data,error}=await this.db.rpc('convert_checklist_to_subtasks',{p_card_id:cardId});fail(error);return Number(data)}
 async controlAgentRun(id:string,action:'approve'|'reject'|'cancel'|'retry'){const {data,error}=await this.db.rpc('control_agent_run',{p_run_id:id,p_action:action});fail(error);return data as string}
 async createPlanningRequest(boardId:string,prompt:string,idempotencyKey:string,model:string|null=null){const clean=prompt.trim();if(clean.length<1||clean.length>4000)throw new Error('Prompt must be 1 to 4000 characters');if(!idempotencyKey||idempotencyKey.length>120)throw new Error('Invalid idempotency key');const {data,error}=await this.db.rpc('create_planning_request',{p_board_id:boardId,p_prompt:clean,p_idempotency_key:idempotencyKey,p_model:model});fail(error);return data}
 async setCardDependencies(cardId:string,dependencyIds:string[]){const ids=[...new Set(dependencyIds)];const {error}=await this.db.rpc('set_card_dependencies',{p_card_id:cardId,p_dependency_ids:ids});fail(error)}
 async setCardAssignees(cardId:string,userIds:string[]){const ids=[...new Set(userIds)];const {error}=await this.db.rpc('set_card_assignees',{p_card_id:cardId,p_user_ids:ids});fail(error)}
 async activity(){const {data,error}=await this.db.from('activity_events').select('*').order('created_at',{ascending:false});fail(error);return data??[]}
 async planningRequests(){const {data,error}=await this.db.from('planning_requests').select('*').order('created_at',{ascending:false});fail(error);return data??[]}
 async agentRuns(){const {data,error}=await this.db.from('agent_runs').select('*').order('updated_at',{ascending:false});fail(error);return data??[]}
 async reminders(){const {data,error}=await this.db.from('reminders').select('*').order('remind_at');fail(error);return data??[]}
 async upsertReminder(cardId:string,remindAt:string|null){const {data,error}=await this.db.rpc('upsert_card_reminder',{p_card_id:cardId,p_remind_at:remindAt});fail(error);return data}
 async upsertRecurringRule(cardId:string,cadence:Card['recurrence'],nextAt:string|null){const {data,error}=await this.db.rpc('upsert_recurring_rule',{p_card_id:cardId,p_cadence:cadence,p_next_at:nextAt});fail(error);return data}
 subscribeProductivity(userId:string,reload:()=>void){return this.db.channel(`productivity:${userId}`).on('postgres_changes',{event:'*',schema:'public',table:'notifications',filter:`user_id=eq.${userId}`},reload).on('postgres_changes',{event:'*',schema:'public',table:'agent_runs'},reload).on('postgres_changes',{event:'*',schema:'public',table:'activity_events'},reload).on('postgres_changes',{event:'*',schema:'public',table:'planning_requests'},reload).subscribe()}
 subscribe(boardId:string,reload:()=>void){return this.db.channel(`board:${boardId}`).on('postgres_changes',{event:'*',schema:'public',table:'cards',filter:`board_id=eq.${boardId}`},reload).subscribe()}
}
