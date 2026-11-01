import {useEffect,useState} from 'react';
import {GlassButton,GlassModal} from './App';

export type BoardRole='member'|'admin';
export type BoardMember={userId:string;displayName:string;avatarUrl?:string;role:BoardRole|'owner';isSelf:boolean;accessSource:'workspace'|'board';workspaceRole?:'owner'|'admin'|'member'|'guest'};
export type BoardJoinRequest={id:string;displayName:string;avatarUrl?:string;requestedAt:string};
export type BoardSharing={members:BoardMember[];requests:BoardJoinRequest[];shareUrl:string|null;canManage:boolean};

export interface SharingRepository {
  boardSharing(boardId:string):Promise<BoardSharing>;
  createBoardShareLink(boardId:string):Promise<string>;
  resolveBoardJoinRequest(boardId:string,requestId:string,approve:boolean,role:BoardRole):Promise<BoardSharing>;
  updateBoardMember(boardId:string,userId:string,role:BoardRole|null):Promise<BoardSharing>;
}

const initialTestSharing:BoardSharing={
  members:[{userId:'demo',displayName:'Demo User',role:'owner',isSelf:true,accessSource:'workspace'}],
  requests:[],shareUrl:null,canManage:true,
};

export function ShareBoardModal({boardId='b1',repository,testMode=false,onClose}:{boardId?:string;repository?:SharingRepository|null;testMode?:boolean;onClose:()=>void}){
  const [sharing,setSharing]=useState<BoardSharing>(()=>testMode?initialTestSharing:{members:[],requests:[],shareUrl:null,canManage:false});
  const [tab,setTab]=useState<'members'|'requests'>('members');
  const [error,setError]=useState('');
  const [busy,setBusy]=useState(!testMode&&Boolean(repository));

  useEffect(()=>{
    if(testMode||!repository)return;
    let active=true;
    repository.boardSharing(boardId).then(next=>{if(active){setSharing(next);setError('')}}).catch(cause=>{if(active)setError((cause as Error).message)}).finally(()=>{if(active)setBusy(false)});
    return()=>{active=false};
  },[boardId,repository,testMode]);

  async function mutate(action:()=>Promise<BoardSharing|string>){
    if(busy)return;
    setBusy(true);
    try{
      const result=await action();
      if(typeof result==='string')setSharing(current=>({...current,shareUrl:result}));
      else setSharing(result);
      setError('');
    }catch(cause){setError((cause as Error).message)}
    finally{setBusy(false)}
  }

  const createLink=()=>mutate(async()=>testMode?`${window.location.origin}${window.location.pathname}?share=test-${boardId}`:repository!.createBoardShareLink(boardId));
  const resolveRequest=(request:BoardJoinRequest,approve:boolean)=>mutate(async()=>testMode
    ? {...sharing,requests:sharing.requests.filter(item=>item.id!==request.id),members:approve?[...sharing.members,{userId:`test-${request.id}`,displayName:request.displayName,role:'member',isSelf:false,accessSource:'board'}]:sharing.members}
    : repository!.resolveBoardJoinRequest(boardId,request.id,approve,'member'));
  const updateMember=(member:BoardMember,nextRole:BoardRole|null)=>mutate(async()=>testMode
    ? {...sharing,members:nextRole?sharing.members.map(item=>item.userId===member.userId?{...item,role:nextRole}:item):sharing.members.filter(item=>item.userId!==member.userId)}
    : repository!.updateBoardMember(boardId,member.userId,nextRole));

  return <GlassModal title="Share board" onClose={onClose}>
    <div className="share-dialog" aria-busy={busy}>
      {busy&&<p role="status">{sharing.members.length?'Saving changes…':'Loading sharing…'}</p>}
      {error&&<p className="error" role="alert">{error}</p>}
      {sharing.canManage&&<section className="share-link">
        <h3>Share this board with a link</h3>
        <p>Anyone with the link can request access. A board manager must approve each request.</p>
        {sharing.shareUrl?<div className="inline"><input readOnly aria-label="Share link" value={sharing.shareUrl}/><GlassButton disabled={busy} onClick={()=>navigator.clipboard?.writeText(sharing.shareUrl!)}>Copy link</GlassButton></div>:<GlassButton disabled={busy} onClick={createLink}>Create link</GlassButton>}
      </section>}
      <div className="share-tabs" role="tablist">
        <button disabled={busy} role="tab" aria-selected={tab==='members'} onClick={()=>setTab('members')}>Board members {sharing.members.length}</button>
        {sharing.canManage&&<button disabled={busy} role="tab" aria-selected={tab==='requests'} onClick={()=>setTab('requests')}>Join requests {sharing.requests.length}</button>}
      </div>
      {tab==='members'?<div className="member-list">{sharing.members.map(member=><div className="member-row" key={member.userId}>
        <span className="member-avatar">{member.displayName[0]?.toUpperCase()}</span>
        <span><b>{member.displayName}</b>{member.isSelf&&<small> (you)</small>}</span>
        {member.role==='owner'||member.accessSource==='workspace'||member.isSelf||!sharing.canManage?<span className="member-role">{member.role[0].toUpperCase()+member.role.slice(1)}</span>:<span className="member-controls"><select disabled={busy} aria-label={`Role for ${member.displayName}`} value={member.role} onChange={event=>updateMember(member,event.target.value as BoardRole)}><option value="member">Member</option><option value="admin">Admin</option></select><GlassButton disabled={busy} aria-label={`Remove ${member.displayName}`} onClick={()=>updateMember(member,null)}>Remove</GlassButton></span>}
      </div>)}</div>:<div className="member-list">{sharing.requests.map(request=><div className="member-row" key={request.id}><span className="member-avatar">{request.displayName[0]}</span><span><b>{request.displayName}</b></span><span className="request-actions"><GlassButton disabled={busy} aria-label={`Approve ${request.displayName}`} onClick={()=>resolveRequest(request,true)}>Approve</GlassButton><GlassButton disabled={busy} aria-label={`Decline ${request.displayName}`} onClick={()=>resolveRequest(request,false)}>Decline</GlassButton></span></div>)}</div>}
    </div>
  </GlassModal>;
}
