revoke update on table public.households from authenticated;
grant update (name) on table public.households to authenticated;

drop policy if exists "Household members can update households" on public.households;
create policy "Household members can update household names"
on public.households
for update
to authenticated
using (public.is_household_member(id))
with check (public.is_household_member(id));