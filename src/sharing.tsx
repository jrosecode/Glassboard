import {useEffect,useState} from 'react';
import {GlassButton,GlassModal} from './App';

export type BoardRole='member'|'admin';
export type BoardMember={userId:string;displayName:string;avatarUrl?:string;role:BoardRole|'owner';isSelf:boolean;accessSource:'workspace'|'board';workspaceRole?:'owner'|'admin'|'member'|'guest'};
export type BoardJoinRequest={id:string;displayName:string;avatarUrl?:string;requestedAt:string};
export type BoardInvitation={id:string;email:string;role:BoardRole;status:'pending'|'accepted'|'expired'|'revoked';createdAt:string;expiresAt:string};
export type BoardSharing={members:BoardMember[];requests:BoardJoinRequest[];shareUrl:string|null;canManage:boolean};
export interface SharingRepository {
 boardSharing(boardId:string):Promise<BoardSharing>;
 createBoardShareLink(boardId:string):Promise<string>;
 boardShareLinkStatus?(boardId:string):Promise<{active:boolean;createdAt:string|null}>;
 revokeBoardShareLink?(boardId:string):Promise<void>;
 createBoardEmailInvitation?(boardId:string,email:string,role:BoardRole):Promise<{id:string;token:string;email:string;role:BoardRole;expiresAt:string;url:string}>;
 boardEmailInvitations?(boardId:string):Promise<BoardInvitation[]>;
 revokeBoardEmailInvitation?(boardId:string,id:string):Promise<void>;
 resolveBoardJoinRequest(boardId:string,requestId:string,approve:boolean,role:BoardRole):Promise<BoardSharing>;
 updateBoardMember(boardId:string,userId:string,role:BoardRole|null):Promise<BoardSharing>;
}
const initialTestSharing:BoardSharing={members:[{userId:'demo',displayName:'Demo User',role:'owner',isSelf:true,accessSource:'workspace'}],requests:[],shareUrl:null,canManage:true};
const makeUrl=(token:string,key:'share'|'invite')=>`${window.location.origin}${window.location.pathname}?${key}=${token}`;
export function ShareBoardModal({boardId='b1',repository,testMode=false,onClose}:{boardId?:string;repository?:SharingRepository|null;testMode?:boolean;onClose:()=>void}){
 const [sharing,setSharing]=useState<BoardSharing>(testMode?initialTestSharing:{members:[],requests:[],shareUrl:null,canManage:false});
 const [tab,setTab]=useState<'members'|'requests'|'invitations'>('members');
 const [invitations,setInvitations]=useState<BoardInvitation[]>([]);
 const [linkActive,setLinkActive]=useState(false);
 const [linkUrl,setLinkUrl]=useState<string|null>(null);
 const [inviteEmail,setInviteEmail]=useState('');
 const [inviteRole,setInviteRole]=useState<BoardRole>('member');
 const [lastInvitation,setLastInvitation]=useState<{url:string;email:string}|null>(null);
 const [error,setError]=useState('');
 const [notice,setNotice]=useState('');
 const [busy,setBusy]=useState(!testMode&&Boolean(repository));
 const [copyFailed,setCopyFailed]=useState(false);
 useEffect(()=>{
  if(testMode||!repository)return;
  let active=true;setBusy(true);setLinkUrl(null);setLastInvitation(null);
  Promise.all([repository.boardSharing(boardId),repository.boardShareLinkStatus?.(boardId),repository.boardEmailInvitations?.(boardId)])
   .then(([value,link,invites])=>{if(active){setSharing(value);setLinkActive(link?.active??Boolean(value.shareUrl));setLinkUrl(value.shareUrl);setInvitations(invites??[]);setError('')}})
   .catch(cause=>{if(active)setError((cause as Error).message)})
   .finally(()=>{if(active)setBusy(false)});
  return()=>{active=false};
 },[boardId,repository,testMode]);
 async function mutate(action:()=>Promise<void>){
  if(busy)return;setBusy(true);setError('');setNotice('');
  try{await action()}catch(cause){setError(cause instanceof Error?cause.message:'Unable to update sharing')}
  finally{setBusy(false)}
 }
 async function copy(value:string){
  try{if(!navigator.clipboard?.writeText)throw new Error('Clipboard unavailable');await navigator.clipboard.writeText(value);setNotice('Link copied');setCopyFailed(false)}
  catch{setCopyFailed(true);setNotice('Select the link below to copy it manually.')}
 }
 const refreshSharing=async()=>{if(testMode)return;const next=await repository!.boardSharing(boardId);setSharing(next)};
 const createLink=()=>mutate(async()=>{
  const url=testMode?makeUrl('test-'+boardId,'share'):await repository!.createBoardShareLink(boardId);
  setLinkActive(true);setLinkUrl(url);setNotice('Access-request link created. Anyone using it must be approved.');
 });
 const revokeLink=()=>mutate(async()=>{
  if(!testMode){if(!repository?.revokeBoardShareLink)throw new Error('Link revocation is unavailable');await repository.revokeBoardShareLink(boardId)}
  setLinkActive(false);setLinkUrl(null);setNotice('Share link revoked. Existing board members retain access.');
  if(!testMode)await refreshSharing();
 });
 const sendInvite=()=>mutate(async()=>{
  const email=inviteEmail.trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Enter a valid email address');
  const result=testMode?{id:'demo-invite',email,role:inviteRole,expiresAt:new Date(Date.now()+604800000).toISOString(),url:makeUrl('test-invite','invite')}:await repository!.createBoardEmailInvitation!(boardId,email,inviteRole);
  setLastInvitation({url:result.url,email});setInviteEmail('');
  setInvitations(current=>[{id:result.id,email,role:inviteRole,expiresAt:result.expiresAt,createdAt:new Date().toISOString(),status:'pending'},...current.filter(i=>i.email!==email||i.status==='accepted')]);
  setNotice('Secure invitation ready. Copy the link or open your email app to send it.');
 });
 const resolveRequest=(request:BoardJoinRequest,approve:boolean)=>mutate(async()=>{
  const result=testMode?{...sharing,requests:sharing.requests.filter(item=>item.id!==request.id),members:approve?[...sharing.members,{userId:`test-${request.id}`,displayName:request.displayName,role:'member' as const,isSelf:false,accessSource:'board' as const}]:sharing.members}:await repository!.resolveBoardJoinRequest(boardId,request.id,approve,'member');
  setSharing(result);setNotice(approve?'Access approved':'Request declined');
 });
 const updateMember=(member:BoardMember,role:BoardRole|null)=>mutate(async()=>{
  const result=testMode?{...sharing,members:role?sharing.members.map(m=>m.userId===member.userId?{...m,role}:m):sharing.members.filter(m=>m.userId!==member.userId)}:await repository!.updateBoardMember(boardId,member.userId,role);
  setSharing(result);setNotice(role?'Member role updated':'Member removed');
 });
 const revokeInvitation=(id:string)=>mutate(async()=>{
  if(!testMode)await repository!.revokeBoardEmailInvitation!(boardId,id);
  setInvitations(current=>current.map(i=>i.id===id?{...i,status:'revoked'}:i));setNotice('Invitation revoked');
  if(lastInvitation)setLastInvitation(null);
 });
 const reloadSharing=()=>mutate(async()=>{
  if(testMode){setNotice('Sharing is up to date');return}
  const [next,link,invites]=await Promise.all([
   repository!.boardSharing(boardId),repository!.boardShareLinkStatus?.(boardId),repository!.boardEmailInvitations?.(boardId)
  ]);
  setSharing(next);setLinkActive(link?.active??Boolean(next.shareUrl));setInvitations(invites??[]);
  if(!link?.active)setLinkUrl(null);
  setNotice('Sharing updated');
 });
 const invitationMailto=lastInvitation?`mailto:${encodeURIComponent(lastInvitation.email)}?subject=${encodeURIComponent('You are invited to collaborate in Glassboard')}&body=${encodeURIComponent('You have been invited to a private Glassboard board. Open this invitation while signed in with this email address:\n\n'+lastInvitation.url+'\n\nThe invitation expires after 7 days.')}`:null;
 return <GlassModal title="Share board" onClose={onClose}><div className="share-dialog share-dialog-v2" aria-busy={busy}>
  {busy&&<p role="status">Saving or loading sharing…</p>}
  {error&&<p className="error" role="alert">{error}</p>}
  {notice&&<p className="share-feedback" role="status">{notice}</p>}
  {sharing.canManage&&<section className="share-invitation-panel">
   <h3>Invite people to this board</h3>
   <form className="share-invite" onSubmit={event=>{event.preventDefault();void sendInvite()}}>
    <input aria-label="Invite email address" type="email" value={inviteEmail} onChange={event=>setInviteEmail(event.target.value)} placeholder="Email address" required disabled={busy}/>
    <select aria-label="Invite role" value={inviteRole} onChange={event=>setInviteRole(event.target.value as BoardRole)} disabled={busy}><option value="member">Member</option><option value="admin">Admin</option></select>
    <button className="primary" type="submit" disabled={busy||!inviteEmail.trim()}>Create invitation</button>
   </form>
   <p className="share-help">Invitations are restricted to the specified email address and expire after 7 days.</p>
   {lastInvitation&&<div className="share-generated"><label>Invitation link<input readOnly aria-label="Invitation link" value={lastInvitation.url} onFocus={event=>event.target.select()}/></label><div className="inline"><GlassButton disabled={busy} onClick={()=>void copy(lastInvitation.url)}>Copy invitation</GlassButton>{invitationMailto&&<a className="glass-button" href={invitationMailto}>Open email app</a>}</div></div>}
  </section>}
  {sharing.canManage&&<section className="share-link"><h3>Share with a link</h3><p>Anyone with this link can request access. Approval is required.</p>
   {linkActive&&<p className="share-link-active">An access-request link is active{linkUrl?' and ready to copy.':'. The original secret cannot be retrieved; generate a replacement if needed.'}</p>}
   {linkUrl&&<div className="inline"><input readOnly aria-label="Share link" onFocus={event=>event.target.select()} value={linkUrl}/><GlassButton disabled={busy} onClick={()=>void copy(linkUrl)}>Copy link</GlassButton></div>}
   <div className="share-link-actions"><GlassButton disabled={busy} onClick={createLink}>{linkActive?'Regenerate link':'Create link'}</GlassButton>{linkActive&&<GlassButton disabled={busy} onClick={revokeLink}>Revoke link</GlassButton>}</div>
  </section>}
  {copyFailed&&<p className="share-help">Your browser blocked clipboard access. Select and copy the link from its field.</p>}
  <div className="share-tabs" role="tablist"><button type="button" className="share-refresh" aria-label="Refresh sharing" disabled={busy} onClick={reloadSharing}>Refresh</button><button role="tab" disabled={busy} aria-selected={tab==='members'} onClick={()=>setTab('members')}>Members {sharing.members.length}</button>{sharing.canManage&&<><button role="tab" disabled={busy} aria-selected={tab==='requests'} onClick={()=>setTab('requests')}>Requests {sharing.requests.length}</button><button role="tab" disabled={busy} aria-selected={tab==='invitations'} onClick={()=>setTab('invitations')}>Invitations {invitations.filter(x=>x.status==='pending').length}</button></>}</div>
  {tab==='members'?<div className="member-list">{sharing.members.map(member=><div className="member-row" key={member.userId}><span className="member-avatar">{member.displayName[0]?.toUpperCase()}</span><span><b>{member.displayName}</b>{member.isSelf&&<small> (you)</small>}</span>{member.role==='owner'||member.accessSource==='workspace'||member.isSelf||!sharing.canManage?<span className="member-role">{member.role[0].toUpperCase()+member.role.slice(1)}{member.accessSource==='workspace'&&<small> · workspace</small>}</span>:<span className="member-controls"><select disabled={busy} aria-label={`Role for ${member.displayName}`} value={member.role} onChange={event=>updateMember(member,event.target.value as BoardRole)}><option value="member">Member</option><option value="admin">Admin</option></select><GlassButton disabled={busy} aria-label={`Remove ${member.displayName}`} onClick={()=>updateMember(member,null)}>Remove</GlassButton></span>}</div>)}</div>:tab==='requests'?<div className="member-list">{sharing.requests.length===0&&<p className="share-help">No pending access requests.</p>}{sharing.requests.map(request=><div className="member-row" key={request.id}><span className="member-avatar">{request.displayName[0]}</span><span><b>{request.displayName}</b></span><span className="request-actions"><GlassButton disabled={busy} aria-label={`Approve ${request.displayName}`} onClick={()=>resolveRequest(request,true)}>Approve</GlassButton><GlassButton disabled={busy} aria-label={`Decline ${request.displayName}`} onClick={()=>resolveRequest(request,false)}>Decline</GlassButton></span></div>)}</div>:<div className="member-list">{invitations.length===0&&<p className="share-help">No invitations yet.</p>}{invitations.map(inv=><div className="member-row" key={inv.id}><span className="member-avatar">{inv.email[0].toUpperCase()}</span><span><b>{inv.email}</b><small className="share-invite-status"> {inv.role} · {inv.status}</small></span>{inv.status==='pending'&&<GlassButton disabled={busy} aria-label={`Revoke invitation for ${inv.email}`} onClick={()=>revokeInvitation(inv.id)}>Revoke</GlassButton>}</div>)}</div>}
 </div></GlassModal>
}
