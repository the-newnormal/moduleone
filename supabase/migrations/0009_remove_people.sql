-- 0009: removing people from Module One, and recording who changed someone's sign-in email.
--
-- Removing someone (admin_remove_member, which the team page's removePerson calls): they can't
-- sign in any more, they leave their team and everything they lead, and the admin pages stop
-- showing them. Whatever they left behind stays, so past weeks on the heat-map don't change: the
-- row is kept, marked removed (removed_at, removed_by), with no login, no team and the member role
-- (members_removed_cleared), and nobody can place it, give it a login or edit it again from the
-- app. Only a row that never had a login and that nothing refers to (someone added by mistake) is
-- deleted outright.
--
-- The function is SECURITY DEFINER (admins have no delete privilege on members, and must not
-- write removed_at themselves), so it checks everything RLS would have, and more: the caller holds
-- the admin grant; the person isn't a Master Admin, isn't the caller, holds no grants (those are
-- the project owner's), and doesn't sit in or lead the organisation (only the owner staffs it).
-- It unlinks the login itself, which cuts access at once (every policy helper maps auth.uid()
-- through members.auth_user_id), and keeps the login's id in removed_login_id until the server
-- has deleted that login with the service-role key; if that fails, the owner deletes the user with
-- that id in the Supabase dashboard (the foreign key then clears the column).
--
-- Sign-in email changes: the server (changeEmail, service-role key) changes the address in Supabase
-- Auth and records which admin did it and when (login_email_changed_by / _at), as giveLogin
-- records login_given_by / _at. login_email_in_use tells it whether an address already has a
-- login (Auth's admin update answers a taken address with a 500).

-- ---------- members: removed people, and who changed a sign-in email ----------
alter table members
  add column removed_at timestamptz,
  add column removed_by uuid references members(id) on delete set null,
  -- The login a removal unlinked, until it's deleted. A soft-deleted login keeps its row in
  -- auth.users (and with it the privacy-notice acceptances in recording_notices); a hard delete
  -- in the dashboard clears this.
  add column removed_login_id uuid references auth.users(id) on delete set null,
  add column login_email_changed_by uuid references members(id) on delete set null,
  add column login_email_changed_at timestamptz,
  add constraint members_removed_pair check (removed_by is null or removed_at is not null),
  add constraint members_removed_login check (removed_login_id is null or removed_at is not null),
  -- Whoever writes it (the app, the server, the dashboard), a removed row never signs in, sits
  -- anywhere or leads anything.
  add constraint members_removed_cleared
    check (removed_at is null or (auth_user_id is null and team_id is null and role = 'member')),
  add constraint members_login_email_changed_pair
    check (login_email_changed_by is null or login_email_changed_at is not null);
-- No column grants: signed-in users read these (select is table-wide) but never write them.

-- Admins edit people as before (0002), except removed ones.
drop policy members_admin_update on members;
create policy members_admin_update on members for update to authenticated
  using (app_has_grant('admin') and role <> 'hq' and auth_user_id is distinct from auth.uid() and removed_at is null)
  with check (app_has_grant('admin') and role <> 'hq' and auth_user_id is distinct from auth.uid() and removed_at is null);

-- ---------- check-ins: never for someone removed ----------
-- As in 0002, plus: a check-in for a removed person is refused, whether or not it names a team.
-- The member row is read FOR SHARE, which a removal's FOR UPDATE waits for and vice versa: a
-- check-in that gets there first commits in their team before the removal goes on (and is history
-- it keeps), and one that comes second waits, then sees the removal and is refused. So no check-in
-- commits after its member was removed.
create or replace function checkins_set_team() returns trigger
  language plpgsql set search_path = '' as $$
declare
  member_team    uuid;
  member_removed timestamptz;
begin
  select m.team_id, m.removed_at into member_team, member_removed
  from public.members m where m.id = new.member_id
  for share;
  if member_removed is not null then
    raise exception using errcode = 'check_violation', message = 'That person was removed from Module One.';
  end if;
  if new.team_id is null then
    new.team_id := member_team;
  end if;
  return new;
end $$;
revoke execute on function checkins_set_team() from public, anon, authenticated;

-- ---------- admin_remove_member ----------
-- Returns {"outcome": "removed" | "deleted", "login_id": <the unlinked login, or null>}. Someone
-- already removed or already gone counts as done (another admin got there first, or a retry), and
-- a removed row hands back a login it still has to delete.
create function admin_remove_member(p_member_id uuid) returns jsonb
  language plpgsql security definer set search_path = '' as $$
declare
  m_id        uuid;
  m_role      text;
  m_team      uuid;
  m_login     uuid;
  m_given_at  timestamptz;
  m_changed_at timestamptz;
  m_removed   timestamptz;
  m_pending   uuid;
  org         uuid;
  kept        boolean;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = 'invalid_transaction_state',
      message = 'Change the team tree in a READ COMMITTED transaction.';
  end if;
  if not coalesce(public.app_has_grant('admin'), false) then
    raise exception using errcode = 'insufficient_privilege', message = 'Only admins can remove people.';
  end if;

  -- The tree lock first and then the row, the order every other writer of members uses. Rows
  -- that refer to this one (check-ins, drafts, notices, grants, leads) lock it as they're
  -- inserted, so once it's locked nothing new can refer to it until this commits: what's checked
  -- below is what's there.
  perform pg_advisory_xact_lock(hashtextextended('moduleone:team_tree', 0));
  select m.id, m.role, m.team_id, m.auth_user_id, m.login_given_at, m.login_email_changed_at, m.removed_at,
         m.removed_login_id
    into m_id, m_role, m_team, m_login, m_given_at, m_changed_at, m_removed, m_pending
  from public.members m where m.id = p_member_id
  for update;
  if not found then
    return jsonb_build_object('outcome', 'deleted', 'login_id', null);
  end if;
  if m_removed is not null then
    return jsonb_build_object('outcome', 'removed', 'login_id', m_pending);
  end if;

  if m_role = 'hq' then
    raise exception using errcode = 'check_violation',
      message = 'Master Admins can''t be removed here. The project owner looks after them.';
  end if;
  if m_login is not null and m_login = auth.uid() then
    raise exception using errcode = 'check_violation', message = 'You can''t remove yourself.';
  end if;
  if exists (select 1 from public.member_grants g where g.member_id = m_id) then
    raise exception using errcode = 'check_violation',
      message = 'This person holds grants (such as admin), so only the project owner can remove them.';
  end if;
  select t.id into org from public.teams t where t.kind = 'organisation';
  if org is not null and (
    m_team = org or exists (select 1 from public.team_leads l where l.member_id = m_id and l.team_id = org)
  ) then
    raise exception using errcode = 'check_violation',
      message = 'This person sits in or leads the organisation, so only the project owner can remove them.';
  end if;

  -- Anything that would go, or be rewritten, with the row. A login (now, or given or changed
  -- earlier) counts too: it may have read check-ins, and login_given_by / login_email_changed_by
  -- say who gave or changed it.
  kept := m_login is not null
    or m_given_at is not null
    or m_changed_at is not null
    or exists (select 1 from public.checkins c where c.member_id = m_id)
    or exists (select 1 from public.checkin_drafts d where d.member_id = m_id)
    or exists (select 1 from public.checkin_mentions x where x.about_member_id = m_id)
    or exists (select 1 from public.member_profiles p where p.member_id = m_id)
    or exists (select 1 from public.recording_notices r where r.member_id = m_id)
    or exists (
      select 1 from public.members o
      where o.login_given_by = m_id or o.removed_by = m_id or o.login_email_changed_by = m_id
    )
    or exists (select 1 from public.scoring_settings s where s.updated_by = m_id)
    -- 0007: a Master Admin's delete or reset, of their check-in or done by them.
    or exists (select 1 from public.checkin_resets r where r.member_id = m_id or r.done_by = m_id)
    or exists (
      select 1 from storage.objects o
      where o.bucket_id = 'checkin-audio' and (storage.foldername(o.name))[1] = m_id::text
    );

  if not kept then
    delete from public.members where id = m_id;
    return jsonb_build_object('outcome', 'deleted', 'login_id', null);
  end if;

  -- One statement, so members_removed_cleared holds at every step. Making a leader a member
  -- deletes their lead rows (members_drop_team_leads); a member has none.
  update public.members
  set removed_at = now(),
      removed_by = public.app_current_member_id(),
      removed_login_id = m_login,
      auth_user_id = null,
      team_id = null,
      role = 'member'
  where id = m_id;
  delete from public.team_leads l where l.member_id = m_id;
  return jsonb_build_object('outcome', 'removed', 'login_id', m_login);
end $$;
revoke execute on function admin_remove_member(uuid) from public, anon;
grant execute on function admin_remove_member(uuid) to authenticated, service_role;

-- ---------- login_email_in_use ----------
-- For the server only (service role, which can't read auth.users itself). The address is compared
-- as the login page sends it: trimmed and lower case.
create function login_email_in_use(p_email text) returns boolean
  language sql stable security definer set search_path = '' as $$
  select exists (select 1 from auth.users u where lower(u.email) = lower(btrim(p_email)));
$$;
revoke execute on function login_email_in_use(text) from public, anon, authenticated;
grant execute on function login_email_in_use(text) to service_role;
