import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';

const path=resolve(process.cwd(),'supabase/migrations/20261031010000_board_sharing.sql');

describe('board sharing migration',()=>{
  it('adds protected sharing tables and security-definer RPCs',()=>{
    const sql=readFileSync(path,'utf8').toLowerCase();
    for(const table of ['board_members','board_invites','board_share_links','board_join_requests']){
      expect(sql).toContain(`create table public.${table}`);
      expect(sql).toContain(`alter table public.${table} enable row level security`);
    }
    for(const fn of ['get_board_sharing','invite_board_member','create_board_share_link','request_board_access','resolve_board_join_request','update_board_member']){
      expect(sql).toContain(`function public.${fn}`);
    }
    expect(sql).toContain('security definer');
    expect(sql).toContain('revoke all on function');
    expect(sql).toContain('grant execute on function');
    expect(sql).toContain('board_members bm');
  });
});
