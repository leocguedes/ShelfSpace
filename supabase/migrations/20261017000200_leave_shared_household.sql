-- Let a member leave a shared household without deleting their account.
create or replace function public.leave_household(target_household_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private, pg_temp
as $leave$
declare
  v_user_id uuid := (select auth.uid());
  v_is_personal boolean;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select h.is_personal into v_is_personal
  from public.households h
  join public.household_members hm on hm.household_id = h.id
  where h.id = target_household_id and hm.user_id = v_user_id
  for update of h;

  if not found then
    raise exception 'Household membership required';
  end if;
  if v_is_personal then
    raise exception 'Personal households cannot be left';
  end if;

  delete from public.household_members
  where household_id = target_household_id and user_id = v_user_id;
end;
$leave$;

revoke all on function public.leave_household(uuid) from public, anon;
grant execute on function public.leave_household(uuid) to authenticated;
