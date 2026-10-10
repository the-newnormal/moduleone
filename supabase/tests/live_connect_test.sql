-- A live session's one transcription connection (0012). Run: supabase test db
-- Builds its own fixtures inside the transaction and rolls back, so it doesn't depend on seed.sql.
begin;
select plan(14);

insert into auth.users (id, email) values
  ('aa000000-0000-4000-8000-000000000001', 'k1@connect.test'),
  ('aa000000-0000-4000-8000-000000000002', 'k2@connect.test');
insert into teams (id, name) values ('ba000000-0000-4000-8000-000000000001', 'Connect team');
insert into members (id, auth_user_id, name, team_id, role) values
  ('ca000000-0000-4000-8000-000000000001', 'aa000000-0000-4000-8000-000000000001', 'Mei', 'ba000000-0000-4000-8000-000000000001', 'member'),
  ('ca000000-0000-4000-8000-000000000002', 'aa000000-0000-4000-8000-000000000002', 'Arun', 'ba000000-0000-4000-8000-000000000001', 'member');

-- s1 open, s2 ended, s3 expired, s4 open (for the second member's attempt and the privilege checks).
insert into live_checkin_sessions (id, member_id, started_at, expires_at, stt_model, coach_model, coach_rubric, ended_at) values
  ('ea000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001', now(), now() + interval '15 minutes',
   'openai:gpt-live-transcribe', 'claude-haiku-5-5', 'abcdef012345', null),
  ('ea000000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-000000000001', now(), now() + interval '15 minutes',
   'openai:gpt-live-transcribe', 'claude-haiku-5-5', 'abcdef012345', now()),
  ('ea000000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-000000000001', now() - interval '20 minutes',
   now() - interval '5 minutes', 'openai:gpt-live-transcribe', 'claude-haiku-5-5', 'abcdef012345', null),
  ('ea000000-0000-4000-8000-000000000004', 'ca000000-0000-4000-8000-000000000001', now(), now() + interval '15 minutes',
   'openai:gpt-live-transcribe', 'claude-haiku-5-5', 'abcdef012345', null);

-- ---------- schema and privileges ----------
select has_column('public', 'live_checkin_sessions', 'connected_at', 'live_checkin_sessions has connected_at');
select col_type_is('public', 'live_checkin_sessions', 'connected_at', 'timestamp with time zone', 'connected_at is a timestamptz');
select col_is_null('public', 'live_checkin_sessions', 'connected_at', 'connected_at is empty until it connects');
select function_privs_are('public', 'connect_live_checkin_session', array['uuid', 'uuid'], r, array[]::text[],
    format('%s cannot call connect_live_checkin_session', r))
  from unnest(array['anon', 'authenticated']) as r;
select function_privs_are('public', 'connect_live_checkin_session', array['uuid', 'uuid'], 'service_role', array['EXECUTE'],
  'the server (service_role) can call connect_live_checkin_session');

-- ---------- connecting ----------
select is(connect_live_checkin_session('ea000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001'), true,
  'an open session of their own connects');
select is((select connected_at from live_checkin_sessions where id = 'ea000000-0000-4000-8000-000000000001'), now(),
  'and is marked connected');
select is(connect_live_checkin_session('ea000000-0000-4000-8000-000000000001', 'ca000000-0000-4000-8000-000000000001'), false,
  'but only once: a second offer opens nothing');
select is(connect_live_checkin_session('ea000000-0000-4000-8000-000000000004', 'ca000000-0000-4000-8000-000000000002'), false,
  'another member can''t connect someone else''s session');
select is((select connected_at from live_checkin_sessions where id = 'ea000000-0000-4000-8000-000000000004'), null::timestamptz,
  'which stays unconnected');
select is(connect_live_checkin_session('ea000000-0000-4000-8000-000000000002', 'ca000000-0000-4000-8000-000000000001'), false,
  'an ended session doesn''t connect');
select is(connect_live_checkin_session('ea000000-0000-4000-8000-000000000003', 'ca000000-0000-4000-8000-000000000001'), false,
  'nor does an expired one');

-- A signed-in member calling it through the API.
set local role authenticated;
set local request.jwt.claims to '{"sub": "aa000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select throws_ok(
  $$select connect_live_checkin_session('ea000000-0000-4000-8000-000000000004', 'ca000000-0000-4000-8000-000000000001')$$,
  '42501', 'permission denied for function connect_live_checkin_session', 'a member can''t open a connection themselves'
);
reset role;

select * from finish();
rollback;
