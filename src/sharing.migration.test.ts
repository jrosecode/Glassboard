import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';

const path=resolve(process.cwd(),'supabase/migrations/20261031010000_board_sharing.sql');
const sql=readFileSync(path,'utf8').toLowerCase();
const functionSql=(name:string)=>sql.match(new RegExp(`create or replace function public\\.${name}[\\s\\S]*?end\\$\\$`))?.[0]??'';

describe('board sharing migration',()=>{
  it('has no direct invitation RPC or global auth.users lookup',()=>{
    expect(sql).not.toContain('function public.invite_board_member');
    expect(sql).not.toContain('invite_board_member(');
    expect(sql).not.toContain('auth.users');
  });

  it('schema-qualifies pgcrypto calls under an empty search path',()=>{
    expect(sql).toContain('extensions.gen_random_bytes(32)');
    expect(sql).toContain("extensions.digest(raw_token,'sha256')");
    expect(sql).toContain("extensions.digest(p_token,'sha256')");
    expect(functionSql('create_board_share_link')).toContain("set search_path=''");
  });

  it('revokes prior links and deletes their pending requests during rotation',()=>{
    const fn=functionSql('create_board_share_link');
    expect(fn).toContain('update public.board_share_links');
    expect(fn).toContain('returning id');
    expect(fn).toContain('delete from public.board_join_requests');
    expect(fn).toContain('share_link_id');
  });

  it('only approves requests tied to a still-active share link',()=>{
    const fn=functionSql('resolve_board_join_request');
    expect(fn).toContain('using public.board_share_links');
    expect(fn).toContain('revoked_at is null');
    expect(fn).toContain('join public.workspace_members');
    expect(fn).toContain('public.board_members bm');
    expect(fn.indexOf('join public.workspace_members')).toBeLessThan(fn.indexOf('insert into public.board_members'));
  });

  it('removes stale requests when access already exists',()=>{
    const fn=functionSql('request_board_access');
    const access=fn.indexOf('public.can_access_board(link.board_id)');
    const remove=fn.indexOf('delete from public.board_join_requests',access);
    const accessible=fn.indexOf("'status','accessible'",access);
    expect(remove).toBeGreaterThan(access);
    expect(remove).toBeLessThan(accessible);
  });

  it('rejects self-removal server-side',()=>{
    const fn=functionSql('update_board_member');
    expect(fn).toContain('p_user_id=auth.uid()');
    expect(fn).toContain('cannot remove your own board access');
  });

  it('uses a narrow metadata RPC guarded by board-management permission',()=>{
    const fn=functionSql('update_board_metadata');
    expect(fn).toContain('public.can_manage_board(p_board_id)');
    expect(fn).toContain('title=coalesce');
    expect(fn).toContain('is_favorite=coalesce');
    expect(fn).not.toContain('workspace_id');
    expect(fn).not.toContain('created_by');
    expect(sql).toContain('grant execute on function public.update_board_metadata');
  });

  it('bounds label count and trimmed label length',()=>{
    const fn=functionSql('set_card_labels');
    expect(fn).toMatch(/array_length\(p_names,\s*1\).*20/);
    expect(fn).toContain('length(trim(name))>50');
  });
});
