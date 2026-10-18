-- Prevent RLS bypass via TRUNCATE and stop former household members
-- from retaining access to shared locations they originally created.

REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE TRUNCATE ON TABLES FROM anon, authenticated;

DROP POLICY IF EXISTS "Users and household members can read locations" ON public.locations;
CREATE POLICY "Users and household members can read locations"
ON public.locations
FOR SELECT TO authenticated
USING (
  (household_id IS NULL AND user_id = (SELECT auth.uid()))
  OR
  (household_id IS NOT NULL AND public.is_household_member(household_id))
);

DROP POLICY IF EXISTS "Users and household members can update locations" ON public.locations;
CREATE POLICY "Users and household members can update locations"
ON public.locations
FOR UPDATE TO authenticated
USING (
  (household_id IS NULL AND user_id = (SELECT auth.uid()))
  OR
  (household_id IS NOT NULL AND public.is_household_member(household_id))
)
WITH CHECK (
  (household_id IS NULL AND user_id = (SELECT auth.uid()))
  OR
  (household_id IS NOT NULL AND public.is_household_member(household_id))
);

DROP POLICY IF EXISTS "Users and household members can delete locations" ON public.locations;
CREATE POLICY "Users and household members can delete locations"
ON public.locations
FOR DELETE TO authenticated
USING (
  (household_id IS NULL AND user_id = (SELECT auth.uid()))
  OR
  (household_id IS NOT NULL AND public.is_household_member(household_id))
);

-- Household assignment and attribution are managed by trusted database functions,
-- not direct client updates. Normal UI edits only need these columns.
REVOKE UPDATE ON public.locations FROM authenticated;
GRANT UPDATE (name, updated_at) ON public.locations TO authenticated;
