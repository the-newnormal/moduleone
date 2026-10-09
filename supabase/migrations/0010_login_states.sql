-- 0010: who can sign in, for the admin pages.
--
-- Each person's row on the admin pages says whether their login has been used, not just whether
-- they have one. For each linked login this returns its state: 'invited' (nobody has used it yet,
-- with when the invite went out), 'ready' (set up ready to use, but nobody has signed in with it)
-- or 'active' (with when it was last signed in with). The labels admins see are in loginStatusText
-- (src/app/admin/teams/[id]/team-view.ts). Without this an admin only found out an invite went
-- unused by pressing Resend invite.
--
-- Those facts live in auth.users, which admins can't read, and the app keeps the service-role key
-- to the few actions that need it. So admin_login_states is SECURITY DEFINER: it checks the
-- caller holds the admin grant, and returns one row per linked login with just those facts. No
-- email address and no other column of auth.users leaves it, and it writes nothing.
--
-- "Used" matches the server's own test (resendInvite, changeEmail): an address confirmed or a
-- sign-in recorded. Opening an invite does both at once.

create function admin_login_states()
  returns table (member_id uuid, state text, invited_at timestamptz, last_sign_in_at timestamptz)
  language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(public.app_has_grant('admin'), false) then
    raise exception using errcode = 'insufficient_privilege', message = 'Only admins can see who has signed in.';
  end if;

  return query
    select m.id,
           case
             when u.last_sign_in_at is not null then 'active'
             when u.email_confirmed_at is not null then 'ready'
             else 'invited'
           end,
           -- When the invite went out matters only while it's unused.
           case when u.last_sign_in_at is null and u.email_confirmed_at is null then u.invited_at end,
           u.last_sign_in_at
    from public.members m
    join auth.users u on u.id = m.auth_user_id
    -- A removed person has no login (members_removed_cleared); a soft-deleted login opens nothing.
    where m.removed_at is null and u.deleted_at is null
    order by m.id;
end;
$$;

revoke execute on function admin_login_states() from public, anon;
grant execute on function admin_login_states() to authenticated;
