import {render,screen,within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {describe,expect,it} from 'vitest';
import {App} from './App';
import {ShareBoardModal} from './sharing';

describe('board sharing',()=>{
  it('opens the Share board dialog from the board header',async()=>{
    const user=userEvent.setup();
    render(<App testMode/>);

    await user.click(screen.getByRole('button',{name:'Share'}));

    expect(screen.getByRole('dialog',{name:'Share board'})).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Email address or name')).toBeInTheDocument();
    expect(screen.getByRole('combobox',{name:'Invite role'})).toHaveValue('member');
  });

  it('invites an existing user and shows them as a board member',async()=>{
    const user=userEvent.setup();
    render(<App testMode/>);
    await user.click(screen.getByRole('button',{name:'Share'}));
    await user.type(screen.getByPlaceholderText('Email address or name'),'alex@glassboard.test');
    await user.click(within(screen.getByRole('dialog',{name:'Share board'})).getByRole('button',{name:'Share'}));

    expect(await screen.findByText('Alex Rivera')).toBeInTheDocument();
    expect(screen.getByRole('tab',{name:'Board members 2'})).toBeInTheDocument();
  });

  it('keeps an email invite pending when the user is not registered',async()=>{
    const user=userEvent.setup();
    render(<App testMode/>);
    await user.click(screen.getByRole('button',{name:'Share'}));
    const dialog=screen.getByRole('dialog',{name:'Share board'});
    await user.type(within(dialog).getByPlaceholderText('Email address or name'),'new.person@example.com');
    await user.click(within(dialog).getByRole('button',{name:'Share'}));

    expect(await within(dialog).findByText('new.person@example.com',{selector:'b'})).toBeInTheDocument();
    expect(within(dialog).getByText('Pending invitation')).toBeInTheDocument();
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
    await user.type(within(dialog).getByPlaceholderText('Email address or name'),'alex@glassboard.test');
    await user.click(within(dialog).getByRole('button',{name:'Share'}));

    await user.selectOptions(within(dialog).getByRole('combobox',{name:'Role for Alex Rivera'}),'admin');
    expect(within(dialog).getByRole('combobox',{name:'Role for Alex Rivera'})).toHaveValue('admin');
  });

  it('removes a board member',async()=>{
    const user=userEvent.setup();
    render(<App testMode/>);
    await user.click(screen.getByRole('button',{name:'Share'}));
    const dialog=screen.getByRole('dialog',{name:'Share board'});
    await user.type(within(dialog).getByPlaceholderText('Email address or name'),'alex@glassboard.test');
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
    expect(within(dialog).queryByPlaceholderText('Email address or name')).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button',{name:'Create link'})).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('combobox',{name:'Role for Regular Member'})).not.toBeInTheDocument();
  });

  it('handles a share token after authentication by submitting an access request',async()=>{
    window.history.replaceState({},'', '/?share=test-request');
    render(<App testMode/>);
    expect(await screen.findByText('Access request submitted')).toHaveAttribute('role','status');
    window.history.replaceState({},'', '/');
  });
});
