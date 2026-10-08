-- Who can read and write what, through the Data API and Storage. Run: supabase test db
-- Builds its own fixtures inside the transaction and rolls back, so it doesn't depend on seed.sql.
--
-- Fixtures: team A (leader lead_a, members a1 and a2), team B (leader lead_b, member b1),
-- an hq member with no team, a member with no team ("solo"), and a signed-in "outsider" with no
-- members row. Check-ins: a1, a2, lead_a, b1, solo. A 360 mention in a2's check-in is about a1, one
-- in b1's is about b1, and one in solo's is about a1. Big Five profiles: a1, a2, b1.
-- Recordings in the bucket: one each in a1's, a2's and b1's folders. Only the speaker and hq can play
-- them, and nobody but the service role can write to the bucket.
begin;
select plan(92);

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-0000000000a1', 'hq@rls.test'),
  ('a0000000-0000-4000-8000-0000000000a2', 'lead-a@rls.test'),
  ('a0000000-0000-4000-8000-0000000000a3', 'a1@rls.test'),
  ('a0000000-0000-4000-8000-0000000000a4', 'a2@rls.test'),
  ('a0000000-0000-4000-8000-0000000000b2', 'lead-b@rls.test'),
  ('a0000000-0000-4000-8000-0000000000b3', 'b1@rls.test'),
  ('a0000000-0000-4000-8000-0000000000c1', 'outsider@rls.test'),
  ('a0000000-0000-4000-8000-0000000000d1', 'solo@rls.test');

insert into teams (id, name) values
  ('b0000000-0000-4000-8000-0000000000a0', 'RLS team A'),
  ('b0000000-0000-4000-8000-0000000000b0', 'RLS team B');

insert into members (id, auth_user_id, name, team_id, role) values
  ('c0000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-0000000000a1', 'hq',     null,                                   'hq'),
  ('c0000000-0000-4000-8000-0000000000a2', 'a0000000-0000-4000-8000-0000000000a2', 'lead_a', 'b0000000-0000-4000-8000-0000000000a0', 'leader'),
  ('c0000000-0000-4000-8000-0000000000a3', 'a0000000-0000-4000-8000-0000000000a3', 'a1',     'b0000000-0000-4000-8000-0000000000a0', 'member'),
  ('c0000000-0000-4000-8000-0000000000a4', 'a0000000-0000-4000-8000-0000000000a4', 'a2',     'b0000000-0000-4000-8000-0000000000a0', 'member'),
  ('c0000000-0000-4000-8000-0000000000b2', 'a0000000-0000-4000-8000-0000000000b2', 'lead_b', 'b0000000-0000-4000-8000-0000000000b0', 'leader'),
  ('c0000000-0000-4000-8000-0000000000b3', 'a0000000-0000-4000-8000-0000000000b3', 'b1',     'b0000000-0000-4000-8000-0000000000b0', 'member'),
  ('c0000000-0000-4000-8000-0000000000d1', 'a0000000-0000-4000-8000-0000000000d1', 'solo',   null,                                   'member');

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

-- Counts only fixture rows, so the seed data (or anything else in the database) doesn't matter.
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

-- ---------- schema ----------
select has_column('public', 'checkins', 'audio_path', 'checkins has audio_path');
select hasnt_column('public', 'members', 'big_five', 'big_five is no longer on the team-visible members table');
select is((select relrowsecurity from pg_class where oid = 'public.member_profiles'::regclass), true, 'member_profiles has RLS on');
select is(
  (select public from storage.buckets where id = 'checkin-audio'), false, 'the recordings bucket is private'
);

-- ---------- privileges ----------
select table_privs_are('public', t, 'anon', array[]::text[], format('anon has no privileges on %s', t))
  from unnest(array['teams', 'members', 'checkins', 'checkin_mentions', 'member_profiles']) t;
select table_privs_are('public', t, 'authenticated', array['SELECT'], format('signed-in users can only read %s', t))
  from unnest(array['teams', 'members', 'checkins', 'checkin_mentions', 'member_profiles']) t;
select function_privs_are('public', f, array[]::text[], 'anon', array[]::text[], format('anon cannot call %s', f))
  from unnest(array['app_current_team', 'app_current_role', 'app_current_member_id']) f;
select is(
  (select proconfig from pg_proc where oid = format('public.%s()', f)::regprocedure),
  array['search_path=""'], format('%s runs with an empty search_path', f)
) from unnest(array['app_current_team', 'app_current_role', 'app_current_member_id']) f;
select table_privs_are(
  'public', t, 'service_role', array['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'],
  format('the server (service_role) has full access to %s', t)
) from unnest(array['teams', 'members', 'checkins', 'checkin_mentions', 'member_profiles']) t;
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
select is(pg_temp.n($$select 1 from storage.objects where bucket_id = 'checkin-audio'$$), 0, 'anon sees no recordings');

-- ---------- member a1 ----------
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "a0000000-0000-4000-8000-0000000000a3", "role": "authenticated"}';

select is(pg_temp.n($$select 1 from checkins where id::text like 'd0000000-%'$$), 1, 'a1 sees only their own check-in');
select is(pg_temp.n($$select 1 from members where id::text like 'c0000000-%'$$), 3, 'a1 sees themselves and their two teammates');
select is(pg_temp.n($$select 1 from teams where id::text like 'b0000000-%'$$), 1, 'a1 sees only their own team');
select is(pg_temp.n('select 1 from checkin_mentions'), 0, 'a1 cannot read mentions in a teammate''s check-in, even about a1');
select is(pg_temp.n($$select 1 from member_profiles where member_id = 'c0000000-0000-4000-8000-0000000000a3'$$), 1, 'a1 sees their own profile');
select is(pg_temp.n($$select 1 from member_profiles where member_id = 'c0000000-0000-4000-8000-0000000000a4'$$), 0, 'a1 cannot read teammate a2''s profile');
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
select throws_ok(
  $$update members set role = 'hq' where id = 'c0000000-0000-4000-8000-0000000000a3'$$,
  '42501', null, 'a1 cannot change their own role'
);
select throws_ok(
  $$update members set team_id = 'b0000000-0000-4000-8000-0000000000b0' where id = 'c0000000-0000-4000-8000-0000000000a3'$$,
  '42501', null, 'a1 cannot move themselves to another team'
);
select throws_ok(
  $$insert into checkin_mentions (checkin_id, about_member_id, sentiment) values ('d0000000-0000-4000-8000-0000000000a3', 'c0000000-0000-4000-8000-0000000000a4', -2)$$,
  '42501', null, 'a1 cannot add a mention'
);
select throws_ok(
  $$insert into member_profiles (member_id, big_five) values ('c0000000-0000-4000-8000-0000000000a4', '{}')$$,
  '42501', null, 'a1 cannot write a profile'
);
select throws_ok(
  $$insert into teams (name) values ('mine')$$, '42501', null, 'a1 cannot create a team'
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
  $$insert into storage.objects (bucket_id, name) values ('checkin-audio', 'loose.webm')$$,
  '42501', null, 'a1 cannot upload outside any member folder'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('checkin-audio', 'c0000000-0000-4000-8000-0000000000a3/../c0000000-0000-4000-8000-0000000000a4/fake.webm')$$,
  '42501', null, 'a1 cannot climb out of their folder with ..'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('checkin-audio', 'c0000000-0000-4000-8000-0000000000a3/%2e%2e/c0000000-0000-4000-8000-0000000000a4/fake.webm')$$,
  '42501', null, 'a1 cannot climb out of their folder with an encoded ..'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('checkin-audio', 'c0000000-0000-4000-8000-0000000000a3/sub/x.webm')$$,
  '42501', null, 'a1 cannot create subfolders'
);
select is(
  pg_temp.changed($$update storage.objects set metadata = '{"x": 1}' where bucket_id = 'checkin-audio'$$),
  0, 'a1 has no UPDATE on recordings, even their own'
);
-- Storage blocks direct SQL deletes with a trigger unless this is set; set it so RLS alone decides.
set local storage.allow_delete_query = 'true';
select is(
  pg_temp.changed($$delete from storage.objects where bucket_id = 'checkin-audio'$$),
  0, 'a1 cannot delete recordings, even their own'
);
-- Overwrite protection through Storage itself comes from the server creating upload URLs with upsert
-- off (a second upload to the same path fails). That runs inside Storage, so pgTAP can't exercise it.

-- ---------- member a2: the author of a check-in sees its mentions ----------
set local request.jwt.claims to '{"sub": "a0000000-0000-4000-8000-0000000000a4", "role": "authenticated"}';
select is(pg_temp.n('select 1 from checkin_mentions'), 1, 'a2 sees the mention in their own check-in');
select is(pg_temp.n($$select 1 from storage.objects where bucket_id = 'checkin-audio'$$), 1, 'a2 sees only their own recording');

-- ---------- leader of team A ----------
set local request.jwt.claims to '{"sub": "a0000000-0000-4000-8000-0000000000a2", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from checkins where id::text like 'd0000000-%'$$), 3, 'lead_a sees team A''s three check-ins');
select is(pg_temp.n($$select 1 from checkins where id = 'd0000000-0000-4000-8000-0000000000b3'$$), 0, 'lead_a cannot see team B''s check-in');
select is(pg_temp.n('select 1 from checkin_mentions'), 1, 'lead_a sees team A''s mention, not team B''s');
select is(pg_temp.n('select 1 from member_profiles'), 0, 'lead_a cannot read team A''s Big Five profiles');
select is(pg_temp.n($$select 1 from storage.objects where bucket_id = 'checkin-audio'$$), 0, 'lead_a cannot play team A''s recordings (they get transcripts)');
select throws_ok(
  $$update checkins set activity_score = 1 where member_id = 'c0000000-0000-4000-8000-0000000000a3'$$,
  '42501', null, 'lead_a cannot change a team member''s scores'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('checkin-audio', 'c0000000-0000-4000-8000-0000000000a3/planted.webm')$$,
  '42501', null, 'lead_a cannot upload into a team member''s folder'
);

-- ---------- leader of team B ----------
set local request.jwt.claims to '{"sub": "a0000000-0000-4000-8000-0000000000b2", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from checkins where id::text like 'd0000000-%'$$), 1, 'lead_b sees only team B''s check-in');
select is(pg_temp.n($$select 1 from storage.objects where bucket_id = 'checkin-audio'$$), 0, 'lead_b cannot play team B''s recording either');

-- ---------- hq ----------
set local request.jwt.claims to '{"sub": "a0000000-0000-4000-8000-0000000000a1", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from checkins where id::text like 'd0000000-%'$$), 5, 'hq sees every check-in');
select is(pg_temp.n($$select 1 from teams where id::text like 'b0000000-%'$$), 2, 'hq sees every team');
select is(pg_temp.n($$select 1 from members where id::text like 'c0000000-%'$$), 7, 'hq sees every member');
select is(pg_temp.n($$select 1 from checkin_mentions where checkin_id::text like 'd0000000-%'$$), 3, 'hq sees every mention');
select is(pg_temp.n($$select 1 from member_profiles where member_id::text like 'c0000000-%'$$), 3, 'hq sees every profile');
select is(
  pg_temp.n($$select 1 from storage.objects where bucket_id = 'checkin-audio' and name like 'c0000000-%'$$),
  3, 'hq hears every recording'
);
select throws_ok(
  $$update checkins set activity_score = 5 where id = 'd0000000-0000-4000-8000-0000000000b3'$$,
  '42501', null, 'hq cannot change scores through the API either'
);
select throws_ok(
  $$update members set role = 'member' where id = 'c0000000-0000-4000-8000-0000000000a2'$$,
  '42501', null, 'hq cannot change roles through the API'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('checkin-audio', 'c0000000-0000-4000-8000-0000000000b3/planted.webm')$$,
  '42501', null, 'hq cannot upload into someone else''s folder'
);
select is(
  pg_temp.changed($$delete from storage.objects where bucket_id = 'checkin-audio'$$),
  0, 'hq cannot delete recordings through the API either'
);

-- ---------- a member with no team ----------
set local request.jwt.claims to '{"sub": "a0000000-0000-4000-8000-0000000000d1", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from checkins where id::text like 'd0000000-%'$$), 1, 'solo sees their own check-in');
select is(pg_temp.n('select 1 from checkin_mentions'), 1, 'solo sees the mention in their own check-in (0001 hid it)');

-- ---------- signed in, but not a member ----------
set local request.jwt.claims to '{"sub": "a0000000-0000-4000-8000-0000000000c1", "role": "authenticated"}';
select is(pg_temp.n('select 1 from checkins'), 0, 'an outsider sees no check-ins');
select is(pg_temp.n('select 1 from members'), 0, 'an outsider sees no members (not even the team-less hq)');
select is(pg_temp.n('select 1 from teams'), 0, 'an outsider sees no teams');
select is(pg_temp.n($$select 1 from storage.objects where bucket_id = 'checkin-audio'$$), 0, 'an outsider hears no recordings');
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('checkin-audio', 'a0000000-0000-4000-8000-0000000000c1/x.webm')$$,
  '42501', null, 'an outsider cannot upload, even into a folder named after their user id'
);
select is(public.app_current_member_id(), null::uuid, 'an outsider has no member id');

-- ---------- constraints and defaults (hold for the service role too) ----------
reset role;
set local role service_role;
create temp table default_week on commit drop as
  with ins as (
    insert into checkins (member_id) values ('c0000000-0000-4000-8000-0000000000b2') returning week_start
  ) select week_start from ins;
select throws_ok(
  $$insert into checkins (member_id, week_start) values ('c0000000-0000-4000-8000-0000000000a3', '2026-10-07')$$,
  '23514', null, 'week_start must be a Monday'
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
  $$update checkins set morale_score = null where id = 'd0000000-0000-4000-8000-0000000000a3'$$,
  '23514', null, 'a check-in is graded on all three scores or none'
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
