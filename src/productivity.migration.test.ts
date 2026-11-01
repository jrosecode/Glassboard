import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';
const sql=readFileSync(resolve(process.cwd(),'supabase/migrations/20261101010000_productivity_platform.sql'),'utf8').toLowerCase();
describe('productivity migration contract',()=>{
 it('normalizes activity notifications planning agents and schedules',()=>{for(const table of ['activity_events','notification_preferences','planning_requests','agent_runs','agent_events','reminders','recurring_rules','email_reminder_queue'])expect(sql).toContain(`create table public.${table}`);expect(sql).toContain('alter table public.notifications add column event_id')});
 it('enforces the one AI list per board invariant',()=>{expect(sql).toContain('create unique index lists_one_ai_per_board');expect(sql).toContain("where kind = 'ai'");expect(sql).toContain('public.queue_card_for_ai')});
 it('extends cards for projects and dependencies',()=>{for(const value of ['parent_id','task_type','blocked_reason','acceptance_criteria','completed_at'])expect(sql).toContain(value);expect(sql).toContain('alter table public.card_dependencies')});
 it('hardens definer functions and grants narrowly',()=>{expect(sql).toMatch(/security definer set search_path\s*=\s*''/);expect(sql).toContain('revoke all on function public.queue_card_for_ai');expect(sql).toContain('to authenticated');expect(sql).not.toContain('grant execute on all functions')});
 it('enables RLS on every new actor-facing table',()=>{for(const table of ['activity_events','notifications','planning_requests','agent_runs','reminders'])expect(sql).toContain(`alter table public.${table} enable row level security`)});
});
