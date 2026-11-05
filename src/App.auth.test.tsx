import {act,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,describe,expect,it,vi} from 'vitest';

let authChange:((_event:string,session:unknown)=>void)|undefined;
const session={user:{id:'user-1',email:'person@example.com'}};
const repository={
  boards:vi.fn(),
  lists:vi.fn(),
  cards:vi.fn(),
  boardSharing:vi.fn(),
  notificationPreferences:vi.fn(),
};

vi.mock('./supabase',()=>{
  class SupabaseRepository {
    constructor(){return repository as never}
  }
  return {
    isConfigured:true,
    supabase:{
      auth:{
        getSession:vi.fn().mockResolvedValue({data:{session}}),
        onAuthStateChange:vi.fn((callback:typeof authChange)=>{authChange=callback;return {data:{subscription:{unsubscribe:vi.fn()}}}}),
      },
    },
    SupabaseRepository,
  };
});

const {App}=await import('./App');

describe('auth refresh persistence',()=>{
  beforeEach(()=>{
    authChange=undefined;
    vi.clearAllMocks();
    repository.boards.mockReset().mockResolvedValue([{id:'board-1',workspaceId:'workspace-1',title:'Persistent board',description:'',background:'coast',favorite:false,updatedAt:'2026-11-01'}]);
    repository.lists.mockReset().mockResolvedValue([{id:'list-1',boardId:'board-1',title:'Backlog',position:1,collapsed:false,kind:'normal'}]);
    repository.cards.mockReset().mockResolvedValue([]);
    repository.boardSharing.mockReset().mockResolvedValue({canManage:true,members:[],requests:[],shareUrl:null});
    repository.notificationPreferences.mockReset().mockResolvedValue({inApp:true,email:false,dueReminders:true,agentUpdates:true});
  });

  it('keeps the loaded board mounted when the same signed-in user refreshes their token',async()=>{
    render(<App/>);
    expect(await screen.findByRole('heading',{name:'Persistent board'})).toBeInTheDocument();
    expect(repository.boards).toHaveBeenCalledTimes(1);

    repository.boards.mockImplementationOnce(()=>new Promise(()=>{}));
    await act(async()=>{authChange?.('TOKEN_REFRESHED',{...session,access_token:'refreshed-token'})});

    await waitFor(()=>expect(screen.getByRole('heading',{name:'Persistent board'})).toBeInTheDocument());
    expect(screen.queryByLabelText('Loading')).not.toBeInTheDocument();
    expect(repository.boards).toHaveBeenCalledTimes(1);
  });
});
