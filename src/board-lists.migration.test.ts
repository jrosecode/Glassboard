import {existsSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';

const migrationPath=resolve(process.cwd(),'supabase/migrations/20261101050000_bootstrap_board_lists.sql');
const accountBootstrapPath=resolve(process.cwd(),'supabase/migrations/20261101060000_bootstrap_default_board.sql');

describe('board list bootstrap migration',()=>{
 it('starts every board with one blank normal list and one AI list',()=>{
  expect(existsSync(migrationPath)).toBe(true);
  if(!existsSync(migrationPath))return;
  const sql=readFileSync(migrationPath,'utf8').toLowerCase();
  expect(sql).toContain("'new list'");
  expect(sql).toContain("'ai'");
  expect(sql).toContain('after insert on public.boards');
  expect(sql).toContain('where not exists');
  expect(sql).toContain("set_config('app.queue_card_for_ai','on',true)");
  expect(sql).toContain("previous_queue_setting text:=coalesce(current_setting('app.queue_card_for_ai',true),'')");
  expect(sql).toContain("set_config('app.queue_card_for_ai',previous_queue_setting,true)");
  expect(sql).toMatch(/lock table public\.lists in share row exclusive mode[\s\S]*for target_board in select id from public\.boards/);
  const backfill=sql.slice(sql.indexOf('lock table public.lists'),sql.indexOf('drop policy if exists lists_member'));
  expect(backfill).not.toContain('pg_advisory_xact_lock');
  expect(backfill).toMatch(/for target_board in select id from public\.boards[\s\S]*insert into public\.lists[\s\S]*'new list'[\s\S]*insert into public\.lists[\s\S]*'ai'/);
 });

 it('creates additional normal lists through a bounded board-scoped RPC',()=>{
  expect(existsSync(migrationPath)).toBe(true);
  if(!existsSync(migrationPath))return;
  const sql=readFileSync(migrationPath,'utf8').toLowerCase();
  expect(sql).toContain('public.create_board_list(p_board_id uuid,p_title text)');
  expect(sql).toContain('public.can_access_board(p_board_id)');
  expect(sql).toContain('length(clean_title) between 1 and 120');
  expect(sql).toMatch(/count\(\*\)[\s\S]*>=50/);
  expect(sql).toContain('grant execute on function public.create_board_list(uuid,text) to authenticated');
  expect(sql).toContain('revoke all on function public.create_board_list(uuid,text) from public,anon,authenticated');
 });

 it('removes direct list inserts while retaining scoped read update and guarded delete policies',()=>{
  const sql=readFileSync(migrationPath,'utf8').toLowerCase();
  expect(sql).toContain('drop policy if exists lists_member on public.lists');
  expect(sql).toMatch(/create policy lists_member_read on public\.lists for select to authenticated\s+using\s*\(public\.can_access_board\(board_id\)\)/);
  expect(sql).toMatch(/create policy lists_member_update on public\.lists for update to authenticated[\s\S]*with check\s*\(public\.can_access_board\(board_id\)\)/);
  expect(sql).toMatch(/create policy lists_member_delete on public\.lists for delete to authenticated\s+using\s*\(public\.can_access_board\(board_id\)\)/);
  expect(sql).toContain('lists_ai_delete_guard');
  expect(sql).toContain('revoke insert on public.lists from authenticated');
  expect(sql).not.toMatch(/create policy [^;]+ on public\.lists for insert/);
 });

 it('forbids moving a list between boards',()=>{
  const sql=readFileSync(migrationPath,'utf8').toLowerCase();
  expect(sql).toMatch(/validate_list_board_change[\s\S]*new\.board_id is distinct from old\.board_id[\s\S]*raise exception 'list cannot move between boards'/);
 });

 it('rechecks board access after taking the create-list lock',()=>{
  const sql=readFileSync(migrationPath,'utf8').toLowerCase();
  expect(sql).toMatch(/create_board_list[\s\S]*pg_advisory_xact_lock\(hashtextextended\(p_board_id::text,0\)\);\s*if not public\.can_access_board\(p_board_id\) then\s*raise exception 'board access denied'/);
 });

 it('serializes list reordering with create-list, blocks direct position writes, and reauthorizes after locking',()=>{
  const sql=readFileSync(migrationPath,'utf8').toLowerCase();
  expect(sql).toContain('public.reorder_board_list(p_list_id uuid,p_position numeric)');
  expect(sql).toMatch(/reorder_board_list[\s\S]*select board_id into target_board[\s\S]*pg_advisory_xact_lock\(hashtextextended\(target_board::text,0\)\);[\s\S]*select board_id into target_board[\s\S]*not public\.can_access_board\(target_board\)[\s\S]*set_config\('app\.reorder_board_list','on',true\)[\s\S]*update public\.lists/);
  expect(sql).toContain('public.enforce_list_position_update()');
  expect(sql).toContain("current_setting('app.reorder_board_list',true)");
  expect(sql).toContain('before update of position on public.lists');
  expect(sql).toContain('revoke all on function public.reorder_board_list(uuid,numeric) from public,anon,authenticated');
  expect(sql).toContain('grant execute on function public.reorder_board_list(uuid,numeric) to authenticated');
 });

 it('takes the board list lock before planning materialization derives list positions',()=>{
  const sql=readFileSync(migrationPath,'utf8').toLowerCase();
  expect(sql).toMatch(/approve_and_materialize_plan[\s\S]*pg_advisory_xact_lock\(hashtextextended\(request\.board_id::text,0\)\);[\s\S]*can_access_board\(request\.board_id\)[\s\S]*for list_row in[\s\S]*insert into public\.lists[\s\S]*max\(position\)/);
 });
});

describe('default board bootstrap migration',()=>{
 it('creates one authorized default workspace and board idempotently',()=>{
  expect(existsSync(accountBootstrapPath)).toBe(true);
  if(!existsSync(accountBootstrapPath))return;
  const sql=readFileSync(accountBootstrapPath,'utf8').toLowerCase();
  expect(sql).toContain('create or replace function public.ensure_default_board()');
  expect(sql).toContain('auth.uid()');
  expect(sql).toContain('pg_advisory_xact_lock');
  expect(sql).toMatch(/pg_advisory_xact_lock[\s\S]*workspace_members[\s\S]*user_id=caller_id[\s\S]*board_members[\s\S]*user_id=caller_id/);
  expect(sql).toContain('workspace_members_user_workspace_idx');
  expect(sql).not.toContain('insert into public.workspace_members');
  expect(sql).toContain("values('my workspace',caller_id)");
  expect(sql).toContain("values(created_workspace,'my board',caller_id)");
  expect(sql).toContain('revoke all on function public.ensure_default_board() from public,anon,authenticated');
  expect(sql).toContain('grant execute on function public.ensure_default_board() to authenticated');
 });
});
