import {createClient,type SupabaseClient} from '@supabase/supabase-js'; import type {Board,Card,List,Workspace} from './domain';
export const config={url:import.meta.env.VITE_SUPABASE_URL as string|undefined,key:import.meta.env.VITE_SUPABASE_ANON_KEY as string|undefined};
export const isConfigured=Boolean(config.url&&config.key&&!config.key.includes('your-'));
export const supabase:SupabaseClient|null=isConfigured?createClient(config.url!,config.key!,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}}):null;
const fail=(error:{message:string}|null)=>{if(error)throw new Error(error.message)};
export class SupabaseRepository {constructor(private db:SupabaseClient){ }
 async workspaces(){const {data,error}=await this.db.from('workspaces').select('*').order('created_at');fail(error);return data as Workspace[]}
 async boards(){const {data,error}=await this.db.from('boards').select('*').order('updated_at',{ascending:false});fail(error);return (data??[]).map((b:any)=>({id:b.id,title:b.title,description:b.description??'',background:b.background,favorite:b.is_favorite,workspaceId:b.workspace_id,updatedAt:b.updated_at})) as Board[]}
 async lists(boardId:string){const {data,error}=await this.db.from('lists').select('*').eq('board_id',boardId).order('position');fail(error);return (data??[]).map((l:any)=>({...l,collapsed:l.is_collapsed})) as List[]}
 async cards(boardId:string){const {data,error}=await this.db.from('cards').select('*,card_labels(label:labels(name))').eq('board_id',boardId).order('position');fail(error);return (data??[]).map((c:any)=>({id:c.id,listId:c.list_id,title:c.title,description:c.description??'',priority:c.priority,labels:(c.card_labels??[]).map((x:any)=>x.label.name),dueDate:c.due_at?.slice(0,10)??null,completed:c.completed,position:Number(c.position),assignees:[],checklist:c.checklist??[],comments:c.comments??[],customFields:c.custom_fields??{},dependencies:c.dependencies??[],attachments:[]})) as Card[]}
 async createCard(boardId:string,listId:string,title:string,position:number){const {data,error}=await this.db.from('cards').insert({board_id:boardId,list_id:listId,title,position}).select().single();fail(error);return data}
 async patchCard(id:string,patch:Record<string,unknown>){const {error}=await this.db.from('cards').update(patch).eq('id',id);fail(error)}
 async deleteCard(id:string){const {error}=await this.db.from('cards').delete().eq('id',id);fail(error)}
 async reorderCard(id:string,listId:string,position:number){await this.patchCard(id,{list_id:listId,position})}
 async toggleList(id:string,collapsed:boolean){const {error}=await this.db.from('lists').update({is_collapsed:collapsed}).eq('id',id);fail(error)}
 async toggleFavorite(id:string,value:boolean){const {error}=await this.db.from('boards').update({is_favorite:value}).eq('id',id);fail(error)}
 async upload(cardId:string,file:File){const path=`${cardId}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;const {error}=await this.db.storage.from('attachments').upload(path,file);fail(error);const {data, error:insertError}=await this.db.from('attachments').insert({card_id:cardId,name:file.name,storage_path:path,size_bytes:file.size,mime_type:file.type}).select().single();fail(insertError);return data}
 subscribe(boardId:string,reload:()=>void){return this.db.channel(`board:${boardId}`).on('postgres_changes',{event:'*',schema:'public',table:'cards',filter:`board_id=eq.${boardId}`},reload).subscribe()}
}
