import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe,it,expect} from 'vitest';

const edge=readFileSync(resolve(process.cwd(),'supabase/functions/agent-api/index.ts'),'utf8');
const worker=readFileSync(resolve(process.cwd(),'scripts/productivity-worker.mjs'),'utf8');
const health=readFileSync(resolve(process.cwd(),'supabase/migrations/20261105060000_agent_worker_health.sql'),'utf8');

describe('agent API security and update contract',()=>{
 it('requires a signed-in Supabase user and uses the user-scoped RLS client',()=>{
  expect(edge).toContain('client.auth.getUser(token)');
  expect(edge).toContain('Authorization:bearer');
  expect(edge).not.toContain('SERVICE_ROLE');
  expect(edge).not.toContain('supabaseAdmin');
 });
 it('exposes efficient, bounded task reads and explicitly constrained write fields',()=>{
  expect(edge).toContain('requested>200');
  expect(edge).toContain('.range(offset,offset+requested)');
  for(const item of ['title','description','priority','completed','due_at','is_archived'])expect(edge).toContain(item);
  expect(edge).toContain('allowedChanges.has(key)');
 });
 it('enforces same-board list movement and idempotent AI queuing',()=>{
  expect(edge).toContain('.eq("board_id",card.board_id)');
  expect(edge).toContain('queue_card_for_ai');
  expect(edge).toContain('idempotency_key');
 });
});
describe('reliable worker handoff',()=>{
 it('does not claim work unless Ollama and the requested model are reachable',()=>{
  expect(worker).toContain('/api/tags');
  expect(worker).toContain('const work=ready?await rpc');
  expect(worker).toContain("p_status:status");
  expect(worker).toContain('report_agent_worker_heartbeat');
 });
 it('restricts privileged heartbeat writes to the service role',()=>{
  expect(health).toContain('enable row level security');
  expect(health).toContain('grant execute on function public.report_agent_worker_heartbeat(text,text) to service_role');
  expect(health).toContain('revoke all on function public.report_agent_worker_heartbeat(text,text) from public,anon,authenticated');
 });
});
