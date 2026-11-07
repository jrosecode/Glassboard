import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe,it,expect} from 'vitest';

const read=(path:string)=>readFileSync(resolve(process.cwd(),path),'utf8');
const sql=read('supabase/migrations/20261107010000_ai_chat.sql');
const app=read('src/App.tsx');
const ui=read('src/AIChat.tsx');
const worker=read('scripts/productivity-worker.mjs');
const repository=read('src/supabase.ts');

describe('private AI model chat contract',()=>{
 it('replaces board favorite action with chat and keeps settings navigation',()=>{
  expect(app).toContain('aria-label="Chat with AI"');
  expect(app).not.toContain('aria-label="Favorite board"');
  expect(app).toContain('onSettings={()=>{setChatOpen(false);setSettingsSection(\'ai\');setPanel(\'settings\')}');
 });
 it('keeps model API keys out of the browser and routes through the private worker',()=>{
  expect(ui).not.toMatch(/OPENAI_API_KEY|SUPABASE_SERVICE_ROLE_KEY|VITE_.*KEY/);
  expect(repository).toContain("rpc('ai_chat_send'");
  expect(worker).toContain("rpc('ai_chat_claim'");
  expect(worker).toContain('generateWithFallback');
  expect(worker).toContain('credentialsFor(userId,settings)');
  expect(worker).toContain("rpc('ai_chat_complete'");
 });
 it('isolates chat by signed-in user and board, and forbids client-written replies',()=>{
  expect(sql).toContain('alter table public.ai_chat_messages enable row level security');
  expect(sql).toContain('revoke all on public.ai_chat_messages from public,anon,authenticated');
  expect(sql).toContain('grant select on public.ai_chat_messages to authenticated');
  expect(sql).toContain('user_id=(select auth.uid())');
  expect(sql).toContain('public.can_access_board(p_board_id)');
  expect(sql).toContain('public.can_access_board(b.id)');
  expect(sql).toContain("role='assistant' and status in ('queued','running')");
 });
 it('supports mobile scrolling, conversation history and a pending state',()=>{
  expect(ui).toContain('ai-chat-history');
  expect(ui).toContain("status==='queued'");
  expect(ui).toContain('repo.aiChatMessages(boardId)');
  expect(ui).toContain('repo.getAISettings(userId)');
  expect(ui).toContain('role="dialog"');
  expect(read('src/reference-theme.css')).toContain('.ai-chat-history');
 });
});
