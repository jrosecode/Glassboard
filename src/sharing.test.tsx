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


describe('sharing invitation and link lifecycle',()=>{
 it('creates an email-restricted invitation and exposes its copyable link',async()=>{
  const user=userEvent.setup();
  const createBoardEmailInvitation=vi.fn().mockResolvedValue({id:'invite-1',email:'guest@example.com',role:'member',url:'https://example.test/?invite=secret',expiresAt:'2026-11-13T20:00:00Z'});
  const repository={boardSharing:vi.fn().mockResolvedValue(sharing),createBoardEmailInvitation,boardEmailInvitations:vi.fn().mockResolvedValue([]),boardShareLinkStatus:vi.fn().mockResolvedValue({active:false,createdAt:null})};
  render(<ShareBoardModal repository={repository as never} boardId="b1" onClose={()=>{}}/>);
  await screen.findByText('Demo User');
  await user.type(screen.getByRole('textbox',{name:'Invite email address'}),'Guest@Example.com');
  await user.click(screen.getByRole('button',{name:'Create invitation'}));
  await waitFor(()=>expect(createBoardEmailInvitation).toHaveBeenCalledWith('b1','guest@example.com','member'));
  expect(await screen.findByRole('textbox',{name:'Invitation link'})).toHaveValue('https://example.test/?invite=secret');
  expect(screen.getByText(/Copy the link or open your email app/)).toBeInTheDocument();
 });
 it('shows a previously created share link as active and offers regeneration or revocation',async()=>{
  const user=userEvent.setup();
  const revokeBoardShareLink=vi.fn().mockResolvedValue(undefined);
  const repository={boardSharing:vi.fn().mockResolvedValue(sharing),boardShareLinkStatus:vi.fn().mockResolvedValue({active:true,createdAt:'2026-11-06T20:00:00Z'}),boardEmailInvitations:vi.fn().mockResolvedValue([]),revokeBoardShareLink};
  render(<ShareBoardModal repository={repository as never} boardId="b1" onClose={()=>{}}/>);
  expect(await screen.findByRole('button',{name:'Regenerate link'})).toBeInTheDocument();
  await user.click(screen.getByRole('button',{name:'Revoke link'}));
  await waitFor(()=>expect(revokeBoardShareLink).toHaveBeenCalledWith('b1'));
  expect(screen.getByRole('button',{name:'Create link'})).toBeInTheDocument();
 });
 it('refreshes pending join requests and invitations without reopening the dialog',async()=>{
  const user=userEvent.setup();
  const boardSharing=vi.fn().mockResolvedValueOnce(sharing).mockResolvedValue({...sharing,requests:[{id:'req-1',displayName:'Guest User',requestedAt:'2026-11-06T20:00:00Z'}]});
  const repository={boardSharing,boardShareLinkStatus:vi.fn().mockResolvedValue({active:false,createdAt:null}),boardEmailInvitations:vi.fn().mockResolvedValue([])};
  render(<ShareBoardModal repository={repository as never} boardId="b1" onClose={()=>{}}/>);
  await screen.findByText('Demo User');
  await user.click(screen.getByRole('button',{name:'Refresh sharing'}));
  await waitFor(()=>expect(boardSharing).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('tab',{name:'Requests 1'})).toBeInTheDocument();
 });
});
