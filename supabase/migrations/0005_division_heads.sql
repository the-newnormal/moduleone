-- 0005: division heads. Someone can sit in a division and lead it, like a domain: the head of
-- Gather checks in at Gather's own level (their check-ins count as Gather's, not some domain's)
-- and, as a leader whose team is Gather, sees every check-in made in Gather and under it
-- (app_led_team_ids already follows the tree down from a leader's own team and their leads).
--
-- 0003 kept divisions empty: nobody placed in one, nobody leading one, and no domain with people,
-- leads or check-ins becoming one. This replaces the three functions that said so; nothing else
-- about the tree changes. A division is still at the top level, holds only domains, and is
-- archived only once nobody sits in it and nothing active is under it.
--
-- The heat-map already counts a division's own check-ins in its box, its Trend row and its
-- drill-in (src/lib/dashboard/org.ts), and RLS needs no change: leaders read check-ins by
-- app_led_team_ids, everyone sees the nodes above the teams they can see.

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
    --    included: they can be restored). People, leads and check-ins may stay: since 0005 a
    --    division can hold all three, like a domain.
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

-- Placed in a division, a domain or a team; never in an archived one.
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
  if target_archived is not null then
    raise exception using errcode = 'check_violation',
      message = format('That %s is archived. Restore it first, or pick another.', target_kind);
  end if;
  return null;
end $$;
revoke execute on function members_check_team() from public, anon, authenticated;

-- A lead row needs a leader (so never an hq member, who sees everything anyway) and an active
-- division, domain or team. Also checked when the server rewrites a row (authenticated can't update).
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
  if lead_role is distinct from 'leader' then
    raise exception using errcode = 'check_violation',
      message = 'Only members with the leader role can lead a team. Make them a leader first.';
  elsif target_archived is not null then
    raise exception using errcode = 'check_violation',
      message = format('That %s is archived. Restore it first.', target_kind);
  end if;
  return null;
end $$;
revoke execute on function team_leads_check() from public, anon, authenticated;
