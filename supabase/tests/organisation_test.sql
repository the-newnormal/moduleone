-- The organisation node and automatic leadership (migration 0006).
-- Run: supabase test db. Builds its own fixtures and rolls back.
--
-- Fixtures (ids b6… teams, c6… members, a6… logins, d6… check-ins):
--   The New Normal (the organisation, from 0006)
--     DO Division                     DO Other
--       DO Domain                       DO Other domain  (other)
--         DO Team  (teammate)
--   DO Unplaced (a domain at the top level, outside the organisation)  (outsider)
--   admin      role leader, no team, grant admin
--   boss       a member with no team; the project owner places them in the organisation
--   divlead    a leader sitting in DO Division
--   plain      a member with no team
--   chief      hq, no team
begin;
select plan(74);

create function pg_temp.n(sql text) returns int language plpgsql as $$
declare result int;
begin
  execute format('select count(*) from (%s) q', sql) into result;
  return result;
end $$;

create function pg_temp.error_of(sql text) returns text language plpgsql as $$
begin
  execute sql;
  return 'no error';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;

-- The organisation's id, whoever is asking (security definer: the test reads it as any role).
create function pg_temp.org() returns uuid language sql security definer as $$
  select id from public.teams where kind = 'organisation'
$$;
create function pg_temp.role_of(member uuid) returns text language sql security definer as $$
  select role from public.members where id = member
$$;
create function pg_temp.parent_of(team uuid) returns uuid language sql security definer as $$
  select parent_id from public.teams where id = team
$$;

grant execute on function pg_temp.n(text), pg_temp.error_of(text), pg_temp.org(), pg_temp.role_of(uuid),
  pg_temp.parent_of(uuid) to authenticated, service_role;

-- ---------- the organisation as 0006 left it ----------
select is((select count(*)::int from teams where kind = 'organisation'), 1, 'there is exactly one organisation');
select results_eq(
  $$select name, parent_id, sort_order, code, domain_type, division_type, note, archived_at, leader_title
    from teams where kind = 'organisation'$$,
  $$values ('The New Normal'::text, null::uuid, 0, null::text, null::text, null::text, null::text, null::timestamptz, 'President'::text)$$,
  'it is The New Normal, at the top, whose leaders are called President, with nothing else set'
);
select is((select count(*)::int from teams where leader_title is not null and kind <> 'organisation'), 0,
  'no other node has a title yet');
select is(
  (select count(*)::int from teams d where d.kind = 'division' and d.parent_id is distinct from pg_temp.org()),
  0, 'every founding division sits under it'
);
select results_eq(
  $$select name, sort_order from teams where parent_id = (select id from teams where kind = 'organisation') order by sort_order$$,
  $$values ('Gather'::text, 0), ('Culture', 1), ('HQ', 2), ('Special Projects', 3)$$,
  'in their founding order'
);
select is(has_function_privilege('authenticated', f, 'execute'), false, format('signed-in users cannot call %s', f))
  from unnest(array['public.teams_fill_tree()', 'public.members_lead_where_placed()', 'public.members_check_role()', 'public.members_check_login()']) f;

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a6000000-0000-4000-8000-000000000001', 'admin@org.test'),
  ('a6000000-0000-4000-8000-000000000002', 'boss@org.test'),
  ('a6000000-0000-4000-8000-000000000003', 'divlead@org.test'),
  ('a6000000-0000-4000-8000-000000000004', 'plain@org.test'),
  ('a6000000-0000-4000-8000-000000000005', 'teammate@org.test');

insert into teams (id, name, kind, sort_order) values
  ('b6000000-0000-4000-8000-000000000001', 'DO Division', 'division', 10),
  ('b6000000-0000-4000-8000-000000000004', 'DO Other',    'division', 11);
insert into teams (id, name, kind, parent_id, sort_order) values
  ('b6000000-0000-4000-8000-000000000002', 'DO Domain',       'domain', 'b6000000-0000-4000-8000-000000000001', 0),
  ('b6000000-0000-4000-8000-000000000005', 'DO Other domain', 'domain', 'b6000000-0000-4000-8000-000000000004', 0);
insert into teams (id, name, kind, parent_id, sort_order) values
  ('b6000000-0000-4000-8000-000000000003', 'DO Team', 'team', 'b6000000-0000-4000-8000-000000000002', 0);
insert into teams (id, name) values ('b6000000-0000-4000-8000-000000000006', 'DO Unplaced');

select is(pg_temp.parent_of('b6000000-0000-4000-8000-000000000001'), pg_temp.org(),
  'a division saved without a parent goes under the organisation');

insert into members (id, auth_user_id, name, team_id, role) values
  ('c6000000-0000-4000-8000-000000000001', 'a6000000-0000-4000-8000-000000000001', 'admin',    null,                                   'leader'),
  ('c6000000-0000-4000-8000-000000000002', 'a6000000-0000-4000-8000-000000000002', 'boss',     null,                                   'member'),
  ('c6000000-0000-4000-8000-000000000003', 'a6000000-0000-4000-8000-000000000003', 'divlead',  'b6000000-0000-4000-8000-000000000001', 'leader'),
  ('c6000000-0000-4000-8000-000000000004', 'a6000000-0000-4000-8000-000000000004', 'plain',    null,                                   'member'),
  ('c6000000-0000-4000-8000-000000000005', 'a6000000-0000-4000-8000-000000000005', 'teammate', 'b6000000-0000-4000-8000-000000000003', 'member'),
  ('c6000000-0000-4000-8000-000000000006', null,                                   'other',    'b6000000-0000-4000-8000-000000000005', 'member'),
  ('c6000000-0000-4000-8000-000000000007', null,                                   'chief',    null,                                   'hq'),
  ('c6000000-0000-4000-8000-000000000008', null,                                   'outsider', 'b6000000-0000-4000-8000-000000000006', 'member');
insert into member_grants (member_id, grant_name) values ('c6000000-0000-4000-8000-000000000001', 'admin');

insert into checkins (id, member_id, week_start) values
  ('d6000000-0000-4000-8000-000000000003', 'c6000000-0000-4000-8000-000000000003', '2026-10-05'),
  ('d6000000-0000-4000-8000-000000000005', 'c6000000-0000-4000-8000-000000000005', '2026-10-05'),
  ('d6000000-0000-4000-8000-000000000006', 'c6000000-0000-4000-8000-000000000006', '2026-10-05'),
  ('d6000000-0000-4000-8000-000000000008', 'c6000000-0000-4000-8000-000000000008', '2026-10-05');

-- ---------- an admin can rename the organisation, and nothing else ----------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a6000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  pg_temp.error_of($$update teams set name = 'The Newer Normal', note = 'Everyone.' where kind = 'organisation'$$),
  'no error', 'an admin can rename the organisation and note it'
);
select is((select name from teams where kind = 'organisation'), 'The Newer Normal', 'the new name is saved');
select is(pg_temp.error_of($$update teams set leader_title = 'Chair' where kind = 'organisation'$$), 'no error',
  'an admin can rename the title of whoever sits there');
select is((select leader_title from teams where kind = 'organisation'), 'Chair', 'the new title is saved');
select is(pg_temp.error_of($$update teams set leader_title = 'Divisional Leader' where id = 'b6000000-0000-4000-8000-000000000001'$$),
  'no error', 'and give a division one');
select alike(pg_temp.error_of($$update teams set leader_title = ' Chair' where kind = 'organisation'$$),
  '23514: %"teams_leader_title_format"%', 'a title with spaces around it is refused');
select alike(pg_temp.error_of($$update teams set leader_title = '' where kind = 'organisation'$$),
  '23514: %"teams_leader_title_format"%', 'an empty title is refused (null clears it)');
select alike(pg_temp.error_of(format('update teams set leader_title = %L where kind = %L', repeat('t', 61), 'organisation')),
  '23514: %"teams_leader_title_format"%', 'a title over 60 characters is refused');
select is(pg_temp.error_of($$update teams set archived_at = now() where kind = 'organisation'$$),
  '23514: The organisation can''t be archived.', 'it cannot be archived');
select is(pg_temp.error_of($$update teams set kind = 'division' where kind = 'organisation'$$),
  '23514: The organisation''s kind can''t change.', 'nor turned into anything else');
select is(
  pg_temp.error_of($$update teams set parent_id = 'b6000000-0000-4000-8000-000000000001' where kind = 'organisation'$$),
  '23514: The organisation can''t be moved.', 'nor moved under anything');
select is(pg_temp.error_of(format('select admin_move_team(%L, null, 1)', pg_temp.org())),
  '23514: The organisation can''t be moved.', 'nor moved by drag and drop');
select is(pg_temp.error_of($$insert into teams (name, kind) values ('Another', 'organisation')$$),
  '23514: There is only one organisation.', 'there cannot be a second');
select is(pg_temp.error_of($$update teams set kind = 'organisation' where id = 'b6000000-0000-4000-8000-000000000006'$$),
  '23514: There is only one organisation.', 'nor can another node become one');
select is(
  pg_temp.error_of(format('insert into teams (name, kind, parent_id) values (%L, %L, %L)', 'x', 'domain', pg_temp.org())),
  '23514: A domain can only sit under a division, or at the top level (unplaced).', 'a domain cannot sit under the organisation');
select is(
  pg_temp.error_of(format('insert into teams (name, kind, parent_id) values (%L, %L, %L)', 'x', 'team', pg_temp.org())),
  '23514: A team can only sit under a domain.', 'nor can a team');
reset role;

set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
select is(pg_temp.error_of($$insert into teams (name, kind) values ('Another', 'organisation')$$),
  '23514: There is only one organisation.', 'the server cannot add a second either');
reset role;

-- With every trigger off (as a restore might run), the unique index still allows only one. The
-- error undoes the setting along with the insert.
select alike(
  pg_temp.error_of($q$do $x$ begin
    set local session_replication_role = replica;
    insert into teams (name, kind) values ('Bypass', 'organisation');
  end $x$$q$),
  '23505: %"teams_one_organisation"%', 'with the triggers off, the unique index still refuses a second organisation'
);
select is(current_setting('session_replication_role'), 'origin', 'and the triggers are back on');

-- ---------- divisions stay under the organisation ----------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a6000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(pg_temp.error_of($$select admin_move_team('b6000000-0000-4000-8000-000000000004', null, 0)$$), 'no error',
  'an admin drops a division at the top level, as the Structure page did before 0006');
select is(pg_temp.parent_of('b6000000-0000-4000-8000-000000000004'), pg_temp.org(), 'and it stays under the organisation');
select is(
  (select string_agg(name || ':' || sort_order, ', ' order by sort_order) from teams
   where parent_id = pg_temp.org() and archived_at is null),
  'DO Other:0, Gather:1, Culture:2, HQ:3, Special Projects:4, DO Division:5',
  'first among the divisions, which are renumbered 0, 1, 2, …'
);
select is(
  pg_temp.error_of($$select admin_move_team('b6000000-0000-4000-8000-000000000004', 'b6000000-0000-4000-8000-000000000001', 0)$$),
  '23514: A division can only sit under the organisation.', 'a division cannot be dropped under another');
select is(pg_temp.error_of($$update teams set parent_id = null where id = 'b6000000-0000-4000-8000-000000000004'$$), 'no error',
  'unplacing a division directly');
select is(pg_temp.parent_of('b6000000-0000-4000-8000-000000000004'), pg_temp.org(), 'leaves it under the organisation');
select is(pg_temp.error_of($$insert into teams (name, kind) values ('DO Empty', 'division')$$), 'no error',
  'an admin adds an empty division');
select is(pg_temp.error_of($$update teams set kind = 'domain' where name = 'DO Empty'$$), 'no error',
  'which becomes a domain');
select is((select parent_id from teams where name = 'DO Empty'), null, 'and so is unplaced, not left under the organisation');
reset role;

-- ---------- only the project owner places people in the organisation ----------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a6000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  pg_temp.error_of(format('update members set team_id = %L where id = %L', pg_temp.org(), 'c6000000-0000-4000-8000-000000000002')),
  '42501: Only the project owner can place people in the organisation itself.', 'an admin cannot place someone in the organisation');
select is(
  pg_temp.error_of(format('insert into members (name, team_id) values (%L, %L)', 'DO newcomer', pg_temp.org())),
  '42501: Only the project owner can place people in the organisation itself.', 'nor add someone straight into it');
select is(
  pg_temp.error_of(format('insert into team_leads (team_id, member_id) values (%L, %L)', pg_temp.org(), 'c6000000-0000-4000-8000-000000000003')),
  '42501: Only the project owner can make someone a lead of the organisation itself.',
  'nor make a leader a lead of the organisation');
reset role;

set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
select is(
  pg_temp.error_of(format('insert into team_leads (team_id, member_id) values (%L, %L)', pg_temp.org(), 'c6000000-0000-4000-8000-000000000003')),
  'no error', 'the owner can make a leader a lead of the organisation');
delete from team_leads where member_id = 'c6000000-0000-4000-8000-000000000003';
select is(
  pg_temp.error_of(format('update members set team_id = %L where id = %L', pg_temp.org(), 'c6000000-0000-4000-8000-000000000002')),
  'no error', 'the server (or the owner in the dashboard) places boss in the organisation');
select is(pg_temp.role_of('c6000000-0000-4000-8000-000000000002'), 'leader', 'which makes them its leader');
select is(
  pg_temp.error_of(format('update members set team_id = %L where id = %L', pg_temp.org(), 'c6000000-0000-4000-8000-000000000007')),
  'no error', 'an hq member can sit there too');
select is(pg_temp.role_of('c6000000-0000-4000-8000-000000000007'), 'hq', 'and stays hq');
insert into checkins (id, member_id, week_start) values
  ('d6000000-0000-4000-8000-000000000002', 'c6000000-0000-4000-8000-000000000002', '2026-10-05');
select is((select team_id from checkins where id = 'd6000000-0000-4000-8000-000000000002'), pg_temp.org(),
  'boss checks in at the organisation''s own level');
reset role;

-- ---------- only the project owner gives a login to someone in the organisation ----------
-- giveLogin links a login through the server and records who gave it; the owner, linking one in
-- the dashboard, doesn't.
insert into auth.users (id, email) values
  ('a6000000-0000-4000-8000-000000000011', 'seat@org.test'),
  ('a6000000-0000-4000-8000-000000000012', 'seat2@org.test'),
  ('a6000000-0000-4000-8000-000000000013', 'deputy@org.test'),
  ('a6000000-0000-4000-8000-000000000014', 'divhead@org.test');
set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
insert into members (id, name, team_id) values
  ('c6000000-0000-4000-8000-000000000011', 'DO seat', pg_temp.org()),
  ('c6000000-0000-4000-8000-000000000013', 'DO deputy', 'b6000000-0000-4000-8000-000000000002'),
  ('c6000000-0000-4000-8000-000000000014', 'DO div head', 'b6000000-0000-4000-8000-000000000001');
update members set role = 'leader' where id = 'c6000000-0000-4000-8000-000000000013';
insert into team_leads (team_id, member_id) values (pg_temp.org(), 'c6000000-0000-4000-8000-000000000013');
select is(
  pg_temp.error_of($$update members set auth_user_id = 'a6000000-0000-4000-8000-000000000011',
    login_given_by = 'c6000000-0000-4000-8000-000000000001', login_given_at = now()
    where id = 'c6000000-0000-4000-8000-000000000011'$$),
  '42501: Only the project owner gives a login to someone in the organisation.',
  'an admin''s Give login cannot link a login to someone sitting in the organisation');
select is(
  pg_temp.error_of($$update members set auth_user_id = 'a6000000-0000-4000-8000-000000000013',
    login_given_by = 'c6000000-0000-4000-8000-000000000001', login_given_at = now()
    where id = 'c6000000-0000-4000-8000-000000000013'$$),
  '42501: Only the project owner gives a login to someone in the organisation.',
  'nor to a lead of the organisation');
select is(
  pg_temp.error_of($$update members set auth_user_id = 'a6000000-0000-4000-8000-000000000014',
    login_given_by = 'c6000000-0000-4000-8000-000000000001', login_given_at = now()
    where id = 'c6000000-0000-4000-8000-000000000014'$$),
  'no error', 'but it can for someone in a division');
select is(
  pg_temp.error_of($$update members set auth_user_id = 'a6000000-0000-4000-8000-000000000012'
    where id = 'c6000000-0000-4000-8000-000000000011'$$),
  'no error', 'the owner links a login to someone in the organisation (no giver recorded)');
reset role;

-- ---------- whoever sits in a division leads it ----------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a6000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(pg_temp.error_of($$update members set team_id = 'b6000000-0000-4000-8000-000000000004' where id = 'c6000000-0000-4000-8000-000000000004'$$),
  'no error', 'an admin places plain, a member, in a division');
select is(pg_temp.role_of('c6000000-0000-4000-8000-000000000004'), 'leader', 'which makes them a leader');
select is(pg_temp.error_of($$insert into members (name, team_id) values ('DO new head', 'b6000000-0000-4000-8000-000000000004')$$),
  'no error', 'an admin adds someone straight into a division');
select is((select role from members where name = 'DO new head'), 'leader', 'and they arrive as a leader');
select is(pg_temp.error_of($$update members set role = 'member' where id = 'c6000000-0000-4000-8000-000000000004'$$),
  '23514: People placed in a division or the organisation lead it. Move them to a domain or team before making them a member.',
  'nobody sitting in a division can be made a member');
select is(pg_temp.error_of($$update members set team_id = 'b6000000-0000-4000-8000-000000000005' where id = 'c6000000-0000-4000-8000-000000000004'$$),
  'no error', 'the admin moves plain on to a domain');
select is(pg_temp.role_of('c6000000-0000-4000-8000-000000000004'), 'leader', 'and plain stays a leader');
select is(pg_temp.error_of($$update members set role = 'member' where id = 'c6000000-0000-4000-8000-000000000004'$$),
  'no error', 'until the admin makes them a member again');
select is(pg_temp.error_of($$update members set team_id = 'b6000000-0000-4000-8000-000000000003' where id = 'c6000000-0000-4000-8000-000000000004'$$),
  'no error', 'a member moved between a domain and a team');
select is(pg_temp.role_of('c6000000-0000-4000-8000-000000000004'), 'member', 'stays a member');
reset role;

set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
update members set team_id = 'b6000000-0000-4000-8000-000000000004' where id = 'c6000000-0000-4000-8000-000000000007';
select is(pg_temp.role_of('c6000000-0000-4000-8000-000000000007'), 'hq', 'an hq member placed in a division stays hq');
update members set team_id = pg_temp.org() where id = 'c6000000-0000-4000-8000-000000000007';
reset role;

-- ---------- the organisation's leader sees everything in it ----------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a6000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select ok(
  (select array_agg(id) from teams where kind in ('division', 'domain', 'team') and parent_id is not null)
    <@ app_led_team_ids() and pg_temp.org() = any (app_led_team_ids()),
  'boss leads the organisation and every division, domain and team under it'
);
select is('b6000000-0000-4000-8000-000000000006'::uuid = any (app_led_team_ids()), false,
  'but not an unplaced domain, which sits outside it');
select is(pg_temp.n($$select 1 from checkins where id in ('d6000000-0000-4000-8000-000000000002', 'd6000000-0000-4000-8000-000000000003',
  'd6000000-0000-4000-8000-000000000005', 'd6000000-0000-4000-8000-000000000006')$$), 4,
  'boss sees their own check-in and every one made in a division, a domain or a team');
select is(pg_temp.n($$select 1 from checkins where id = 'd6000000-0000-4000-8000-000000000008'$$), 0,
  'but not one made in an unplaced domain');
select is(pg_temp.n($$select 1 from members where id in ('c6000000-0000-4000-8000-000000000005', 'c6000000-0000-4000-8000-000000000006')$$), 2,
  'and sees the people in every team');

-- ---------- below the organisation, its own check-ins stay hidden ----------
set local request.jwt.claims to '{"sub": "a6000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from checkins where id = 'd6000000-0000-4000-8000-000000000005'$$), 1,
  'a division''s leader sees the check-ins under their division');
select is(pg_temp.n($$select 1 from checkins where id = 'd6000000-0000-4000-8000-000000000002'$$), 0,
  'but not the organisation''s own');
select is(pg_temp.org() = any (app_led_team_ids()), false, 'they don''t lead the organisation');

set local request.jwt.claims to '{"sub": "a6000000-0000-4000-8000-000000000005", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from teams where kind = 'organisation'$$), 1,
  'a member in a team sees the organisation above them');
select is(
  pg_temp.error_of($$update teams set leader_title = 'Emperor' where kind = 'organisation'$$)
    || '|' || (select leader_title from teams where kind = 'organisation'),
  'no error|Chair', 'but cannot rename its title (the update changes nothing)');
select is(pg_temp.n($$select 1 from checkins where id = 'd6000000-0000-4000-8000-000000000002'$$), 0,
  'but not its check-ins');
select is(pg_temp.n($$select 1 from members where id = 'c6000000-0000-4000-8000-000000000002'$$), 0,
  'nor the people sitting in it');
reset role;

select * from finish();
rollback;
