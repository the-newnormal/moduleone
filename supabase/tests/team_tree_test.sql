-- The team tree, team leads and admin_move_team (migration 0003). Run: supabase test db
-- Builds its own fixtures inside the transaction and rolls back, so it doesn't depend on seed.sql
-- (it does check the founding structure, which 0003 itself loads). Since 0005 a division can hold
-- people, leads and check-ins like a domain; division_heads_test.sql covers that.
--
-- Fixtures (ids b1… teams, c1… members, a1… logins, d1… check-ins):
--   TT Division 1                       TT Division 2               TT Division 3
--     TT Domain 1    (mdm1, dlead)        TT Domain 3    (mdm3)       TT Domain 4
--       TT Team 1.1  (m11, m11b)            TT Team 3.1  (m31)          TT Team 4.1  (m41)
--       TT Team 1.2  (m12, mover)           TT Team 3.2  (archived)
--     TT Domain 2
--       TT Team 2.1  (lead, m21)
--   TT Move division                    TT Move division N          TT Unplaced (a domain at the top level)
--     TT MA, TT MB, TT MC, TT MZ (archived)   TT NA
--   lead     a leader in TT Team 2.1 who also leads TT Team 1.1 and TT Domain 3 (team_leads)
--   dlead    a leader whose own team is TT Domain 1
--   mover    checked in while in TT Team 1.1, then moved to TT Team 1.2
--   m32      checked in while in TT Team 3.2, then left it; TT Team 3.2 was then archived
--   admin    role leader, no team, grant admin    hq        role hq, no team
--   lead2    a leader with no team or login       plain, plain2   members with no team
--   outsider signed in, but no members row
-- Check-ins (week of 2026-10-05): m11, m12, mdm1, m31, mdm3, m21, mover, m32 and m41, each in their
-- team. The admin sections add more nodes by name (admins can't choose ids) and look them up with
-- pg_temp.team().
begin;
select plan(309);

-- ---------- tree lock ----------
-- Whether running sql takes the tree lock. It runs in a subtransaction that is rolled back, which
-- releases the lock again, so this only tells anything while the transaction doesn't hold it yet.
create function pg_temp.takes_tree_lock(sql text) returns boolean language plpgsql as $$
declare took boolean;
begin
  begin
    execute sql;
    took := exists (
      select 1 from pg_locks
      where locktype = 'advisory' and pid = pg_backend_pid() and granted
        and objsubid = 1
        and ((classid::bigint << 32) | objid::bigint) = hashtextextended('moduleone:team_tree', 0)
    );
    raise exception 'tt: undo';
  exception when raise_exception then
    if sqlerrm <> 'tt: undo' then
      raise;
    end if;
  end;
  return took;
end $$;

-- Fixtures made with this file's triggers off (user triggers only; foreign keys still apply), so
-- none of them takes the lock and the statements below are the first to: a leader with no team
-- and a lead row; someone in IP.1; a domain at the top level and an archived team under IP.X.
alter table members disable trigger user;
alter table team_leads disable trigger user;
alter table teams disable trigger user;
insert into members (id, name, role) values ('e1000000-0000-4000-8000-000000000001', 'TT lock leader', 'leader');
insert into team_leads (team_id, member_id)
  select id, 'e1000000-0000-4000-8000-000000000001' from teams where code = 'IP.1';
insert into members (id, name, team_id)
  select 'e1000000-0000-4000-8000-000000000002', 'TT lock placed', id from teams where code = 'IP.1';
insert into teams (id, name, kind, parent_id, archived_at) values
  ('e1000000-0000-4000-8000-000000000011', 'TT lock unplaced', 'domain', null, null),
  ('e1000000-0000-4000-8000-000000000012', 'TT lock archived', 'team', (select id from teams where code = 'IP.X'), now());
alter table members enable trigger user;
alter table team_leads enable trigger user;
alter table teams enable trigger user;
select ok(
  not exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()),
  'no advisory lock is held before any structural change'
);
-- Each structural statement takes the lock before it touches a row (a BEFORE STATEMENT trigger),
-- so it never holds a row another session's drag needs while waiting for the lock: these change
-- no rows at all and still take it.
select is(pg_temp.takes_tree_lock($$update teams set archived_at = now() where false$$), true,
  'an archive, move or kind change takes the tree lock before it locks any row (teams_tree_lock)');
select is(pg_temp.takes_tree_lock($$update members set team_id = null where false$$), true,
  'so does placing or moving someone (members_tree_lock)');
select is(pg_temp.takes_tree_lock($$insert into team_leads (team_id, member_id) select team_id, member_id from team_leads where false$$), true,
  'and adding a lead (team_leads_tree_lock)');
select is(pg_temp.takes_tree_lock($$insert into teams (name) values ('TT lock domain')$$), true,
  'adding a team takes the tree lock (teams_check_tree)');
select is(pg_temp.takes_tree_lock($$update teams set name = 'TT lock rename' where code = 'IP.1'$$), false,
  'renaming a team does not (the tree trigger only runs for parent, kind and archive changes)');
select is(
  pg_temp.takes_tree_lock($$insert into members (name, team_id) select 'TT lock member', id from teams where code = 'IP.1'$$),
  true, 'placing someone in a team takes the tree lock (members_check_team)'
);
-- Updates too: these are the admin's everyday changes, and the race the lock is for (archive a
-- domain while someone is placed into it) needs both sides to take it.
select is(
  pg_temp.takes_tree_lock($$update members set team_id = (select id from teams where code = 'IP.2') where id = 'e1000000-0000-4000-8000-000000000002'$$),
  true, 'moving someone to another team takes the tree lock (members_check_team on update)'
);
select is(
  pg_temp.takes_tree_lock($$update members set team_id = (select id from teams where code = 'IP.2') where id = 'e1000000-0000-4000-8000-000000000001'$$),
  true, 'placing someone who has no team yet takes the tree lock (members_check_team on update)'
);
select is(
  pg_temp.takes_tree_lock($$update teams set parent_id = (select id from teams where code = 'YS.X') where code = 'IP.2'$$),
  true, 'moving a team takes the tree lock (teams_check_tree on update)'
);
select is(pg_temp.takes_tree_lock($$update teams set archived_at = now() where id = 'e1000000-0000-4000-8000-000000000011'$$), true,
  'so does archiving one');
select is(pg_temp.takes_tree_lock($$update teams set archived_at = null where id = 'e1000000-0000-4000-8000-000000000012'$$), true,
  'and restoring one');
select is(pg_temp.takes_tree_lock($$update teams set kind = 'division' where id = 'e1000000-0000-4000-8000-000000000011'$$), true,
  'and changing its kind');
select is(
  pg_temp.takes_tree_lock($$insert into team_leads (team_id, member_id) select id, 'e1000000-0000-4000-8000-000000000001' from teams where code = 'IP.2'$$),
  true, 'adding a lead takes the tree lock (team_leads_check)'
);
select is(
  pg_temp.takes_tree_lock($$update team_leads set team_id = (select id from teams where code = 'IP.2') where member_id = 'e1000000-0000-4000-8000-000000000001'$$),
  true, 'so does the server rewriting one'
);
select is(
  pg_temp.takes_tree_lock($$update members set role = 'member' where id = 'e1000000-0000-4000-8000-000000000001'$$),
  true, 'demoting a leader takes the tree lock (members_drop_team_leads)'
);
select is(
  pg_temp.takes_tree_lock($$update members set name = 'TT lock rename' where id = 'e1000000-0000-4000-8000-000000000001'$$),
  false, 'renaming a leader does not'
);
-- Each function takes the lock before it reads any table (comments left out, so a commented-out
-- lock doesn't count), so what it reads is what the change it waited for left behind.
select ok(
  strpos(x.src, 'pg_advisory_xact_lock(hashtextextended(''moduleone:team_tree'', 0))') between 1 and strpos(x.src, 'from public.'),
  format('%s takes the tree lock before it reads any table', x.f)
) from (
  select f, regexp_replace((select prosrc from pg_proc where oid = f::regprocedure), '--[^' || chr(10) || ']*', '', 'g') as src
  from unnest(array[
    'public.admin_move_team(uuid, uuid, integer)', 'public.teams_check_tree()', 'public.members_check_team()',
    'public.team_leads_check()', 'public.members_drop_team_leads()']) f
) x;
delete from members where id in ('e1000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000002');
delete from teams where id in ('e1000000-0000-4000-8000-000000000011', 'e1000000-0000-4000-8000-000000000012');

insert into teams (id, name, kind) values ('b1000000-0000-4000-8000-000000000001', 'TT Division 1', 'division');
select ok(
  exists (
    select 1 from pg_locks
    where locktype = 'advisory' and pid = pg_backend_pid() and granted
      and objsubid = 1
      and ((classid::bigint << 32) | objid::bigint) = hashtextextended('moduleone:team_tree', 0)
  ),
  'creating a team takes the tree lock, held until the transaction ends'
);

-- ---------- founding structure (loaded by 0003) ----------
select is(
  (select count(*)::int from teams where id::text not like 'b1000000-%'),
  25, 'the founding structure has exactly 25 nodes (4 divisions, 14 domains, 7 teams), nothing more'
);
select results_eq(
  $$select t.name, t.division_type, t.sort_order, t.note, t.archived_at is null
    from teams t
    where t.kind = 'division' and t.id::text not like 'b1000000-%'
    order by t.sort_order$$,
  $$values ('Gather', 'strategy', 0, null::text, true),
           ('Culture', 'strategy', 1, 'The three work as a cycle.', true),
           ('HQ', 'support_development', 2, null, true),
           ('Special Projects', 'support_development', 3, null, true)$$,
  'the four founding divisions, in order, with their types and notes'
);
select is(
  (select count(*)::int from teams where kind = 'division' and parent_id is not null),
  0, 'every division sits at the top level'
);
select results_eq(
  $$select t.code, t.name, t.kind, coalesce(p.code, p.name), p.kind, t.domain_type, t.division_type,
           t.sort_order, t.note, t.archived_at is null
    from teams t join teams p on p.id = t.parent_id
    where t.code is not null and t.id::text not like 'b1000000-%'
    order by t.code collate "C"$$,
  $$values
    ('AT.X', 'Atlas',          'domain', 'Culture',          'division', 'development', null::text, 1, null::text, true),
    ('BQ.X', 'Barbeques',      'domain', 'Gather',           'division', 'ip',          null, 1, null, true),
    ('DN.X', 'Dinners',        'domain', 'Gather',           'division', 'ip',          null, 2, null, true),
    ('DV.X', 'Development',    'domain', 'HQ',               'division', 'development', null, 3, null, true),
    ('FL.X', 'Flag Lab',       'domain', 'Culture',          'division', 'lab',         null, 0, null, true),
    ('FN.X', 'Finance',        'domain', 'HQ',               'division', 'development', null, 2, null, true),
    ('HP.X', 'Houseparties',   'domain', 'Gather',           'division', 'ip',          null, 3, null, true),
    ('IF.X', 'Infrastructure', 'domain', 'HQ',               'division', 'lab',         null, 0, 'Future division.', true),
    ('IP.1', 'IP Lab 1',       'team',   'IP.X',             'domain',   null,          null, 0, null, true),
    ('IP.2', 'IP Lab 2',       'team',   'IP.X',             'domain',   null,          null, 1, null, true),
    ('IP.X', 'IP Lab',         'domain', 'Gather',           'division', 'lab',         null, 0, null, true),
    ('LA.X', 'Living Archive', 'domain', 'Culture',          'division', 'ip',          null, 2, null, true),
    ('PB.X', 'Publicity',      'domain', 'HQ',               'division', 'development', null, 4, null, true),
    ('RL.X', 'Relationships',  'domain', 'HQ',               'division', 'development', null, 1, null, true),
    ('YD.1', 'Youth Day 1',    'team',   'YD.X',             'domain',   null,          null, 0, null, true),
    ('YD.2', 'Youth Day 2',    'team',   'YD.X',             'domain',   null,          null, 1, null, true),
    ('YD.3', 'Youth Day 3',    'team',   'YD.X',             'domain',   null,          null, 2, null, true),
    ('YD.X', 'Youth Day',      'domain', 'Special Projects', 'division', 'ip',          null, 0, null, true),
    ('YS.1', 'Youth Spaces 1', 'team',   'YS.X',             'domain',   null,          null, 0, null, true),
    ('YS.2', 'Youth Spaces 2', 'team',   'YS.X',             'domain',   null,          null, 1, null, true),
    ('YS.X', 'Youth Spaces',   'domain', 'Special Projects', 'division', 'ip',          null, 1, null, true)$$,
  'the 14 founding domains and 7 teams, each under the right parent, with types, notes and order'
);
select col_is_unique('public', 'teams', array['code'], 'team codes are unique');

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a1000000-0000-4000-8000-000000000001', 'admin@tree.test'),
  ('a1000000-0000-4000-8000-000000000002', 'lead@tree.test'),
  ('a1000000-0000-4000-8000-000000000003', 'm11@tree.test'),
  ('a1000000-0000-4000-8000-000000000004', 'm12@tree.test'),
  ('a1000000-0000-4000-8000-000000000005', 'outsider@tree.test'),
  ('a1000000-0000-4000-8000-000000000006', 'hq@tree.test'),
  ('a1000000-0000-4000-8000-000000000007', 'dlead@tree.test');

insert into teams (id, name, kind, sort_order) values
  ('b1000000-0000-4000-8000-000000000002', 'TT Division 2',      'division', 0),
  ('b1000000-0000-4000-8000-000000000003', 'TT Division 3',      'division', 0),
  ('b1000000-0000-4000-8000-000000000031', 'TT Move division',   'division', 0),
  ('b1000000-0000-4000-8000-000000000036', 'TT Move division N', 'division', 0),
  ('b1000000-0000-4000-8000-000000000038', 'TT Unplaced',        'domain',   0);
insert into teams (id, name, kind, parent_id, sort_order, archived_at) values
  ('b1000000-0000-4000-8000-000000000011', 'TT Domain 1', 'domain', 'b1000000-0000-4000-8000-000000000001', 0, null),
  ('b1000000-0000-4000-8000-000000000012', 'TT Domain 2', 'domain', 'b1000000-0000-4000-8000-000000000001', 1, null),
  ('b1000000-0000-4000-8000-000000000013', 'TT Domain 3', 'domain', 'b1000000-0000-4000-8000-000000000002', 0, null),
  ('b1000000-0000-4000-8000-000000000014', 'TT Domain 4', 'domain', 'b1000000-0000-4000-8000-000000000003', 0, null),
  ('b1000000-0000-4000-8000-000000000032', 'TT MA',       'domain', 'b1000000-0000-4000-8000-000000000031', 0, null),
  ('b1000000-0000-4000-8000-000000000033', 'TT MB',       'domain', 'b1000000-0000-4000-8000-000000000031', 1, null),
  ('b1000000-0000-4000-8000-000000000034', 'TT MC',       'domain', 'b1000000-0000-4000-8000-000000000031', 2, null),
  ('b1000000-0000-4000-8000-000000000035', 'TT MZ',       'domain', 'b1000000-0000-4000-8000-000000000031', 1, now()),
  ('b1000000-0000-4000-8000-000000000037', 'TT NA',       'domain', 'b1000000-0000-4000-8000-000000000036', 0, null);
insert into teams (id, name, kind, parent_id, sort_order) values
  ('b1000000-0000-4000-8000-000000000021', 'TT Team 1.1', 'team', 'b1000000-0000-4000-8000-000000000011', 0),
  ('b1000000-0000-4000-8000-000000000022', 'TT Team 1.2', 'team', 'b1000000-0000-4000-8000-000000000011', 1),
  ('b1000000-0000-4000-8000-000000000023', 'TT Team 2.1', 'team', 'b1000000-0000-4000-8000-000000000012', 0),
  ('b1000000-0000-4000-8000-000000000024', 'TT Team 3.1', 'team', 'b1000000-0000-4000-8000-000000000013', 0),
  ('b1000000-0000-4000-8000-000000000025', 'TT Team 3.2', 'team', 'b1000000-0000-4000-8000-000000000013', 1),
  ('b1000000-0000-4000-8000-000000000026', 'TT Team 4.1', 'team', 'b1000000-0000-4000-8000-000000000014', 0);

insert into members (id, auth_user_id, name, team_id, role) values
  ('c1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'admin',  null,                                   'leader'),
  ('c1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002', 'lead',   'b1000000-0000-4000-8000-000000000023', 'leader'),
  ('c1000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000003', 'm11',    'b1000000-0000-4000-8000-000000000021', 'member'),
  ('c1000000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000004', 'm12',    'b1000000-0000-4000-8000-000000000022', 'member'),
  ('c1000000-0000-4000-8000-000000000005', null,                                   'mdm1',   'b1000000-0000-4000-8000-000000000011', 'member'),
  ('c1000000-0000-4000-8000-000000000006', null,                                   'm31',    'b1000000-0000-4000-8000-000000000024', 'member'),
  ('c1000000-0000-4000-8000-000000000007', null,                                   'mdm3',   'b1000000-0000-4000-8000-000000000013', 'member'),
  ('c1000000-0000-4000-8000-000000000008', null,                                   'm21',    'b1000000-0000-4000-8000-000000000023', 'member'),
  ('c1000000-0000-4000-8000-000000000009', null,                                   'mover',  'b1000000-0000-4000-8000-000000000021', 'member'),
  ('c1000000-0000-4000-8000-000000000010', 'a1000000-0000-4000-8000-000000000006', 'hq',     null,                                   'hq'),
  ('c1000000-0000-4000-8000-000000000011', null,                                   'lead2',  null,                                   'leader'),
  ('c1000000-0000-4000-8000-000000000012', null,                                   'plain',  null,                                   'member'),
  ('c1000000-0000-4000-8000-000000000013', null,                                   'm11b',   'b1000000-0000-4000-8000-000000000021', 'member'),
  ('c1000000-0000-4000-8000-000000000014', null,                                   'plain2', null,                                   'member'),
  ('c1000000-0000-4000-8000-000000000015', null,                                   'm32',    'b1000000-0000-4000-8000-000000000025', 'member'),
  ('c1000000-0000-4000-8000-000000000016', null,                                   'm41',    'b1000000-0000-4000-8000-000000000026', 'member'),
  ('c1000000-0000-4000-8000-000000000017', 'a1000000-0000-4000-8000-000000000007', 'dlead',  'b1000000-0000-4000-8000-000000000011', 'leader');

insert into member_grants (member_id, grant_name) values ('c1000000-0000-4000-8000-000000000001', 'admin');

insert into team_leads (team_id, member_id) values
  ('b1000000-0000-4000-8000-000000000021', 'c1000000-0000-4000-8000-000000000002'),
  ('b1000000-0000-4000-8000-000000000013', 'c1000000-0000-4000-8000-000000000002');

-- No team_id given: the trigger takes each member's current team.
insert into checkins (id, member_id, week_start) values
  ('d1000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000003', '2026-10-05'),
  ('d1000000-0000-4000-8000-000000000004', 'c1000000-0000-4000-8000-000000000004', '2026-10-05'),
  ('d1000000-0000-4000-8000-000000000005', 'c1000000-0000-4000-8000-000000000005', '2026-10-05'),
  ('d1000000-0000-4000-8000-000000000006', 'c1000000-0000-4000-8000-000000000006', '2026-10-05'),
  ('d1000000-0000-4000-8000-000000000007', 'c1000000-0000-4000-8000-000000000007', '2026-10-05'),
  ('d1000000-0000-4000-8000-000000000008', 'c1000000-0000-4000-8000-000000000008', '2026-10-05'),
  ('d1000000-0000-4000-8000-000000000009', 'c1000000-0000-4000-8000-000000000009', '2026-10-05'),
  ('d1000000-0000-4000-8000-000000000010', 'c1000000-0000-4000-8000-000000000015', '2026-10-05'),
  ('d1000000-0000-4000-8000-000000000011', 'c1000000-0000-4000-8000-000000000016', '2026-10-05');
update members set team_id = 'b1000000-0000-4000-8000-000000000022' where id = 'c1000000-0000-4000-8000-000000000009';
-- m32 leaves TT Team 3.2, which is then archived.
update members set team_id = null where id = 'c1000000-0000-4000-8000-000000000015';
update teams set archived_at = now() where id = 'b1000000-0000-4000-8000-000000000025';

-- Counts rows the caller can see.
create function pg_temp.n(sql text) returns int language plpgsql as $$
declare result int;
begin
  execute format('select count(*) from (%s) q', sql) into result;
  return result;
end $$;

-- Rows changed by a write that RLS filters silently (an UPDATE or DELETE whose USING hides the rows).
create function pg_temp.changed(sql text) returns int language plpgsql as $$
declare result int;
begin
  execute sql;
  get diagnostics result = row_count;
  return result;
end $$;

-- 'SQLSTATE: message' for a statement that fails, so a test can check both; 'no error' otherwise.
create function pg_temp.error_of(sql text) returns text language plpgsql as $$
begin
  execute sql;
  return 'no error';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;

-- A team's id by name, for teams the admin creates (admins can't choose ids). Runs with the
-- caller's RLS, so use it as admin, hq or the server.
create function pg_temp.team(team_name text) returns uuid language sql stable as $$
  select t.id from public.teams t where t.name = team_name;
$$;

-- The active children of a node as 'name:sort_order', in order.
create function pg_temp.order_of(parent uuid) returns text language sql as $$
  select string_agg(t.name || ':' || t.sort_order, ', ' order by t.sort_order, t.name, t.id)
  from public.teams t where t.parent_id = parent and t.archived_at is null;
$$;

-- The columns of a table that a role may insert and update, as 'column:privilege', sorted.
create function pg_temp.column_privs(role_name text, tbl text) returns text[] language sql as $$
  select array_agg(a.attname || ':' || p order by a.attname, p)
  from pg_attribute a, unnest(array['insert', 'update']) p
  where a.attrelid = tbl::regclass and a.attnum > 0 and not a.attisdropped
    and has_column_privilege(role_name, tbl, a.attname, p);
$$;

grant execute on function pg_temp.n(text), pg_temp.changed(text), pg_temp.error_of(text), pg_temp.team(text),
  pg_temp.order_of(uuid)
  to anon, authenticated, service_role;

-- ---------- schema and privileges ----------
select has_column('public', 'teams', c, format('teams has %s', c))
  from unnest(array['parent_id', 'kind', 'domain_type', 'division_type', 'code', 'sort_order', 'note']) c;
select is(
  col_description('public.teams'::regclass,
    (select attnum from pg_attribute where attrelid = 'public.teams'::regclass and attname = 'division')),
  'Deprecated: superseded by the parent division node; not read by the app.',
  'teams.division is marked deprecated'
);
select has_index('public', 'teams', 'teams_parent_id', 'parent_id', 'teams are indexed by parent');
select has_index('public', 'team_leads', 'team_leads_member_id', 'member_id', 'team_leads is indexed by member');
select col_is_pk('public', 'team_leads', array['team_id', 'member_id'], 'a member leads a team at most once');
select is(
  (select relrowsecurity from pg_class where oid = 'public.team_leads'::regclass),
  true, 'team_leads has row level security on'
);
select table_privs_are('public', 'team_leads', 'anon', array[]::text[], 'anon has no privileges on team_leads');
select table_privs_are(
  'public', 'team_leads', 'authenticated', array['DELETE', 'SELECT'],
  'signed-in users get table-wide SELECT and DELETE only on team_leads'
);
select table_privs_are(
  'public', 'team_leads', 'service_role', array['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'],
  'the server (service_role) has full access to team_leads'
);
select is(
  array[has_column_privilege('authenticated', 'public.team_leads', 'team_id', 'insert'),
        has_column_privilege('authenticated', 'public.team_leads', 'member_id', 'insert'),
        has_column_privilege('authenticated', 'public.team_leads', 'created_at', 'insert')],
  array[true, true, false],
  'signed-in users can insert team_leads.team_id and member_id, not created_at'
);
select is(
  has_any_column_privilege('authenticated', 'public.team_leads', 'update'),
  false, 'signed-in users cannot update any team_leads column'
);
select is(
  pg_temp.column_privs('authenticated', 'public.teams'),
  array['archived_at:update', 'code:insert', 'code:update', 'division:insert', 'division:update',
        'division_type:insert', 'division_type:update', 'domain_type:insert', 'domain_type:update',
        'kind:insert', 'kind:update', 'name:insert', 'name:update', 'note:insert', 'note:update',
        'parent_id:insert', 'parent_id:update', 'sort_order:insert', 'sort_order:update'],
  'signed-in users can write exactly these teams columns (RLS limits it to admins); not id, created_at, or archived_at on insert'
);
select is(
  has_table_privilege('authenticated', 'public.teams', 'delete'),
  false, 'signed-in users still cannot delete teams'
);
select has_column('public', 'members', c, format('members has %s', c))
  from unnest(array['login_given_by', 'login_given_at']) c;
select fk_ok('public', 'members', 'login_given_by', 'public', 'members', 'id', 'login_given_by points at a member');
select is(
  (select confdeltype from pg_constraint where conrelid = 'public.members'::regclass and contype = 'f'
     and conkey = array[(select attnum from pg_attribute where attrelid = 'public.members'::regclass and attname = 'login_given_by')]),
  'n', 'deleting the member who gave a login clears login_given_by (on delete set null)'
);
select is(
  pg_temp.column_privs('authenticated', 'public.members'),
  array['name:insert', 'name:update', 'role:insert', 'role:update', 'team_id:insert', 'team_id:update'],
  'signed-in users (admins too) can write only name, team_id and role on members, not login_given_by or login_given_at'
);
select is(
  array[has_column_privilege('authenticated', 'public.members', 'login_given_by', 'select'),
        has_column_privilege('authenticated', 'public.members', 'login_given_at', 'select')],
  array[true, true], 'signed-in users can read who gave a login, and when (RLS decides which rows)'
);
select function_privs_are('public', f, array[]::text[], 'anon', array[]::text[], format('anon cannot call %s', f))
  from unnest(array['app_led_team_ids', 'app_visible_team_ids']) f;
select function_privs_are('public', 'admin_move_team', array['uuid', 'uuid', 'integer'], 'anon', array[]::text[],
  'anon cannot call admin_move_team');
select function_privs_are('public', f, array[]::text[], 'authenticated', array['EXECUTE'], format('signed-in users can call %s', f))
  from unnest(array['app_led_team_ids', 'app_visible_team_ids']) f;
select function_privs_are('public', 'admin_move_team', array['uuid', 'uuid', 'integer'], 'authenticated', array['EXECUTE'],
  'signed-in users can call admin_move_team (it checks for the admin grant itself)');
select is(
  (select bool_or(has_function_privilege('public', f, 'execute')) from unnest(array[
    'public.app_led_team_ids()', 'public.app_visible_team_ids()', 'public.admin_move_team(uuid, uuid, integer)',
    'public.teams_check_tree()', 'public.members_check_team()', 'public.team_leads_check()',
    'public.members_drop_team_leads()']) f),
  false, 'PUBLIC cannot call any of the new functions'
);
select is(
  (select bool_or(has_function_privilege(r, f, 'execute'))
   from unnest(array['anon', 'authenticated']) r,
        unnest(array['public.teams_check_tree()', 'public.members_check_team()', 'public.team_leads_check()',
                     'public.members_drop_team_leads()']) f),
  false, 'anon and signed-in users cannot call the trigger functions'
);
select is(
  (select proconfig from pg_proc where oid = f::regprocedure),
  array['search_path=""'], format('%s runs with an empty search_path', f)
) from unnest(array[
  'public.app_led_team_ids()', 'public.app_visible_team_ids()', 'public.admin_move_team(uuid, uuid, integer)',
  'public.teams_check_tree()', 'public.members_check_team()', 'public.team_leads_check()',
  'public.members_drop_team_leads()']) f;
select is(
  (select array_agg(proname::text || '=' || prosecdef order by proname) from pg_proc
   where pronamespace = 'public'::regnamespace and proname in (
     'app_led_team_ids', 'app_visible_team_ids', 'admin_move_team', 'teams_check_tree',
     'members_check_team', 'team_leads_check', 'members_drop_team_leads')),
  array['admin_move_team=false', 'app_led_team_ids=true', 'app_visible_team_ids=true', 'members_check_team=true',
        'members_drop_team_leads=true', 'team_leads_check=true', 'teams_check_tree=true'],
  'admin_move_team runs as the caller; the helpers and trigger functions as the owner'
);
select is(
  (select array_agg(tgname::text || ':' || (tgtype & 1 = 1)::text order by tgname) from pg_trigger
   where tgname in ('teams_check_tree', 'members_check_team', 'team_leads_check', 'members_drop_team_leads')),
  array['members_check_team:true', 'members_drop_team_leads:true', 'team_leads_check:true', 'teams_check_tree:true'],
  'the tree triggers are row triggers'
);
select is(
  (select array_agg(tgname::text order by tgname) from pg_trigger
   where tgname in ('teams_check_tree', 'members_check_team', 'team_leads_check', 'members_drop_team_leads')
     and tgtype & 2 = 0),
  array['members_check_team', 'members_drop_team_leads', 'team_leads_check', 'teams_check_tree'],
  'the tree triggers run AFTER the write (so RLS refuses non-admins first)'
);

-- ---------- check constraints (they bind the server too) ----------
set local role service_role;
select alike(pg_temp.error_of($$insert into teams (name, kind) values ('x', 'group')$$),
  '23514: %"teams_kind"%', 'kind must be division, domain or team');
select lives_ok($$insert into teams (name, kind, domain_type) values ('TT ok domain type', 'domain', 'lab')$$,
  'a domain can have a domain type');
select alike(pg_temp.error_of($$insert into teams (name, kind, domain_type) values ('x', 'domain', 'shop')$$),
  '23514: %"teams_domain_type"%', 'a domain type must be development, ip or lab');
select alike(pg_temp.error_of($$insert into teams (name, kind, domain_type) values ('x', 'division', 'lab')$$),
  '23514: %"teams_domain_type"%', 'only a domain has a domain type');
select lives_ok($$insert into teams (name, kind, division_type) values ('TT ok division type', 'division', 'support_development')$$,
  'a division can have a division type');
select alike(pg_temp.error_of($$insert into teams (name, kind, division_type) values ('x', 'division', 'growth')$$),
  '23514: %"teams_division_type"%', 'a division type must be strategy or support_development');
select alike(pg_temp.error_of($$insert into teams (name, kind, division_type) values ('x', 'domain', 'strategy')$$),
  '23514: %"teams_division_type"%', 'only a division has a division type');
select lives_ok(
  $$insert into teams (name, code) values ('TT code 1', 'ZZ'), ('TT code 2', 'ZZ.1'), ('TT code 3', '12345678.ABCDEFGH')$$,
  'codes like ZZ, ZZ.1 and 12345678.ABCDEFGH are accepted'
);
select alike(pg_temp.error_of(format('insert into teams (name, code) values (%L, %L)', 'x', c)),
  '23514: %"teams_code_format"%', format('the code %L is refused', c))
  from unnest(array['ip.x', 'IP..1', 'IP.123456789', 'ABCDEFGHI', 'IP.X.1', '', 'IP.', 'I P']) c;
select alike(pg_temp.error_of($$insert into teams (name, code) values ('x', 'IP.X')$$),
  '23505: %', 'codes are unique (IP.X is taken)');
select lives_ok($$insert into teams (name, sort_order) values ('TT sort 0', 0), ('TT sort 10000', 10000)$$,
  'sort_order 0 and 10000 are accepted');
select alike(pg_temp.error_of(format('insert into teams (name, sort_order) values (%L, %s)', 'x', s)),
  '23514: %"teams_sort_order_range"%', format('sort_order %s is refused', s))
  from unnest(array[-1, 10001]) s;
select lives_ok($$insert into teams (name, note) values ('TT note 500', repeat('n', 500))$$, 'a 500-character note is accepted');
select alike(pg_temp.error_of($$insert into teams (name, note) values ('x', repeat('n', 501))$$),
  '23514: %"teams_note_length"%', 'a 501-character note is refused');
select alike(
  pg_temp.error_of($$insert into teams (id, name, parent_id) values ('b1000000-0000-4000-8000-0000000000ff', 'x', 'b1000000-0000-4000-8000-0000000000ff')$$),
  '23514: %"teams_not_own_parent"%', 'a node cannot be its own parent');
select alike(
  pg_temp.error_of($$insert into teams (name, kind, parent_id) values ('x', 'division', 'b1000000-0000-4000-8000-000000000001')$$),
  '23514: %"teams_division_at_top"%', 'a division has no parent');
select alike(pg_temp.error_of($$insert into teams (name, kind) values ('x', 'team')$$),
  '23514: %"teams_team_has_parent"%', 'a team has a parent');
select is(
  (select kind || ',' || (parent_id is null) from teams where name = 'TT code 1'),
  'domain,true', 'insert into teams (name) still works: it makes an unplaced domain'
);
reset role;

-- ---------- a plain member: their team and what's above it ----------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(
  (select array_agg(name order by name) from teams where id::text like 'b1000000-%'),
  array['TT Division 1', 'TT Domain 1', 'TT Team 1.1'], 'm11 sees their team, its domain and its division, nothing else'
);
select is(
  (select array_agg(x order by x) from unnest(app_visible_team_ids()) x),
  array['b1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000011', 'b1000000-0000-4000-8000-000000000021']::uuid[],
  'app_visible_team_ids() is m11''s team plus its ancestors'
);
select is(app_led_team_ids(), '{}'::uuid[], 'a plain member leads nothing (an empty array, not null)');
select is(pg_temp.n($$select 1 from checkins where id::text like 'd1000000-%'$$), 1, 'm11 sees only their own check-in');
select is(
  (select array_agg(name order by name) from members where id::text like 'c1000000-%'),
  array['m11', 'm11b'], 'm11 sees themselves and their current teammate (not mover, who left)'
);
select is(pg_temp.n('select 1 from team_leads where team_id::text like ''b1000000-%'''), 1, 'm11 sees who leads their team');
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select is(pg_temp.n('select 1 from team_leads where team_id::text like ''b1000000-%'''), 0, 'm12 sees no lead rows (nobody leads their team)');
select is(
  pg_temp.changed($$update teams set parent_id = 'b1000000-0000-4000-8000-000000000012' where id = 'b1000000-0000-4000-8000-000000000022'$$),
  0, 'm12 cannot move their team'
);
select throws_ok(
  $$insert into teams (name, kind, parent_id) values ('mine', 'team', 'b1000000-0000-4000-8000-000000000011')$$,
  '42501', null, 'm12 cannot add a team, even a valid one (permission denied, not a structure error)'
);
select throws_ok(
  $$insert into teams (name, kind, parent_id) values ('mine', 'team', 'b1000000-0000-4000-8000-000000000001')$$,
  '42501', null, 'm12 gets permission denied for an invalid placement too (no hint about the tree)'
);

-- ---------- signed in, but not a member ----------
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000005", "role": "authenticated"}';
select is(pg_temp.n('select 1 from teams'), 0, 'an outsider sees no teams');
select is(pg_temp.n('select 1 from members'), 0, 'an outsider sees no members');
select is(pg_temp.n('select 1 from checkins'), 0, 'an outsider sees no check-ins');
select is(pg_temp.n('select 1 from team_leads'), 0, 'an outsider sees no lead rows');
select is(app_visible_team_ids(), '{}'::uuid[], 'an outsider has no visible teams (an empty array, not null)');
select is(app_led_team_ids(), '{}'::uuid[], 'an outsider leads nothing');

-- ---------- a leader with team_leads rows ----------
-- lead sits in TT Team 2.1 and leads TT Team 1.1 (a sub-team) and TT Domain 3 (a domain).
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select is(
  (select array_agg(x order by x) from unnest(app_led_team_ids()) x),
  array['b1000000-0000-4000-8000-000000000013', 'b1000000-0000-4000-8000-000000000021', 'b1000000-0000-4000-8000-000000000023',
        'b1000000-0000-4000-8000-000000000024', 'b1000000-0000-4000-8000-000000000025']::uuid[],
  'lead leads their own team, their two team_leads nodes, and the led domain''s sub-teams (archived ones too)'
);
select is(pg_temp.n($$select 1 from checkins where id = 'd1000000-0000-4000-8000-000000000003'$$), 1,
  'lead sees check-ins made in a team they lead through team_leads');
select is(pg_temp.n($$select 1 from checkins where id = 'd1000000-0000-4000-8000-000000000007'$$), 1,
  'lead sees check-ins made in a domain they lead');
select is(pg_temp.n($$select 1 from checkins where id = 'd1000000-0000-4000-8000-000000000008'$$), 1,
  'lead still sees check-ins made in their own team');
select is(pg_temp.n($$select 1 from checkins where id = 'd1000000-0000-4000-8000-000000000009'$$), 1,
  'lead sees mover''s check-in made in the led team, after mover left it');
select is(pg_temp.n($$select 1 from checkins where id = 'd1000000-0000-4000-8000-000000000006'$$), 1,
  'lead sees check-ins made in a sub-team of a domain they lead');
select is(pg_temp.n($$select 1 from checkins where id = 'd1000000-0000-4000-8000-000000000010'$$), 1,
  'lead sees check-ins made in an archived sub-team of a domain they lead');
select is(pg_temp.n($$select 1 from checkins where id = 'd1000000-0000-4000-8000-000000000004'$$), 0,
  'lead does not see a sibling team''s check-ins (leading a sub-team covers only that team)');
select is(pg_temp.n($$select 1 from checkins where id = 'd1000000-0000-4000-8000-000000000005'$$), 0,
  'lead does not see check-ins made in the led team''s parent domain');
select is(pg_temp.n($$select 1 from checkins where id = 'd1000000-0000-4000-8000-000000000011'$$), 0,
  'lead does not see check-ins made in a team under a domain they don''t lead');
select is(
  (select array_agg(name order by name) from members where id::text like 'c1000000-%'),
  array['lead', 'm11', 'm11b', 'm21', 'm31', 'm32', 'mdm3', 'mover'],
  'lead sees themselves, the people in what they lead (sub-teams included), and m32 and mover (who checked in there)'
);
select is(
  (select array_agg(name order by name) from teams where id::text like 'b1000000-%'),
  array['TT Division 1', 'TT Division 2', 'TT Domain 1', 'TT Domain 2', 'TT Domain 3', 'TT Team 1.1', 'TT Team 2.1',
        'TT Team 3.1', 'TT Team 3.2'],
  'lead sees what they lead (the led domain''s sub-teams too) and every node above it, not the sibling team'
);
select is(pg_temp.n('select 1 from team_leads where team_id::text like ''b1000000-%'''), 2, 'lead sees their own lead rows');
select throws_ok(
  $$insert into team_leads (team_id, member_id) values ('b1000000-0000-4000-8000-000000000022', 'c1000000-0000-4000-8000-000000000011')$$,
  '42501', null, 'a leader without the admin grant cannot add leads'
);
select is(
  pg_temp.changed($$delete from team_leads where member_id = 'c1000000-0000-4000-8000-000000000002'$$),
  0, 'a leader without the admin grant cannot remove leads, even their own'
);
select throws_ok(
  $$select admin_move_team('b1000000-0000-4000-8000-000000000022', 'b1000000-0000-4000-8000-000000000012', 0)$$,
  '42501', null, 'a leader without the admin grant cannot move teams'
);

-- A sub-team moved under the led domain after the lead was added: its history comes with it.
-- Moved out again, it goes. (The server moves it here; lead only reads.)
reset role;
set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
update teams set parent_id = 'b1000000-0000-4000-8000-000000000013' where id = 'b1000000-0000-4000-8000-000000000026';
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from checkins where id = 'd1000000-0000-4000-8000-000000000011'$$), 1,
  'lead sees check-ins made in a sub-team moved under the domain they lead');
select is(pg_temp.n($$select 1 from members where id = 'c1000000-0000-4000-8000-000000000016'$$), 1,
  'and the people in it');
select is(pg_temp.n($$select 1 from teams where id = 'b1000000-0000-4000-8000-000000000026'$$), 1,
  'and the sub-team itself');
reset role;
set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
update teams set parent_id = 'b1000000-0000-4000-8000-000000000014' where id = 'b1000000-0000-4000-8000-000000000026';
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from checkins where id = 'd1000000-0000-4000-8000-000000000011'$$), 0,
  'once that sub-team is moved out, lead no longer sees its check-ins');
select is(pg_temp.n($$select 1 from members where id = 'c1000000-0000-4000-8000-000000000016'$$), 0,
  'nor the people in it');
select is(pg_temp.n($$select 1 from teams where id = 'b1000000-0000-4000-8000-000000000026'$$), 0,
  'nor the sub-team');

-- ---------- a leader whose own team is a domain ----------
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000007", "role": "authenticated"}';
select is(
  (select array_agg(x order by x) from unnest(app_led_team_ids()) x),
  array['b1000000-0000-4000-8000-000000000011', 'b1000000-0000-4000-8000-000000000021', 'b1000000-0000-4000-8000-000000000022']::uuid[],
  'dlead leads their own domain and its teams'
);
select is(
  (select array_agg(id::text order by id) from checkins where id::text like 'd1000000-%'),
  array['d1000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000004',
        'd1000000-0000-4000-8000-000000000005', 'd1000000-0000-4000-8000-000000000009'],
  'dlead sees the check-ins made in their domain and in its teams (mdm1, m11, m12, mover), nothing else'
);
select is(
  (select array_agg(name order by name) from members where id::text like 'c1000000-%'),
  array['dlead', 'm11', 'm11b', 'm12', 'mdm1', 'mover'],
  'dlead sees the people in their domain and in its teams'
);
select is(
  (select array_agg(name order by name) from teams where id::text like 'b1000000-%'),
  array['TT Division 1', 'TT Domain 1', 'TT Team 1.1', 'TT Team 1.2'],
  'dlead sees their domain, its teams and its division'
);

-- ---------- hq ----------
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000006", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from teams where id::text like 'b1000000-%'$$), 21, 'hq sees every team');
select is(pg_temp.n($$select 1 from checkins where id::text like 'd1000000-%'$$), 9, 'hq sees every check-in');
select is(pg_temp.n($$select 1 from team_leads where member_id::text like 'c1000000-%'$$), 2, 'hq sees every lead row');
select throws_ok(
  $$select admin_move_team('b1000000-0000-4000-8000-000000000022', 'b1000000-0000-4000-8000-000000000012', 0)$$,
  '42501', null, 'hq without the admin grant cannot move teams'
);

-- ---------- anon ----------
reset role;
set local role anon;
set local request.jwt.claims to '{"role": "anon"}';
select throws_ok('select * from team_leads', '42501', null, 'anon cannot read team_leads');
select throws_ok(
  $$insert into team_leads (team_id, member_id) values ('b1000000-0000-4000-8000-000000000022', 'c1000000-0000-4000-8000-000000000011')$$,
  '42501', null, 'anon cannot add leads'
);
select throws_ok('delete from team_leads', '42501', null, 'anon cannot remove leads');
select throws_ok(
  $$select admin_move_team('b1000000-0000-4000-8000-000000000022', 'b1000000-0000-4000-8000-000000000012', 0)$$,
  '42501', null, 'anon cannot call admin_move_team'
);
select throws_ok('select app_visible_team_ids()', '42501', null, 'anon cannot call app_visible_team_ids');
select is(has_function_privilege('anon', 'public.admin_move_team(uuid, uuid, integer)', 'execute'), false,
  'anon has no execute privilege on admin_move_team');

-- ---------- admin: tree rule 1, where a node may sit ----------
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from teams where id::text like 'b1000000-%'$$), 21, 'admin sees every team');
select is(pg_temp.n($$select 1 from team_leads where member_id::text like 'c1000000-%'$$), 2, 'admin sees every lead row');
select lives_ok(
  $$insert into teams (name, kind, division_type) values ('TT New division', 'division', 'strategy')$$,
  'admin can add a division at the top level'
);
select lives_ok(
  $$insert into teams (name, kind, parent_id, domain_type) values ('TT New domain', 'domain', pg_temp.team('TT New division'), 'ip')$$,
  'admin can add a domain under a division'
);
select lives_ok(
  $$insert into teams (name, kind, parent_id, code) values ('TT New team', 'team', pg_temp.team('TT New domain'), 'TT.1')$$,
  'admin can add a team under a domain'
);
select lives_ok(
  $$insert into teams (name) values ('TT New unplaced')$$,
  'admin can add an unplaced domain the 0001 way (name only)'
);
select alike(
  pg_temp.error_of($$insert into teams (name, kind, parent_id) values ('x', 'domain', 'b1000000-0000-4000-8000-000000000011')$$),
  '23514: A domain can only sit under a division%', 'a domain cannot sit under a domain'
);
select alike(
  pg_temp.error_of($$insert into teams (name, kind, parent_id) values ('x', 'team', 'b1000000-0000-4000-8000-000000000001')$$),
  '23514: A team can only sit under a domain.', 'a team cannot sit under a division'
);
select alike(
  pg_temp.error_of($$insert into teams (name, kind, parent_id) values ('x', 'team', 'b1000000-0000-4000-8000-000000000021')$$),
  '23514: A team can only sit under a domain.', 'a team cannot sit under a team'
);
select alike(
  pg_temp.error_of($$insert into teams (name, kind, parent_id) values ('x', 'domain', 'b1000000-0000-4000-8000-000000000021')$$),
  '23514: A domain can only sit under a division%', 'nothing can sit under a team'
);
select alike(
  pg_temp.error_of($$update teams set parent_id = 'b1000000-0000-4000-8000-000000000021' where id = 'b1000000-0000-4000-8000-000000000011'$$),
  '23514: A domain can only sit under a division%', 'a cycle is refused: a domain cannot move under its own team'
);
select alike(
  pg_temp.error_of($$update teams set parent_id = 'b1000000-0000-4000-8000-000000000011' where id = 'b1000000-0000-4000-8000-000000000001'$$),
  '23514: %"teams_division_at_top"%', 'a cycle is refused: a division cannot move under its own domain'
);
select alike(
  pg_temp.error_of($$update teams set parent_id = id where id = 'b1000000-0000-4000-8000-000000000011'$$),
  '23514: %"teams_not_own_parent"%', 'a node cannot move under itself'
);
select alike(
  pg_temp.error_of($$update teams set parent_id = null where id = 'b1000000-0000-4000-8000-000000000022'$$),
  '23514: %"teams_team_has_parent"%', 'a team cannot move to the top level'
);
select is(
  pg_temp.changed($$update teams set parent_id = null where id = pg_temp.team('TT New domain')$$),
  1, 'admin can unplace a domain (move it to the top level)'
);
select is(
  pg_temp.changed($$update teams set parent_id = 'b1000000-0000-4000-8000-000000000012' where id = pg_temp.team('TT New team')$$),
  1, 'admin can move a team to another domain'
);
select is(
  pg_temp.changed($$update teams set parent_id = pg_temp.team('TT New division') where id = pg_temp.team('TT New domain')$$),
  1, 'admin can place an unplaced domain under a division'
);
-- Changing kind in place (same parent) is checked against the parent too.
select lives_ok(
  $$insert into teams (name, kind, parent_id) values ('TT Childless domain', 'domain', 'b1000000-0000-4000-8000-000000000003')$$,
  'admin adds a domain with nothing under it'
);
select alike(
  pg_temp.error_of($$update teams set kind = 'team' where id = pg_temp.team('TT Childless domain')$$),
  '23514: A team can only sit under a domain.', 'a domain under a division cannot become a team in place'
);
select alike(
  pg_temp.error_of($$update teams set kind = 'domain' where id = 'b1000000-0000-4000-8000-000000000022'$$),
  '23514: A domain can only sit under a division%', 'a team cannot become a domain in place (it would sit under a domain)'
);

-- ---------- admin: tree rule 2, nothing active under an archived node ----------
-- (Admins can't insert an archived node: archived_at is update-only, as in 0002.)
select lives_ok(
  $$insert into teams (name, kind, parent_id) values ('TT Archived domain', 'domain', pg_temp.team('TT New division'))$$,
  'admin adds a domain to archive'
);
select lives_ok(
  $$insert into teams (name, kind, parent_id) values ('TT Archived team', 'team', pg_temp.team('TT Archived domain'))$$,
  'and a team under it'
);
select is(
  pg_temp.changed($$update teams set archived_at = now() where id = pg_temp.team('TT Archived team')$$),
  1, 'admin archives the team'
);
select is(
  pg_temp.changed($$update teams set archived_at = now() where id = pg_temp.team('TT Archived domain')$$),
  1, 'then the domain'
);
select alike(
  pg_temp.error_of($$insert into teams (name, kind, parent_id) values ('x', 'team', pg_temp.team('TT Archived domain'))$$),
  '23514: Restore the parent first: it is archived.', 'an active team cannot be added under an archived domain'
);
select alike(
  pg_temp.error_of($$update teams set parent_id = pg_temp.team('TT Archived domain') where id = pg_temp.team('TT New team')$$),
  '23514: Restore the parent first: it is archived.', 'an active team cannot be moved under an archived domain'
);
select is(
  pg_temp.changed($$update teams set parent_id = 'b1000000-0000-4000-8000-000000000035' where id = pg_temp.team('TT Archived team')$$),
  1, 'an archived team can move under another archived domain'
);
select alike(
  pg_temp.error_of($$update teams set archived_at = null where id = pg_temp.team('TT Archived team')$$),
  '23514: Restore the parent first: it is archived.', 'a team cannot be restored while its domain is archived'
);
select is(
  pg_temp.changed($$update teams set parent_id = pg_temp.team('TT Archived domain') where id = pg_temp.team('TT Archived team')$$),
  1, 'admin moves the archived team back'
);
select is(
  pg_temp.changed($$update teams set archived_at = null where id = pg_temp.team('TT Archived domain')$$),
  1, 'admin can restore the domain'
);
select is(
  pg_temp.changed($$update teams set archived_at = null where id = pg_temp.team('TT Archived team')$$),
  1, 'then the team under it'
);

-- ---------- admin: tree rule 3, changing kind ----------
select alike(
  pg_temp.error_of($$update teams set kind = 'division', parent_id = null where id = 'b1000000-0000-4000-8000-000000000011'$$),
  '23514: A division can only hold domains. Move its 2 teams out first.', 'a domain with teams cannot become a division'
);
select alike(
  pg_temp.error_of($$update teams set kind = 'team', parent_id = 'b1000000-0000-4000-8000-000000000012' where id = 'b1000000-0000-4000-8000-000000000011'$$),
  '23514: Nothing can sit under a team. Move its 2 teams out first.', 'a domain with teams cannot become a team'
);
select alike(
  pg_temp.error_of($$update teams set kind = 'domain' where id = 'b1000000-0000-4000-8000-000000000002'$$),
  '23514: A domain can only hold teams. Move its 1 domain out first.', 'a division with domains cannot become a domain'
);
select lives_ok($$insert into teams (name) values ('TT Kind domain')$$, 'admin adds an unplaced domain');
select lives_ok(
  $$insert into teams (name, kind, parent_id) values ('TT Kind team', 'team', pg_temp.team('TT Kind domain'))$$,
  'and a team under it'
);
select is(
  pg_temp.changed($$update teams set archived_at = now() where id = pg_temp.team('TT Kind team')$$),
  1, 'admin archives the team'
);
select alike(
  pg_temp.error_of($$update teams set kind = 'division' where id = pg_temp.team('TT Kind domain')$$),
  '23514: A division can only hold domains. Move its 1 team out first.',
  'an archived team still stops its domain becoming a division (it could be restored)'
);
select is(
  pg_temp.changed($$update members set team_id = pg_temp.team('TT New unplaced') where id = 'c1000000-0000-4000-8000-000000000012'$$),
  1, 'admin places plain in an unplaced domain'
);
select lives_ok(
  $$insert into teams (name) values ('TT Led unplaced'), ('TT Empty unplaced')$$,
  'admin adds two more unplaced domains'
);
select lives_ok(
  $$insert into team_leads (team_id, member_id) values (pg_temp.team('TT Led unplaced'), 'c1000000-0000-4000-8000-000000000011')$$,
  'admin makes lead2 a lead of one of them'
);
select lives_ok($$insert into teams (name) values ('TT History unplaced')$$, 'admin adds another unplaced domain');
select lives_ok(
  $$insert into members (name, team_id) values ('TT historian', pg_temp.team('TT History unplaced'))$$,
  'and someone in it'
);
reset role;
set local role service_role;
insert into checkins (id, member_id, week_start)
  select 'd1000000-0000-4000-8000-000000000013', id, '2026-10-05' from members where name = 'TT historian';
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  pg_temp.changed($$update members set team_id = null where name = 'TT historian'$$),
  1, 'who checks in there, then leaves'
);
select is(
  pg_temp.changed($$update teams set kind = 'division' where id = pg_temp.team('TT Empty unplaced')$$),
  1, 'an empty unplaced domain can become a division'
);
select is(
  pg_temp.changed($$update teams set kind = 'domain' where id = pg_temp.team('TT Empty unplaced')$$),
  1, 'and an empty division can become a domain again'
);
select is(
  pg_temp.changed($$update teams set kind = 'team', parent_id = 'b1000000-0000-4000-8000-000000000012' where id = pg_temp.team('TT Empty unplaced')$$),
  1, 'an empty domain can become a team under a domain'
);

-- ---------- admin: tree rule 4, archiving ----------
select alike(
  pg_temp.error_of($$update teams set archived_at = now() where id = 'b1000000-0000-4000-8000-000000000011'$$),
  '23514: Archive or move the 2 active teams under it first.', 'a domain with active teams cannot be archived'
);
select alike(
  pg_temp.error_of($$update teams set archived_at = now() where id = 'b1000000-0000-4000-8000-000000000001'$$),
  '23514: Archive or move the 2 active domains under it first.', 'a division with active domains cannot be archived'
);
select alike(
  pg_temp.error_of($$update teams set archived_at = now() where id = 'b1000000-0000-4000-8000-000000000021'$$),
  '23514: Move its 2 members out first.', 'a team with members cannot be archived'
);
select lives_ok(
  $$insert into teams (name, kind, parent_id) values ('TT Closing domain', 'domain', pg_temp.team('TT New division'))$$,
  'admin adds a domain to close down'
);
select lives_ok(
  $$insert into teams (name, kind, parent_id) values ('TT Closing team', 'team', pg_temp.team('TT Closing domain'))$$,
  'and a team under it'
);
select is(
  pg_temp.changed($$update members set team_id = pg_temp.team('TT Closing team') where id = 'c1000000-0000-4000-8000-000000000014'$$),
  1, 'admin places plain2 in the closing team'
);
select lives_ok(
  $$insert into team_leads (team_id, member_id) values (pg_temp.team('TT Closing team'), 'c1000000-0000-4000-8000-000000000002')$$,
  'admin makes lead a lead of the closing team'
);
reset role;
set local role service_role;
insert into checkins (id, member_id, week_start) values
  ('d1000000-0000-4000-8000-000000000014', 'c1000000-0000-4000-8000-000000000014', '2026-10-05');
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select alike(
  pg_temp.error_of($$update teams set archived_at = now() where id = pg_temp.team('TT Closing domain')$$),
  '23514: Archive or move the 1 active team under it first.', 'the closing domain cannot be archived while its team is active'
);
select alike(
  pg_temp.error_of($$update teams set archived_at = now() where id = pg_temp.team('TT Closing team')$$),
  '23514: Move its 1 member out first.', 'the closing team cannot be archived while plain2 is in it'
);
select is(
  pg_temp.changed($$update members set team_id = null where id = 'c1000000-0000-4000-8000-000000000014'$$),
  1, 'admin moves plain2 out (team_id = null)'
);
select is(
  pg_temp.changed($$update teams set archived_at = now() where id = pg_temp.team('TT Closing team')$$),
  1, 'then the closing team can be archived'
);
select is(
  pg_temp.changed($$update teams set archived_at = now() where id = pg_temp.team('TT Closing domain')$$),
  1, 'then the closing domain'
);
select is(
  pg_temp.n($$select 1 from team_leads where team_id = pg_temp.team('TT Closing team')$$),
  1, 'archiving a team keeps its lead rows'
);
select lives_ok(
  $$insert into teams (name, kind, parent_id) values
     ('TT Subtree domain', 'domain', pg_temp.team('TT New division'))$$,
  'admin adds another domain'
);
select lives_ok(
  $$insert into teams (name, kind, parent_id) values
     ('TT Subtree team', 'team', pg_temp.team('TT Subtree domain'))$$,
  'and a team under it'
);
select is(
  pg_temp.changed($$update teams set archived_at = now() where id in (pg_temp.team('TT Subtree domain'), pg_temp.team('TT Subtree team'))$$),
  2, 'a domain and its teams can be archived in one statement'
);
select is(
  pg_temp.changed($$update teams set archived_at = null where id in (pg_temp.team('TT Subtree domain'), pg_temp.team('TT Subtree team'))$$),
  2, 'and restored in one statement'
);

-- The leader of an archived team still sees its history.
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from checkins where id = 'd1000000-0000-4000-8000-000000000014'$$), 1,
  'lead still sees check-ins made in an archived team they led');
select is(pg_temp.n($$select 1 from teams where name = 'TT Closing team'$$), 1,
  'and the archived team itself');
select is(pg_temp.n($$select 1 from members where id = 'c1000000-0000-4000-8000-000000000014'$$), 1,
  'and who made those check-ins, after they left');

-- ---------- admin: who can be placed where ----------
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select alike(
  pg_temp.error_of($$update members set team_id = pg_temp.team('TT Closing team') where id = 'c1000000-0000-4000-8000-000000000014'$$),
  '23514: That team is archived. Restore it first, or pick another.', 'nobody can be moved into an archived team'
);
select alike(
  pg_temp.error_of($$insert into members (name, team_id) values ('x', 'b1000000-0000-4000-8000-000000000035')$$),
  '23514: That domain is archived. Restore it first, or pick another.', 'nobody can be added to an archived domain'
);
select is(
  pg_temp.changed($$update members set team_id = 'b1000000-0000-4000-8000-000000000013' where id = 'c1000000-0000-4000-8000-000000000014'$$),
  1, 'admin can place someone in a domain'
);
select lives_ok(
  $$insert into members (name, team_id) values ('newcomer', 'b1000000-0000-4000-8000-000000000024')$$,
  'admin can add someone to a team'
);
select is(
  pg_temp.changed($$update members set team_id = null where id = 'c1000000-0000-4000-8000-000000000014'$$),
  1, 'admin can take someone out of their team'
);
-- A member who sits in an archived team from before these rules (simulated by switching the tree
-- trigger off) can still be renamed.
reset role;
alter table teams disable trigger teams_check_tree;
update teams set archived_at = now() where id = 'b1000000-0000-4000-8000-000000000024';
alter table teams enable trigger teams_check_tree;
set local role authenticated;
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  pg_temp.changed($$update members set name = 'm31 renamed' where id = 'c1000000-0000-4000-8000-000000000006'$$),
  1, 'a member whose (archived) team is unchanged can be renamed'
);
select is(
  pg_temp.changed($$update members set name = 'm31 again', team_id = 'b1000000-0000-4000-8000-000000000024' where id = 'c1000000-0000-4000-8000-000000000006'$$),
  1, 'even when the update repeats the unchanged team_id'
);
select alike(
  pg_temp.error_of($$update members set team_id = 'b1000000-0000-4000-8000-000000000024' where id = 'c1000000-0000-4000-8000-000000000014'$$),
  '23514: That team is archived.%', 'but nobody new can be moved into that team'
);

-- ---------- who gave a login: only the server writes it ----------
select throws_ok(
  $$update members set login_given_by = 'c1000000-0000-4000-8000-000000000001' where id = 'c1000000-0000-4000-8000-000000000013'$$,
  '42501', null, 'an admin cannot set login_given_by'
);
select throws_ok(
  $$update members set login_given_at = now() where id = 'c1000000-0000-4000-8000-000000000013'$$,
  '42501', null, 'an admin cannot set login_given_at'
);
select throws_ok(
  $$insert into members (name, login_given_by, login_given_at) values ('x', 'c1000000-0000-4000-8000-000000000001', now())$$,
  '42501', null, 'an admin cannot add a member with a login giver'
);
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select throws_ok(
  $$update members set login_given_by = null, login_given_at = null where id = 'c1000000-0000-4000-8000-000000000003'$$,
  '42501', null, 'a member cannot write who gave their own login'
);
reset role;
set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
select is(
  pg_temp.changed($$update members set login_given_by = 'c1000000-0000-4000-8000-000000000001', login_given_at = now() where id = 'c1000000-0000-4000-8000-000000000013'$$),
  1, 'the server records who gave a login, and when'
);
select alike(
  pg_temp.error_of($$update members set login_given_at = null where id = 'c1000000-0000-4000-8000-000000000013'$$),
  '23514: %"members_login_given_pair"%', 'a login giver needs a time'
);
select alike(
  pg_temp.error_of($$insert into members (name, login_given_by) values ('x', 'c1000000-0000-4000-8000-000000000001')$$),
  '23514: %"members_login_given_pair"%', 'a login giver needs a time, on insert too'
);
select alike(
  pg_temp.error_of($$update members set login_given_by = id, login_given_at = now() where id = 'c1000000-0000-4000-8000-000000000003'$$),
  '23514: %"members_login_given_not_self"%', 'nobody gives their own login'
);
insert into members (id, name) values ('c1000000-0000-4000-8000-000000000019', 'TT giver');
update members set login_given_by = 'c1000000-0000-4000-8000-000000000019', login_given_at = '2026-10-01 09:00+08'
  where id = 'c1000000-0000-4000-8000-000000000012';
select lives_ok($$delete from members where id = 'c1000000-0000-4000-8000-000000000019'$$,
  'the member who gave a login can still be deleted');
select is(
  (select coalesce(login_given_by::text, 'none') || ' at ' || login_given_at from members where id = 'c1000000-0000-4000-8000-000000000012'),
  'none at ' || '2026-10-01 09:00+08'::timestamptz,
  'deleting the giver clears login_given_by and keeps when the login was given'
);
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(
  (select login_given_by from members where id = 'c1000000-0000-4000-8000-000000000013'),
  'c1000000-0000-4000-8000-000000000001'::uuid, 'teammates can read who gave a login'
);
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000001", "role": "authenticated"}';

-- ---------- admin: team leads ----------
select lives_ok(
  $$insert into team_leads (team_id, member_id) values ('b1000000-0000-4000-8000-000000000022', 'c1000000-0000-4000-8000-000000000011')$$,
  'admin can make a leader a lead of another team'
);
select alike(
  pg_temp.error_of($$insert into team_leads (team_id, member_id) values ('b1000000-0000-4000-8000-000000000022', 'c1000000-0000-4000-8000-000000000012')$$),
  '23514: Only members with the leader role can lead a team.%', 'a plain member cannot be made a lead'
);
select alike(
  pg_temp.error_of($$insert into team_leads (team_id, member_id) values ('b1000000-0000-4000-8000-000000000022', 'c1000000-0000-4000-8000-000000000010')$$),
  '23514: Only members with the leader role can lead a team.%', 'an hq member cannot be made a lead'
);
select throws_ok(
  $$insert into team_leads (team_id, member_id) values ('b1000000-0000-4000-8000-000000000022', 'c1000000-0000-4000-8000-000000000001')$$,
  '42501', null, 'admin cannot make themselves a lead (they are a leader, so only RLS stops it)'
);
select alike(
  pg_temp.error_of($$insert into team_leads (team_id, member_id) values ('b1000000-0000-4000-8000-000000000035', 'c1000000-0000-4000-8000-000000000011')$$),
  '23514: That domain is archived. Restore it first.', 'nobody can be made a lead of an archived domain'
);
select throws_ok(
  $$update team_leads set team_id = 'b1000000-0000-4000-8000-000000000021' where member_id = 'c1000000-0000-4000-8000-000000000011'$$,
  '42501', null, 'admin cannot edit a lead row in place (remove and add instead)'
);
reset role;
set local role service_role;
select alike(
  pg_temp.error_of($$update team_leads set member_id = 'c1000000-0000-4000-8000-000000000012' where team_id = 'b1000000-0000-4000-8000-000000000022' and member_id = 'c1000000-0000-4000-8000-000000000011'$$),
  '23514: Only members with the leader role%', 'nor at someone who is not a leader'
);
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  pg_temp.changed($$delete from team_leads where team_id = 'b1000000-0000-4000-8000-000000000022' and member_id = 'c1000000-0000-4000-8000-000000000011'$$),
  1, 'admin can remove a lead'
);

-- ---------- admin: demoting a leader ends their leads ----------
select lives_ok(
  $$insert into team_leads (team_id, member_id) values ('b1000000-0000-4000-8000-000000000023', 'c1000000-0000-4000-8000-000000000011')$$,
  'admin makes lead2 a lead of lead''s own team'
);
select is(
  pg_temp.changed($$update members set role = 'member' where id = 'c1000000-0000-4000-8000-000000000002'$$),
  1, 'admin demotes lead to member'
);
select is(pg_temp.n($$select 1 from team_leads where member_id = 'c1000000-0000-4000-8000-000000000002'$$), 0,
  'demoting a leader deletes their lead rows');
select is(pg_temp.n($$select 1 from team_leads where member_id = 'c1000000-0000-4000-8000-000000000011'$$), 2,
  'other leaders keep theirs');
select is(
  pg_temp.n($$select 1 from team_leads where member_id = 'c1000000-0000-4000-8000-000000000011' and team_id = 'b1000000-0000-4000-8000-000000000023'$$),
  1, 'including a lead row on the demoted leader''s own team'
);
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select is(app_led_team_ids(), '{}'::uuid[], 'a demoted leader leads nothing');
select is(pg_temp.n($$select 1 from checkins where id::text like 'd1000000-%'$$), 0,
  'after demotion, lead sees none of the check-ins they saw as a leader');
select is(
  (select array_agg(name order by name) from members where id::text like 'c1000000-%'),
  array['lead', 'm21'], 'after demotion, lead sees only themselves and their teammate'
);
select is(
  (select array_agg(name order by name) from teams where id::text like 'b1000000-%'),
  array['TT Division 1', 'TT Domain 2', 'TT Team 2.1'], 'after demotion, lead sees only their own team and what''s above it'
);
reset role;
set local role service_role;
select is(
  pg_temp.changed($$update members set role = 'hq' where id = 'c1000000-0000-4000-8000-000000000011'$$),
  1, 'the server makes lead2 hq'
);
select is(pg_temp.n($$select 1 from team_leads where member_id = 'c1000000-0000-4000-8000-000000000011'$$), 0,
  'a leader who becomes hq stops leading too');
-- A lead row left behind for someone who isn't a leader (say, from a hand edit with the triggers
-- off) gives them nothing: app_led_team_ids() only counts leaders' rows.
reset role;
alter table team_leads disable trigger team_leads_check;
insert into team_leads (team_id, member_id) values
  ('b1000000-0000-4000-8000-000000000021', 'c1000000-0000-4000-8000-000000000004');
alter table team_leads enable trigger team_leads_check;
set local role authenticated;
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select is(app_led_team_ids(), '{}'::uuid[], 'a member with a stray lead row leads nothing');
select is(pg_temp.n($$select 1 from checkins where id = 'd1000000-0000-4000-8000-000000000003'$$), 0,
  'and sees no check-ins through it');
select is(pg_temp.n($$select 1 from team_leads where member_id = 'c1000000-0000-4000-8000-000000000004'$$), 1,
  'but does see their own lead row, on a team they can''t otherwise see');
reset role;

-- ---------- admin_move_team ----------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(pg_temp.order_of('b1000000-0000-4000-8000-000000000031'), 'TT MA:0, TT MB:1, TT MC:2', 'move division starts as MA, MB, MC');
select lives_ok(
  $$select admin_move_team('b1000000-0000-4000-8000-000000000034', 'b1000000-0000-4000-8000-000000000031', 0)$$,
  'admin moves MC to the front of its division'
);
select is(pg_temp.order_of('b1000000-0000-4000-8000-000000000031'), 'TT MC:0, TT MA:1, TT MB:2', 'its siblings are renumbered 0, 1, 2');
select is((select sort_order from teams where id = 'b1000000-0000-4000-8000-000000000035'), 1, 'the archived sibling keeps its sort_order');
select lives_ok(
  $$select admin_move_team('b1000000-0000-4000-8000-000000000032', 'b1000000-0000-4000-8000-000000000036', 0)$$,
  'admin moves MA to the front of another division'
);
select is(pg_temp.order_of('b1000000-0000-4000-8000-000000000036'), 'TT MA:0, TT NA:1', 'the new parent is renumbered');
select is(pg_temp.order_of('b1000000-0000-4000-8000-000000000031'), 'TT MC:0, TT MB:1', 'the old parent''s gap is closed');
select lives_ok(
  $$select admin_move_team('b1000000-0000-4000-8000-000000000033', 'b1000000-0000-4000-8000-000000000036', 99)$$,
  'admin moves MB past the end of another division'
);
select is(pg_temp.order_of('b1000000-0000-4000-8000-000000000036'), 'TT MA:0, TT NA:1, TT MB:2', 'a position past the end puts it last');
select lives_ok(
  $$select admin_move_team('b1000000-0000-4000-8000-000000000032', 'b1000000-0000-4000-8000-000000000036', 2)$$,
  'admin moves MA down within its division'
);
select is(pg_temp.order_of('b1000000-0000-4000-8000-000000000036'), 'TT NA:0, TT MB:1, TT MA:2', 'moving down within a parent keeps 0, 1, 2');
select lives_ok(
  $$select admin_move_team('b1000000-0000-4000-8000-000000000037', null, 0)$$,
  'admin moves NA to the front of the top level (unplaces it)'
);
select is(pg_temp.order_of('b1000000-0000-4000-8000-000000000036'), 'TT MB:0, TT MA:1', 'its old division closes the gap');
select is(
  (select array_agg(sort_order order by sort_order) from teams where parent_id is null and archived_at is null),
  (select array_agg(g) from generate_series(0, (select count(*)::int - 1 from teams where parent_id is null and archived_at is null)) g),
  'the top level (divisions and unplaced domains together) is renumbered 0, 1, 2, …'
);
select is((select sort_order from teams where id = 'b1000000-0000-4000-8000-000000000037'), 0, 'with NA first');
select alike(
  pg_temp.error_of($$select admin_move_team('b1000000-0000-4000-8000-000000000021', 'b1000000-0000-4000-8000-000000000036', 0)$$),
  '23514: A team can only sit under a domain.', 'an invalid move is refused with the tree rule''s message'
);
select is(
  (select parent_id::text || ':' || sort_order from teams where id = 'b1000000-0000-4000-8000-000000000021'),
  'b1000000-0000-4000-8000-000000000011:0', 'a refused move leaves the node where it was'
);
select is(pg_temp.order_of('b1000000-0000-4000-8000-000000000036'), 'TT MB:0, TT MA:1', 'and leaves the destination as it was');
-- The drops the check constraints would refuse in Postgres's words get a sentence too.
select alike(
  pg_temp.error_of($$select admin_move_team('b1000000-0000-4000-8000-000000000021', null, 0)$$),
  '23514: A team can only sit under a domain.', 'dropping a team at the top level is refused in words'
);
select alike(
  pg_temp.error_of($$select admin_move_team('b1000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000002', 0)$$),
  '23514: A division can only sit at the top level.', 'dropping a division under another is refused in words'
);
select alike(
  pg_temp.error_of($$select admin_move_team('b1000000-0000-4000-8000-000000000011', 'b1000000-0000-4000-8000-000000000011', 0)$$),
  '23514: A domain can''t sit under itself.', 'dropping a node on itself is refused in words'
);
select throws_ok(
  $$select admin_move_team('b1000000-0000-4000-8000-000000000033', 'b1000000-0000-4000-8000-000000000031', -1)$$,
  '22023', null, 'a position of -1 is refused'
);
select throws_ok(
  $$select admin_move_team('b1000000-0000-4000-8000-000000000033', 'b1000000-0000-4000-8000-000000000031', 10001)$$,
  '22023', null, 'a position over 10000 is refused'
);
-- 10000 itself is allowed (it goes last). Undone straight away so the order tests below don't move.
select is(
  pg_temp.error_of($q$do $x$ begin
    perform admin_move_team('b1000000-0000-4000-8000-000000000033', 'b1000000-0000-4000-8000-000000000031', 10000);
    raise exception 'tt: undo';
  end $x$$q$),
  'P0001: tt: undo', 'a position of 10000 is accepted'
);
select throws_ok(
  $$select admin_move_team('b1000000-0000-4000-8000-000000000033', 'b1000000-0000-4000-8000-000000000031', null)$$,
  '22023', null, 'a missing position is refused'
);
select throws_ok(
  $$select admin_move_team('b1000000-0000-4000-8000-0000000000fe', null, 0)$$,
  'P0002', null, 'moving a team that doesn''t exist is refused'
);
-- Archived siblings don't count toward the end position.
select is(pg_temp.order_of('b1000000-0000-4000-8000-000000000031'), 'TT MC:0', 'move division now holds MC (and the archived MZ)');
select lives_ok(
  $$select admin_move_team('b1000000-0000-4000-8000-000000000033', 'b1000000-0000-4000-8000-000000000031', 99)$$,
  'admin moves MB past the end of move division'
);
select is(pg_temp.order_of('b1000000-0000-4000-8000-000000000031'), 'TT MC:0, TT MB:1', 'MB goes right after MC: the archived MZ leaves no gap');
-- An archived node that is moved goes after the active ones, which stay 0..n-1.
select lives_ok(
  $$select admin_move_team('b1000000-0000-4000-8000-000000000035', 'b1000000-0000-4000-8000-000000000036', 0)$$,
  'admin moves the archived MZ to the front of division N'
);
select is(pg_temp.order_of('b1000000-0000-4000-8000-000000000036'), 'TT MA:0', 'division N''s active domains keep 0..n-1');
select is((select sort_order from teams where id = 'b1000000-0000-4000-8000-000000000035'), 1,
  'and the archived MZ goes after them');
-- Siblings with the same sort_order are numbered by name, then id (the ids here run the other way).
reset role;
set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
insert into teams (id, name, kind, sort_order) values
  ('b1000000-0000-4000-8000-000000000041', 'TT Tie dest', 'division', 0),
  ('b1000000-0000-4000-8000-000000000044', 'TT Tie src',  'division', 0);
insert into teams (id, name, kind, parent_id, sort_order) values
  ('b1000000-0000-4000-8000-000000000043', 'TT Tie A', 'domain', 'b1000000-0000-4000-8000-000000000041', 0),
  ('b1000000-0000-4000-8000-000000000042', 'TT Tie B', 'domain', 'b1000000-0000-4000-8000-000000000041', 0),
  ('b1000000-0000-4000-8000-000000000046', 'TT Tie D', 'domain', 'b1000000-0000-4000-8000-000000000044', 0),
  ('b1000000-0000-4000-8000-000000000045', 'TT Tie E', 'domain', 'b1000000-0000-4000-8000-000000000044', 0),
  ('b1000000-0000-4000-8000-000000000047', 'TT Tie C', 'domain', 'b1000000-0000-4000-8000-000000000044', 0);
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select lives_ok(
  $$select admin_move_team('b1000000-0000-4000-8000-000000000047', 'b1000000-0000-4000-8000-000000000041', 2)$$,
  'admin moves C to the end of a division whose domains tie on sort_order'
);
select is(pg_temp.order_of('b1000000-0000-4000-8000-000000000041'), 'TT Tie A:0, TT Tie B:1, TT Tie C:2',
  'tied siblings at the destination are numbered by name');
select is(pg_temp.order_of('b1000000-0000-4000-8000-000000000044'), 'TT Tie D:0, TT Tie E:1',
  'and so are the ones left at the old parent');
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select throws_ok(
  $$select admin_move_team('b1000000-0000-4000-8000-000000000021', 'b1000000-0000-4000-8000-000000000011', 1)$$,
  '42501', null, 'a member without the admin grant cannot move teams'
);

-- ---------- an admin who leads can't move teams into what they lead ----------
-- The admin is a leader. The server makes them a lead of TT Esc domain; TT Esc team, under another
-- domain, has a check-in the admin can't read.
reset role;
set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
insert into teams (id, name, kind, parent_id) values
  ('b1000000-0000-4000-8000-000000000051', 'TT Esc domain', 'domain', 'b1000000-0000-4000-8000-000000000003'),
  ('b1000000-0000-4000-8000-000000000052', 'TT Esc other',  'domain', 'b1000000-0000-4000-8000-000000000003');
insert into teams (id, name, kind, parent_id) values
  ('b1000000-0000-4000-8000-000000000053', 'TT Esc team',  'team', 'b1000000-0000-4000-8000-000000000052'),
  ('b1000000-0000-4000-8000-000000000054', 'TT Esc inner', 'team', 'b1000000-0000-4000-8000-000000000051');
insert into members (id, name, team_id) values ('c1000000-0000-4000-8000-000000000018', 'esc', 'b1000000-0000-4000-8000-000000000053');
insert into checkins (id, member_id, week_start) values
  ('d1000000-0000-4000-8000-000000000012', 'c1000000-0000-4000-8000-000000000018', '2026-10-05');
insert into team_leads (team_id, member_id) values ('b1000000-0000-4000-8000-000000000051', 'c1000000-0000-4000-8000-000000000001');
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from checkins where id = 'd1000000-0000-4000-8000-000000000012'$$), 0,
  'the admin can''t read TT Esc team''s check-in');
select alike(
  pg_temp.error_of($$select admin_move_team('b1000000-0000-4000-8000-000000000053', 'b1000000-0000-4000-8000-000000000051', 0)$$),
  '42501: You lead where this is going, so another admin has to move it there.',
  'an admin cannot move a team into a domain they lead'
);
select alike(
  pg_temp.error_of($$update teams set parent_id = 'b1000000-0000-4000-8000-000000000051' where id = 'b1000000-0000-4000-8000-000000000053'$$),
  '42501: You lead where this is going%', 'nor with a plain update'
);
select is(pg_temp.n($$select 1 from checkins where id = 'd1000000-0000-4000-8000-000000000012'$$), 0,
  'so its check-in stays hidden from them');
select lives_ok(
  $$insert into teams (name, kind, parent_id) values ('TT Esc new', 'team', 'b1000000-0000-4000-8000-000000000051')$$,
  'the admin can add a new (empty) team under the domain they lead'
);
select lives_ok(
  $$select admin_move_team(pg_temp.team('TT Esc new'), 'b1000000-0000-4000-8000-000000000051', 0)$$,
  'and reorder the teams in it'
);
select lives_ok(
  $$select admin_move_team('b1000000-0000-4000-8000-000000000054', 'b1000000-0000-4000-8000-000000000052', 0)$$,
  'and move a team out of it'
);
select alike(
  pg_temp.error_of($$select admin_move_team('b1000000-0000-4000-8000-000000000054', 'b1000000-0000-4000-8000-000000000051', 0)$$),
  '42501: You lead where this is going%', 'but not back in'
);
-- A kind change in the same update is no different: an unplaced domain (what every team made
-- before 0003 is) or an empty domain under a division, turned into a team under the led domain.
reset role;
set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
insert into teams (id, name, kind, parent_id) values
  ('b1000000-0000-4000-8000-000000000055', 'TT Esc unplaced', 'domain', null),
  ('b1000000-0000-4000-8000-000000000056', 'TT Esc placed',   'domain', 'b1000000-0000-4000-8000-000000000003');
insert into members (id, name, team_id) values
  ('c1000000-0000-4000-8000-000000000020', 'esc2', 'b1000000-0000-4000-8000-000000000055'),
  ('c1000000-0000-4000-8000-000000000021', 'esc3', 'b1000000-0000-4000-8000-000000000056');
insert into checkins (id, member_id, week_start) values
  ('d1000000-0000-4000-8000-000000000015', 'c1000000-0000-4000-8000-000000000020', '2026-10-05'),
  ('d1000000-0000-4000-8000-000000000016', 'c1000000-0000-4000-8000-000000000021', '2026-10-05');
update members set team_id = null
  where id in ('c1000000-0000-4000-8000-000000000020', 'c1000000-0000-4000-8000-000000000021');
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select alike(
  pg_temp.error_of($$update teams set kind = 'team', parent_id = 'b1000000-0000-4000-8000-000000000051' where id = 'b1000000-0000-4000-8000-000000000055'$$),
  '42501: You lead where this is going%', 'an admin cannot turn an unplaced domain into a team under a domain they lead'
);
select alike(
  pg_temp.error_of($$update teams set kind = 'team', parent_id = 'b1000000-0000-4000-8000-000000000051' where id = 'b1000000-0000-4000-8000-000000000056'$$),
  '42501: You lead where this is going%', 'nor a domain from under a division'
);
select is(pg_temp.n($$select 1 from checkins where id in ('d1000000-0000-4000-8000-000000000015', 'd1000000-0000-4000-8000-000000000016')$$), 0,
  'so their check-ins stay hidden');
-- Archived is no different: an old team's history is exactly what the move would show them.
-- The server empties and archives TT Esc team (its check-in stays with it).
reset role;
set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
update members set team_id = null where id = 'c1000000-0000-4000-8000-000000000018';
update teams set archived_at = now() where id = 'b1000000-0000-4000-8000-000000000053';
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select alike(
  pg_temp.error_of($$select admin_move_team('b1000000-0000-4000-8000-000000000053', 'b1000000-0000-4000-8000-000000000051', 0)$$),
  '42501: You lead where this is going%', 'an admin cannot move an archived team into a domain they lead either'
);
select alike(
  pg_temp.error_of($$update teams set parent_id = 'b1000000-0000-4000-8000-000000000051' where id = 'b1000000-0000-4000-8000-000000000053'$$),
  '42501: You lead where this is going%', 'nor with a plain update'
);
select is(pg_temp.n($$select 1 from checkins where id = 'd1000000-0000-4000-8000-000000000012'$$), 0,
  'so the archived team''s check-in stays hidden too');
reset role;
set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
select is(
  pg_temp.changed($$update teams set parent_id = 'b1000000-0000-4000-8000-000000000051' where id = 'b1000000-0000-4000-8000-000000000053'$$),
  1, 'someone who doesn''t lead the domain (here the server) can move the team in'
);
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from checkins where id = 'd1000000-0000-4000-8000-000000000012'$$), 1,
  'and then the admin, who leads the domain, sees its history (archived teams included)');

select * from finish();
rollback;
