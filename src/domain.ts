export type Priority='low'|'medium'|'high'|'urgent';
export interface Card {id:string;listId:string;title:string;description:string;priority:Priority;labels:string[];dueDate:string|null;completed:boolean;position:number;assignees?:string[];reminderAt?:string|null;checklist?:{id:string;text:string;done:boolean}[];comments?:{id:string;body:string;author:string;createdAt:string}[];customFields?:Record<string,string>;dependencies?:string[];attachments?:{id:string;name:string;path:string;mimeType?:string;signedUrl?:string}[]}
export interface List {id:string;title:string;position:number;collapsed:boolean}
export interface Board {id:string;title:string;description:string;background:string;favorite:boolean;workspaceId:string;updatedAt:string}
export interface Workspace {id:string;name:string}
export type View='board'|'table'|'calendar'|'timeline'|'dashboard';
export const filterCards=(cards:Card[],query:string,priority:Priority|'all'='all')=>{const q=query.trim().toLowerCase();return cards.filter(c=>(priority==='all'||c.priority===priority)&&(!q||[c.title,c.description,c.priority,...c.labels].join(' ').toLowerCase().includes(q)))};
export const moveCard=(cards:Card[],id:string,listId:string,position:number)=>cards.map(c=>c.id===id?{...c,listId,position}:c).sort((a,b)=>a.listId.localeCompare(b.listId)||a.position-b.position);
export const analytics=(cards:Card[])=>{const today=new Date().toISOString().slice(0,10);const completed=cards.filter(c=>c.completed).length;return {total:cards.length,completed,overdue:cards.filter(c=>!c.completed&&c.dueDate!==null&&c.dueDate<today).length,completionRate:cards.length?Math.round(completed/cards.length*100):0};};
