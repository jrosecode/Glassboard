import {describe,expect,it,vi} from 'vitest';
import {SupabaseRepository} from './supabase';
describe('productivity repository boundary',()=>{
 it('queues AI work through the transactional RPC',async()=>{const rpc=vi.fn().mockResolvedValue({data:{listId:'ai',runId:'run',status:'queued'},error:null});const repo=new SupabaseRepository({rpc} as never);expect(await repo.queueCardForAi('card','key')).toMatchObject({status:'queued'});expect(rpc).toHaveBeenCalledWith('queue_card_for_ai',{p_card_id:'card',p_idempotency_key:'key'})});
 it('reads and marks normalized notifications',async()=>{const order=vi.fn().mockResolvedValue({data:[{id:'n',read_at:null}],error:null});const eq=vi.fn(()=>({order}));const select=vi.fn(()=>({eq}));const from=vi.fn(()=>({select}));const rpc=vi.fn().mockResolvedValue({data:null,error:null});const repo=new SupabaseRepository({from,rpc} as never);expect(await repo.notifications()).toHaveLength(1);await repo.markAllNotificationsRead();expect(rpc).toHaveBeenCalledWith('mark_all_notifications_read')});
});
