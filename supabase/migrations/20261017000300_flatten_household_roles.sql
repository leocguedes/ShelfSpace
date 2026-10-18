-- Remove legacy role distinctions from household membership records.
update public.household_members set role = 'member' where role <> 'member';

alter table public.household_members alter column role set default 'member';
alter table public.household_members drop constraint if exists household_members_role_check;
alter table public.household_members add constraint household_members_role_check
  check (role = 'member');

create or replace function public.ensure_personal_household()
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $personal$
declare
  v_user_id uuid := (select auth.uid());
  v_household_id uuid;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  insert into public.households (name, created_by, is_personal)
  values ('Minha casa', v_user_id, true)
  on conflict (created_by) where is_personal
  do update set created_by = excluded.created_by
  returning id into v_household_id;

  insert into public.household_members (household_id, user_id, role)
  values (v_household_id, v_user_id, 'member')
  on conflict (household_id, user_id) do nothing;

  update public.locations
  set household_id = v_household_id
  where user_id = v_user_id and household_id is null;

  return v_household_id;
end;
$personal$;

create or replace function public.get_household_members(target_household_id uuid)
returns table(user_id uuid, email text, display_name text, role text, joined_at timestamptz)
language plpgsql
stable
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $members$
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;
  if not private.is_household_member(target_household_id) then
    raise exception 'You are not a member of this household';
  end if;

  return query
    select hm.user_id,
      coalesce(u.email, '')::text,
      coalesce(
        nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''),
        nullif(trim(u.raw_user_meta_data ->> 'name'), ''),
        nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
        'Membro da família'
      )::text,
      'member'::text,
      hm.joined_at
    from public.household_members hm
    join auth.users u on u.id = hm.user_id
    where hm.household_id = target_household_id
    order by hm.joined_at asc, hm.user_id asc;
end;
$members$;

revoke all on function public.ensure_personal_household() from public, anon;
grant execute on function public.ensure_personal_household() to authenticated;
revoke all on function public.get_household_members(uuid) from public, anon;
grant execute on function public.get_household_members(uuid) to authenticated;
