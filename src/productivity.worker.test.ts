import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';

const worker=readFileSync(resolve(process.cwd(),'scripts/productivity-worker.mjs'),'utf8');
describe('local productivity worker contract',()=>{
 it('requires server credentials and keeps Ollama worker-side',()=>{expect(worker).toContain('SUPABASE_SERVICE_ROLE_KEY');expect(worker).toContain('SUPABASE_URL');expect(worker).toContain('OLLAMA_URL');expect(worker).toContain('127.0.0.1')});
 it('atomically claims and resolves both queue types through restricted RPCs',()=>{for(const rpc of ['claim_productivity_work','renew_productivity_lease','complete_agent_run','complete_planning_request','fail_productivity_work'])expect(worker).toContain(rpc);expect(worker).toContain('generateWithFallback');expect(worker).toContain('ai_usage_events');expect(worker).toContain('setInterval')});
 it('claims and resolves email reminders through the leased worker contract',()=>{for(const rpc of ['enqueue_due_reminders','generate_recurring_cards','claim_email_reminder','complete_email_reminder','fail_email_reminder'])expect(worker).toContain(rpc);expect(worker).toContain('EMAIL_DELIVERY_URL');expect(worker).toContain('recipientEmail');expect(worker).toContain('cardTitle')});
 it('passes the claiming worker identity to every terminal worker RPC',()=>{expect(worker).toMatch(/complete_agent_run[^\n]*p_worker_id:workerId/);expect(worker).toMatch(/complete_planning_request[^\n]*p_worker_id:workerId/);expect(worker).toMatch(/fail_productivity_work[^\n]*p_worker_id:workerId/);expect(worker).toMatch(/complete_email_reminder[^\n]*p_worker_id:workerId/);expect(worker).toMatch(/fail_email_reminder[^\n]*p_worker_id:workerId/)});
 it('heartbeats email leases and sends a stable provider idempotency key',()=>{expect(worker).toContain('renew_email_reminder_lease');expect(worker).toMatch(/processEmail[\s\S]*setInterval\([\s\S]*renew_email_reminder_lease/);expect(worker).toContain("'Idempotency-Key':job.id");expect(worker).toMatch(/finally\{clearInterval\(heartbeat\)\}/)});
 it('reauthorizes email delivery immediately before constructing the provider payload',()=>{expect(worker).toMatch(/processEmail[\s\S]*authorize_email_reminder_delivery[\s\S]*const payload/);expect(worker).toMatch(/const authorized=await rpc\('authorize_email_reminder_delivery'/)});
});