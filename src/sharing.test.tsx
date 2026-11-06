import {render,screen,within,waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe,expect,it,vi} from 'vitest';
import {App} from './App';
import {ShareBoardModal,type BoardSharing} from './sharing';

const sharing:BoardSharing={
  members:[{userId:'self',displayName:'Demo User',role:'owner',isSelf:true,accessSource:'workspace'}],
  requests:[],shareUrl:null,canManage:true,
};

const board=(id:string,title:string)=>({id,workspaceId:'w1',title,description:'',background:'coast',favorite:false,updatedAt:''});

describe('board sharing',()=>{
  it('shows email invitations and a secure access-request link',async()=>{
    const user=userEvent.setup();
    render(<App testMode/>);
    await user.click(screen.getByRole('button',{name:'Share'}));
    const dialog=screen.getByRole('dialog',{name:'Share board'});
    expect(within(dialog).getByText('Share with a link')).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox',{name:'Invite email address'})).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox',{name:'Invite role'})).toBeInTheDocument();
  });

  it('creates a board share link and clears stale errors after success',async()=>{
    const user=userEvent.setup();
    const repository={
      boardSharing:vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue(sharing),
      createBoardShareLink:vi.fn().mockResolvedValue('https://example.test/?share=token'),
    };
    const {rerender}=render(<ShareBoardModal boardId="board-1" repository={repository as never} onClose={()=>{}}/>);
    expect(await screen.findByRole('alert')).toHaveTextContent('temporary');
    rerender(<ShareBoardModal boardId="board-2" repository={repository as never} onClose={()=>{}}/>);
    await screen.findByText('Demo User');
    await user.click(screen.getByRole('button',{name:'Create link'}));
    expect(await screen.findByDisplayValue(/share=token/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('serializes modal mutations and disables controls while one is running',async()=>{
    let resolve!: (value:string)=>void;
    const pending=new Promise<string>(r=>{resolve=r});
    const repository={boardSharing:vi.fn().mockResolvedValue(sharing),createBoardShareLink:vi.fn(()=>pending)};
    const user=userEvent.setup();
    render(<ShareBoardModal boardId="board-1" repository={repository as never} onClose={()=>{}}/>);
    await screen.findByText('Demo User');
    const create=screen.getByRole('button',{name:'Create link'});
    await user.click(create);
    expect(create).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Saving or loading sharing');
    await user.click(create);
    expect(repository.createBoardShareLink).toHaveBeenCalledTimes(1);
    resolve('https://example.test/?share=token');
    expect(await screen.findByDisplayValue(/share=token/)).toBeInTheDocument();
  });

  it('hides self-removal while retaining controls for another board guest',async()=>{
    const repository={boardSharing:async()=>({...sharing,members:[
      {userId:'self',displayName:'Self Guest',role:'admin' as const,isSelf:true,accessSource:'board' as const},
      {userId:'other',displayName:'Other Guest',role:'member' as const,isSelf:false,accessSource:'board' as const},
    ]})};
    render(<ShareBoardModal boardId="board-1" repository={repository as never} onClose={()=>{}}/>);
    const dialog=screen.getByRole('dialog',{name:'Share board'});
    expect(await within(dialog).findByText('Self Guest')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button',{name:'Remove Self Guest'})).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button',{name:'Remove Other Guest'})).toBeInTheDocument();
  });

  it('renders Auth for a logged-out share URL and preserves its token',()=>{
    window.history.replaceState({},'', '/?share=keep-me');
    render(<App testMode authenticated={false} repository={{} as never}/>);
    expect(screen.getByRole('heading',{name:'Welcome to Glassboard'})).toBeInTheDocument();
    expect(window.location.search).toBe('?share=keep-me');
    window.history.replaceState({},'', '/');
  });

  it('scrubs an invalid token and shows an error without seed data',async()=>{
    window.history.replaceState({},'', '/?share=invalid');
    const repository={requestBoardAccess:vi.fn().mockRejectedValue(new Error('Share link is invalid or expired'))};
    render(<App testMode repository={repository as never}/>);
    expect(await screen.findByRole('heading',{name:'Unable to open board'})).toBeInTheDocument();
    expect(screen.getByText('Share link is invalid or expired')).toBeInTheDocument();
    expect(screen.queryByRole('heading',{name:'Website Launch'})).not.toBeInTheDocument();
    expect(window.location.search).toBe('');
    window.history.replaceState({},'', '/');
  });

  it('scrubs the token and shows an error when linked-board loading fails',async()=>{
    window.history.replaceState({},'', '/?share=token');
    const repository={
      requestBoardAccess:vi.fn().mockResolvedValue({status:'accessible',boardId:'board-2'}),
      boards:vi.fn().mockRejectedValue(new Error('Board load failed')),
    };
    render(<App testMode repository={repository as never}/>);
    expect(await screen.findByRole('heading',{name:'Unable to open board'})).toBeInTheDocument();
    expect(screen.queryByRole('heading',{name:'Website Launch'})).not.toBeInTheDocument();
    expect(window.location.search).toBe('');
    window.history.replaceState({},'', '/');
  });

  it('keeps the target board pending and Check access loads exactly that board',async()=>{
    window.history.replaceState({},'', '/?share=request-token');
    const repository={
      requestBoardAccess:vi.fn().mockResolvedValue({status:'requested',boardId:'board-2'}),
      boards:vi.fn().mockResolvedValueOnce([board('board-1','Wrong board')]).mockResolvedValueOnce([board('board-1','Wrong board'),board('board-2','Linked board')]),
      lists:vi.fn().mockResolvedValue([]),cards:vi.fn().mockResolvedValue([]),boardSharing:vi.fn().mockResolvedValue({...sharing,canManage:false}),
    };
    const user=userEvent.setup();
    render(<App testMode repository={repository as never}/>);
    expect(await screen.findByRole('heading',{name:'Access request pending'})).toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'Check access'}));
    expect(screen.getByRole('heading',{name:'Access request pending'})).toBeInTheDocument();
    await user.click(screen.getByRole('button',{name:'Check access'}));
    expect(await screen.findByRole('heading',{name:'Linked board'})).toBeInTheDocument();
    expect(repository.lists).toHaveBeenLastCalledWith('board-2');
    expect(repository.cards).toHaveBeenLastCalledWith('board-2');
    window.history.replaceState({},'', '/');
  });

  it('hides rename and favorite without metadata permission',async()=>{
    window.history.replaceState({},'', '/?share=token');
    const repository={
      requestBoardAccess:vi.fn().mockResolvedValue({status:'accessible',boardId:'board-2'}),
      boards:vi.fn().mockResolvedValue([board('board-2','Guest board')]),lists:vi.fn().mockResolvedValue([]),cards:vi.fn().mockResolvedValue([]),
      boardSharing:vi.fn().mockResolvedValue({...sharing,canManage:false}),
    };
    render(<App testMode repository={repository as never}/>);
    expect(await screen.findByRole('heading',{name:'Guest board'})).toBeInTheDocument();
    await waitFor(()=>expect(repository.boardSharing).toHaveBeenCalledWith('board-2'));
    expect(screen.queryByRole('button',{name:'Rename board'})).not.toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Favorite board'})).not.toBeInTheDocument();
    window.history.replaceState({},'', '/');
  });
});
