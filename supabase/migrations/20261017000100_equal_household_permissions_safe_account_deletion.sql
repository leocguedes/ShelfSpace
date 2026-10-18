-- Equal household permissions and safe account deletion.
-- This migration is additive and preserves existing household membership/data.

-- Household membership is the only authorization boundary; role labels are legacy metadata.
create or replace function public.is_household_admin(target_household_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public, private, pg_temp
as $$ select private.is_household_member(target_household_id); $$;

create or replace function private.is_household_admin(target_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select exists (
    select 1 from public.household_members hm
    where hm.household_id = target_household_id
      and hm.user_id = (select auth.uid())
  );
$$;

-- All members can rename the house and manage invites.
drop policy if exists "Household admins can update households" on public.households;
create policy "Household members can update households"
on public.households for update to authenticated
using (public.is_household_member(id))
with check (public.is_household_member(id));

drop policy if exists "Household admins can read invites" on public.household_invites;
create policy "Household members can read invites"
on public.household_invites for select to authenticated
using (public.is_household_member(household_id));

create or replace function public.create_household_invite(
  target_household_id uuid,
  valid_for_days integer default 7,
  allowed_uses integer default 5
)
returns table(invite_code text, invite_expires_at timestamptz)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_code text;
  v_expires_at timestamptz;
begin
  if (select auth.uid()) is null then
    raise exception 'Authentication required';
  end if;
  if not private.is_household_member(target_household_id) then
    raise exception 'Household membership required';
  end if;
  if valid_for_days is null or valid_for_days < 1 or valid_for_days > 30 then
    raise exception 'Invite validity must be between 1 and 30 days';
  end if;
  if allowed_uses is null or allowed_uses < 1 or allowed_uses > 50 then
    raise exception 'Invite capacity must be between 1 and 50';
  end if;

  v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  v_expires_at := now() + make_interval(days => valid_for_days);

  insert into public.household_invites(household_id, code, created_by, expires_at, max_uses)
  values(target_household_id, v_code, (select auth.uid()), v_expires_at, allowed_uses);

  return query select v_code, v_expires_at;
end;
$$;

-- Allow trusted nested cleanup to transfer inventory ownership during auth deletion.
create or replace function public.preserve_row_creator()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $preserve$
begin
  if tg_op = 'INSERT' then
    if new.user_id is distinct from (select auth.uid()) then
      raise exception 'user_id must match the authenticated user';
    end if;
  elsif pg_trigger_depth() > 1 and current_user = 'postgres' then
    return new;
  else
    new.user_id := old.user_id;
  end if;
  return new;
end;
$preserve$;

-- Preserve household-wide records when the creator's auth account is deleted.
-- Nullable attribution is preferable to cascading deletion of shared records.
alter table public.households alter column created_by drop not null;
alter table public.household_invites alter column created_by drop not null;
alter table public.shopping_items alter column created_by drop not null;
alter table public.recurring_shopping_items alter column created_by drop not null;
alter table public.food_consumption_events alter column created_by drop not null;
alter table public.food_consumption_rules alter column created_by drop not null;

alter table public.households drop constraint if exists households_created_by_fkey;
alter table public.households add constraint households_created_by_fkey
  foreign key (created_by) references auth.users(id) on delete set null;
alter table public.household_invites drop constraint if exists household_invites_created_by_fkey;
alter table public.household_invites add constraint household_invites_created_by_fkey
  foreign key (created_by) references auth.users(id) on delete set null;
alter table public.shopping_items drop constraint if exists shopping_items_created_by_fkey;
alter table public.shopping_items add constraint shopping_items_created_by_fkey
  foreign key (created_by) references auth.users(id) on delete set null;
alter table public.recurring_shopping_items drop constraint if exists recurring_shopping_items_created_by_fkey;
alter table public.recurring_shopping_items add constraint recurring_shopping_items_created_by_fkey
  foreign key (created_by) references auth.users(id) on delete set null;
alter table public.food_consumption_events drop constraint if exists food_consumption_events_created_by_fkey;
alter table public.food_consumption_events add constraint food_consumption_events_created_by_fkey
  foreign key (created_by) references auth.users(id) on delete set null;
alter table public.food_consumption_rules drop constraint if exists food_consumption_rules_created_by_fkey;
alter table public.food_consumption_rules add constraint food_consumption_rules_created_by_fkey
  foreign key (created_by) references auth.users(id) on delete set null;

-- On account deletion, transfer ownership of shared inventory rows to another
-- member before auth.users cascades can remove them. The whole operation is transactional.
create or replace function private.preserve_shared_household_data_before_user_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
declare
  v_house record;
  v_replacement uuid;
begin
  for v_house in
    select hm.household_id
    from public.household_members hm
    where hm.user_id = old.id
    order by hm.household_id
    for update
  loop
    select hm.user_id into v_replacement
    from public.household_members hm
    where hm.household_id = v_house.household_id
      and hm.user_id <> old.id
    order by hm.joined_at, hm.user_id
    limit 1;

    if v_replacement is not null then
      update public.locations
      set user_id = v_replacement
      where household_id = v_house.household_id and user_id = old.id;

      update public.subdivisions s
      set user_id = v_replacement
      from public.locations l
      where s.location_id = l.id
        and l.household_id = v_house.household_id
        and s.user_id = old.id;

      update public.foods f
      set user_id = v_replacement
      from public.subdivisions s
      join public.locations l on l.id = s.location_id
      where f.subdivision_id = s.id
        and l.household_id = v_house.household_id
        and f.user_id = old.id;
    end if;
  end loop;

  return old;
end;
$$;

drop trigger if exists preserve_shared_household_data_before_user_delete on auth.users;
create trigger preserve_shared_household_data_before_user_delete
before delete on auth.users
for each row execute function private.preserve_shared_household_data_before_user_delete();

-- A household is removed only after its final member is removed.
create or replace function private.delete_empty_household_after_member_delete()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private, pg_temp
as $$
begin
  if not exists (
    select 1 from public.household_members hm
    where hm.household_id = old.household_id
  ) then
    delete from public.households h where h.id = old.household_id;
  end if;
  return old;
end;
$$;

drop trigger if exists delete_empty_household_after_member_delete on public.household_members;
create trigger delete_empty_household_after_member_delete
after delete on public.household_members
for each row execute function private.delete_empty_household_after_member_delete();

revoke all on function private.preserve_shared_household_data_before_user_delete() from public, anon, authenticated;
revoke all on function private.delete_empty_household_after_member_delete() from public, anon, authenticated;
revoke all on function public.create_household_invite(uuid, integer, integer) from public, anon;
grant execute on function public.create_household_invite(uuid, integer, integer) to authenticated;
