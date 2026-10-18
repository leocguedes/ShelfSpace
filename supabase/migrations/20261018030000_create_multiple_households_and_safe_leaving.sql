create or replace function public.create_household(house_name text)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, private, pg_temp
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_household_id uuid;
  v_name text := trim(coalesce(house_name, ''));
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 15 then
    raise exception 'House name must be between 1 and 15 characters';
  end if;

  insert into public.households (name, created_by, is_personal)
  values (v_name, v_user_id, false)
  returning id into v_household_id;

  insert into public.household_members (household_id, user_id, role)
  values (v_household_id, v_user_id, 'member');

  return v_household_id;
end;
$function$;

revoke all on function public.create_household(text) from public, anon;
grant execute on function public.create_household(text) to authenticated;

create or replace function public.leave_household(target_household_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private, pg_temp
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_is_personal boolean;
  v_created_by uuid;
  v_other_members integer;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select h.is_personal, h.created_by
    into v_is_personal, v_created_by
  from public.households h
  join public.household_members hm on hm.household_id = h.id
  where h.id = target_household_id and hm.user_id = v_user_id
  for update of h;

  if not found then
    raise exception 'Household membership required';
  end if;

  select count(*)::integer into v_other_members
  from public.household_members hm
  where hm.household_id = target_household_id and hm.user_id <> v_user_id;

  if v_is_personal and v_created_by = v_user_id and v_other_members = 0 then
    raise exception 'Your only personal household cannot be left while it has no other members';
  end if;

  if v_is_personal and v_created_by = v_user_id and v_other_members > 0 then
    update public.households
      set is_personal = false, created_by = null
    where id = target_household_id;
  end if;

  delete from public.household_members
  where household_id = target_household_id and user_id = v_user_id;
end;
$function$;

revoke all on function public.leave_household(uuid) from public, anon;
grant execute on function public.leave_household(uuid) to authenticated;
