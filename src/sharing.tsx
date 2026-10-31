import {useEffect,useState} from 'react';
import {GlassButton,GlassModal} from './App';

export type BoardRole='member'|'admin';
export type BoardMember={userId:string;displayName:string;email?:string;avatarUrl?:string;role:BoardRole|'owner';isSelf:boolean};
export type BoardInvite={id:string;email:string;role:BoardRole;status:'pending'};
export type BoardJoinRequest={id:string;displayName:string;email?:string;requestedAt:string};
export type BoardSharing={members:BoardMember[];invites:BoardInvite[];requests:BoardJoinRequest[];shareUrl:string|null;canManage:boolean};

export interface SharingRepository {
  boardSharing(boardId:string):Promise<BoardSharing>;
  inviteBoardMember(boardId:string,identity:string,role:BoardRole):Promise<BoardSharing>;
  createBoardShareLink(boardId:string):Promise<string>;
  resolveBoardJoinRequest(boardId:string,requestId:string,approve:boolean,role:BoardRole):Promise<BoardSharing>;
  updateBoardMember(boardId:string,userId:string,role:BoardRole|null):Promise<BoardSharing>;
}

const initialTestSharing:BoardSharing={
  members:[{userId:'demo',displayName:'Demo User',email:'demo@glassboard.test',role:'owner',isSelf:true}],
  invites:[],requests:[],shareUrl:null,canManage:true,
};

export function ShareBoardModal({boardId='b1',repository,testMode=false,onClose}:{boardId?:string;repository?:SharingRepository|null;testMode?:boolean;onClose:()=>void}){
  const [role,setRole]=useState<BoardRole>('member');
  const [identity,setIdentity]=useState('');
  const [sharing,setSharing]=useState<BoardSharing>(()=>testMode?(new URLSearchParams(window.location.search).has('share')?{...initialTestSharing,requests:[{id:'request-1',displayName:'Taylor Chen',email:'taylor@example.com',requestedAt:'2026-10-31T12:00:00Z'}]}:initialTestSharing):{members:[],invites:[],requests:[],shareUrl:null,canManage:false});
  const [tab,setTab]=useState<'members'|'requests'>('members');
  const [error,setError]=useState('');
  useEffect(()=>{if(!testMode&&repository)repository.boardSharing(boardId).then(setSharing).catch(error=>setError(error.message))},[boardId,repository,testMode]);
  async function invite(){
    const value=identity.trim();if(!value)return;
    try{
      const next=testMode
        ? value.toLowerCase()==='alex@glassboard.test'
          ? {...sharing,members:[...sharing.members,{userId:'alex',displayName:'Alex Rivera',email:value,role,isSelf:false}]}
          : {...sharing,invites:[...sharing.invites,{id:crypto.randomUUID(),email:value,role,status:'pending'} as BoardInvite]}
        : await repository!.inviteBoardMember(boardId,value,role);
      setSharing(next);setIdentity('');
    }catch(error){setError((error as Error).message)}
  }
  async function createLink(){
    try{
      const shareUrl=testMode?`${window.location.origin}${window.location.pathname}?share=test-${boardId}`:await repository!.createBoardShareLink(boardId);
      setSharing({...sharing,shareUrl});
    }catch(error){setError((error as Error).message)}
  }
  async function resolveRequest(request:BoardJoinRequest,approve:boolean){
    try{
      const next=testMode?{...sharing,requests:sharing.requests.filter(item=>item.id!==request.id),members:approve?[...sharing.members,{userId:'taylor',displayName:request.displayName,email:request.email,role:'member' as const,isSelf:false}]:sharing.members}:await repository!.resolveBoardJoinRequest(boardId,request.id,approve,'member');
      setSharing(next);
    }catch(error){setError((error as Error).message)}
  }
  async function updateMember(member:BoardMember,nextRole:BoardRole|null){
    try{setSharing(testMode?{...sharing,members:nextRole?sharing.members.map(item=>item.userId===member.userId?{...item,role:nextRole}:item):sharing.members.filter(item=>item.userId!==member.userId)}:await repository!.updateBoardMember(boardId,member.userId,nextRole))}
    catch(error){setError((error as Error).message)}
  }
  return <GlassModal title="Share board" onClose={onClose}>
    <div className="share-dialog">
      {error&&<p className="error" role="alert">{error}</p>}
      {sharing.canManage&&<><div className="share-invite">
        <input placeholder="Email address or name" aria-label="Email address or name" value={identity} onChange={event=>setIdentity(event.target.value)}/>
        <select aria-label="Invite role" value={role} onChange={event=>setRole(event.target.value as BoardRole)}>
          <option value="member">Member</option><option value="admin">Admin</option>
        </select>
        <button className="primary" type="button" onClick={invite} disabled={!identity.trim()}>Share</button>
      </div>
      <section className="share-link"><h3>Share this board with a link</h3>{sharing.shareUrl?<div className="inline"><input readOnly aria-label="Share link" value={sharing.shareUrl}/><GlassButton onClick={()=>navigator.clipboard?.writeText(sharing.shareUrl!)}>Copy link</GlassButton></div>:<GlassButton onClick={createLink}>Create link</GlassButton>}</section></>}
      <div className="share-tabs" role="tablist">
        <button role="tab" aria-selected={tab==='members'} onClick={()=>setTab('members')}>Board members {sharing.members.length}</button>
        {sharing.canManage&&<button role="tab" aria-selected={tab==='requests'} onClick={()=>setTab('requests')}>Join requests {sharing.requests.length}</button>}
      </div>
      {tab==='members'?<div className="member-list">{sharing.members.map(member=><div className="member-row" key={member.userId}>
        <span className="member-avatar">{member.displayName[0]?.toUpperCase()}</span>
        <span><b>{member.displayName}</b>{member.isSelf&&<small> (you)</small>}<small>{member.email}</small></span>
        {member.role==='owner'||!sharing.canManage?<span className="member-role">{member.role[0].toUpperCase()+member.role.slice(1)}</span>:<span className="member-controls"><select aria-label={`Role for ${member.displayName}`} value={member.role} onChange={event=>updateMember(member,event.target.value as BoardRole)}><option value="member">Member</option><option value="admin">Admin</option></select><GlassButton aria-label={`Remove ${member.displayName}`} onClick={()=>updateMember(member,null)}>Remove</GlassButton></span>}
      </div>)}{sharing.invites.map(invite=><div className="member-row pending" key={invite.id}>
        <span className="member-avatar">{invite.email[0].toUpperCase()}</span>
        <span><b>{invite.email}</b><small>Pending invitation</small></span>
        <span className="member-role">{invite.role[0].toUpperCase()+invite.role.slice(1)}</span>
      </div>)}</div>:<div className="member-list">{sharing.requests.map(request=><div className="member-row" key={request.id}><span className="member-avatar">{request.displayName[0]}</span><span><b>{request.displayName}</b><small>{request.email}</small></span><span className="request-actions"><GlassButton aria-label={`Approve ${request.displayName}`} onClick={()=>resolveRequest(request,true)}>Approve</GlassButton><GlassButton aria-label={`Decline ${request.displayName}`} onClick={()=>resolveRequest(request,false)}>Decline</GlassButton></span></div>)}</div>}
    </div>
  </GlassModal>;
}
