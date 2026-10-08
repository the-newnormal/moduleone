-- The team tree's checks refuse to run outside READ COMMITTED (migration 0003). Run: supabase test db
-- Under REPEATABLE READ a transaction keeps the snapshot it started with, so after waiting for the
-- tree lock it would still check against the tree as it was before the change it waited for. This
-- file's transaction is REPEATABLE READ on purpose; team_tree_test.sql covers READ COMMITTED.
-- Fixture ids: a2… logins, c2… members. Everything is rolled back.
begin isolation level repeatable read;
select plan(10);

select is(current_setting('transaction_isolation'), 'repeatable read', 'this file runs at REPEATABLE READ');

-- 'SQLSTATE: message' for a statement that fails; 'no error' otherwise.
create function pg_temp.error_of(sql text) returns text language plpgsql as $$
begin
  execute sql;
  return 'no error';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
grant execute on function pg_temp.error_of(text) to authenticated;

-- An admin, and a leader with a lead row (added with its trigger off), none of which needs the tree.
insert into auth.users (id, email) values ('a2000000-0000-4000-8000-000000000001', 'admin@iso.test');
insert into members (id, auth_user_id, name, role) values
  ('c2000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000001', 'iso admin', 'leader'),
  ('c2000000-0000-4000-8000-000000000002', null, 'iso leader', 'leader');
insert into member_grants (member_id, grant_name) values ('c2000000-0000-4000-8000-000000000001', 'admin');
alter table team_leads disable trigger team_leads_check;
insert into team_leads (team_id, member_id)
  select id, 'c2000000-0000-4000-8000-000000000002' from teams where code = 'IP.1';
alter table team_leads enable trigger team_leads_check;

select is(
  pg_temp.error_of($$insert into teams (name) values ('iso domain')$$),
  '25000: Change the team tree in a READ COMMITTED transaction.', 'adding a team is refused (teams_check_tree)'
);
select is(
  pg_temp.error_of($$update teams set archived_at = now() where code = 'HP.X'$$),
  '25000: Change the team tree in a READ COMMITTED transaction.', 'so is archiving one'
);
select is(
  pg_temp.error_of($$update members set team_id = (select id from teams where code = 'IP.2') where id = 'c2000000-0000-4000-8000-000000000002'$$),
  '25000: Change the team tree in a READ COMMITTED transaction.', 'placing someone is refused (members_check_team)'
);
select is(
  pg_temp.error_of($$insert into team_leads (team_id, member_id) select id, 'c2000000-0000-4000-8000-000000000001' from teams where code = 'IP.2'$$),
  '25000: Change the team tree in a READ COMMITTED transaction.', 'adding a lead is refused (team_leads_check)'
);
select is(
  pg_temp.error_of($$update members set role = 'member' where id = 'c2000000-0000-4000-8000-000000000002'$$),
  '25000: Change the team tree in a READ COMMITTED transaction.', 'demoting a leader is refused (members_drop_team_leads)'
);
set local role authenticated;
set local request.jwt.claims to '{"sub": "a2000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  pg_temp.error_of($$select admin_move_team((select id from teams where code = 'IP.2'), (select id from teams where code = 'IP.X'), 0)$$),
  '25000: Change the team tree in a READ COMMITTED transaction.', 'an admin''s move is refused (by the tree trigger, before anything is renumbered)'
);
reset role;

-- What doesn't touch the tree or who sits where still works.
select is(
  pg_temp.error_of($$update teams set name = 'IP Lab One' where code = 'IP.1'$$),
  'no error', 'renaming a team still works'
);
select is(
  pg_temp.error_of($$update members set name = 'iso leader renamed' where id = 'c2000000-0000-4000-8000-000000000002'$$),
  'no error', 'renaming a member still works'
);
select is(
  pg_temp.error_of($$insert into members (name) values ('iso newcomer')$$),
  'no error', 'adding someone with no team still works'
);

select * from finish();
rollback;
