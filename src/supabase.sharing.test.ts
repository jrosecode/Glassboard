import {describe,expect,it,vi} from 'vitest';
import {SupabaseRepository} from './supabase';

describe('SupabaseRepository board sharing',()=>{
  it('uses only the secured link/request/member RPC surface',async()=>{
    const rpc=vi.fn().mockResolvedValue({data:{members:[],requests:[],shareUrl:null,canManage:true},error:null});
    const repository=new SupabaseRepository({rpc} as never);
    await repository.boardSharing('board-1');
    await repository.resolveBoardJoinRequest('board-1','request-1',true,'member');
    await repository.updateBoardMember('board-1','user-1',null);
    await repository.requestBoardAccess('share-token');
    expect(rpc.mock.calls).toEqual([
      ['get_board_sharing',{p_board_id:'board-1'}],
      ['resolve_board_join_request',{p_board_id:'board-1',p_request_id:'request-1',p_approve:true,p_role:'member'}],
      ['update_board_member',{p_board_id:'board-1',p_user_id:'user-1',p_role:null}],
      ['request_board_access',{p_token:'share-token'}],
    ]);
    expect(rpc).not.toHaveBeenCalledWith('invite_board_member',expect.anything());
  });

  it('updates only allowed board metadata through the RPC',async()=>{
    const rpc=vi.fn().mockResolvedValue({data:null,error:null});
    const repository=new SupabaseRepository({rpc} as never);
    await repository.renameBoard('board-1','New title');
    await repository.toggleFavorite('board-1',true);
    expect(rpc.mock.calls).toEqual([
      ['update_board_metadata',{p_board_id:'board-1',p_title:'New title',p_is_favorite:null}],
      ['update_board_metadata',{p_board_id:'board-1',p_title:null,p_is_favorite:true}],
    ]);
  });

  it('normalizes valid labels and rejects oversized input before RPC',async()=>{
    const rpc=vi.fn().mockResolvedValue({data:null,error:null});
    const repository=new SupabaseRepository({rpc} as never);
    await repository.setCardLabels('card-1',[' urgent ','urgent','design']);
    expect(rpc).toHaveBeenCalledWith('set_card_labels',{p_card_id:'card-1',p_names:['urgent','design']});
    await expect(repository.setCardLabels('card-1',Array.from({length:21},(_,i)=>`label-${i}`))).rejects.toThrow('20');
    await expect(repository.setCardLabels('card-1',['x'.repeat(51)])).rejects.toThrow('50');
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
