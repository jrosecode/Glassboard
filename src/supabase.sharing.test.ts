import {describe,expect,it,vi} from 'vitest';
import {SupabaseRepository} from './supabase';

describe('SupabaseRepository board sharing',()=>{
  it('uses the secured board-sharing RPC surface',async()=>{
    const rpc=vi.fn().mockResolvedValue({data:{members:[],invites:[],requests:[],shareUrl:null,canManage:true},error:null});
    const repository=new SupabaseRepository({rpc} as never);

    await repository.boardSharing('board-1');
    await repository.inviteBoardMember('board-1','person@example.com','admin');
    await repository.resolveBoardJoinRequest('board-1','request-1',true,'member');
    await repository.updateBoardMember('board-1','user-1',null);
    await repository.requestBoardAccess('share-token');

    expect(rpc.mock.calls).toEqual([
      ['get_board_sharing',{p_board_id:'board-1'}],
      ['invite_board_member',{p_board_id:'board-1',p_identity:'person@example.com',p_role:'admin'}],
      ['resolve_board_join_request',{p_board_id:'board-1',p_request_id:'request-1',p_approve:true,p_role:'member'}],
      ['update_board_member',{p_board_id:'board-1',p_user_id:'user-1',p_role:null}],
      ['request_board_access',{p_token:'share-token'}],
    ]);
  });
});
