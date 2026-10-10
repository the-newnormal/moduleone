-- The live check-in's sessions and the rubric fingerprint on check-ins (0011). Run: supabase test db
-- Builds its own fixtures inside the transaction and rolls back, so it doesn't depend on seed.sql.
-- now() is fixed for the whole transaction, so a session that starts here has run for no time at
-- all: tests that need time to have passed move started_at back instead.
--
-- Fixtures (team L):
--   m1  member, a check-in last week           m2  member, a check-in two weeks ago, old sessions
--   m3  member, this week's check-in is in     m4  member, sessions 25 and 23 hours old
--   m5  member, removed at the end              hq  role hq, no team (resets a check-in)
begin;
select plan(113);

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a9000000-0000-4000-8000-000000000001', 'm1@live.test'),
  ('a9000000-0000-4000-8000-000000000002', 'm2@live.test'),
  ('a9000000-0000-4000-8000-000000000003', 'm3@live.test'),
  ('a9000000-0000-4000-8000-000000000004', 'm4@live.test'),
  ('a9000000-0000-4000-8000-000000000005', 'm5@live.test'),
  ('a9000000-0000-4000-8000-000000000006', 'hq@live.test');

insert into teams (id, name) values ('b9000000-0000-4000-8000-000000000001', 'Live team L');

insert into members (id, auth_user_id, name, team_id, role) values
  ('c9000000-0000-4000-8000-000000000001', 'a9000000-0000-4000-8000-000000000001', 'Wei Ling', 'b9000000-0000-4000-8000-000000000001', 'member'),
  ('c9000000-0000-4000-8000-000000000002', 'a9000000-0000-4000-8000-000000000002', 'Ravi',     'b9000000-0000-4000-8000-000000000001', 'member'),
  ('c9000000-0000-4000-8000-000000000003', 'a9000000-0000-4000-8000-000000000003', 'Siti',     'b9000000-0000-4000-8000-000000000001', 'member'),
  ('c9000000-0000-4000-8000-000000000004', 'a9000000-0000-4000-8000-000000000004', 'Jun Hao',  'b9000000-0000-4000-8000-000000000001', 'member'),
  ('c9000000-0000-4000-8000-000000000005', 'a9000000-0000-4000-8000-000000000005', 'Priya',    'b9000000-0000-4000-8000-000000000001', 'member'),
  ('c9000000-0000-4000-8000-000000000006', 'a9000000-0000-4000-8000-000000000006', 'hq',       null,                                   'hq');

-- The Monday of this Singapore week, worked out the same way as the column defaults.
create function pg_temp.this_week() returns date language sql stable as $$
  select (date_trunc('week', now() at time zone 'Asia/Singapore'))::date;
$$;

-- Sessions started through start_live_checkin_session, by name, since it picks their ids.
create temp table started (name text primary key, id uuid not null);
create function pg_temp.sid(n text) returns uuid language sql stable as $$
  select id from started where name = n;
$$;

grant select, insert on started to service_role;
grant execute on function pg_temp.this_week(), pg_temp.sid(text) to service_role;

insert into checkins (id, member_id, week_start, audio_path, submitted_at) values
  ('d9000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000003', pg_temp.this_week(),
   'c9000000-0000-4000-8000-000000000003/this-week.webm', now()),
  ('d9000000-0000-4000-8000-000000000002', 'c9000000-0000-4000-8000-000000000001', pg_temp.this_week() - 7, null, now() - interval '7 days'),
  ('d9000000-0000-4000-8000-000000000003', 'c9000000-0000-4000-8000-000000000002', pg_temp.this_week() - 14, null, now() - interval '14 days');

-- Sessions with a past: e9..01 and 02 count (or not) towards m4's daily limit; 03 to 07 are for the
-- daily job; 08 recorded m3's check-in; 09 is m5's; 10 is m1's, started five minutes ago; 11 is m1's,
-- left open for a month (the daily job didn't run).
insert into live_checkin_sessions
  (id, member_id, week_start, started_at, expires_at, stt_model, coach_model, coach_rubric, recorded_ms, ended_at, audio_path, checkin_id)
select id::uuid, member_id::uuid, pg_temp.this_week(), now() - started, now() - started + interval '15 minutes',
       'openai:gpt-live-transcribe', 'claude-haiku-5-5', '0123456789ab', recorded_ms,
       case when ended then now() - started + interval '10 minutes' end, audio_path, checkin_id::uuid
from (values
  ('e9000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000004', interval '25 hours',  0,     true,  null, null),
  ('e9000000-0000-4000-8000-000000000002', 'c9000000-0000-4000-8000-000000000004', interval '23 hours',  0,     true,  null, null),
  ('e9000000-0000-4000-8000-000000000003', 'c9000000-0000-4000-8000-000000000002', interval '76 minutes', 42000, false, null, null),
  ('e9000000-0000-4000-8000-000000000004', 'c9000000-0000-4000-8000-000000000002', interval '74 minutes', 0,     false, null, null),
  ('e9000000-0000-4000-8000-000000000005', 'c9000000-0000-4000-8000-000000000002', interval '15 days',   90000, true,
   'c9000000-0000-4000-8000-000000000002/never-submitted.webm', null),
  ('e9000000-0000-4000-8000-000000000006', 'c9000000-0000-4000-8000-000000000002', interval '15 days',   90000, true,  null,
   'd9000000-0000-4000-8000-000000000003'),
  ('e9000000-0000-4000-8000-000000000007', 'c9000000-0000-4000-8000-000000000002', interval '13 days',   90000, true,  null, null),
  ('e9000000-0000-4000-8000-000000000008', 'c9000000-0000-4000-8000-000000000003', interval '2 hours',   120000, true, null,
   'd9000000-0000-4000-8000-000000000001'),
  ('e9000000-0000-4000-8000-000000000009', 'c9000000-0000-4000-8000-000000000005', interval '2 days',    60000, true,  null, null),
  ('e9000000-0000-4000-8000-000000000010', 'c9000000-0000-4000-8000-000000000001', interval '5 minutes', 0,     false, null, null),
  ('e9000000-0000-4000-8000-000000000011', 'c9000000-0000-4000-8000-000000000001', interval '30 days',   0,     false, null, null)
) f (id, member_id, started, recorded_ms, ended, audio_path, checkin_id);

-- ---------- schema and privileges ----------
select has_table('public', 'live_checkin_sessions', 'live_checkin_sessions exists');
select is((select relrowsecurity from pg_class where oid = 'public.live_checkin_sessions'::regclass), true, 'RLS is on');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'live_checkin_sessions'), 0,
  'there is no policy: nobody reads it through the API');
select columns_are('public', 'live_checkin_sessions',
  array['id', 'member_id', 'week_start', 'started_at', 'expires_at', 'stt_model', 'coach_model', 'coach_rubric',
        'coach_calls', 'last_coach_at', 'coach_state', 'recorded_ms', 'ended_at', 'audio_path', 'checkin_id'],
  'live_checkin_sessions has exactly the expected columns (no transcript, no questions)');
select table_privs_are('public', 'live_checkin_sessions', 'anon', array[]::text[], 'anon has no privileges');
select table_privs_are('public', 'live_checkin_sessions', 'authenticated', array[]::text[],
  'signed-in users have no privileges, not even to read');
select table_privs_are(
  'public', 'live_checkin_sessions', 'service_role',
  array['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'],
  'the server (service_role) has full access'
);
select has_column('public', 'checkins', 'rubric_version', 'checkins has rubric_version');
select col_type_is('public', 'checkins', 'rubric_version', 'text', 'rubric_version is text');

select function_privs_are('public', f, args, r, array[]::text[], format('%s cannot call %s', r, f))
  from (values
    ('start_live_checkin_session', array['uuid', 'text', 'text', 'text', 'integer', 'integer']),
    ('claim_live_coach_call', array['uuid', 'uuid', 'integer', 'integer']),
    ('save_live_coach_state', array['uuid', 'uuid', 'integer', 'jsonb', 'integer']),
    ('end_live_checkin_session', array['uuid', 'uuid', 'integer']),
    ('tidy_live_checkin_sessions', array['integer'])
  ) fn (f, args)
  cross join unnest(array['anon', 'authenticated']) r;
select function_privs_are('public', f, args, 'service_role', array['EXECUTE'], format('the server can call %s', f))
  from (values
    ('start_live_checkin_session', array['uuid', 'text', 'text', 'text', 'integer', 'integer']),
    ('claim_live_coach_call', array['uuid', 'uuid', 'integer', 'integer']),
    ('save_live_coach_state', array['uuid', 'uuid', 'integer', 'jsonb', 'integer']),
    ('end_live_checkin_session', array['uuid', 'uuid', 'integer']),
    ('tidy_live_checkin_sessions', array['integer'])
  ) fn (f, args);
select is(has_function_privilege('public', f, 'execute'), false, format('PUBLIC cannot call %s', f))
  from unnest(array[
    'public.start_live_checkin_session(uuid,text,text,text,integer,integer)', 'public.claim_live_coach_call(uuid,uuid,integer,integer)',
    'public.save_live_coach_state(uuid,uuid,integer,jsonb,integer)', 'public.end_live_checkin_session(uuid,uuid,integer)',
    'public.tidy_live_checkin_sessions(integer)'
  ]) f;
select is((select proconfig from pg_proc where oid = f::regprocedure), array['search_path=""'],
  format('%s runs with an empty search_path', f))
  from unnest(array[
    'public.start_live_checkin_session(uuid,text,text,text,integer,integer)', 'public.claim_live_coach_call(uuid,uuid,integer,integer)',
    'public.save_live_coach_state(uuid,uuid,integer,jsonb,integer)', 'public.end_live_checkin_session(uuid,uuid,integer)',
    'public.tidy_live_checkin_sessions(integer)'
  ]) f;
select is(
  (select bool_or(prosecdef) from pg_proc where proname in (
    'start_live_checkin_session', 'claim_live_coach_call', 'save_live_coach_state', 'end_live_checkin_session',
    'tidy_live_checkin_sessions') and pronamespace = 'public'::regnamespace),
  false, 'they all run as the caller, the server'
);

-- ---------- checkins.rubric_version ----------
set local role service_role;
select lives_ok(
  $$update checkins set rubric_version = '3fa9c01b7e42' where id = 'd9000000-0000-4000-8000-000000000002'$$,
  'a check-in takes the fingerprint of the rubric that graded it'
);
select throws_ok(
  format($$update checkins set rubric_version = %L where id = 'd9000000-0000-4000-8000-000000000002'$$, v),
  '23514', null, format('rubric_version refuses %s', why)
) from (values
  ('3FA9C01B7E42', 'upper-case hex'),
  ('3fa9c01b7e4', 'eleven characters'),
  ('3fa9c01b7e42a', 'thirteen characters'),
  ('grading.md v2', 'anything but a fingerprint')
) v (v, why);
reset role;

-- ---------- starting a session ----------
set local role service_role;
select throws_ok(
  format($$select start_live_checkin_session('c9000000-0000-4000-8000-000000000001', 'openai:gpt-live-transcribe',
            'claude-haiku-5-5', '0123456789ab', %s, %s)$$, ttl, per_day),
  'P0001', 'bad_request', format('start refuses %s', why)
) from (values
  ('59', '12', 'a session shorter than a minute'),
  ('3601', '12', 'a session longer than an hour'),
  ('null', '12', 'no length'),
  ('900', '0', 'a daily limit of none'),
  ('900', '101', 'a daily limit over 100'),
  ('900', 'null', 'no daily limit')
) v (ttl, per_day, why);

insert into started values ('m1', start_live_checkin_session('c9000000-0000-4000-8000-000000000001',
  'openai:gpt-live-transcribe', 'claude-haiku-5-5', '0123456789ab', 900, 12));
select isnt(pg_temp.sid('m1'), null, 'starting returns the new session''s id (a check-in last week doesn''t stop it)');
select is((select week_start from live_checkin_sessions where id = pg_temp.sid('m1')), pg_temp.this_week(),
  'a session belongs to this Singapore week');
select is((select (started_at, expires_at)::text from live_checkin_sessions where id = pg_temp.sid('m1')),
  (now(), now() + interval '900 seconds')::text, 'it starts now and expires the given number of seconds later');
select is(
  (select (member_id, stt_model, coach_model, coach_rubric, coach_calls, last_coach_at, coach_state, recorded_ms,
           ended_at, audio_path, checkin_id)::text
     from live_checkin_sessions where id = pg_temp.sid('m1')),
  ('c9000000-0000-4000-8000-000000000001'::uuid, 'openai:gpt-live-transcribe', 'claude-haiku-5-5', '0123456789ab',
   0, null::timestamptz, '{}'::jsonb, 0, null::timestamptz, null::text, null::uuid)::text,
  'it is the member''s, names its models, and has no calls, state or recording yet'
);
select throws_ok(
  $$select start_live_checkin_session('c9000000-0000-4000-8000-000000000003', 'openai:gpt-live-transcribe',
      'claude-haiku-5-5', '0123456789ab', 900, 12)$$,
  'P0001', 'already_submitted', 'no session once this week''s check-in is in'
);
select lives_ok(
  $$insert into started values ('m4', start_live_checkin_session('c9000000-0000-4000-8000-000000000004',
      'openai:gpt-live-transcribe', 'claude-haiku-5-5', '0123456789ab', 900, 2))$$,
  'a session started over a day ago doesn''t count towards the daily limit'
);
select throws_ok(
  $$select start_live_checkin_session('c9000000-0000-4000-8000-000000000004', 'openai:gpt-live-transcribe',
      'claude-haiku-5-5', '0123456789ab', 900, 2)$$,
  'P0001', 'too_many_sessions', 'one started 23 hours ago does, so a third start in a day is refused at a limit of two'
);
select lives_ok(
  $$select start_live_checkin_session('c9000000-0000-4000-8000-000000000004', 'openai:gpt-live-transcribe',
      'claude-haiku-5-5', '0123456789ab', 900, 3)$$,
  'the limit is the server''s to set'
);
select throws_ok(
  $$select start_live_checkin_session('c9000000-0000-4000-8000-000000000005', 'openai:gpt-live-transcribe',
      'claude-haiku-5-5', 'coach.md', 900, 12)$$,
  '23514', null, 'the coach rubric is stored as its fingerprint'
);
select lives_ok(
  $$select start_live_checkin_session('c9000000-0000-4000-8000-000000000005', 'openai:gpt-live-transcribe',
      'claude-haiku-5-5', '0123456789ab', 60, 1)$$,
  'a one-minute session at a limit of one a day starts'
);
select lives_ok(
  $$select start_live_checkin_session('c9000000-0000-4000-8000-000000000005', 'openai:gpt-live-transcribe',
      'claude-haiku-5-5', '0123456789ab', 3600, 100)$$,
  'so does an hour-long one at a limit of 100'
);

-- ---------- claiming coach calls ----------
select is(
  (select (coach_state, started_at, call_number)::text
     from claim_live_coach_call(pg_temp.sid('m1'), 'c9000000-0000-4000-8000-000000000001', 120, 1000)),
  ('{}'::jsonb, now(), 1)::text,
  'the first call gets the empty state, when the session started, and call number 1'
);
select is(
  (select call_number from claim_live_coach_call(pg_temp.sid('m1'), 'c9000000-0000-4000-8000-000000000001', 120, 0)),
  2, 'with no minimum interval, a second call straight after is call 2'
);
select is((select (coach_calls, last_coach_at)::text from live_checkin_sessions where id = pg_temp.sid('m1')),
  (2, now())::text, 'the session counts its calls and remembers the latest');
select throws_ok(
  $$select * from claim_live_coach_call(pg_temp.sid('m1'), 'c9000000-0000-4000-8000-000000000001', 120, 1000)$$,
  'P0001', 'too_soon', 'a call within the minimum interval of the last is refused'
);
select throws_ok(
  $$select * from claim_live_coach_call(pg_temp.sid('m1'), 'c9000000-0000-4000-8000-000000000001', 2, 0)$$,
  'P0001', 'too_many_calls', 'a call past the cap is refused'
);
select throws_ok(
  $$select * from claim_live_coach_call(pg_temp.sid('m1'), 'c9000000-0000-4000-8000-000000000002', 120, 0)$$,
  'P0001', 'no_session', 'another member can''t use the session'
);
select throws_ok(
  $$select * from claim_live_coach_call(gen_random_uuid(), 'c9000000-0000-4000-8000-000000000001', 120, 0)$$,
  'P0001', 'no_session', 'a session that doesn''t exist is refused the same way'
);
select is((select coach_calls from live_checkin_sessions where id = pg_temp.sid('m1')), 2, 'a refused call isn''t counted');

insert into started values ('m2', start_live_checkin_session('c9000000-0000-4000-8000-000000000002',
  'openai:gpt-live-transcribe', 'claude-haiku-5-5', '0123456789ab', 900, 12));
update live_checkin_sessions set started_at = now() - interval '16 minutes', expires_at = now() - interval '1 minute'
  where id = pg_temp.sid('m2');
select throws_ok(
  $$select * from claim_live_coach_call(pg_temp.sid('m2'), 'c9000000-0000-4000-8000-000000000002', 120, 0)$$,
  'P0001', 'session_over', 'an expired session gets no more calls'
);

-- ---------- saving the coach's state ----------
-- Ten minutes into m1's session, after its second call.
update live_checkin_sessions set started_at = now() - interval '10 minutes' where id = pg_temp.sid('m1');
select is(
  save_live_coach_state(pg_temp.sid('m1'), 'c9000000-0000-4000-8000-000000000001', 2,
    '{"v": 1, "coverage": {"shipped": "clear", "team_mood": "brief"}, "tone": "positive", "asked": ["superpower"]}', 120000),
  true, 'the latest call saves its state'
);
select is(
  (select (coach_state, recorded_ms)::text from live_checkin_sessions where id = pg_temp.sid('m1')),
  ('{"v": 1, "coverage": {"shipped": "clear", "team_mood": "brief"}, "tone": "positive", "asked": ["superpower"]}'::jsonb, 120000)::text,
  'with how far into the recording it was'
);
select is(
  save_live_coach_state(pg_temp.sid('m1'), 'c9000000-0000-4000-8000-000000000001', 1, '{"v": 1, "coverage": {}}', 130000),
  false, 'a slower, earlier call doesn''t overwrite it'
);
select is(
  save_live_coach_state(pg_temp.sid('m1'), 'c9000000-0000-4000-8000-000000000001', 3, '{"v": 1, "coverage": {}}', 130000),
  false, 'nor does a call that was never claimed'
);
select is(
  save_live_coach_state(pg_temp.sid('m1'), 'c9000000-0000-4000-8000-000000000002', 2, '{"v": 1, "coverage": {}}', 130000),
  false, 'nor another member'
);
select is(
  (select (coach_state -> 'coverage' ->> 'shipped', recorded_ms)::text from live_checkin_sessions where id = pg_temp.sid('m1')),
  ('clear', 120000)::text, 'so the saved state and recording length stay as they were'
);
select is(
  save_live_coach_state(pg_temp.sid('m1'), 'c9000000-0000-4000-8000-000000000001', 2,
    '{"v": 1, "coverage": {"shipped": "clear", "team_mood": "clear"}, "tone": "positive"}', 60000),
  true, 'a save that reports less of the recording still saves its state'
);
select is((select recorded_ms from live_checkin_sessions where id = pg_temp.sid('m1')), 120000,
  'but the recording length never goes down');
select is(
  save_live_coach_state(pg_temp.sid('m1'), 'c9000000-0000-4000-8000-000000000001', 2,
    '{"v": 1, "coverage": {"shipped": "clear", "team_mood": "clear"}, "tone": "positive"}', 3600000),
  true, 'a save that reports an hour of recording saves'
);
select is((select recorded_ms from live_checkin_sessions where id = pg_temp.sid('m1')), 600000,
  'but the length is capped at the ten minutes since the session started');
select throws_ok(
  format($$select save_live_coach_state(pg_temp.sid('m1'), 'c9000000-0000-4000-8000-000000000001', 2, %s, 1000)$$, state),
  'P0001', 'bad_request', format('a state that is %s is refused', why)
) from (values
  ($$'[]'::jsonb$$, 'a list'),
  ($$'"clear"'::jsonb$$, 'a string'),
  ($$'null'::jsonb$$, 'JSON null'),
  ('null', 'missing')
) v (state, why);

-- ---------- ending a session ----------
select is(
  end_live_checkin_session('e9000000-0000-4000-8000-000000000010', 'c9000000-0000-4000-8000-000000000002', 1000),
  null, 'another member can''t end it'
);
select is(
  end_live_checkin_session('e9000000-0000-4000-8000-000000000010', 'c9000000-0000-4000-8000-000000000001', 3600000),
  300000, 'ending returns how long the recording ran, capped at the five minutes since it started'
);
select is(
  (select (ended_at, recorded_ms)::text from live_checkin_sessions where id = 'e9000000-0000-4000-8000-000000000010'),
  (now(), 300000)::text, 'the session is ended with that length'
);
select is(
  end_live_checkin_session('e9000000-0000-4000-8000-000000000010', 'c9000000-0000-4000-8000-000000000001', 1000),
  null, 'ending it again returns nothing, so its minutes are logged once'
);
select is(
  end_live_checkin_session(pg_temp.sid('m1'), 'c9000000-0000-4000-8000-000000000001', 0),
  600000, 'a browser that reports no length still ends with what the coach last heard'
);
select is(
  end_live_checkin_session('e9000000-0000-4000-8000-000000000011', 'c9000000-0000-4000-8000-000000000001', 3600000),
  3600000, 'a session left open for a month still ends, at an hour at most'
);
select throws_ok(
  $$select * from claim_live_coach_call(pg_temp.sid('m1'), 'c9000000-0000-4000-8000-000000000001', 120, 0)$$,
  'P0001', 'session_over', 'an ended session gets no more calls'
);
select is(
  save_live_coach_state(pg_temp.sid('m1'), 'c9000000-0000-4000-8000-000000000001', 2, '{"v": 1, "coverage": {}}', 1000),
  false, 'and saves no more state'
);

-- ---------- the daily job ----------
create temp table tidied as select * from tidy_live_checkin_sessions();
select is(
  (select array_agg((session_id, stt_model, recorded_ms)::text) from tidied
    where session_id::text like 'e9%' or session_id in (select id from started)),
  array[('e9000000-0000-4000-8000-000000000003'::uuid, 'openai:gpt-live-transcribe', 42000)::text],
  'it ends a session the browser left open an hour past its expiry, with the length the coach last heard'
);
select is((select ended_at from live_checkin_sessions where id = 'e9000000-0000-4000-8000-000000000003'), now(),
  'that session is ended');
select is((select ended_at from live_checkin_sessions where id = 'e9000000-0000-4000-8000-000000000004'), null,
  'one that expired under an hour ago stays open');
select is((select count(*)::int from live_checkin_sessions where id = 'e9000000-0000-4000-8000-000000000005'), 0,
  'a session whose take never became a check-in is deleted after 14 days');
select is((select count(*)::int from live_checkin_sessions where id = 'e9000000-0000-4000-8000-000000000006'), 1,
  'one linked to its check-in is kept');
select is((select count(*)::int from live_checkin_sessions where id = 'e9000000-0000-4000-8000-000000000007'), 1,
  'and so is an unsubmitted one under 14 days old');
select is(
  (select count(*)::int from tidy_live_checkin_sessions() where session_id::text like 'e9%' or session_id in (select id from started)),
  0, 'a second run ends nothing twice'
);

-- ---------- the take and the check-in ----------
select lives_ok(
  $$update live_checkin_sessions set audio_path = 'c9000000-0000-4000-8000-000000000001/' || to_char(pg_temp.this_week(), 'YYYY-MM-DD') || '-live.webm'
    where id = 'e9000000-0000-4000-8000-000000000010'$$,
  'a session is linked to its take in the member''s own folder'
);
select throws_ok(
  format($$update live_checkin_sessions set audio_path = %L where id = 'e9000000-0000-4000-8000-000000000010'$$, path),
  '23514', null, format('a session''s take cannot be %s', why)
) from (values
  ('c9000000-0000-4000-8000-000000000002/take.webm', 'in another member''s folder'),
  ('c9000000-0000-4000-8000-000000000001/../c9000000-0000-4000-8000-000000000002/take.webm', 'outside the member''s folder'),
  ('c9000000-0000-4000-8000-000000000001/..', 'the folder above'),
  ('take.webm', 'in no folder')
) v (path, why);
reset role;

-- A Master Admin resets m3's check-in, which session e9..08 recorded.
set local role authenticated;
set local request.jwt.claims to '{"sub": "a9000000-0000-4000-8000-000000000006", "role": "authenticated"}';
select lives_ok($$select * from hq_reset_checkin('d9000000-0000-4000-8000-000000000001')$$, 'hq resets m3''s check-in');
reset role;
select is(
  (select (checkin_id is null, recorded_ms)::text from live_checkin_sessions where id = 'e9000000-0000-4000-8000-000000000008'),
  (true, 120000)::text, 'the session stays, no longer linked to the deleted check-in'
);

select is((select count(*)::int from live_checkin_sessions where member_id = 'c9000000-0000-4000-8000-000000000005'), 3,
  'm5 has three sessions');
delete from members where id = 'c9000000-0000-4000-8000-000000000005';
select is((select count(*)::int from live_checkin_sessions where member_id = 'c9000000-0000-4000-8000-000000000005'), 0,
  'deleting a member deletes their sessions');

-- ---------- nobody else reads or writes it ----------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a9000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select throws_ok($$select * from live_checkin_sessions$$, '42501', 'permission denied for table live_checkin_sessions',
  'a member can''t read their own sessions: the coach''s working stays on the server');
select throws_ok(
  $$insert into live_checkin_sessions (member_id, expires_at, stt_model, coach_model, coach_rubric)
    values ('c9000000-0000-4000-8000-000000000001', now() + interval '1 hour', 'x', 'x', '0123456789ab')$$,
  '42501', 'permission denied for table live_checkin_sessions', 'a member can''t start a session directly'
);
select throws_ok($$update live_checkin_sessions set coach_calls = 0$$, '42501', 'permission denied for table live_checkin_sessions',
  'a member can''t reset their call count');
select throws_ok($$delete from live_checkin_sessions$$, '42501', 'permission denied for table live_checkin_sessions',
  'a member can''t delete sessions');
select throws_ok(
  $$select start_live_checkin_session('c9000000-0000-4000-8000-000000000001', 'x', 'x', '0123456789ab', 900, 100)$$,
  '42501', 'permission denied for function start_live_checkin_session', 'a member can''t call start_live_checkin_session'
);
select throws_ok(
  $$select * from claim_live_coach_call('e9000000-0000-4000-8000-000000000010', 'c9000000-0000-4000-8000-000000000001', 1000, 0)$$,
  '42501', 'permission denied for function claim_live_coach_call', 'a member can''t claim coach calls'
);
select is((select rubric_version from checkins where id = 'd9000000-0000-4000-8000-000000000002'), '3fa9c01b7e42',
  'a member sees which rubric graded their check-in');

set local request.jwt.claims to '{"sub": "a9000000-0000-4000-8000-000000000006", "role": "authenticated"}';
select throws_ok($$select * from live_checkin_sessions$$, '42501', 'permission denied for table live_checkin_sessions',
  'nor can a Master Admin');

set local role anon;
set local request.jwt.claims to '{"role": "anon"}';
select throws_ok($$select * from live_checkin_sessions$$, '42501', 'permission denied for table live_checkin_sessions',
  'nor can a signed-out visitor');
reset role;

select * from finish();
rollback;
