import {describe,expect,it,vi} from 'vitest';
import {SupabaseRepository} from './supabase';
describe('productivity repository boundary',()=>{
 it('queues AI work through the transactional RPC',async()=>{const rpc=vi.fn().mockResolvedValue({data:{listId:'ai',runId:'run',status:'queued'},error:null});const repo=new SupabaseRepository({rpc} as never);expect(await repo.queueCardForAi('card','key')).toMatchObject({status:'queued'});expect(rpc).toHaveBeenCalledWith('queue_card_for_ai',{p_card_id:'card',p_idempotency_key:'key'})});
 it('reads and marks normalized notifications',async()=>{const order=vi.fn().mockResolvedValue({data:[{id:'n',read_at:null}],error:null});const eq=vi.fn(()=>({order}));const select=vi.fn(()=>({eq}));const from=vi.fn(()=>({select}));const rpc=vi.fn().mockResolvedValue({data:null,error:null});const repo=new SupabaseRepository({from,rpc} as never);expect(await repo.notifications()).toHaveLength(1);await repo.markAllNotificationsRead();expect(rpc).toHaveBeenCalledWith('mark_all_notifications_read')});
 it('creates planning requests only through the narrow RPC',async()=>{const rpc=vi.fn().mockResolvedValue({data:{id:'p',status:'queued'},error:null});const repo=new SupabaseRepository({rpc} as never);await repo.createPlanningRequest('board','Plan this','idem');expect(rpc).toHaveBeenCalledWith('create_planning_request',{p_board_id:'board',p_prompt:'Plan this',p_idempotency_key:'idem',p_model:null})});
 it('persists normalized dependencies through the validation RPC',async()=>{const rpc=vi.fn().mockResolvedValue({data:null,error:null});const repo=new SupabaseRepository({rpc} as never);await repo.setCardDependencies('card',['a','b']);expect(rpc).toHaveBeenCalledWith('set_card_dependencies',{p_card_id:'card',p_dependency_ids:['a','b']})});
 it('loads all-board productivity data and activity',async()=>{const order=vi.fn().mockResolvedValue({data:[],error:null});const select=vi.fn(()=>({order}));const from=vi.fn(()=>({select}));const repo=new SupabaseRepository({from} as never);await repo.activity();expect(from).toHaveBeenCalledWith('activity_events')});
 it('persists voice card due date and source at creation',async()=>{const single=vi.fn().mockResolvedValue({data:{id:'c'},error:null});const selectResult=vi.fn(()=>({single}));const insert=vi.fn(()=>({select:selectResult}));const from=vi.fn(()=>({insert}));const repo=new SupabaseRepository({from} as never);await repo.createCard('b','l','Voice task',1,{dueAt:'2026-11-02',source:'voice'});expect(insert).toHaveBeenCalledWith({board_id:'b',list_id:'l',title:'Voice task',position:1,due_at:'2026-11-02',source:'voice'})});
 it('maps persisted card assignments and the newest agent run',async()=>{const order=vi.fn().mockResolvedValue({data:[{id:'c',board_id:'b',list_id:'l',title:'T',description:'',priority:'medium',position:1,completed:false,card_labels:[],attachments:[],card_dependencies:[],agent_runs:[{id:'new',status:'running',created_at:'2026-11-01T02:00:00Z'},{id:'old',status:'failed',created_at:'2026-11-01T01:00:00Z'}],reminders:[],card_members:[{user_id:'u'}]}],error:null});const eq=vi.fn(()=>({order}));const select=vi.fn(()=>({eq}));const from=vi.fn(()=>({select}));const repo=new SupabaseRepository({from,storage:{from:()=>({})}} as never);const card=(await repo.cards('b'))[0];expect(card.assignees).toEqual(['u']);expect(card.agentRun?.id).toBe('new')});
 it('persists notification preferences through the self-scoped RPC',async()=>{const rpc=vi.fn().mockResolvedValue({data:{email:true},error:null});const repo=new SupabaseRepository({rpc} as never);await repo.setNotificationPreferences({inApp:true,email:true,dueReminders:true,agentUpdates:false});expect(rpc).toHaveBeenCalledWith('set_notification_preferences',{p_in_app:true,p_email:true,p_due_reminders:true,p_agent_updates:false})});
 it('persists card assignment edits through a validated RPC',async()=>{const rpc=vi.fn().mockResolvedValue({data:null,error:null});const repo=new SupabaseRepository({rpc} as never);await repo.setCardAssignees('c',['u','u','v']);expect(rpc).toHaveBeenCalledWith('set_card_assignees',{p_card_id:'c',p_user_ids:['u','v']})});
 it('loads comments with author names in chronological order',async()=>{const order=vi.fn().mockResolvedValue({data:[{id:'c',board_id:'b',list_id:'l',title:'T',description:'',priority:'medium',position:1,completed:false,card_labels:[],attachments:[],card_dependencies:[],agent_runs:[],reminders:[],card_members:[],recurring_rules:[],comments:[{id:'later',body:'Second',created_at:'2026-11-01T02:00:00Z',author:{display_name:'Sam'}},{id:'earlier',body:'First',created_at:'2026-11-01T01:00:00Z',author:{display_name:'Alex'}}]}],error:null});const eq=vi.fn(()=>({order}));const select=vi.fn(()=>({eq}));const from=vi.fn(()=>({select}));const repo=new SupabaseRepository({from,storage:{from:()=>({})}} as never);const card=(await repo.cards('b'))[0];expect(select).toHaveBeenCalledWith(expect.stringContaining('comments(id,body,created_at,author:profiles'));expect(card.comments).toEqual([{id:'earlier',body:'First',author:'Alex',createdAt:'2026-11-01T01:00:00Z'},{id:'later',body:'Second',author:'Sam',createdAt:'2026-11-01T02:00:00Z'}])});
 it('persists a trimmed comment through the scoped comments path',async()=>{const insert=vi.fn().mockResolvedValue({data:null,error:null});const from=vi.fn(()=>({insert}));const repo=new SupabaseRepository({from} as never);await repo.addComment('c','  Durable note  ');expect(from).toHaveBeenCalledWith('comments');expect(insert).toHaveBeenCalledWith({card_id:'c',body:'Durable note'})});
 it('loads recurrence from recurring_rules and persists its selected next date',async()=>{const order=vi.fn().mockResolvedValue({data:[{id:'c',board_id:'b',list_id:'l',title:'T',description:'',priority:'medium',position:1,completed:false,card_labels:[],attachments:[],card_dependencies:[],agent_runs:[],reminders:[],card_members:[],recurring_rules:[{cadence:'monthly',next_at:'2026-12-31T09:00:00Z'}]}],error:null});const eq=vi.fn(()=>({order}));const select=vi.fn(()=>({eq}));const from=vi.fn(()=>({select}));const rpc=vi.fn().mockResolvedValue({data:'rule',error:null});const repo=new SupabaseRepository({from,rpc,storage:{from:()=>({})}} as never);const card=(await repo.cards('b'))[0];expect(select).toHaveBeenCalledWith(expect.stringContaining('recurring_rules(cadence,next_at)'));expect(card.recurrence).toBe('monthly');expect(card.recurrenceNextAt).toBe('2026-12-31T09:00:00Z');await repo.upsertRecurringRule('c','monthly','2027-01-30T09:00:00Z');expect(rpc).toHaveBeenCalledWith('upsert_recurring_rule',{p_card_id:'c',p_cadence:'monthly',p_next_at:'2027-01-30T09:00:00Z'})});
});

describe('board list repository boundary',()=>{
 it('ensures a default board through the scoped RPC',async()=>{
  const rpc=vi.fn().mockResolvedValue({data:{id:'board',workspace_id:'workspace',title:'My board',description:'',background:'coast',is_favorite:false,updated_at:'2026-11-01'},error:null});
  const repo=new SupabaseRepository({rpc} as never);
  expect(await repo.ensureDefaultBoard()).toMatchObject({id:'board',workspaceId:'workspace',title:'My board'});
  expect(rpc).toHaveBeenCalledWith('ensure_default_board');
 });
 it('creates normal lists through the scoped RPC',async()=>{
  const rpc=vi.fn().mockResolvedValue({data:{id:'list',board_id:'board',title:'Backlog',position:3,is_collapsed:false,kind:'normal'},error:null});
  const repo=new SupabaseRepository({rpc} as never);
  expect(await repo.createList('board','  Backlog  ')).toMatchObject({id:'list',boardId:'board',title:'Backlog',kind:'normal'});
  expect(rpc).toHaveBeenCalledWith('create_board_list',{p_board_id:'board',p_title:'Backlog'});
 });

 it('rejects blank list names before calling the database',async()=>{
  const rpc=vi.fn();
  const repo=new SupabaseRepository({rpc} as never);
  await expect(repo.createList('board','   ')).rejects.toThrow('List name is required');
  expect(rpc).not.toHaveBeenCalled();
 });

 it('reorders lists through the board-serialized RPC',async()=>{
  const rpc=vi.fn().mockResolvedValue({data:null,error:null});
  const from=vi.fn();
  const repo=new SupabaseRepository({rpc,from} as never);
  await repo.reorderList('list',2.5);
  expect(rpc).toHaveBeenCalledWith('reorder_board_list',{p_list_id:'list',p_position:2.5});
  expect(from).not.toHaveBeenCalled();
 });
});
