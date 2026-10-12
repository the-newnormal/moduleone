-- 0014: adding a list of people at once, and noting someone's email before their invite goes out.
--
-- Admins can add a list of people to a node in one go (the team page's Add a list), each with the
-- email address their invite will go to, if there is one. They can also note that address for
-- anyone who has no login yet (Set email). Nobody is emailed until an admin gives them a login:
-- Give login offers the noted address, one person at a time or for everyone in a node at once.
--
--   * pending_login_emails: the address noted for someone's first invite. The members table is
--     read by teammates and leaders (0002's members_select), and an address is personal, so it
--     lives here, where only holders of the admin grant read and write it. Only people who could
--     be given a login have one: not a Master Admin, nobody with a login already, nobody removed
--     from Module One, and nobody who holds grants (the project owner gives those a login). A
--     trigger checks that, in sentences the page shows as they are, and records which admin noted
--     it and when. Others forget the address once the person gets a login, is removed, is made a
--     Master Admin or is given a grant: from then on any address of theirs lives only in Supabase
--     Auth, which admins can't read. No two people have the same address noted, and no address is
--     noted that already has a login: noting an address and linking a login to it take the same
--     lock on the address, so whichever comes second is refused (members_login_not_noted_elsewhere).
--   * admin_add_members: adds a whole list, with their addresses, in one transaction, as the
--     signed-in admin (SECURITY INVOKER, so RLS and the members triggers decide each row as they
--     do a single insert: archived nodes, the organisation, who leads where they sit). Either
--     everyone on the list is added, or nobody.
--   * link_noted_login: for the server only. Send invites (giveLogin) links each new login only
--     while the address it went to is still the one noted for that person, so an invite sent as
--     another admin corrects or forgets the note never becomes that person's login.

-- ---------- pending_login_emails ----------
create table pending_login_emails (
  member_id  uuid primary key references members(id) on delete cascade,
  email      text not null,
  -- Filled in by pending_login_emails_check, never by the client.
  set_by     uuid references members(id) on delete set null,
  set_at     timestamptz not null default now(),
  -- As the server's parseEmail stores it: trimmed, lower case, at most 254 characters, one @ with
  -- something before it, and a domain of two or more dot-separated parts, with no spaces.
  constraint pending_login_emails_email_format check (
    email = lower(btrim(email))
    and char_length(email) <= 254
    and email ~ '^[^@[:space:]]+@[^@[:space:].]+(\.[^@[:space:].]+)+$'
  ),
  constraint pending_login_emails_email_key unique (email)
);

alter table pending_login_emails enable row level security;

-- Admins read every noted address and forget any; they write only the person and the address (who
-- noted it, and when, are the trigger's). The server (service_role) has full access, as on every
-- table.
grant select, delete on table pending_login_emails to authenticated;
grant insert (member_id, email), update (email) on table pending_login_emails to authenticated;
grant all on table pending_login_emails to service_role;

create policy pending_login_emails_admin_select on pending_login_emails for select to authenticated
  using (app_has_grant('admin'));
create policy pending_login_emails_admin_insert on pending_login_emails for insert to authenticated
  with check (app_has_grant('admin'));
create policy pending_login_emails_admin_update on pending_login_emails for update to authenticated
  using (app_has_grant('admin'))
  with check (app_has_grant('admin'));
create policy pending_login_emails_admin_delete on pending_login_emails for delete to authenticated
  using (app_has_grant('admin'));

-- Before an address is noted or changed: the person may be given a login (as giveLogin decides,
-- apart from what only the server sees: records from an earlier login, and Supabase Auth), and who
-- noted it, and when.
--
-- A BEFORE trigger runs before RLS checks the new row, so a signed-in caller without the admin
-- grant is let through to RLS untouched: its refusal says nothing about the person, where these
-- sentences would say who exists, was removed, is a Master Admin, has a login or holds grants
-- (none of which RLS shows a member about someone outside their team, or anyone's grants).
--
-- A new address reads the person's row FOR SHARE, which giving them a login waits for (it updates
-- auth_user_id, a unique column, so it locks the row FOR UPDATE), and the other way round: an
-- address noted first is forgotten by the link (members_forget_pending_email), and one noted after
-- the link is refused here. So an address never stays behind on someone with a login. Changing an
-- address reads the row without a lock: the pending row is locked already, and every path that
-- forgets addresses locks the person's row first and the pending row second, so locking the
-- person's row here could deadlock with it. None is needed: such a path waits for this change to
-- commit, then forgets the changed address; and once it has, there's no row left to change.
--
-- Last, the address itself is locked (a transaction-level advisory lock on it, which linking a login
-- with that address takes too, after the person's row, as here) and refused if it already has a
-- login: its invite would only re-send that login, or fail. A login linked meanwhile was invited
-- first (Supabase Auth made it before the link), so once the lock is ours it shows up here.
create function pending_login_emails_check() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  m_role     text;
  m_login    uuid;
  m_removed  timestamptz;
begin
  if auth.uid() is not null and not coalesce(public.app_has_grant('admin'), false) then
    return new;
  end if;
  if tg_op = 'INSERT' then
    select m.role, m.auth_user_id, m.removed_at into m_role, m_login, m_removed
    from public.members m where m.id = new.member_id
    for share;
  else
    select m.role, m.auth_user_id, m.removed_at into m_role, m_login, m_removed
    from public.members m where m.id = new.member_id;
  end if;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'This person doesn''t exist any more. Reload the page.';
  end if;
  if m_removed is not null then
    raise exception using errcode = 'check_violation', message = 'This person was removed from Module One. Reload the page.';
  end if;
  if m_role = 'hq' then
    raise exception using errcode = 'check_violation', message = 'Master Admins get their login from the project owner.';
  end if;
  if m_login is not null then
    raise exception using errcode = 'check_violation',
      message = 'This person already has a login. To change the address they sign in with, use Change email.';
  end if;
  if exists (select 1 from public.member_grants g where g.member_id = new.member_id) then
    raise exception using errcode = 'check_violation',
      message = 'This person holds grants (such as admin), so only the project owner can give them a login.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('moduleone:login_email:' || lower(btrim(new.email)), 0));
  if exists (select 1 from auth.users u where lower(u.email) = lower(btrim(new.email))) then
    raise exception using errcode = 'check_violation',
      message = format('%s already has a login. Use another address.', lower(btrim(new.email)));
  end if;
  -- Null for the server and the dashboard, where nobody is signed in.
  new.set_by := public.app_current_member_id();
  new.set_at := now();
  return new;
end $$;
revoke execute on function pending_login_emails_check() from public, anon, authenticated;

create trigger pending_login_emails_check before insert or update on pending_login_emails
  for each row execute function pending_login_emails_check();

-- Once someone has a login (giveLogin, or the project owner in the dashboard), is removed from
-- Module One (admin_remove_member) or is made a Master Admin, their noted address goes: it was
-- only ever for their first invite.
create function members_forget_pending_email() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  delete from public.pending_login_emails p where p.member_id = new.id;
  return null;
end $$;
revoke execute on function members_forget_pending_email() from public, anon, authenticated;

create trigger members_forget_pending_email after update of auth_user_id, removed_at, role on members
  for each row when (new.auth_user_id is not null or new.removed_at is not null or new.role = 'hq')
  execute function members_forget_pending_email();

-- Before a login is linked to someone (giveLogin, Change email's new invite, link_noted_login, or
-- the project owner in the dashboard): its address mustn't be noted for anyone else's invite, or
-- that person's invite would only re-send this login. The address is locked first, as
-- pending_login_emails_check locks it (the person's row is locked already by this update, as there),
-- so an address noted meanwhile is seen here, or refused there.
create function members_login_not_noted_elsewhere() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  login_email text;
begin
  if tg_op = 'UPDATE' and new.auth_user_id is not distinct from old.auth_user_id then
    return new;
  end if;
  select lower(btrim(u.email)) into login_email from auth.users u where u.id = new.auth_user_id;
  if login_email is null or login_email = '' then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('moduleone:login_email:' || login_email, 0));
  if exists (select 1 from public.pending_login_emails p where p.email = login_email and p.member_id <> new.id) then
    raise exception using errcode = 'check_violation',
      message = 'That email is noted for someone else''s invite. Use another address, or change theirs first.';
  end if;
  return new;
end $$;
revoke execute on function members_login_not_noted_elsewhere() from public, anon, authenticated;

create trigger members_login_not_noted_elsewhere before insert or update of auth_user_id on members
  for each row when (new.auth_user_id is not null)
  execute function members_login_not_noted_elsewhere();

-- Likewise once the project owner gives them a grant: the owner gives grant holders their login,
-- and the pages offer admins nothing on their row, so an address left noted would stay out of
-- reach and keep anyone else from using it.
-- The person's row is locked first (FOR NO KEY UPDATE, which waits for pending_login_emails_check's
-- FOR SHARE and the other way round), so an address noted at the same moment is either refused
-- there, seeing the grant, or committed before this forgets it.
create function member_grants_forget_pending_email() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.members m where m.id = new.member_id for no key update;
  delete from public.pending_login_emails p where p.member_id = new.member_id;
  return null;
end $$;
revoke execute on function member_grants_forget_pending_email() from public, anon, authenticated;

create trigger member_grants_forget_pending_email after insert or update of member_id on member_grants
  for each row execute function member_grants_forget_pending_email();

-- ---------- admin_add_members ----------
-- p_people: a JSON array of 1 to 200 {"name": …, "role": "member" | "leader", "email": … or null}.
-- Each person goes into p_team_id with their address noted, in the list's order, as the signed-in
-- admin: the members triggers and RLS refuse what they'd refuse for one person (an archived node,
-- the organisation, a Master Admin), and pending_login_emails_check and its constraints refuse a
-- bad or already-noted address, in their own words. Returns the new rows' ids, in the list's order.
create function admin_add_members(p_team_id uuid, p_people jsonb) returns uuid[]
  language plpgsql security invoker set search_path = '' as $$
declare
  person  jsonb;
  new_id  uuid;
  ids     uuid[] := '{}';
begin
  if not coalesce(public.app_has_grant('admin'), false) then
    raise exception using errcode = 'insufficient_privilege', message = 'Only admins can add people.';
  end if;
  if p_team_id is null then
    raise exception using errcode = 'invalid_parameter_value', message = 'Pick where to add them.';
  end if;
  if jsonb_typeof(p_people) is distinct from 'array' or jsonb_array_length(p_people) not between 1 and 200 then
    raise exception using errcode = 'invalid_parameter_value', message = 'Add from 1 to 200 people at a time.';
  end if;

  for person in select value from jsonb_array_elements(p_people) loop
    if jsonb_typeof(person) is distinct from 'object' then
      raise exception using errcode = 'invalid_parameter_value', message = 'Each person needs a name.';
    end if;
    insert into public.members (name, team_id, role)
    values (person ->> 'name', p_team_id, coalesce(person ->> 'role', 'member'))
    returning id into new_id;
    if coalesce(person ->> 'email', '') <> '' then
      insert into public.pending_login_emails (member_id, email) values (new_id, person ->> 'email');
    end if;
    ids := ids || new_id;
  end loop;
  return ids;
end $$;
revoke execute on function admin_add_members(uuid, jsonb) from public, anon;
grant execute on function admin_add_members(uuid, jsonb) to authenticated;

-- ---------- link_noted_login ----------
-- For the server (service_role) only: giveLogin, when Send invites sends someone the address noted
-- for them. It checks that address before inviting it, but another admin may correct or forget the
-- note while the invite is going out. So the new login is linked here only if the address is still
-- the one noted for them, in one transaction: their row is locked first (as every path that
-- forgets notes locks it), then their note, so neither can change until this commits; linking then
-- forgets the note (members_forget_pending_email). Returns 'linked'; 'note_changed' when the note
-- is gone or holds another address (the server then deletes the login it just made, so the link
-- in that email opens nothing); or 'changed' when they have a login, were removed or are a Master
-- Admin by now. A login another row uses fails with the unique violation, as giveLogin's own link.
create function link_noted_login(p_member_id uuid, p_login uuid, p_email text, p_given_by uuid)
  returns text language plpgsql set search_path = '' as $$
begin
  perform 1 from public.members m
  where m.id = p_member_id and m.auth_user_id is null and m.removed_at is null and m.role <> 'hq'
  for update;
  if not found then
    return 'changed';
  end if;
  perform 1 from public.pending_login_emails p
  where p.member_id = p_member_id and p.email = lower(btrim(p_email))
  for update;
  if not found then
    return 'note_changed';
  end if;
  update public.members
  set auth_user_id = p_login, login_given_by = p_given_by, login_given_at = now()
  where id = p_member_id;
  return 'linked';
end $$;
revoke execute on function link_noted_login(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function link_noted_login(uuid, uuid, text, uuid) to service_role;
