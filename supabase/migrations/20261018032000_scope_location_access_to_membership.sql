-- Shared locations must be accessible only through current household membership.
-- A former creator must not retain access to subdivisions or foods through user_id.
CREATE OR REPLACE FUNCTION private.can_access_location(target_location_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'pg_temp'
AS $function$
  select exists (
    select 1
    from public.locations l
    where l.id = target_location_id
      and (
        (l.household_id is null and l.user_id = (select auth.uid()))
        or
        (l.household_id is not null and private.is_household_member(l.household_id))
      )
  );
$function$;

CREATE OR REPLACE FUNCTION public.can_access_location(target_location_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
  select private.can_access_location(target_location_id);
$function$;
