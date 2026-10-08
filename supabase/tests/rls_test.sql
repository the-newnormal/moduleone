-- Who can read and write what, through the Data API and Storage. Run: supabase test db
-- Builds its own fixtures inside the transaction and rolls back, so it doesn't depend on seed.sql.
--
-- Fixtures:
--   team A: leader lead_a, members a1 and a2      team B: leader lead_b, member b1
--   hq      role hq, no team, no grants (so hq alone doesn't mean recordings or Big Five)
--   admin   no team, grant admin                  auditor  no team, grants recordings + big_five
--   solo    a member with no team                 outsider signed in, but no members row
-- Check-ins (week of 2026-10-05): lead_a, a1, a2, b1, solo. Mentions: in a2's (about a1), in b1's
-- (about b1), in solo's (about a1). Big Five profiles: a1, a2, b1.
-- Recordings: one each in a1's, a2's and b1's folders.
begin;
select plan(160);

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-0000000000a1', 'hq@rls.test'),
  ('a0000000-0000-4000-8000-0000000000a2', 'lead-a@rls.test'),
  ('a0000000-0000-4000-8000-0000000000a3', 'a1@rls.test'),
  ('a0000000-0000-4000-8000-0000000000a4', 'a2@rls.test'),
  ('a0000000-0000-4000-8000-0000000000b2', 'lead-b@rls.test'),
  ('a0000000-0000-4000-8000-0000000000b3', 'b1@rls.test'),
  ('a0000000-0000-4000-8000-0000000000c1', 'outsider@rls.test'),
  ('a0000000-0000-4000-8000-0000000000d1', 'solo@rls.test'),
  ('a0000000-0000-4000-8000-0000000000e1', 'admin@rls.test'),
  ('a0000000-0000-4000-8000-0000000000e2', 'auditor@rls.test');

insert into teams (id, name) values
  ('b0000000-0000-4000-8000-0000000000a0', 'RLS team A'),
  ('b0000000-0000-4000-8000-0000000000b0', 'RLS team B');

insert into members (id, auth_user_id, name, team_id, role) values
  ('c0000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-0000000000a1', 'hq',      null,                                   'hq'),
  ('c0000000-0000-4000-8000-0000000000a2', 'a0000000-0000-4000-8000-0000000000a2', 'lead_a',  'b0000000-0000-4000-8000-0000000000a0', 'leader'),
  ('c0000000-0000-4000-8000-0000000000a3', 'a0000000-0000-4000-8000-0000000000a3', 'a1',      'b0000000-0000-4000-8000-0000000000a0', 'member'),
  ('c0000000-0000-4000-8000-0000000000a4', 'a0000000-0000-4000-8000-0000000000a4', 'a2',      'b0000000-0000-4000-8000-0000000000a0', 'member'),
  ('c0000000-0000-4000-8000-0000000000b2', 'a0000000-0000-4000-8000-0000000000b2', 'lead_b',  'b0000000-0000-4000-8000-0000000000b0', 'leader'),
  ('c0000000-0000-4000-8000-0000000000b3', 'a0000000-0000-4000-8000-0000000000b3', 'b1',      'b0000000-0000-4000-8000-0000000000b0', 'member'),
  ('c0000000-0000-4000-8000-0000000000d1', 'a0000000-0000-4000-8000-0000000000d1', 'solo',    null,                                   'member'),
  ('c0000000-0000-4000-8000-0000000000e1', 'a0000000-0000-4000-8000-0000000000e1', 'admin',   null,                                   'member'),
  ('c0000000-0000-4000-8000-0000000000e2', 'a0000000-0000-4000-8000-0000000000e2', 'auditor', null,                                   'member');

insert into member_grants (member_id, grant_name) values
  ('c0000000-0000-4000-8000-0000000000e1', 'admin'),
  ('c0000000-0000-4000-8000-0000000000e2', 'recordings'),
  ('c0000000-0000-4000-8000-0000000000e2', 'big_five');

-- No team_id given: the trigger takes each member's current team.
insert into checkins (id, member_id, week_start, activity_score, excellence_score, morale_score) values
  ('d0000000-0000-4000-8000-0000000000a2', 'c0000000-0000-4000-8000-0000000000a2', '2026-10-05', 3, 3, 3),
  ('d0000000-0000-4000-8000-0000000000a3', 'c0000000-0000-4000-8000-0000000000a3', '2026-10-05', 3, 3, 3),
  ('d0000000-0000-4000-8000-0000000000a4', 'c0000000-0000-4000-8000-0000000000a4', '2026-10-05', 3, 3, 3),
  ('d0000000-0000-4000-8000-0000000000b3', 'c0000000-0000-4000-8000-0000000000b3', '2026-10-05', 3, 3, 3),
  ('d0000000-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-0000000000d1', '2026-10-05', 3, 3, 3);

insert into checkin_mentions (checkin_id, about_member_id, sentiment) values
  ('d0000000-0000-4000-8000-0000000000a4', 'c0000000-0000-4000-8000-0000000000a3', -1),
  ('d0000000-0000-4000-8000-0000000000b3', 'c0000000-0000-4000-8000-0000000000b3', 1),
  ('d0000000-0000-4000-8000-0000000000d1', 'c0000000-0000-4000-8000-0000000000a3', 2);

insert into member_profiles (member_id, big_five) values
  ('c0000000-0000-4000-8000-0000000000a3', '{"openness": 4}'),
  ('c0000000-0000-4000-8000-0000000000a4', '{"openness": 1}'),
  ('c0000000-0000-4000-8000-0000000000b3', '{"openness": 2}');

-- The storage tables belong to Supabase's storage role, so add the recordings as service_role.
set local role service_role;
insert into storage.objects (bucket_id, name) values
  ('checkin-audio', 'c0000000-0000-4000-8000-0000000000a3/2026-10-05.webm'),
  ('checkin-audio', 'c0000000-0000-4000-8000-0000000000a4/2026-10-05.webm'),
  ('checkin-audio', 'c0000000-0000-4000-8000-0000000000b3/2026-10-05.webm');
reset role;

-- Counts rows the caller can see. Queries filter to fixture ids, so seed data doesn't matter.
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

grant execute on function pg_temp.n(text), pg_temp.changed(text) to anon, authenticated;

-- Storage blocks direct SQL deletes with a trigger unless this is set; set it so RLS alone decides.
set local storage.allow_delete_query = 'true';

-- ---------- schema ----------
select has_column('public', 'checkins', 'team_id', 'checkins records the team');
select has_column('public', 'checkins', 'audio_path', 'checkins has audio_path');
select hasnt_column('public', 'members', 'big_five', 'big_five is no longer on the team-visible members table');
select is((select public from storage.buckets where id = 'checkin-audio'), false, 'the recordings bucket is private');
select is(
  (select (activity_1, activity_2, activity_3, activity_4, activity_5,
           excellence_1, excellence_2, excellence_3, excellence_4, excellence_5,
           morale_1, morale_2, morale_3, morale_4, morale_5,
           green_threshold, yellow_threshold)::text from scoring_settings),
  '(1.00,2.00,3.00,4.00,5.00,1.00,2.00,3.00,4.00,5.00,0.60,0.80,1.00,1.10,1.20,12.00,6.00)',
  'scoring_settings starts with the agreed defaults'
);

-- ---------- privileges ----------
select table_privs_are('public', t, 'anon', array[]::text[], format('anon has no privileges on %s', t))
  from unnest(array['teams', 'members', 'checkins', 'checkin_mentions', 'member_profiles', 'member_grants', 'scoring_settings']) t;
select table_privs_are('public', t, 'authenticated', array['SELECT'], format('signed-in users get table-wide SELECT only on %s', t))
  from unnest(array['teams', 'members', 'checkins', 'checkin_mentions', 'member_profiles', 'member_grants', 'scoring_settings']) t;
select table_privs_are(
  'public', t, 'service_role', array['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'],
  format('the server (service_role) has full access to %s', t)
) from unnest(array['teams', 'members', 'checkins', 'checkin_mentions', 'member_profiles', 'member_grants', 'scoring_settings']) t;
select function_privs_are('public', f, array[]::text[], 'anon', array[]::text[], format('anon cannot call %s', f))
  from unnest(array['app_current_team', 'app_current_role', 'app_current_member_id']) f;
select function_privs_are('public', 'app_has_grant', array['text'], 'anon', array[]::text[], 'anon cannot call app_has_grant');
select is(
  (select proconfig from pg_proc where oid = f::regprocedure),
  array['search_path=""'], format('%s runs with an empty search_path', f)
) from unnest(array['public.app_current_team()', 'public.app_current_role()', 'public.app_current_member_id()', 'public.app_has_grant(text)']) f;
create table public.zz_default_privileges_probe (id int);
select is(
  has_table_privilege('anon', 'public.zz_default_privileges_probe', 'select')
    or has_table_privilege('authenticated', 'public.zz_default_privileges_probe', 'select')
    or has_table_privilege('service_role', 'public.zz_default_privileges_probe', 'select'),
  false, 'a new public table gets no automatic grants (matches hosted Supabase)'
);

-- ---------- anon ----------
set local role anon;
set local request.jwt.claims to '{"role": "anon"}';
select throws_ok('select * from checkins', '42501', null, 'anon cannot read checkins');
select throws_ok('select * from members', '42501', null, 'anon cannot read members');
select throws_ok('select * from scoring_settings', '42501', null, 'anon cannot read the scoring settings');
select is(pg_temp.n($$select 1 from storage.objects where bucket_id = 'checkin-audio'$$), 0, 'anon sees no recordings');

-- ---------- member a1 ----------
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "a0000000-0000-4000-8000-0000000000a3", "role": "authenticated"}';

select is(pg_temp.n($$select 1 from checkins where id::text like 'd0000000-%'$$), 1, 'a1 sees only their own check-in');
select is(pg_temp.n($$select 1 from members where id::text like 'c0000000-%'$$), 3, 'a1 sees themselves and their two teammates');
select is(pg_temp.n($$select 1 from teams where id::text like 'b0000000-%'$$), 1, 'a1 sees only their own team');
select is(pg_temp.n('select 1 from checkin_mentions'), 0, 'a1 cannot read mentions in other people''s check-ins, even about a1');
select is(pg_temp.n($$select 1 from member_profiles where member_id = 'c0000000-0000-4000-8000-0000000000a3'$$), 1, 'a1 sees their own Big Five profile');
select is(pg_temp.n($$select 1 from member_profiles where member_id = 'c0000000-0000-4000-8000-0000000000a4'$$), 0, 'a1 cannot read teammate a2''s profile');
select is(pg_temp.n('select 1 from member_grants'), 0, 'a1 holds no grants and sees no one else''s');
select is(pg_temp.n('select 1 from scoring_settings'), 1, 'a1 can read the scoring settings (the heat-map needs them)');
select is(pg_temp.n($$select 1 from storage.objects where bucket_id = 'checkin-audio'$$), 1, 'a1 sees only their own recording');

select throws_ok(
  $$update checkins set activity_score = 5, excellence_score = 5, morale_score = 5 where member_id = 'c0000000-0000-4000-8000-0000000000a3'$$,
  '42501', null, 'a1 cannot grade their own check-in'
);
select throws_ok(
  $$update checkins set rubric_review = 'great', category = 'on track' where member_id = 'c0000000-0000-4000-8000-0000000000a3'$$,
  '42501', null, 'a1 cannot write their own review or category'
);
select throws_ok(
  $$insert into checkins (member_id, week_start, activity_score) values ('c0000000-0000-4000-8000-0000000000a3', '2026-10-12', 5)$$,
  '42501', null, 'a1 cannot file a check-in through the API'
);
select throws_ok(
  $$delete from checkins where member_id = 'c0000000-0000-4000-8000-0000000000a3'$$,
  '42501', null, 'a1 cannot delete their check-in'
);
select is(
  pg_temp.changed($$update members set role = 'hq' where id = 'c0000000-0000-4000-8000-0000000000a3'$$),
  0, 'a1 cannot change their own role'
);
select is(
  pg_temp.changed($$update members set team_id = 'b0000000-0000-4000-8000-0000000000b0' where id = 'c0000000-0000-4000-8000-0000000000a3'$$),
  0, 'a1 cannot move themselves to another team'
);
select throws_ok(
  $$update members set auth_user_id = null where id = 'c0000000-0000-4000-8000-0000000000a3'$$,
  '42501', null, 'a1 cannot touch the login link on a member row'
);
select throws_ok(
  $$insert into members (name, team_id, role) values ('ghost', 'b0000000-0000-4000-8000-0000000000a0', 'leader')$$,
  '42501', null, 'a1 cannot add a member'
);
select throws_ok(
  $$insert into teams (name) values ('mine')$$, '42501', null, 'a1 cannot create a team'
);
select is(
  pg_temp.changed($$update teams set name = 'renamed', archived_at = now() where id = 'b0000000-0000-4000-8000-0000000000a0'$$),
  0, 'a1 cannot rename or archive their team'
);
select throws_ok(
  $$insert into checkin_mentions (checkin_id, about_member_id, sentiment) values ('d0000000-0000-4000-8000-0000000000a3', 'c0000000-0000-4000-8000-0000000000a4', -2)$$,
  '42501', null, 'a1 cannot add a mention'
);
select throws_ok(
  $$insert into member_profiles (member_id, big_five) values ('c0000000-0000-4000-8000-0000000000a2', '{}')$$,
  '42501', null, 'a1 cannot write a profile'
);
select throws_ok(
  $$insert into member_grants (member_id, grant_name) values ('c0000000-0000-4000-8000-0000000000a3', 'recordings')$$,
  '42501', null, 'a1 cannot give themselves a grant'
);
select is(
  pg_temp.changed('update scoring_settings set green_threshold = 20'),
  0, 'a1 cannot change the scoring settings'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('checkin-audio', 'c0000000-0000-4000-8000-0000000000a3/2026-10-05-retake.webm')$$,
  '42501', null, 'a1 cannot write to the bucket directly, even their own folder (the server issues upload URLs)'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('checkin-audio', 'c0000000-0000-4000-8000-0000000000a4/fake.webm')$$,
  '42501', null, 'a1 cannot upload into a teammate''s folder'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('checkin-audio', 'c0000000-0000-4000-8000-0000000000a3/../c0000000-0000-4000-8000-0000000000a4/fake.webm')$$,
  '42501', null, 'a1 cannot climb out of their folder with ..'
);
select is(
  pg_temp.changed($$update storage.objects set metadata = '{"x": 1}' where bucket_id = 'checkin-audio'$$),
  0, 'a1 has no UPDATE on recordings, even their own'
);
-- Overwrite protection through Storage itself comes from the server creating upload URLs with upsert
-- off (a second upload to the same path fails). That runs inside Storage, so pgTAP can't exercise it.
select is(
  pg_temp.changed($$delete from storage.objects where bucket_id = 'checkin-audio'$$),
  0, 'a1 cannot delete recordings, even their own'
);

-- ---------- member a2: the author of a check-in sees its mentions ----------
set local request.jwt.claims to '{"sub": "a0000000-0000-4000-8000-0000000000a4", "role": "authenticated"}';
select is(pg_temp.n('select 1 from checkin_mentions'), 1, 'a2 sees the mention in their own check-in');
select is(pg_temp.n($$select 1 from storage.objects where bucket_id = 'checkin-audio'$$), 1, 'a2 sees only their own recording');

-- ---------- leader of team A ----------
set local request.jwt.claims to '{"sub": "a0000000-0000-4000-8000-0000000000a2", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from checkins where id::text like 'd0000000-%'$$), 3, 'lead_a sees team A''s three check-ins');
select is(pg_temp.n($$select 1 from checkins where id = 'd0000000-0000-4000-8000-0000000000b3'$$), 0, 'lead_a cannot see team B''s check-in');
select is(pg_temp.n('select 1 from checkin_mentions'), 1, 'lead_a sees team A''s mention, not team B''s or solo''s');
select is(pg_temp.n('select 1 from member_profiles'), 0, 'lead_a cannot read team A''s Big Five profiles');
select is(pg_temp.n($$select 1 from storage.objects where bucket_id = 'checkin-audio'$$), 0, 'lead_a cannot play team A''s recordings (they get transcripts)');
select throws_ok(
  $$update checkins set activity_score = 1 where member_id = 'c0000000-0000-4000-8000-0000000000a3'$$,
  '42501', null, 'lead_a cannot change a team member''s scores'
);
select is(
  pg_temp.changed($$update members set role = 'member' where id = 'c0000000-0000-4000-8000-0000000000a3'$$),
  0, 'lead_a cannot change roles without the admin grant'
);

-- ---------- leader of team B ----------
set local request.jwt.claims to '{"sub": "a0000000-0000-4000-8000-0000000000b2", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from checkins where id::text like 'd0000000-%'$$), 1, 'lead_b sees only team B''s check-in');
select is(pg_temp.n($$select 1 from storage.objects where bucket_id = 'checkin-audio'$$), 0, 'lead_b cannot play team B''s recording either');

-- ---------- hq, with no grants ----------
set local request.jwt.claims to '{"sub": "a0000000-0000-4000-8000-0000000000a1", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from checkins where id::text like 'd0000000-%'$$), 5, 'hq sees every check-in');
select is(pg_temp.n($$select 1 from teams where id::text like 'b0000000-%'$$), 2, 'hq sees every team');
select is(pg_temp.n($$select 1 from members where id::text like 'c0000000-%'$$), 9, 'hq sees every member');
select is(pg_temp.n($$select 1 from checkin_mentions where checkin_id::text like 'd0000000-%'$$), 3, 'hq sees every mention');
select is(pg_temp.n('select 1 from member_profiles'), 0, 'hq without the big_five grant cannot read profiles');
select is(pg_temp.n($$select 1 from storage.objects where bucket_id = 'checkin-audio'$$), 0, 'hq without the recordings grant cannot play recordings');
select throws_ok(
  $$update checkins set activity_score = 5 where id = 'd0000000-0000-4000-8000-0000000000b3'$$,
  '42501', null, 'hq cannot change scores through the API'
);
select is(
  pg_temp.changed($$update members set role = 'member' where id = 'c0000000-0000-4000-8000-0000000000a2'$$),
  0, 'hq cannot change roles without the admin grant'
);
select is(
  pg_temp.changed('update scoring_settings set green_threshold = 20'),
  0, 'hq cannot change the scoring settings without the admin grant'
);
select is(
  pg_temp.changed($$update teams set name = 'renamed' where id = 'b0000000-0000-4000-8000-0000000000b0'$$),
  0, 'hq cannot rename a team without the admin grant'
);

-- ---------- auditor: recordings + big_five grants ----------
set local request.jwt.claims to '{"sub": "a0000000-0000-4000-8000-0000000000e2", "role": "authenticated"}';
select is(
  pg_temp.n($$select 1 from storage.objects where bucket_id = 'checkin-audio' and name like 'c0000000-%'$$),
  3, 'the recordings grant lets auditor play every recording'
);
select is(
  pg_temp.n($$select 1 from member_profiles where member_id::text like 'c0000000-%'$$),
  3, 'the big_five grant lets auditor read every profile'
);
select lives_ok(
  $$insert into member_profiles (member_id, big_five) values ('c0000000-0000-4000-8000-0000000000a2', '{"openness": 3}')$$,
  'the big_five grant lets auditor add a profile'
);
select is(
  pg_temp.changed($$update member_profiles set big_five = '{"openness": 5}' where member_id = 'c0000000-0000-4000-8000-0000000000a3'$$),
  1, 'the big_five grant lets auditor edit a profile'
);
select is(pg_temp.n($$select 1 from checkins where id::text like 'd0000000-%'$$), 0, 'the grants don''t widen check-in access');
select is(pg_temp.n('select 1 from member_grants'), 2, 'auditor sees their own two grants');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('checkin-audio', 'c0000000-0000-4000-8000-0000000000b3/planted.webm')$$,
  '42501', null, 'the recordings grant doesn''t allow uploading'
);
select is(
  pg_temp.changed($$delete from storage.objects where bucket_id = 'checkin-audio'$$),
  0, 'the recordings grant doesn''t allow deleting'
);
select is(
  pg_temp.changed('update scoring_settings set green_threshold = 20'),
  0, 'auditor cannot change the scoring settings'
);

-- ---------- admin ----------
set local request.jwt.claims to '{"sub": "a0000000-0000-4000-8000-0000000000e1", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from teams where id::text like 'b0000000-%'$$), 2, 'admin sees every team');
select is(pg_temp.n($$select 1 from members where id::text like 'c0000000-%'$$), 9, 'admin sees every member');
select is(pg_temp.n($$select 1 from member_grants where member_id::text like 'c0000000-%'$$), 3, 'admin sees every grant');
select is(pg_temp.n($$select 1 from checkins where id::text like 'd0000000-%'$$), 0, 'the admin grant doesn''t widen check-in access');
select is(pg_temp.n('select 1 from member_profiles'), 0, 'the admin grant doesn''t include Big Five');
select is(pg_temp.n($$select 1 from storage.objects where bucket_id = 'checkin-audio'$$), 0, 'the admin grant doesn''t include recordings');

select lives_ok(
  $$insert into teams (name, division) values ('RLS team C', 'Studio')$$,
  'admin can create a team'
);
select is(
  pg_temp.changed($$update teams set name = 'RLS team C2', division = 'Growth' where name = 'RLS team C'$$),
  1, 'admin can rename a team and change its division'
);
select is(
  pg_temp.changed($$update teams set archived_at = now() where name = 'RLS team C2'$$),
  1, 'admin can archive a team'
);
select throws_ok(
  $$delete from teams where name = 'RLS team C2'$$,
  '42501', null, 'admin cannot delete a team (archive it instead)'
);
select lives_ok(
  $$insert into members (name, team_id, role) values ('newcomer', 'b0000000-0000-4000-8000-0000000000a0', 'member')$$,
  'admin can add a member to a team'
);
select is(
  pg_temp.changed($$update members set team_id = 'b0000000-0000-4000-8000-0000000000a0', role = 'leader' where id = 'c0000000-0000-4000-8000-0000000000b3'$$),
  1, 'admin can move a member to a team and change their role'
);
select is(
  pg_temp.changed($$update members set role = 'hq' where id = 'c0000000-0000-4000-8000-0000000000e1'$$),
  0, 'admin cannot make themselves hq (they can''t edit their own row at all)'
);
select is(
  pg_temp.changed($$update members set role = 'leader', team_id = 'b0000000-0000-4000-8000-0000000000a0' where id = 'c0000000-0000-4000-8000-0000000000e1'$$),
  0, 'admin cannot make themselves a team''s leader'
);
select throws_ok(
  $$update members set role = 'hq' where id = 'c0000000-0000-4000-8000-0000000000a4'$$,
  '42501', null, 'admin cannot make someone else hq (only the project owner can)'
);
select is(
  pg_temp.changed($$update members set role = 'member' where id = 'c0000000-0000-4000-8000-0000000000a1'$$),
  0, 'admin cannot change an hq member''s row'
);
select throws_ok(
  $$insert into members (name, role) values ('new boss', 'hq')$$,
  '42501', null, 'admin cannot add an hq member'
);
select throws_ok(
  $$update members set auth_user_id = 'a0000000-0000-4000-8000-0000000000e1' where id = 'c0000000-0000-4000-8000-0000000000a3'$$,
  '42501', null, 'admin cannot re-link a member row to another login'
);
select throws_ok(
  $$delete from members where id = 'c0000000-0000-4000-8000-0000000000b3'$$,
  '42501', null, 'admin cannot delete a member'
);
select throws_ok(
  $$insert into member_grants (member_id, grant_name) values ('c0000000-0000-4000-8000-0000000000e1', 'recordings')$$,
  '42501', null, 'admin cannot give themselves the recordings grant'
);
select is(
  pg_temp.changed($$update scoring_settings set morale_1 = 0.4, green_threshold = 13$$),
  1, 'admin can change the scoring settings'
);
select is(
  (select updated_by from scoring_settings), 'c0000000-0000-4000-8000-0000000000e1'::uuid,
  'a settings change records who made it'
);
select throws_ok(
  $$update scoring_settings set yellow_threshold = 13$$,
  '23514', null, 'the yellow threshold must stay below green'
);
select throws_ok(
  $$update scoring_settings set morale_2 = 0.3$$,
  '23514', null, 'a better score can''t count for less'
);
select throws_ok(
  $$update scoring_settings set morale_1 = 1, morale_2 = 1, morale_3 = 1, morale_4 = 1, morale_5 = 1, yellow_threshold = 1.2, green_threshold = 1.5$$,
  '23514', null, 'settings that leave a colour unreachable are refused'
);
select throws_ok(
  $$update scoring_settings set activity_5 = 'NaN'$$, '23514', null, 'NaN is refused (Postgres sorts it above every number)'
);
select throws_ok(
  $$update scoring_settings set excellence_5 = 'Infinity'$$, '22003', null, 'Infinity is refused'
);
select throws_ok(
  $$update scoring_settings set morale_5 = 5000$$, '23514', null, 'a value over 1000 is refused'
);
select throws_ok(
  $$insert into scoring_settings (id) values (2)$$, '42501', null, 'admin cannot add a second settings row'
);
select throws_ok(
  $$delete from scoring_settings$$, '42501', null, 'admin cannot delete the settings'
);

-- ---------- a member with no team ----------
set local request.jwt.claims to '{"sub": "a0000000-0000-4000-8000-0000000000d1", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from checkins where id::text like 'd0000000-%'$$), 1, 'solo sees their own check-in');
select is(pg_temp.n('select 1 from checkin_mentions'), 1, 'solo sees the mention in their own check-in (0001 hid it)');

-- ---------- signed in, but not a member ----------
set local request.jwt.claims to '{"sub": "a0000000-0000-4000-8000-0000000000c1", "role": "authenticated"}';
select is(pg_temp.n('select 1 from checkins'), 0, 'an outsider sees no check-ins');
select is(pg_temp.n('select 1 from members'), 0, 'an outsider sees no members (not even team-less ones)');
select is(pg_temp.n('select 1 from teams'), 0, 'an outsider sees no teams');
select is(pg_temp.n($$select 1 from storage.objects where bucket_id = 'checkin-audio'$$), 0, 'an outsider hears no recordings');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('checkin-audio', 'a0000000-0000-4000-8000-0000000000c1/x.webm')$$,
  '42501', null, 'an outsider cannot upload, even into a folder named after their user id'
);
select is(public.app_current_member_id(), null::uuid, 'an outsider has no member id');

-- ---------- a check-in keeps the team it was made in ----------
reset role;
set local role service_role;
insert into checkins (id, member_id, week_start) values
  ('d0000000-0000-4000-8000-000000000a31', 'c0000000-0000-4000-8000-0000000000a3', '2026-10-12');
select is(
  (select team_id from checkins where id = 'd0000000-0000-4000-8000-000000000a31'),
  'b0000000-0000-4000-8000-0000000000a0'::uuid, 'a new check-in takes the member''s current team'
);
update members set team_id = 'b0000000-0000-4000-8000-0000000000b0' where id = 'c0000000-0000-4000-8000-0000000000a3';
insert into checkins (id, member_id, week_start) values
  ('d0000000-0000-4000-8000-000000000a32', 'c0000000-0000-4000-8000-0000000000a3', '2026-10-19');
select is(
  (select array_agg(team_id::text order by week_start) from checkins where member_id = 'c0000000-0000-4000-8000-0000000000a3'),
  array['b0000000-0000-4000-8000-0000000000a0', 'b0000000-0000-4000-8000-0000000000a0', 'b0000000-0000-4000-8000-0000000000b0'],
  'after a1 moves to team B, their earlier check-ins stay in team A and new ones go to B'
);
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "a0000000-0000-4000-8000-0000000000a2", "role": "authenticated"}';
select is(
  pg_temp.n($$select 1 from checkins where member_id = 'c0000000-0000-4000-8000-0000000000a3'$$),
  2, 'lead_a still sees the check-ins a1 made in team A, not the new one'
);
select is(
  pg_temp.n($$select 1 from members where id = 'c0000000-0000-4000-8000-0000000000a3'$$),
  1, 'lead_a still sees who made those check-ins after a1 moved'
);
set local request.jwt.claims to '{"sub": "a0000000-0000-4000-8000-0000000000b2", "role": "authenticated"}';
select is(
  pg_temp.n($$select 1 from checkins where member_id = 'c0000000-0000-4000-8000-0000000000a3'$$),
  1, 'lead_b sees only the check-in a1 made in team B'
);

-- ---------- old, broad storage policies can't widen access to recordings ----------
-- Simulate policies a hosted project might already have from the dashboard templates.
reset role;
create policy zz_legacy_read_all on storage.objects for select to anon, authenticated using (true);
create policy zz_legacy_write_all on storage.objects for insert to anon, authenticated with check (true);
create policy zz_legacy_delete_all on storage.objects for delete to anon, authenticated using (true);
create policy zz_legacy_update_all on storage.objects for update to anon, authenticated using (true) with check (true);
create policy zz_legacy_buckets_all on storage.buckets for all to anon, authenticated using (true) with check (true);
set local role authenticated;
set local request.jwt.claims to '{"sub": "a0000000-0000-4000-8000-0000000000a4", "role": "authenticated"}';
select is(
  pg_temp.n($$select 1 from storage.objects where bucket_id = 'checkin-audio'$$),
  1, 'with a read-everything policy present, a2 still sees only their own recording'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('checkin-audio', 'c0000000-0000-4000-8000-0000000000a4/2026-10-05-b.webm')$$,
  '42501', null, 'with a write-everything policy present, a2 still cannot upload'
);
select is(
  pg_temp.changed($$delete from storage.objects where bucket_id = 'checkin-audio'$$),
  0, 'with a delete-everything policy present, a2 still cannot delete recordings'
);
select is(
  pg_temp.changed($$update storage.objects set name = 'c0000000-0000-4000-8000-0000000000a4/renamed.webm' where bucket_id = 'checkin-audio'$$),
  0, 'with an update-everything policy present, a2 still cannot rename or move recordings'
);
select is(
  pg_temp.changed($$update storage.buckets set public = true where id = 'checkin-audio'$$),
  0, 'with a buckets policy present, a2 still cannot make the recordings bucket public'
);
select is(
  pg_temp.changed($$delete from storage.buckets where id = 'checkin-audio'$$),
  0, 'with a buckets policy present, a2 still cannot delete the recordings bucket'
);
reset role;
set local role anon;
set local request.jwt.claims to '{"role": "anon"}';
select is(
  pg_temp.n($$select 1 from storage.objects where bucket_id = 'checkin-audio'$$),
  0, 'with a read-everything policy present, anon still sees no recordings'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('checkin-audio', 'anon.webm')$$,
  '42501', null, 'with a write-everything policy present, anon still cannot upload'
);
select is(
  pg_temp.changed($$delete from storage.objects where bucket_id = 'checkin-audio'$$),
  0, 'with a delete-everything policy present, anon still cannot delete recordings'
);
select is(
  pg_temp.changed($$update storage.buckets set public = true where id = 'checkin-audio'$$),
  0, 'with a buckets policy present, anon still cannot make the recordings bucket public'
);

-- ---------- constraints and defaults (hold for the service role too) ----------
reset role;
set local role service_role;
create temp table default_week on commit drop as
  with ins as (
    insert into checkins (member_id) values ('c0000000-0000-4000-8000-0000000000b2') returning week_start
  ) select week_start from ins;
select is(
  (select (week_start = (date_trunc('week', now() at time zone 'Asia/Singapore'))::date and extract(isodow from week_start) = 1)
   from pg_temp.default_week),
  true, 'week_start defaults to this week''s Monday in Singapore time'
);
select matches(
  (select pg_get_expr(d.adbin, d.adrelid) from pg_attrdef d
   join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
   where d.adrelid = 'public.checkins'::regclass and a.attname = 'week_start'),
  'Asia/Singapore', 'the week_start default is computed in Singapore time, not UTC'
);
select throws_ok(
  $$insert into checkins (member_id, week_start) values ('c0000000-0000-4000-8000-0000000000a4', '2026-10-07')$$,
  '23514', null, 'week_start must be a Monday'
);
select throws_ok(
  $$update checkins set morale_score = null where id = 'd0000000-0000-4000-8000-0000000000a3'$$,
  '23514', null, 'a check-in is graded on all three scores or none'
);
select throws_ok(
  $$update checkins set audio_path = 'c0000000-0000-4000-8000-0000000000a4/2026-10-05.webm' where id = 'd0000000-0000-4000-8000-0000000000a3'$$,
  '23514', null, 'a check-in cannot point at another member''s recording'
);
select throws_ok(
  $$update checkins set audio_path = '../c0000000-0000-4000-8000-0000000000a3/x.webm' where id = 'd0000000-0000-4000-8000-0000000000a3'$$,
  '23514', null, 'audio_path must start with the member''s folder'
);
select throws_ok(
  $$update checkins set audio_path = 'c0000000-0000-4000-8000-0000000000a3/../c0000000-0000-4000-8000-0000000000a4/2026-10-05.webm' where id = 'd0000000-0000-4000-8000-0000000000a3'$$,
  '23514', null, 'audio_path cannot climb into another folder with .. (Storage resolves it)'
);
select throws_ok(
  $$update checkins set audio_path = 'c0000000-0000-4000-8000-0000000000a3/%2e%2e/c0000000-0000-4000-8000-0000000000a4/2026-10-05.webm' where id = 'd0000000-0000-4000-8000-0000000000a3'$$,
  '23514', null, 'audio_path cannot climb with an encoded .. either'
);
select lives_ok(
  $$update checkins set audio_path = 'c0000000-0000-4000-8000-0000000000a3/2026-10-05.webm' where id = 'd0000000-0000-4000-8000-0000000000a3'$$,
  'a check-in can point at its own member''s recording'
);
select is(
  pg_temp.changed($$update checkins set activity_score = 4 where id = 'd0000000-0000-4000-8000-0000000000a3'$$),
  1, 'the service role (the grader) can write scores'
);

select * from finish();
rollback;
