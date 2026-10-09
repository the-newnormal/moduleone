-- 0006: the organisation node, and divisions led by whoever sits in them.
--
-- The organisation: one node above every division (first named "The New Normal"; admins may
-- rename it). Every division sits under it; domains and teams never do. Someone who sits in it
-- (say, the person above all divisions) checks in at the organisation's own level and, as its
-- leader, sees every check-in in every division under it (app_led_team_ids already follows the
-- tree down). That shows as much as hq does, so only the project owner places people there or
-- makes someone a lead of it (from the Supabase dashboard or the server); signed-in admins are
-- refused. It is never archived,
-- moved or turned into anything else, and there is only ever one.
--
-- Automatic leadership: anyone placed in a division, or in the organisation, leads it. A member
-- placed there becomes a leader (hq stays hq), and nobody sitting there can be made a member. A
-- domain becomes a division only once nobody sits in it as a member: promoting them on the way
-- would let an admin who sits in a domain as a member make themselves its leader, and read its
-- history. Someone who moves out keeps the leader role (so they lead wherever they go next, like
-- any leader) until an admin changes it.
--
-- Divisions used to sit at the top level. To keep that working for callers that don't know about
-- the organisation, a division saved without a parent goes under it, admin_move_team takes "the
-- top level" (null) for a division to mean the organisation, and a division that becomes a domain
-- without a new parent is unplaced. Unplaced domains still sit at the top level, outside it.
--
-- Titles: a node can say what the leaders who sit in it are called (teams.leader_title). The
-- organisation's starts as "President", so whoever sits there shows as President; admins rename
-- it like the node's name. It is a label only: what anyone sees comes from where they sit and
-- their role, never from a title.
--
-- No policy changes: everyone who can see a division sees the organisation above it
-- (app_visible_team_ids walks up), and admins rename it, and its title, through the teams update
-- policy (the new column is granted like the others).

-- ---------- the organisation kind ----------
alter table teams drop constraint teams_kind;
alter table teams add constraint teams_kind check (kind in ('organisation', 'division', 'domain', 'team'));
-- teams_check_tree now says where a division sits (under the organisation), in words.
alter table teams drop constraint teams_division_at_top;
-- What the leaders who sit in a node are called ("President" for the organisation); null shows
-- the plain role. Trimmed, 1 to 60 characters.
alter table teams
  add column leader_title text,
  add constraint teams_leader_title_format
    check (leader_title is null or (leader_title = btrim(leader_title) and char_length(leader_title) between 1 and 60));
grant insert (leader_title), update (leader_title) on table teams to authenticated;

-- At most one organisation, even with triggers off. teams_fill_tree refuses a second in words
-- first.
create unique index teams_one_organisation on teams (kind) where kind = 'organisation';

-- ---------- where divisions sit: under the organisation ----------
-- A division saved with no parent goes under the organisation, and a division that becomes a domain
-- where it is (under the organisation, where no domain may sit) is unplaced. BEFORE, so the row the
-- tree rules check is the one saved.
--
-- It runs before RLS checks an insert, so it refuses only one thing, and only because the unique
-- index would otherwise answer first in Postgres's words: a second organisation. That tells
-- whoever tries that there is one, which every signed-in user can see anyway. Every other refusal
-- stays in the AFTER triggers.
create function teams_fill_tree() returns trigger
  language plpgsql security definer set search_path = '' as $$
declare
  org uuid;
begin
  select t.id into org from public.teams t where t.kind = 'organisation';
  if new.kind = 'organisation' and org is not null and new.id is distinct from org then
    raise exception using errcode = 'check_violation', message = 'There is only one organisation.';
  elsif new.id = org then
    return new; -- the organisation itself: teams_check_tree refuses a change of kind in words
  elsif new.kind = 'division' and new.parent_id is null then
    new.parent_id := org;
  elsif tg_op = 'UPDATE' and old.kind = 'division' and new.kind = 'domain'
        and new.parent_id is not distinct from old.parent_id and new.parent_id = org then
    new.parent_id := null;
  end if;
  return new;
end $$;
revoke execute on function teams_fill_tree() from public, anon, authenticated;

create trigger teams_fill_tree before insert or update of kind, parent_id on teams
  for each row execute function teams_fill_tree();

-- ---------- tree rules ----------
-- 0005's rules, plus the organisation's: where it and divisions may sit, that it stays one,
-- unarchived and itself, and that nobody sits in a division as a member.
create or replace function teams_check_tree() returns trigger
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

  -- 0. The organisation: one, at the top, never anything else, never archived.
  if tg_op = 'UPDATE' and old.kind = 'organisation' then
    if new.kind is distinct from old.kind then
      raise exception using errcode = 'check_violation', message = 'The organisation''s kind can''t change.';
    elsif new.parent_id is not null then
      raise exception using errcode = 'check_violation', message = 'The organisation can''t be moved.';
    elsif new.archived_at is not null then
      raise exception using errcode = 'check_violation', message = 'The organisation can''t be archived.';
    end if;
  elsif new.kind = 'organisation' then
    -- Another node turned into the organisation, or a new one: there is already one (0006 made
    -- it, and teams_fill_tree and the unique index refuse a second), and it sits at the top.
    if tg_op = 'UPDATE' or new.parent_id is not null then
      raise exception using errcode = 'check_violation', message = 'There is only one organisation.';
    end if;
  end if;

  -- 1. Where the node may sit (checked when it is created, moved or changes kind). A team without
  --    a parent and a node under itself never get here: the teams_* check constraints refuse
  --    those first (admin_move_team words them for the admin).
  if tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id or new.kind is distinct from old.kind then
    if new.parent_id is not null then
      select p.kind into parent_kind from public.teams p where p.id = new.parent_id;
    end if;
    if new.kind = 'division' and parent_kind is distinct from 'organisation' then
      raise exception using errcode = 'check_violation',
        message = 'A division can only sit under the organisation.';
    elsif new.kind = 'domain' and new.parent_id is not null and parent_kind is distinct from 'division' then
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
    --    included: they can be restored). People, leads and check-ins may stay (since 0005), but
    --    everyone sitting in a division leads it, so its members are made leaders first (by an
    --    admin, who can't do that for themselves).
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
        select count(*) into n from public.members m where m.team_id = new.id and m.role = 'member';
        if n > 0 then
          raise exception using errcode = 'check_violation',
            message = format('Everyone in a division leads it. Make its %s %s leaders, or move them out, first.',
              n, case when n = 1 then 'member' else 'members' end);
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

-- ---------- members: who sits in a division or the organisation leads it ----------
-- A member placed in a division or the organisation (created there, or moved there) becomes a
-- leader; hq and leaders are left as they are. Fills in, never refuses (see teams_fill_tree).
create function members_lead_where_placed() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if new.role = 'member' and new.team_id is not null
     and (tg_op = 'INSERT' or new.team_id is distinct from old.team_id)
     and exists (select 1 from public.teams t where t.id = new.team_id and t.kind in ('division', 'organisation')) then
    new.role := 'leader';
  end if;
  return new;
end $$;
revoke execute on function members_lead_where_placed() from public, anon, authenticated;

create trigger members_lead_where_placed before insert or update of team_id on members
  for each row execute function members_lead_where_placed();

-- Placed in the organisation (by the project owner only), a division, a domain or a team; never
-- in an archived one. The owner works from the dashboard or the server, where no user is signed
-- in; a signed-in admin placing someone in the organisation would give them every check-in.
create or replace function members_check_team() returns trigger
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
  if target_kind = 'organisation' and auth.uid() is not null then
    raise exception using errcode = 'insufficient_privilege',
      message = 'Only the project owner can place people in the organisation itself.';
  elsif target_archived is not null then
    raise exception using errcode = 'check_violation',
      message = format('That %s is archived. Restore it first, or pick another.', target_kind);
  end if;
  return null;
end $$;
revoke execute on function members_check_team() from public, anon, authenticated;

-- A lead row needs a leader and an active node, as in 0005; on the organisation itself only the
-- project owner adds one (a lead of the organisation sees every check-in, like someone sitting
-- there). Also checked when the server rewrites a row (authenticated can't update).
create or replace function team_leads_check() returns trigger
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
  if target_kind = 'organisation' and auth.uid() is not null then
    raise exception using errcode = 'insufficient_privilege',
      message = 'Only the project owner can make someone a lead of the organisation itself.';
  elsif lead_role is distinct from 'leader' then
    raise exception using errcode = 'check_violation',
      message = 'Only members with the leader role can lead a team. Make them a leader first.';
  elsif target_archived is not null then
    raise exception using errcode = 'check_violation',
      message = format('That %s is archived. Restore it first.', target_kind);
  end if;
  return null;
end $$;
revoke execute on function team_leads_check() from public, anon, authenticated;

-- Nobody sitting in a division or the organisation is a member: members_lead_where_placed makes
-- them leaders as they arrive, and this refuses making one a member afterwards.
create function members_check_role() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  if new.role is distinct from 'member' or new.team_id is null then
    return null;
  end if;
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception using errcode = 'invalid_transaction_state',
      message = 'Change the team tree in a READ COMMITTED transaction.';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('moduleone:team_tree', 0));
  if exists (select 1 from public.teams t where t.id = new.team_id and t.kind in ('division', 'organisation')) then
    raise exception using errcode = 'check_violation',
      message = 'People placed in a division or the organisation lead it. Move them to a domain or team before making them a member.';
  end if;
  return null;
end $$;
revoke execute on function members_check_role() from public, anon, authenticated;

create trigger members_check_role after insert or update of role, team_id on members
  for each row execute function members_check_role();

-- ---------- admin_move_team: the organisation stays put, divisions stay under it ----------
-- As in 0003, plus: the organisation can't be moved, and a division dropped at the top level
-- (p_parent_id null, as the Structure page did before 0006) goes under the organisation instead.
create or replace function admin_move_team(p_team_id uuid, p_parent_id uuid, p_index int) returns void
  language plpgsql security invoker set search_path = '' as $$
declare
  old_parent     uuid;
  node_kind      text;
  node_archived  timestamptz;
  dest           uuid := p_parent_id;
  org            uuid;
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
  select t.id into org from public.teams t where t.kind = 'organisation';

  -- The teams_* check constraints refuse some of these too, but in Postgres's words; they are
  -- the most common bad drops, so say what's wrong. The tree trigger words the rest.
  if node_kind = 'organisation' then
    raise exception using errcode = 'check_violation', message = 'The organisation can''t be moved.';
  elsif dest = p_team_id then
    raise exception using errcode = 'check_violation',
      message = format('A %s can''t sit under itself.', node_kind);
  elsif node_kind = 'division' then
    dest := coalesce(dest, org);
    if dest is distinct from org then
      raise exception using errcode = 'check_violation',
        message = 'A division can only sit under the organisation.';
    end if;
  elsif node_kind = 'team' and dest is null then
    raise exception using errcode = 'check_violation',
      message = 'A team can only sit under a domain.';
  end if;

  update public.teams set parent_id = dest where id = p_team_id;

  select count(*) into n
  from public.teams s
  where s.parent_id is not distinct from dest and s.archived_at is null and s.id <> p_team_id;
  -- An archived node isn't part of the active order: put it after the active siblings, which
  -- stay 0..n-1.
  pos := case when node_archived is null then least(p_index, n) else n end;

  update public.teams t
  set sort_order = case when o.rank < pos then o.rank else o.rank + 1 end
  from (
    select s.id, (row_number() over (order by s.sort_order, s.name, s.id) - 1)::int as rank
    from public.teams s
    where s.parent_id is not distinct from dest and s.archived_at is null and s.id <> p_team_id
  ) o
  where t.id = o.id;
  update public.teams set sort_order = pos where id = p_team_id;

  if old_parent is distinct from dest then
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

-- ---------- the organisation, and every division under it ----------
-- Safe to run on a database that already has one: it is matched by kind. The divisions keep their
-- order (sort_order), now among themselves under the organisation.
insert into teams (name, kind, sort_order, leader_title)
select 'The New Normal', 'organisation', 0, 'President'
where not exists (select 1 from teams where kind = 'organisation');

update teams set parent_id = (select id from teams where kind = 'organisation')
where kind = 'division' and parent_id is null;

-- Since 0005 someone may sit in a division as a member; from now on they lead it.
update members set role = 'leader'
where role = 'member' and team_id in (select id from teams where kind in ('division', 'organisation'));
