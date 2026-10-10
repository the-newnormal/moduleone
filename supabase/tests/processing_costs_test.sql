-- The processing cost log (0008). Run: supabase test db
-- Builds its own fixtures inside the transaction and rolls back, so it doesn't depend on seed.sql.
--
-- Fixtures: admin (grant admin), hq (role hq, no grants), m1 (a member with a check-in),
-- outsider (signed in, no members row), and a live session's id (0011; not a foreign key, so no row).
begin;
select plan(32);

insert into auth.users (id, email) values
  ('a7000000-0000-4000-8000-000000000001', 'admin@costs.test'),
  ('a7000000-0000-4000-8000-000000000002', 'hq@costs.test'),
  ('a7000000-0000-4000-8000-000000000003', 'm1@costs.test'),
  ('a7000000-0000-4000-8000-000000000004', 'outsider@costs.test');

insert into teams (id, name) values ('b7000000-0000-4000-8000-000000000001', 'Costs team');

insert into members (id, auth_user_id, name, team_id, role) values
  ('c7000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', 'admin', null, 'leader'),
  ('c7000000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-000000000002', 'hq', null, 'hq'),
  ('c7000000-0000-4000-8000-000000000003', 'a7000000-0000-4000-8000-000000000003', 'm1', 'b7000000-0000-4000-8000-000000000001', 'member');

insert into member_grants (member_id, grant_name) values ('c7000000-0000-4000-8000-000000000001', 'admin');

insert into checkins (id, member_id) values
  ('d7000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000003');

-- The message a row breaking the named check constraint gets, so each test shows which rule refused it.
create function pg_temp.violates(c text) returns text language sql immutable as $$
  select format('new row for relation "processing_costs" violates check constraint "%s"', c);
$$;
grant execute on function pg_temp.violates(text) to service_role;

-- ---------- schema and privileges ----------
select has_table('public', 'processing_costs', 'processing_costs exists');
select is((select relrowsecurity from pg_class where oid = 'public.processing_costs'::regclass), true, 'RLS is on');
select columns_are('public', 'processing_costs',
  array['id', 'checkin_id', 'live_session_id', 'step', 'model', 'audio_ms', 'input_tokens', 'output_tokens',
        'cache_read_tokens', 'cache_write_tokens', 'created_at'],
  'processing_costs has exactly the expected columns (no transcript, grade or member)');
select table_privs_are('public', 'processing_costs', 'anon', array[]::text[], 'anon has no privileges');
select table_privs_are('public', 'processing_costs', 'authenticated', array['SELECT'], 'signed-in users only read');
select table_privs_are(
  'public', 'processing_costs', 'service_role',
  array['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'],
  'the server (service_role) has full access'
);

-- ---------- the server writes ----------
set local role service_role;
select lives_ok(
  $$insert into processing_costs (checkin_id, step, model, audio_ms)
    values ('d7000000-0000-4000-8000-000000000001', 'transcription', 'openai:gpt-4o-transcribe', 95000)$$,
  'the server logs a transcription'
);
select lives_ok(
  $$insert into processing_costs (checkin_id, step, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
    values ('d7000000-0000-4000-8000-000000000001', 'grading', 'claude-haiku-5-5', 40, 300, 1500, 0)$$,
  'the server logs a grading'
);
select lives_ok(
  $$insert into processing_costs (live_session_id, step, model, audio_ms)
    values ('e7000000-0000-4000-8000-000000000001', 'live_transcription', 'openai:gpt-live-transcribe', 182000)$$,
  'the server logs a live session''s transcription minutes'
);
select lives_ok(
  $$insert into processing_costs (live_session_id, step, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
    values ('e7000000-0000-4000-8000-000000000001', 'coaching', 'claude-haiku-5-5', 120, 60, 2400, 0)$$,
  'the server logs a coach call'
);
select throws_ok(
  $$insert into processing_costs (checkin_id, step, model, audio_ms) values (gen_random_uuid(), 'grading', 'claude-haiku-5-5', 1000)$$,
  '23514', null, 'a grading row needs its tokens and no audio'
);
select throws_ok(
  $$insert into processing_costs (checkin_id, step, model, audio_ms, input_tokens) values (gen_random_uuid(), 'transcription', 'openai:whisper-1', 1000, 5)$$,
  '23514', null, 'a transcription row has no tokens'
);
select throws_ok(
  $$insert into processing_costs (checkin_id, step, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
    values (gen_random_uuid(), 'grading', 'claude-haiku-5-5', -1, 0, 0, 0)$$,
  '23514', null, 'token counts are never negative'
);
select throws_ok(
  $$insert into processing_costs (live_session_id, step, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
    values (gen_random_uuid(), 'summary', 'x', 1, 1, 0, 0)$$,
  '23514', pg_temp.violates('processing_costs_step_check'),
  'only transcription, grading, live transcription and coaching are logged'
);

-- A check-in's steps name the check-in, and only that; a live session's name the session, and only that.
select throws_ok(
  $$insert into processing_costs (step, model, audio_ms) values ('transcription', 'openai:whisper-1', 1)$$,
  '23514', pg_temp.violates('processing_costs_subject'), 'a transcription row names its check-in'
);
select throws_ok(
  $$insert into processing_costs (step, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
    values ('grading', 'claude-haiku-5-5', 1, 1, 0, 0)$$,
  '23514', pg_temp.violates('processing_costs_subject'), 'a grading row names its check-in'
);
select throws_ok(
  $$insert into processing_costs (checkin_id, live_session_id, step, model, audio_ms)
    values (gen_random_uuid(), gen_random_uuid(), 'transcription', 'openai:whisper-1', 1)$$,
  '23514', pg_temp.violates('processing_costs_subject'), 'a transcription row names no live session'
);
select throws_ok(
  $$insert into processing_costs (checkin_id, live_session_id, step, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
    values (gen_random_uuid(), gen_random_uuid(), 'grading', 'claude-haiku-5-5', 1, 1, 0, 0)$$,
  '23514', pg_temp.violates('processing_costs_subject'), 'a grading row names no live session'
);
select throws_ok(
  $$insert into processing_costs (step, model, audio_ms) values ('live_transcription', 'openai:gpt-live-transcribe', 1)$$,
  '23514', pg_temp.violates('processing_costs_subject'), 'a live transcription row names its live session'
);
select throws_ok(
  $$insert into processing_costs (checkin_id, live_session_id, step, model, audio_ms)
    values (gen_random_uuid(), gen_random_uuid(), 'live_transcription', 'openai:gpt-live-transcribe', 1)$$,
  '23514', pg_temp.violates('processing_costs_subject'), 'a live transcription row names no check-in'
);
select throws_ok(
  $$insert into processing_costs (checkin_id, step, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
    values (gen_random_uuid(), 'coaching', 'claude-haiku-5-5', 1, 1, 0, 0)$$,
  '23514', pg_temp.violates('processing_costs_subject'), 'a coaching row names its live session, not a check-in'
);
select throws_ok(
  $$insert into processing_costs (checkin_id, live_session_id, step, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
    values (gen_random_uuid(), gen_random_uuid(), 'coaching', 'claude-haiku-5-5', 1, 1, 0, 0)$$,
  '23514', pg_temp.violates('processing_costs_subject'), 'a coaching row names no check-in'
);

-- A live transcription is billed on audio, a coach call on tokens.
select throws_ok(
  $$insert into processing_costs (live_session_id, step, model, audio_ms, input_tokens)
    values (gen_random_uuid(), 'live_transcription', 'openai:gpt-live-transcribe', 1000, 5)$$,
  '23514', pg_temp.violates('processing_costs_step_fields'), 'a live transcription row has no tokens'
);
select throws_ok(
  $$insert into processing_costs (live_session_id, step, model, input_tokens, output_tokens)
    values (gen_random_uuid(), 'coaching', 'claude-haiku-5-5', 120, 60)$$,
  '23514', pg_temp.violates('processing_costs_step_fields'), 'a coaching row needs all four token counts'
);
select throws_ok(
  $$insert into processing_costs (live_session_id, step, model, audio_ms, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
    values (gen_random_uuid(), 'coaching', 'claude-haiku-5-5', 1000, 120, 60, 0, 0)$$,
  '23514', pg_temp.violates('processing_costs_step_fields'), 'a coaching row has no audio'
);
reset role;

-- ---------- who reads ----------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a7000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is((select count(*)::int from processing_costs where checkin_id = 'd7000000-0000-4000-8000-000000000001'), 2,
  'an admin reads the cost log');
select is((select count(*)::int from processing_costs where live_session_id = 'e7000000-0000-4000-8000-000000000001'), 2,
  'an admin reads a live session''s costs');
select throws_ok(
  $$insert into processing_costs (checkin_id, step, model, audio_ms) values (gen_random_uuid(), 'transcription', 'openai:whisper-1', 1)$$,
  '42501', null, 'not even an admin writes it through the API'
);

set local request.jwt.claims to '{"sub": "a7000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select is((select count(*)::int from processing_costs), 0, 'hq without the admin grant sees nothing');

set local request.jwt.claims to '{"sub": "a7000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is((select count(*)::int from processing_costs), 0, 'a member doesn''t see the cost of their own check-in');

set local request.jwt.claims to '{"sub": "a7000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select is((select count(*)::int from processing_costs), 0, 'a login with no member row sees nothing');
reset role;

-- ---------- history outlives the check-in ----------
delete from checkins where id = 'd7000000-0000-4000-8000-000000000001';
select is((select count(*)::int from processing_costs where checkin_id = 'd7000000-0000-4000-8000-000000000001'), 2,
  'deleting a check-in keeps its costs, still grouped by its id, for the month''s total and count');

select * from finish();
rollback;
