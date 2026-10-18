CREATE OR REPLACE FUNCTION public.join_household_by_code(invite_code text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'pg_catalog', 'public', 'private', 'pg_temp'
AS $function$
declare
  v_user_id uuid := (select auth.uid());
  v_invite public.household_invites%rowtype;
  v_existing boolean;
begin
  if v_user_id is null then
    raise exception 'Authentication required';
  end if;

  select * into v_invite
  from public.household_invites i
  where i.code = upper(trim(invite_code))
  for update;

  if not found or v_invite.expires_at <= now() or v_invite.uses >= v_invite.max_uses then
    raise exception 'Invite code is invalid, expired, or has reached its limit';
  end if;

  select exists(
    select 1 from public.household_members hm
    where hm.household_id = v_invite.household_id and hm.user_id = v_user_id
  ) into v_existing;

  if not v_existing then
    insert into public.household_members(household_id, user_id, role)
    values(v_invite.household_id, v_user_id, 'member');
    update public.household_invites set uses = uses + 1 where id = v_invite.id;
  end if;

  return v_invite.household_id;
end;
$function$;

REVOKE ALL ON FUNCTION public.join_household_by_code(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.join_household_by_code(text) TO authenticated;
