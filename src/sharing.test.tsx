import {render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe,expect,it,vi} from 'vitest';
import {App} from './App';
import {ShareBoardModal} from './sharing';

describe('board sharing',()=>{
  it('opens the Share board dialog from the board header',async()=>{
    const user=userEvent.setup();
    render(<App testMode/>);

    await user.click(screen.getByRole('button',{name:'Share'}));

    expect(screen.getByRole('dialog',{name:'Share board'})).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Email address')).toBeInTheDocument();
    expect(screen.getByRole('combobox',{name:'Invite role'})).toHaveValue('member');
  });

  it('invites an existing user and shows them as a board member',async()=>{
    const user=userEvent.setup();
    render(<App testMode/>);
    await user.click(screen.getByRole('button',{name:'Share'}));
    await user.type(screen.getByPlaceholderText('Email address'),'alex@glassboard.test');
    await user.click(within(screen.getByRole('dialog',{name:'Share board'})).getByRole('button',{name:'Share'}));

    expect(await screen.findByText('Alex Rivera')).toBeInTheDocument();
    expect(screen.getByRole('tab',{name:'Board members 2'})).toBeInTheDocument();
  });

  it('directs unknown email addresses to a share link without creating pending invitations',async()=>{
    const user=userEvent.setup();
    render(<App testMode/>);
    await user.click(screen.getByRole('button',{name:'Share'}));
    const dialog=screen.getByRole('dialog',{name:'Share board'});
    await user.type(within(dialog).getByPlaceholderText('Email address'),'new.person@example.com');
    await user.click(within(dialog).getByRole('button',{name:'Share'}));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('No registered user found. Use a share link instead.');
    expect(within(dialog).queryByText('Pending invitation')).not.toBeInTheDocument();
  });

  it('creates a board share link that can be copied',async()=>{
    const user=userEvent.setup();
    render(<App testMode/>);
    await user.click(screen.getByRole('button',{name:'Share'}));
    const dialog=screen.getByRole('dialog',{name:'Share board'});

    expect(within(dialog).getByText('Share this board with a link')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button',{name:'Create link'}));

    expect(within(dialog).getByRole('button',{name:'Copy link'})).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue(/\?share=test-b1/)).toBeInTheDocument();
  });

  it('approves a share-link join request into board membership',async()=>{
    window.history.replaceState({},'', '/?share=test-request');
    const user=userEvent.setup();
    render(<App testMode/>);
    await user.click(screen.getByRole('button',{name:'Share'}));
    const dialog=screen.getByRole('dialog',{name:'Share board'});
    await user.click(within(dialog).getByRole('tab',{name:'Join requests 1'}));

    expect(within(dialog).getByText('Taylor Chen')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button',{name:'Approve Taylor Chen'}));

    expect(within(dialog).getByRole('tab',{name:'Join requests 0'})).toBeInTheDocument();
    expect(within(dialog).getByRole('tab',{name:'Board members 2'})).toBeInTheDocument();
    window.history.replaceState({},'', '/');
  });

  it('declines a share-link join request without adding a member',async()=>{
    window.history.replaceState({},'', '/?share=test-request');
    const user=userEvent.setup();
    render(<App testMode/>);
    await user.click(screen.getByRole('button',{name:'Share'}));
    const dialog=screen.getByRole('dialog',{name:'Share board'});
    await user.click(within(dialog).getByRole('tab',{name:'Join requests 1'}));
    await user.click(within(dialog).getByRole('button',{name:'Decline Taylor Chen'}));

    expect(within(dialog).getByRole('tab',{name:'Join requests 0'})).toBeInTheDocument();
    expect(within(dialog).getByRole('tab',{name:'Board members 1'})).toBeInTheDocument();
    window.history.replaceState({},'', '/');
  });

  it('changes a board member role',async()=>{
    const user=userEvent.setup();
    render(<App testMode/>);
    await user.click(screen.getByRole('button',{name:'Share'}));
    const dialog=screen.getByRole('dialog',{name:'Share board'});
    await user.type(within(dialog).getByPlaceholderText('Email address'),'alex@glassboard.test');
    await user.click(within(dialog).getByRole('button',{name:'Share'}));

    await user.selectOptions(within(dialog).getByRole('combobox',{name:'Role for Alex Rivera'}),'admin');
    expect(within(dialog).getByRole('combobox',{name:'Role for Alex Rivera'})).toHaveValue('admin');
  });

  it('removes a board member',async()=>{
    const user=userEvent.setup();
    render(<App testMode/>);
    await user.click(screen.getByRole('button',{name:'Share'}));
    const dialog=screen.getByRole('dialog',{name:'Share board'});
    await user.type(within(dialog).getByPlaceholderText('Email address'),'alex@glassboard.test');
    await user.click(within(dialog).getByRole('button',{name:'Share'}));
    await user.click(within(dialog).getByRole('button',{name:'Remove Alex Rivera'}));

    expect(within(dialog).queryByText('Alex Rivera')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('tab',{name:'Board members 1'})).toBeInTheDocument();
  });

  it('hides board management actions from regular members',async()=>{
    const repository={boardSharing:async()=>({members:[{userId:'self',displayName:'Regular Member',role:'member' as const,isSelf:true}],invites:[],requests:[],shareUrl:null,canManage:false})};
    render(<ShareBoardModal boardId="board-1" repository={repository as never} onClose={()=>{}}/>);
    const dialog=screen.getByRole('dialog',{name:'Share board'});
    expect(await within(dialog).findByText('Regular Member')).toBeInTheDocument();
    expect(within(dialog).queryByPlaceholderText('Email address')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button',{name:'Create link'})).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('combobox',{name:'Role for Regular Member'})).not.toBeInTheDocument();
  });

  it('shows workspace-derived members without board role or removal controls',async()=>{
    const repository={boardSharing:async()=>({members:[
      {userId:'owner',displayName:'Workspace Owner',role:'owner' as const,isSelf:false,accessSource:'workspace' as const},
      {userId:'member',displayName:'Workspace Member',role:'member' as const,isSelf:false,accessSource:'workspace' as const},
      {userId:'guest',displayName:'Board Guest',role:'member' as const,isSelf:false,accessSource:'board' as const},
    ],invites:[],requests:[],shareUrl:null,canManage:true})};
    render(<ShareBoardModal boardId="board-1" repository={repository as never} onClose={()=>{}}/>);
    const dialog=screen.getByRole('dialog',{name:'Share board'});

    expect(await within(dialog).findByText('Workspace Member')).toBeInTheDocument();
    expect(within(dialog).queryByRole('combobox',{name:'Role for Workspace Member'})).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button',{name:'Remove Workspace Member'})).not.toBeInTheDocument();
    expect(within(dialog).getByRole('combobox',{name:'Role for Board Guest'})).toBeInTheDocument();
  });

  it('shows a pending-access screen instead of seed data after requesting access',async()=>{
    window.history.replaceState({},'', '/?share=test-request');
    const repository={requestBoardAccess:vi.fn().mockResolvedValue({status:'requested',boardId:'board-2'})};
    render(<App testMode repository={repository as never}/>);
    expect(await screen.findByRole('heading',{name:'Access request pending'})).toBeInTheDocument();
    expect(screen.queryByRole('heading',{name:'Website Launch'})).not.toBeInTheDocument();
    expect(window.location.search).toBe('');
    window.history.replaceState({},'', '/');
  });

  it('loads the linked board for a member who already has access',async()=>{
    window.history.replaceState({},'', '/?share=test-accessible');
    const repository={
      requestBoardAccess:vi.fn().mockResolvedValue({status:'accessible',boardId:'board-2'}),
      boards:vi.fn().mockResolvedValue([
        {id:'board-1',workspaceId:'w1',title:'Wrong board',description:'',background:'coast',favorite:false,updatedAt:''},
        {id:'board-2',workspaceId:'w1',title:'Linked board',description:'',background:'coast',favorite:false,updatedAt:''},
      ]),
      lists:vi.fn().mockResolvedValue([]),cards:vi.fn().mockResolvedValue([]),
    };
    render(<App testMode repository={repository as never}/>);
    expect(await screen.findByRole('heading',{name:'Linked board'})).toBeInTheDocument();
    expect(repository.lists).toHaveBeenCalledWith('board-2');
    expect(repository.cards).toHaveBeenCalledWith('board-2');
    expect(window.location.search).toBe('');
    window.history.replaceState({},'', '/');
  });
});
