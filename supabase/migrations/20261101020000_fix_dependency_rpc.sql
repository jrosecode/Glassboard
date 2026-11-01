begin;

create or replace function public.set_card_dependencies(p_card_id uuid,p_dependency_ids uuid[]) returns void
language plpgsql security definer set search_path = ''
as $$declare target_board uuid; begin
  if cardinality(p_dependency_ids)>100 then raise exception 'Too many card dependencies (maximum 100)'; end if;
  select board_id into target_board from public.cards where id=p_card_id for update;
  if target_board is null then raise exception 'Card access denied' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(target_board::text,42));
  select board_id into target_board from public.cards where id=p_card_id;
  if target_board is null or not public.can_access_board(target_board) then raise exception 'Card access denied' using errcode='42501'; end if;
  if p_card_id=any(coalesce(p_dependency_ids,'{}'::uuid[])) then raise exception 'A card cannot depend on itself'; end if;
  if exists(select 1 from unnest(coalesce(p_dependency_ids,'{}'::uuid[])) requested_dependency(dependency_id) left join public.cards c on c.id=requested_dependency.dependency_id where c.id is null or c.board_id<>target_board) then raise exception 'Dependencies must be cards on the same board'; end if;
  delete from public.card_dependencies where card_id=p_card_id;
  insert into public.card_dependencies(card_id,depends_on_card_id) select p_card_id,requested_dependency.dependency_id from unnest(coalesce(p_dependency_ids,'{}'::uuid[])) requested_dependency(dependency_id) on conflict do nothing;
end$$;

revoke all on function public.set_card_dependencies(uuid,uuid[]) from public;
grant execute on function public.set_card_dependencies(uuid,uuid[]) to authenticated;

commit;
