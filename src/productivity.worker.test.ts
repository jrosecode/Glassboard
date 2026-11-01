import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';

const worker=readFileSync(resolve(process.cwd(),'scripts/productivity-worker.mjs'),'utf8');
describe('local productivity worker contract',()=>{
 it('requires server credentials and keeps Ollama worker-side',()=>{expect(worker).toContain('SUPABASE_SERVICE_ROLE_KEY');expect(worker).toContain('SUPABASE_URL');expect(worker).toContain('OLLAMA_URL');expect(worker).toContain('127.0.0.1')});
 it('atomically claims and resolves both queue types through restricted RPCs',()=>{for(const rpc of ['claim_productivity_work','complete_agent_run','complete_planning_request','fail_productivity_work'])expect(worker).toContain(rpc);expect(worker).toContain('/api/generate')});
});