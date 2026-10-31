import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe,expect,it} from 'vitest';

const path=resolve(process.cwd(),'supabase/migrations/20261031010000_board_sharing.sql');
const functionSql=(sql:string,name:string)=>sql.match(new RegExp(`create or replace function public\\.${name}[\\s\\S]*?end\\$\\$`))?.[0]??'';

describe('board sharing migration',()=>{
  it('adds protected sharing tables and security-definer RPCs',()=>{
    const sql=readFileSync(path,'utf8').toLowerCase();
    for(const table of ['board_members','board_share_links','board_join_requests']){
      expect(sql).toContain(`create table public.${table}`);
      expect(sql).toContain(`alter table public.${table} enable row level security`);
    }
    for(const fn of ['get_board_sharing','invite_board_member','create_board_share_link','request_board_access','resolve_board_join_request','update_board_member','set_card_labels'])expect(sql).toContain(`function public.${fn}`);
    expect(sql).toContain('security definer');
    expect(sql).toContain('revoke all on function');
    expect(sql).toContain('grant execute on function');
    expect(sql).toContain('board_members bm');
  });

  it('does not persist unverified email invitations or auto-claim them during signup',()=>{
    const sql=readFileSync(path,'utf8').toLowerCase();
    expect(sql).not.toContain('create table public.board_invites');
    const handler=functionSql(sql,'handle_new_user\\(\\)');
    expect(handler).not.toContain('board_invites');
    expect(handler).not.toContain('board_members');
    expect(sql).toContain('use a share link');
  });

  it('does not discover users by display name or return auth emails in the sharing roster',()=>{
    const sql=readFileSync(path,'utf8').toLowerCase();
    const invite=functionSql(sql,'invite_board_member');
    const sharing=functionSql(sql,'get_board_sharing');
    expect(invite).not.toContain('lower(p.display_name)');
    expect(sharing).not.toContain('auth.users');
    expect(sharing).not.toMatch(/['"]email['"]/);
  });

  it('does not create hidden board roles for users whose access comes from the workspace',()=>{
    const invite=functionSql(readFileSync(path,'utf8').toLowerCase(),'invite_board_member');
    expect(invite).toContain('workspace_members');
    expect(invite).toContain('return public.get_board_sharing');
  });

  it('lists workspace-derived access without editable board controls',()=>{
    const sharing=functionSql(readFileSync(path,'utf8').toLowerCase(),'get_board_sharing');
    expect(sharing).toContain('workspace_members');
    expect(sharing).toContain("'accesssource','workspace'");
    expect(sharing).toContain("'accesssource','board'");
    expect(sharing).toContain('union all');
  });

  it('provides board-scoped label reads and an authorized label mutation RPC',()=>{
    const sql=readFileSync(path,'utf8').toLowerCase();
    expect(sql).toContain('create policy labels_shared_select');
    expect(sql).toContain('public.can_access_board(c.board_id)');
    const setLabels=functionSql(sql,'set_card_labels');
    expect(setLabels).toContain('security definer');
    expect(setLabels).toContain('public.can_access_board');
    expect(setLabels).toContain('delete from public.card_labels');
  });

  it('returns a structured share-token result with status and board id',()=>{
    const request=functionSql(readFileSync(path,'utf8').toLowerCase(),'request_board_access');
    expect(request).toContain("'status','accessible'");
    expect(request).toContain("'status','requested'");
    expect(request).toContain("'boardid'");
    expect(request).toContain('returns jsonb');
  });
});
