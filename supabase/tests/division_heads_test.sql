-- Division heads (migration 0005): someone can sit in a division and lead it, like a domain.
-- Run: supabase test db. Builds its own fixtures and rolls back.
--
-- Fixtures (ids b5… teams, c5… members, a5… logins, d5… check-ins):
--   DH Division                       DH Other
--     DH Domain                         DH Other domain  (other)
--       DH Team  (teammate)
--   admin    role leader, no team, grant admin; at the end placed in DH Division
--   head     a leader with no team yet, then placed in DH Division
--   deputy   a leader in DH Other domain, then made a lead of DH Division
--   plain    a member with no team
begin;
select plan(28);

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

grant execute on function pg_temp.n(text), pg_temp.error_of(text) to authenticated;

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a5000000-0000-4000-8000-000000000001', 'admin@heads.test'),
  ('a5000000-0000-4000-8000-000000000002', 'head@heads.test'),
  ('a5000000-0000-4000-8000-000000000003', 'deputy@heads.test'),
  ('a5000000-0000-4000-8000-000000000004', 'plain@heads.test');

insert into teams (id, name, kind, sort_order) values
  ('b5000000-0000-4000-8000-000000000001', 'DH Division', 'division', 0),
  ('b5000000-0000-4000-8000-000000000004', 'DH Other',    'division', 0);
insert into teams (id, name, kind, parent_id, sort_order) values
  ('b5000000-0000-4000-8000-000000000002', 'DH Domain',       'domain', 'b5000000-0000-4000-8000-000000000001', 0),
  ('b5000000-0000-4000-8000-000000000005', 'DH Other domain', 'domain', 'b5000000-0000-4000-8000-000000000004', 0);
insert into teams (id, name, kind, parent_id, sort_order) values
  ('b5000000-0000-4000-8000-000000000003', 'DH Team', 'team', 'b5000000-0000-4000-8000-000000000002', 0);

insert into members (id, auth_user_id, name, team_id, role) values
  ('c5000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001', 'admin',    null,                                   'leader'),
  ('c5000000-0000-4000-8000-000000000002', 'a5000000-0000-4000-8000-000000000002', 'head',     null,                                   'leader'),
  ('c5000000-0000-4000-8000-000000000003', 'a5000000-0000-4000-8000-000000000003', 'deputy',   'b5000000-0000-4000-8000-000000000005', 'leader'),
  ('c5000000-0000-4000-8000-000000000004', 'a5000000-0000-4000-8000-000000000004', 'plain',    null,                                   'member'),
  ('c5000000-0000-4000-8000-000000000005', null,                                   'teammate', 'b5000000-0000-4000-8000-000000000003', 'member'),
  ('c5000000-0000-4000-8000-000000000006', null,                                   'other',    'b5000000-0000-4000-8000-000000000005', 'member');
insert into member_grants (member_id, grant_name) values ('c5000000-0000-4000-8000-000000000001', 'admin');

insert into checkins (id, member_id, week_start) values
  ('d5000000-0000-4000-8000-000000000005', 'c5000000-0000-4000-8000-000000000005', '2026-10-05'),
  ('d5000000-0000-4000-8000-000000000006', 'c5000000-0000-4000-8000-000000000006', '2026-10-05');

-- ---------- an admin places people in a division and makes leads of one ----------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a5000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  pg_temp.error_of($$update members set team_id = 'b5000000-0000-4000-8000-000000000001' where id = 'c5000000-0000-4000-8000-000000000002'$$),
  'no error', 'an admin can place a leader in a division'
);
select is(
  pg_temp.error_of($$insert into members (name, team_id) values ('DH newcomer', 'b5000000-0000-4000-8000-000000000001')$$),
  'no error', 'and add someone new straight into one'
);
select is(
  pg_temp.error_of($$update members set team_id = 'b5000000-0000-4000-8000-000000000004' where id = 'c5000000-0000-4000-8000-000000000004'$$),
  'no error', 'a plain member can sit in a division too'
);
select is(
  pg_temp.error_of($$insert into team_leads (team_id, member_id) values ('b5000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000003')$$),
  'no error', 'an admin can make a leader from elsewhere a lead of a division'
);
select is(
  pg_temp.error_of($$insert into team_leads (team_id, member_id) values ('b5000000-0000-4000-8000-000000000004', 'c5000000-0000-4000-8000-000000000004')$$),
  '23514: Only members with the leader role can lead a team. Make them a leader first.',
  'a division lead must still be a leader'
);
select is(
  pg_temp.error_of($$update teams set archived_at = now() where id = 'b5000000-0000-4000-8000-000000000004'$$),
  '23514: Archive or move the 1 active domain under it first.',
  'a division is still archived from the leaves up'
);
select is(
  pg_temp.error_of($$update teams set archived_at = now() where id = 'b5000000-0000-4000-8000-000000000005'$$),
  '23514: Move its 2 members out first.', 'and only once nobody sits in what is under it'
);
reset role;

-- ---------- the head checks in at the division's own level ----------
set local role service_role;
insert into checkins (id, member_id, week_start) values
  ('d5000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000002', '2026-10-05');
select is(
  (select team_id from checkins where id = 'd5000000-0000-4000-8000-000000000002'),
  'b5000000-0000-4000-8000-000000000001'::uuid, 'a check-in made by someone in a division is the division''s'
);
reset role;

-- ---------- the head sees their whole division, and nothing else ----------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a5000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select set_eq(
  $$select unnest(app_led_team_ids())$$,
  array['b5000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000002', 'b5000000-0000-4000-8000-000000000003']::uuid[],
  'a leader sitting in a division leads it and everything under it'
);
select is(pg_temp.n($$select 1 from checkins where id = 'd5000000-0000-4000-8000-000000000002'$$), 1,
  'the head sees their own check-in, made in the division');
select is(pg_temp.n($$select 1 from checkins where id = 'd5000000-0000-4000-8000-000000000005'$$), 1,
  'and a check-in made in a team two levels down');
select is(pg_temp.n($$select 1 from checkins where id = 'd5000000-0000-4000-8000-000000000006'$$), 0,
  'but not one made in another division');
select is(pg_temp.n($$select 1 from teams where id = 'b5000000-0000-4000-8000-000000000003'$$), 1,
  'the head sees the teams under the division');
select is(pg_temp.n($$select 1 from teams where id = 'b5000000-0000-4000-8000-000000000005'$$), 0,
  'and not the domains of another division');
select is(pg_temp.n($$select 1 from members where id = 'c5000000-0000-4000-8000-000000000005'$$), 1,
  'and the people in it');

-- ---------- a lead of a division sees all of it ----------
set local request.jwt.claims to '{"sub": "a5000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from checkins where id = 'd5000000-0000-4000-8000-000000000002'$$), 1,
  'a division''s lead sees the check-ins made in the division');
select is(pg_temp.n($$select 1 from checkins where id = 'd5000000-0000-4000-8000-000000000005'$$), 1,
  'and under it');
select is(pg_temp.n($$select 1 from checkins where id = 'd5000000-0000-4000-8000-000000000006'$$), 1,
  'as well as in their own team');

-- ---------- a plain member in a division sees only their own ----------
set local request.jwt.claims to '{"sub": "a5000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from checkins where id = 'd5000000-0000-4000-8000-000000000006'$$), 0,
  'a member sitting in a division doesn''t see the check-ins made under it');
select is(app_led_team_ids(), '{}'::uuid[], 'and leads nothing');
reset role;

-- ---------- a domain with people, leads and check-ins can become a division ----------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a5000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(pg_temp.error_of($$insert into teams (name) values ('DH Unplaced')$$), 'no error', 'admin adds an unplaced domain');
select is(
  pg_temp.error_of($$insert into members (name, team_id) select 'DH sitter', id from teams where name = 'DH Unplaced'$$),
  'no error', 'with someone in it'
);
select is(
  pg_temp.error_of($$insert into team_leads (team_id, member_id) select id, 'c5000000-0000-4000-8000-000000000003' from teams where name = 'DH Unplaced'$$),
  'no error', 'and a lead'
);
reset role;
set local role service_role;
insert into checkins (member_id, week_start) select id, '2026-10-05' from members where name = 'DH sitter';
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "a5000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  pg_temp.error_of($$update teams set kind = 'division' where name = 'DH Unplaced'$$),
  'no error', 'and a check-in, and still becomes a division'
);
select is(
  pg_temp.error_of($$update teams set archived_at = now() where name = 'DH Unplaced'$$),
  '23514: Move its 1 member out first.', 'a division someone sits in cannot be archived'
);
select is(
  pg_temp.error_of($$update teams set kind = 'domain' where name = 'DH Unplaced'$$),
  'no error', 'and back again'
);
reset role;

-- ---------- an admin who sits in a division can't move another domain's history into it ----------
set local role service_role;
update members set team_id = 'b5000000-0000-4000-8000-000000000001' where id = 'c5000000-0000-4000-8000-000000000001';
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "a5000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select alike(
  pg_temp.error_of($$select admin_move_team('b5000000-0000-4000-8000-000000000005', 'b5000000-0000-4000-8000-000000000001', 0)$$),
  '42501: You lead where this is going%', 'an admin sitting in a division cannot pull a domain with check-ins into it'
);
select is(pg_temp.n($$select 1 from checkins where id = 'd5000000-0000-4000-8000-000000000006'$$), 0,
  'and still cannot see that domain''s check-ins');
reset role;

select * from finish();
rollback;
