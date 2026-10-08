-- Run by scripts/check-team-tree-upgrade.sh (see there) on a database at migration 0002, with the
-- psql variables migration (0003's file) and founding (its founding load). Stops at the first
-- broken expectation, and rolls everything back.
begin;

-- What production may hold before 0003: teams made by hand (one named like a founding division),
-- people in one of them, and a check-in.
insert into teams (id, name, division) values
  -- ids sort against the names, so listing them by id instead of by name fails below
  ('0e000000-0000-4000-8000-000000000003', 'Gather',   'Old text'),
  ('0e000000-0000-4000-8000-000000000002', 'Product',  'Gather'),
  ('0e000000-0000-4000-8000-000000000001', 'Zeta Ops', null);
insert into members (id, name, team_id, role) values
  ('0e000000-0000-4000-8000-000000000011', 'Old leader', '0e000000-0000-4000-8000-000000000002', 'leader'),
  ('0e000000-0000-4000-8000-000000000012', 'Old member', '0e000000-0000-4000-8000-000000000002', 'member');
insert into checkins (id, member_id, week_start) values
  ('0e000000-0000-4000-8000-000000000021', '0e000000-0000-4000-8000-000000000012', '2026-09-28');

create temp table old_rows as
  select id, name || '|' || coalesce(division, '-') as v from teams
  union all
  select id, name || '|' || coalesce(team_id::text, '-') || '|' || role || '|' || coalesce(auth_user_id::text, '-') from members
  union all
  select id, member_id || '|' || coalesce(team_id::text, '-') || '|' || week_start from checkins;

\i :migration

do $$
declare
  got text;
begin
  select string_agg(name || ':' || sort_order, ', ' order by sort_order, name) into got
  from teams where kind = 'division';
  if got is distinct from 'Gather:0, Culture:1, HQ:2, Special Projects:3' then
    raise exception 'the four founding divisions should be loaded once, in order; got %', got;
  end if;

  select count(*)::text into got from teams where code is not null;
  if got <> '21' then
    raise exception '0003 should load 21 coded domains and teams; got %', got;
  end if;

  select string_agg(t.code, ', ' order by t.code) into got
  from teams t left join teams p on p.id = t.parent_id
  where t.code is not null
    and p.kind is distinct from (case t.kind when 'domain' then 'division' when 'team' then 'domain' end);
  if got is not null then
    raise exception 'these founding nodes are not under a founding division or domain: %', got;
  end if;

  select p.kind || ' ' || p.name into got from teams t join teams p on p.id = t.parent_id where t.code = 'IP.X';
  if got is distinct from 'division Gather' then
    raise exception 'IP.X should sit under the Gather division, not the old team named Gather; got %', got;
  end if;

  -- The teams that were already there stay unplaced domains, unchanged apart from being listed
  -- after the divisions.
  select string_agg(name || '(' || kind || '):' || sort_order, ', ' order by sort_order, name) into got
  from teams where parent_id is null;
  if got is distinct from
     'Gather(division):0, Culture(division):1, HQ(division):2, Special Projects(division):3, '
     'Gather(domain):4, Product(domain):5, Zeta Ops(domain):6' then
    raise exception 'the top level should list the divisions, then the old teams by name; got %', got;
  end if;
  select string_agg(name, ', ' order by name) into got
  from teams where id::text like '0e000000-%'
    and (code is not null or domain_type is not null or note is not null or archived_at is not null);
  if got is not null then
    raise exception 'these old teams were changed: %', got;
  end if;

  select string_agg(o.v, '; ') into got
  from old_rows o
  where not exists (
    select 1 from (
      select id, name || '|' || coalesce(division, '-') as v from teams
      union all
      select id, name || '|' || coalesce(team_id::text, '-') || '|' || role || '|' || coalesce(auth_user_id::text, '-') from members
      union all
      select id, member_id || '|' || coalesce(team_id::text, '-') || '|' || week_start from checkins
    ) n
    where n.id = o.id and n.v = o.v
  );
  if got is not null then
    raise exception 'these teams, members or check-ins changed or went missing: %', got;
  end if;
end $$;

-- Running the founding load again changes nothing.
create temp table after_first as
  select id, parent_id, kind, code, name, sort_order, division, domain_type, division_type, note, archived_at from teams;

\i :founding

do $$
declare
  got text;
begin
  select string_agg(coalesce(a.name, b.name), ', ') into got
  from after_first a
  full join (
    select id, parent_id, kind, code, name, sort_order, division, domain_type, division_type, note, archived_at from teams
  ) b on b.id = a.id
  where a.id is null or b.id is null
     or (a.parent_id, a.kind, a.code, a.name, a.sort_order, a.division, a.domain_type, a.division_type, a.note, a.archived_at)
        is distinct from
        (b.parent_id, b.kind, b.code, b.name, b.sort_order, b.division, b.domain_type, b.division_type, b.note, b.archived_at);
  if got is not null then
    raise exception 'running the founding load again added or changed: %', got;
  end if;
end $$;

rollback;
