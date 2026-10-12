create or replace function public.get_household_members(target_household_id uuid)
returns table(
  user_id uuid,
  email text,
  display_name text,
  role text,
  joined_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, auth, pg_temp
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;

  if not public.is_household_member(target_household_id) then
    raise exception 'You are not a member of this household';
  end if;

  return query
    select
      hm.user_id,
      coalesce(u.email, '')::text as email,
      coalesce(
        nullif(trim(u.raw_user_meta_data ->> 'full_name'), ''),
        nullif(trim(u.raw_user_meta_data ->> 'name'), ''),
        nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
        'Membro da família'
      )::text as display_name,
      hm.role,
      hm.joined_at
    from public.household_members hm
    join auth.users u on u.id = hm.user_id
    where hm.household_id = target_household_id
    order by
      case hm.role when 'owner' then 0 when 'admin' then 1 else 2 end,
      hm.joined_at asc;
end;
$$;

revoke all on function public.get_household_members(uuid) from public, anon;
grant execute on function public.get_household_members(uuid) to authenticated;
