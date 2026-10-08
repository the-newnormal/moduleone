-- Module One — the team tree, team leads and the founding structure.
--
-- After this migration:
--   * Teams form a tree, the way The Normal is organised: divisions → domains → teams. A domain is
--     a development domain, an IP or a lab; some domains have numbered sub-teams. A domain with no
--     division is "unplaced", which is what every team made before this migration becomes (and what
--     0001-style `insert into teams (name)` still makes).
--   * A person belongs to at most one domain or team (members.team_id, as before). Leaders can also
--     lead other domains and teams, listed in team_leads, which admins maintain.
--   * Leaders see check-ins made in the teams they lead (their own team plus team_leads) and in
--     everything under those, and who made them: leading a domain covers its sub-teams, including
--     ones added or moved in later. Leading a sub-team doesn't show the domain's or its sibling
--     teams' check-ins. Everyone sees the divisions and domains above the teams they can see, so
--     the app can print "Gather › IP Lab › IP Lab 1".
--   * Admins move nodes with admin_move_team (drag and drop). The database refuses any write that
--     breaks the tree, with a sentence the admin UI shows as is. An admin who is also a leader
--     can't move a node into what they lead, as they can't make themselves a lead.
--   * members records who gave each login, and when (login_given_by, login_given_at). Only the
--     server writes these.
--   * The founding divisions, domains and teams are loaded with codes (IP.X, IP.1, …). Teams that
--     already exist stay as they are, as unplaced domains listed after the divisions.
--   * Structural changes must run under READ COMMITTED (the Data API's level); see "tree rules".
--   * teams.division (free text) is superseded by the parent division node. It stays, unread, so
--     older code and tests that write it keep working.
-- "HQ" below is a division. It has nothing to do with members.role = 'hq' (the project owner's
-- see-everything role).

-- ---------- teams: tree columns ----------
-- Every new column has a default or allows null, so existing rows become unplaced domains and the
-- constraints hold for them as soon as they are added.
alter table teams
  add column parent_id      uuid references teams(id),
  add column kind           text not null default 'domain',
  add column domain_type    text,
  add column division_type  text,
  add column code           text unique,
  add column sort_order     int not null default 0,
  add column note           text,
  add constraint teams_kind check (kind in ('division', 'domain', 'team')),
  add constraint teams_domain_type
    check (domain_type is null or (kind = 'domain' and domain_type in ('development', 'ip', 'lab'))),
  add constraint teams_division_type
    check (division_type is null or (kind = 'division' and division_type in ('strategy', 'support_development'))),
  -- Short, upper-case codes like IP.X or IP.1. (Postgres regex ranges are by code point, so [A-Z]
  -- never matches lower case whatever the collation.)
  add constraint teams_code_format check (code is null or code ~ '^[A-Z0-9]{1,8}(\.[A-Z0-9]{1,8})?$'),
  add constraint teams_sort_order_range check (sort_order between 0 and 10000),
  add constraint teams_note_length check (note is null or char_length(note) <= 500),
  add constraint teams_not_own_parent check (parent_id is distinct from id),
  add constraint teams_division_at_top check (kind <> 'division' or parent_id is null),
  add constraint teams_team_has_parent check (kind <> 'team' or parent_id is not null);

create index teams_parent_id on teams (parent_id);

comment on column teams.division is
  'Deprecated: superseded by the parent division node; not read by the app.';

-- Admins edit the tree columns too; 0002 already grants name, division and archived_at.
grant insert (parent_id, kind, domain_type, division_type, code, sort_order, note),
      update (parent_id, kind, domain_type, division_type, code, sort_order, note)
  on table teams to authenticated;

-- ---------- tree rules ----------
-- The fixed layers make cycles impossible: a division sits at the top, a domain under a division
-- (or at the top, unplaced), a team under a domain, and nothing under a team.
--
-- AFTER, not BEFORE: RLS checks a write's new row after BEFORE triggers run, so a BEFORE trigger
-- would also run for non-admins and could answer with a structure error (telling them whether a
-- team id exists or is archived) instead of permission denied. AFTER row triggers only see rows
-- that passed RLS. They also see the whole statement's effect, so archiving or restoring a
-- subtree in one UPDATE works.
--
-- Every check of the tree or of who sits where first takes this transaction-scoped lock, so
-- structural changes (rare, admin-only) run one at a time. Without it, two changes that each pass
-- alone could together break a rule (archive a domain while someone is placed into it). Under
-- READ COMMITTED each statement in these volatile functions takes a new snapshot, so a transaction
-- that waited for the lock checks against what the other one committed. Under REPEATABLE READ or
-- SERIALIZABLE the snapshot is the one the transaction started with, which may predate the other
-- change, so these functions refuse to run there (the Data API and the dashboard use READ
-- COMMITTED; set it for any server transaction that changes the tree or who sits where).
create function teams_check_tree() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  parent_kind  text;
  n            int;
  child_word   text;
  led          uuid[];
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = 'invalid_transaction_state',
      message = 'Change the team tree in a READ COMMITTED transaction.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('moduleone:team_tree', 0));

  -- 1. Where the node may sit (checked when it is created, moved or changes kind). A division
  --    with a parent, a team without one and a node under itself never get here: the teams_*
  --    check constraints refuse those first (admin_move_team words them for the admin).
  if tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id or new.kind is distinct from old.kind then
    if new.parent_id is not null then
      select p.kind into parent_kind from public.teams p where p.id = new.parent_id;
    end if;
    if new.kind = 'domain' and new.parent_id is not null and parent_kind is distinct from 'division' then
      raise exception using errcode = 'check_violation',
        message = 'A domain can only sit under a division, or at the top level (unplaced).';
    elsif new.kind = 'team' and parent_kind is distinct from 'domain' then
      raise exception using errcode = 'check_violation',
        message = 'A team can only sit under a domain.';
    end if;
  end if;

  -- 2. An active node can't sit under an archived one (created, moved or restored).
  if new.archived_at is null and new.parent_id is not null
     and (tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id or old.archived_at is not null) then
    if exists (select 1 from public.teams p where p.id = new.parent_id and p.archived_at is not null) then
      raise exception using errcode = 'check_violation',
        message = 'Restore the parent first: it is archived.';
    end if;
  end if;

  -- An admin who is also a leader can't move a node from outside what they lead into it: leads
  -- cover everything under the led node and check-ins stay with their team, so that would show
  -- them the node's whole history, the widening team_leads_admin_insert refuses too. Moving a
  -- node around inside what they lead, or out of it, still works; another admin (or the server)
  -- can move it in. Only signed-in leaders lead anything, so nobody else is refused here.
  -- (A new node has no history, so inserting one is fine.)
  if tg_op = 'UPDATE' and new.parent_id is distinct from old.parent_id then
    led := public.app_led_team_ids();
    if new.parent_id = any (led) and not coalesce(old.parent_id = any (led), false) then
      raise exception using errcode = 'insufficient_privilege',
        message = 'You lead where this is going, so another admin has to move it there.';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    -- 3. A change of kind must keep everything under the node where it may sit (archived nodes
    --    included: they can be restored), and a division holds no people. Nor any check-ins: they
    --    would show as a division on the heat-map, and nobody can lead a division to see them.
    if new.kind is distinct from old.kind then
      child_word := case old.kind when 'division' then 'domain' when 'domain' then 'team' else 'node' end;
      select count(*) into n from public.teams c
      where c.parent_id = new.id
        and c.kind is distinct from (case new.kind when 'division' then 'domain' when 'domain' then 'team' end);
      if n > 0 then
        raise exception using errcode = 'check_violation',
          message = format('%s Move its %s %s out first.',
            case new.kind
              when 'division' then 'A division can only hold domains.'
              when 'domain' then 'A domain can only hold teams.'
              else 'Nothing can sit under a team.'
            end,
            n, child_word || case when n = 1 then '' else 's' end);
      end if;
      if new.kind = 'division' then
        select count(*) into n from public.members m where m.team_id = new.id;
        if n > 0 then
          raise exception using errcode = 'check_violation',
            message = format('A division can''t have members. Move its %s %s out first.',
              n, case when n = 1 then 'member' else 'members' end);
        end if;
        select count(*) into n from public.team_leads l where l.team_id = new.id;
        if n > 0 then
          raise exception using errcode = 'check_violation',
            message = format('A division can''t have leaders. Remove its %s %s first.',
              n, case when n = 1 then 'leader' else 'leaders' end);
        end if;
        -- Check-ins don't take the tree lock: wait for any being saved, and hold new ones back
        -- until this commits, so the count below sees every check-in made in this node.
        lock table public.checkins in share mode;
        select count(*) into n from public.checkins c where c.team_id = new.id;
        if n > 0 then
          raise exception using errcode = 'check_violation',
            message = format('A division can''t hold check-ins, and %s %s made in this %s. Archive it instead.',
              n, case when n = 1 then 'was' else 'were' end, old.kind);
        end if;
      end if;
    end if;

    -- 4. Archive from the leaves up, once nobody sits in the node. Its team_leads rows stay, so
    --    its leaders keep seeing its history.
    if old.archived_at is null and new.archived_at is not null then
      child_word := case new.kind when 'division' then 'domain' when 'domain' then 'team' else 'node' end;
      select count(*) into n from public.teams c where c.parent_id = new.id and c.archived_at is null;
      if n > 0 then
        raise exception using errcode = 'check_violation',
          message = format('Archive or move the %s active %s under it first.',
            n, child_word || case when n = 1 then '' else 's' end);
      end if;
      select count(*) into n from public.members m where m.team_id = new.id;
      if n > 0 then
        raise exception using errcode = 'check_violation',
          message = format('Move its %s %s out first.', n, case when n = 1 then 'member' else 'members' end);
      end if;
    end if;
  end if;

  return null;
end $$;
revoke execute on function teams_check_tree() from public, anon, authenticated;

create trigger teams_check_tree after insert or update of parent_id, kind, archived_at on teams
  for each row execute function teams_check_tree();

-- ---------- members: placed in a domain or a team ----------
-- Only a new or changed team_id is checked, so a member who sits somewhere that predates these
-- rules can still be renamed. Moving someone out is team_id = null, never a delete (their
-- check-ins stay).
create function members_check_team() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  target_kind      text;
  target_archived  timestamptz;
begin
  if new.team_id is null or (tg_op = 'UPDATE' and new.team_id is not distinct from old.team_id) then
    return null;
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = 'invalid_transaction_state',
      message = 'Change the team tree in a READ COMMITTED transaction.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('moduleone:team_tree', 0));
  select t.kind, t.archived_at into target_kind, target_archived from public.teams t where t.id = new.team_id;
  if target_kind = 'division' then
    raise exception using errcode = 'check_violation',
      message = 'People can only be placed in a domain or a team, not a division.';
  elsif target_archived is not null then
    raise exception using errcode = 'check_violation',
      message = format('That %s is archived. Restore it first, or pick another.', target_kind);
  end if;
  return null;
end $$;
revoke execute on function members_check_team() from public, anon, authenticated;

create trigger members_check_team after insert or update of team_id on members
  for each row execute function members_check_team();

-- ---------- members: who gave each login ----------
-- Admins may give people a login: the server invites the email with the service role and links
-- the member (auth_user_id), recording in the same statement which admin did it and when. Only
-- the server writes these two: 0002's column grants on members leave them out, so signed-in users
-- (admins too) get permission denied. They're readable wherever the member row is. Rows from
-- before this stay null (logins made earlier, or by the project owner in the dashboard).
-- If the giver's member row is ever deleted, login_given_by goes null but login_given_at stays,
-- so the row still says when its login was given. So the pair rule runs one way: a giver needs a
-- time. (A both-or-neither rule would make that delete fail.)
alter table members
  add column login_given_by uuid references members(id) on delete set null,
  add column login_given_at timestamptz,
  add constraint members_login_given_pair check (login_given_by is null or login_given_at is not null),
  add constraint members_login_given_not_self check (login_given_by is distinct from id);

-- ---------- team_leads: leaders of more than their own team ----------
create table team_leads (
  team_id     uuid not null references teams(id),
  member_id   uuid not null references members(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (team_id, member_id)
);
create index team_leads_member_id on team_leads (member_id);
alter table team_leads enable row level security;

-- Admins add and remove rows; nobody edits one in place.
revoke all on table team_leads from public, anon, authenticated;
grant select, delete on table team_leads to authenticated;
grant insert (team_id, member_id) on table team_leads to authenticated;
grant all on table team_leads to service_role;

-- A lead row needs a leader (so never an hq member, who sees everything anyway) and an active
-- domain or team. Also checked when the server rewrites a row (authenticated can't update).
create function team_leads_check() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  lead_role        text;
  target_kind      text;
  target_archived  timestamptz;
begin
  if tg_op = 'UPDATE' and new.team_id is not distinct from old.team_id
     and new.member_id is not distinct from old.member_id then
    return null;
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = 'invalid_transaction_state',
      message = 'Change the team tree in a READ COMMITTED transaction.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('moduleone:team_tree', 0));
  select m.role into lead_role from public.members m where m.id = new.member_id;
  select t.kind, t.archived_at into target_kind, target_archived from public.teams t where t.id = new.team_id;
  if lead_role is distinct from 'leader' then
    raise exception using errcode = 'check_violation',
      message = 'Only members with the leader role can lead a team. Make them a leader first.';
  elsif target_kind = 'division' then
    raise exception using errcode = 'check_violation',
      message = 'Leaders lead domains and teams, not divisions.';
  elsif target_archived is not null then
    raise exception using errcode = 'check_violation',
      message = format('That %s is archived. Restore it first.', target_kind);
  end if;
  return null;
end $$;
revoke execute on function team_leads_check() from public, anon, authenticated;

create trigger team_leads_check after insert or update of team_id, member_id on team_leads
  for each row execute function team_leads_check();

-- Someone who stops being a leader stops leading. SECURITY DEFINER so this happens whoever demotes
-- them (an admin, the server, or the project owner in the dashboard).
create function members_drop_team_leads() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'leader' and new.role is distinct from 'leader' then
    if current_setting('transaction_isolation') <> 'read committed' then
      raise exception using errcode = 'invalid_transaction_state',
        message = 'Change the team tree in a READ COMMITTED transaction.';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('moduleone:team_tree', 0));
    delete from public.team_leads l where l.member_id = new.id;
  end if;
  return null;
end $$;
revoke execute on function members_drop_team_leads() from public, anon, authenticated;

create trigger members_drop_team_leads after update of role on members
  for each row execute function members_drop_team_leads();

-- ---------- helpers for the policies ----------
-- The nodes a signed-in leader leads: their own team and their team_leads rows, plus everything
-- under those (a led domain's sub-teams, including ones added or moved in later). Archived nodes
-- are included so their history stays readable. Empty for everyone else, never null. This is the
-- one place that says what a lead covers; the policies below only call it.
create function app_led_team_ids() returns uuid[]
  language sql stable security definer set search_path = '' as $$
    with recursive led (id) as (
      select m.team_id
      from public.members m
      where m.auth_user_id = auth.uid() and m.role = 'leader' and m.team_id is not null
      union
      select l.team_id
      from public.team_leads l
      join public.members m on m.id = l.member_id
      where m.auth_user_id = auth.uid() and m.role = 'leader'
      union
      select t.id
      from public.teams t
      join led on t.parent_id = led.id
    )
    select coalesce(array_agg(led.id), '{}') from led;
$$;

-- The teams whose rows a signed-in member can read: their own, the ones they lead, and every
-- division and domain above those. Empty when none, never null.
create function app_visible_team_ids() returns uuid[]
  language sql stable security definer set search_path = '' as $$
    with recursive visible (id) as (
      select own.id
      from unnest(array_append(public.app_led_team_ids(), public.app_current_team())) as own (id)
      where own.id is not null
      union
      select t.parent_id
      from public.teams t
      join visible v on v.id = t.id
      where t.parent_id is not null
    )
    select coalesce(array_agg(visible.id), '{}') from visible;
$$;

revoke execute on function app_led_team_ids(), app_visible_team_ids() from public, anon;
grant execute on function app_led_team_ids(), app_visible_team_ids() to authenticated, service_role;

-- ---------- who sees what ----------
-- Helper calls are wrapped in (select …) so Postgres evaluates each once per statement, not once
-- per row. The ::uuid[] cast makes `= any (…)` read the array, not a one-row subquery.

-- Check-ins: your own, every one for hq, and for a leader those made in the teams they lead (by
-- the check-in's own team, as in 0002; app_led_team_ids says what a lead covers). A leader of a
-- team with nothing under it and no team_leads rows sees what 0002 showed.
drop policy checkins_select on checkins;
create policy checkins_select on checkins for select to authenticated
  using (
    member_id = (select app_current_member_id())
    or (select app_current_role()) = 'hq'
    or team_id = any ((select app_led_team_ids())::uuid[])
  );

-- Members: yourself, your teammates, everyone for hq and admins; for a leader, everyone now in a
-- team they lead and anyone who checked in there (so past weeks still show names after a move).
drop policy members_select on members;
create policy members_select on members for select to authenticated
  using (
    auth_user_id = (select auth.uid())
    or team_id = (select app_current_team())
    or (select app_current_role()) = 'hq'
    or (select app_has_grant('admin'))
    or team_id = any ((select app_led_team_ids())::uuid[])
    or exists (
      select 1 from checkins
      where checkins.member_id = members.id
        and checkins.team_id = any ((select app_led_team_ids())::uuid[])
    )
  );

-- Teams: the ones you sit in or lead and everything above them; all of them for hq and admins.
drop policy teams_select on teams;
create policy teams_select on teams for select to authenticated
  using (
    id = any ((select app_visible_team_ids())::uuid[])
    or (select app_current_role()) = 'hq'
    or (select app_has_grant('admin'))
  );

-- Team leads: your own rows, who leads the teams you can see, and all of them for hq and admins.
-- Admins add leads for others only: adding themselves would widen the check-ins they can read.
create policy team_leads_select on team_leads for select to authenticated
  using (
    member_id = (select app_current_member_id())
    or team_id = any ((select app_visible_team_ids())::uuid[])
    or (select app_current_role()) = 'hq'
    or (select app_has_grant('admin'))
  );
create policy team_leads_admin_insert on team_leads for insert to authenticated
  with check ((select app_has_grant('admin')) and member_id is distinct from (select app_current_member_id()));
create policy team_leads_admin_delete on team_leads for delete to authenticated
  using ((select app_has_grant('admin')));

-- ---------- admin_move_team: drag and drop in the admin tree ----------
-- Puts a node under p_parent_id (null for the top level, which holds divisions and unplaced
-- domains together) at position p_index among its active siblings, then renumbers sort_order
-- 0, 1, 2, … at the destination and closes the gap at the old parent. Archived siblings keep their
-- sort_order; an archived node that is moved goes after the destination's active ones. Ties sort
-- by (sort_order, name, id). SECURITY INVOKER, so RLS, the column grants and the tree rules all
-- apply to the caller; a refused move changes nothing.
create function admin_move_team(p_team_id uuid, p_parent_id uuid, p_index int) returns void
  language plpgsql security invoker set search_path = '' as $$
declare
  old_parent     uuid;
  node_kind      text;
  node_archived  timestamptz;
  n              int;
  pos            int;
begin
  if not coalesce(public.app_has_grant('admin'), false) then
    raise exception using errcode = 'insufficient_privilege',
      message = 'Only admins can move teams.';
  end if;
  if p_index is null or p_index < 0 or p_index > 10000 then
    raise exception using errcode = 'invalid_parameter_value',
      message = 'The position must be between 0 and 10000.';
  end if;

  -- Lock before reading, as the triggers do, so the parent read here is the one being changed.
  -- (Outside READ COMMITTED the tree trigger refuses the update below, so nothing is renumbered
  -- from a stale read.)
  perform pg_advisory_xact_lock(hashtextextended('moduleone:team_tree', 0));
  select t.parent_id, t.kind, t.archived_at into old_parent, node_kind, node_archived
  from public.teams t where t.id = p_team_id;
  if not found then
    raise exception using errcode = 'no_data_found', message = 'That team doesn''t exist.';
  end if;

  -- The teams_* check constraints refuse these too, but in Postgres's words; they are the most
  -- common bad drops, so say what's wrong. The tree trigger words the rest.
  if p_parent_id = p_team_id then
    raise exception using errcode = 'check_violation',
      message = format('A %s can''t sit under itself.', node_kind);
  elsif node_kind = 'division' and p_parent_id is not null then
    raise exception using errcode = 'check_violation',
      message = 'A division can only sit at the top level.';
  elsif node_kind = 'team' and p_parent_id is null then
    raise exception using errcode = 'check_violation',
      message = 'A team can only sit under a domain.';
  end if;

  update public.teams set parent_id = p_parent_id where id = p_team_id;

  select count(*) into n
  from public.teams s
  where s.parent_id is not distinct from p_parent_id and s.archived_at is null and s.id <> p_team_id;
  -- An archived node isn't part of the active order: put it after the active siblings, which
  -- stay 0..n-1.
  pos := case when node_archived is null then least(p_index, n) else n end;

  update public.teams t
  set sort_order = case when o.rank < pos then o.rank else o.rank + 1 end
  from (
    select s.id, (row_number() over (order by s.sort_order, s.name, s.id) - 1)::int as rank
    from public.teams s
    where s.parent_id is not distinct from p_parent_id and s.archived_at is null and s.id <> p_team_id
  ) o
  where t.id = o.id;
  update public.teams set sort_order = pos where id = p_team_id;

  if old_parent is distinct from p_parent_id then
    update public.teams t
    set sort_order = o.rank
    from (
      select s.id, (row_number() over (order by s.sort_order, s.name, s.id) - 1)::int as rank
      from public.teams s
      where s.parent_id is not distinct from old_parent and s.archived_at is null
    ) o
    where t.id = o.id;
  end if;
end $$;
revoke execute on function admin_move_team(uuid, uuid, int) from public, anon;
grant execute on function admin_move_team(uuid, uuid, int) to authenticated, service_role;

-- ---------- founding structure ----------
-- Safe to re-run on a database that already has some of it: divisions are matched by kind and
-- name, domains and teams by code. sort_order follows the owner's table within each parent.
insert into teams (name, kind, division_type, sort_order, note)
select v.name, 'division', v.division_type, v.sort_order, v.note
from (values
  ('Gather',           'strategy',            0, null),
  ('Culture',          'strategy',            1, 'The three work as a cycle.'),
  ('HQ',               'support_development', 2, null),
  ('Special Projects', 'support_development', 3, null)
) as v (name, division_type, sort_order, note)
where not exists (select 1 from teams t where t.kind = 'division' and t.name = v.name);

-- Teams made before this migration are now unplaced domains at the top level, all at sort_order 0
-- like Gather. List them after the divisions, by name, so the top level opens in the owner's
-- order. Nothing else about them changes. (Rows already moved off 0 are left alone.)
update teams t
set sort_order = (select coalesce(max(d.sort_order), -1) + 1 from teams d where d.kind = 'division' and d.parent_id is null)
               + o.rank
from (
  select u.id, (row_number() over (order by u.name, u.id) - 1)::int as rank
  from teams u
  where u.kind = 'domain' and u.parent_id is null and u.sort_order = 0
) o
where t.id = o.id;

insert into teams (parent_id, name, kind, domain_type, code, sort_order, note)
select d.id, v.name, 'domain', v.domain_type, v.code, v.sort_order, v.note
from (values
  ('Gather',           'IP.X', 'IP Lab',         'lab',         0, null),
  ('Gather',           'BQ.X', 'Barbeques',      'ip',          1, null),
  ('Gather',           'DN.X', 'Dinners',        'ip',          2, null),
  ('Gather',           'HP.X', 'Houseparties',   'ip',          3, null),
  ('Culture',          'FL.X', 'Flag Lab',       'lab',         0, null),
  ('Culture',          'AT.X', 'Atlas',          'development', 1, null),
  ('Culture',          'LA.X', 'Living Archive', 'ip',          2, null),
  ('HQ',               'IF.X', 'Infrastructure', 'lab',         0, 'Future division.'),
  ('HQ',               'RL.X', 'Relationships',  'development', 1, null),
  ('HQ',               'FN.X', 'Finance',        'development', 2, null),
  ('HQ',               'DV.X', 'Development',    'development', 3, null),
  ('HQ',               'PB.X', 'Publicity',      'development', 4, null),
  ('Special Projects', 'YD.X', 'Youth Day',      'ip',          0, null),
  ('Special Projects', 'YS.X', 'Youth Spaces',   'ip',          1, null)
) as v (division, code, name, domain_type, sort_order, note)
join teams d on d.kind = 'division' and d.name = v.division
on conflict (code) do nothing;

insert into teams (parent_id, name, kind, code, sort_order)
select p.id, v.name, 'team', v.code, v.sort_order
from (values
  ('IP.X', 'IP.1', 'IP Lab 1',       0),
  ('IP.X', 'IP.2', 'IP Lab 2',       1),
  ('YD.X', 'YD.1', 'Youth Day 1',    0),
  ('YD.X', 'YD.2', 'Youth Day 2',    1),
  ('YD.X', 'YD.3', 'Youth Day 3',    2),
  ('YS.X', 'YS.1', 'Youth Spaces 1', 0),
  ('YS.X', 'YS.2', 'Youth Spaces 2', 1)
) as v (domain_code, code, name, sort_order)
join teams p on p.code = v.domain_code
on conflict (code) do nothing;
