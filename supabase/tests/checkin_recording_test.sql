-- Recording drafts, submitting, processing claims and privacy notices (0004). Run: supabase test db
-- Builds its own fixtures inside the transaction and rolls back, so it doesn't depend on seed.sql.
--
-- Fixtures:
--   team R: leader lead_r, members m1 and m2      hq      role hq, no team, no grants
--   auditor no team, recordings grant             outsider signed in, but no members row
begin;
select plan(89);

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a1000000-0000-4000-8000-000000000001', 'lead-r@rec.test'),
  ('a1000000-0000-4000-8000-000000000002', 'm1@rec.test'),
  ('a1000000-0000-4000-8000-000000000003', 'm2@rec.test'),
  ('a1000000-0000-4000-8000-000000000004', 'hq@rec.test'),
  ('a1000000-0000-4000-8000-000000000005', 'auditor@rec.test'),
  ('a1000000-0000-4000-8000-000000000006', 'outsider@rec.test');

insert into teams (id, name) values ('b1000000-0000-4000-8000-000000000001', 'Recording team R');

insert into members (id, auth_user_id, name, team_id, role) values
  ('c1000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'lead_r',  'b1000000-0000-4000-8000-000000000001', 'leader'),
  ('c1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000002', 'm1',      'b1000000-0000-4000-8000-000000000001', 'member'),
  ('c1000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000003', 'm2',      'b1000000-0000-4000-8000-000000000001', 'member'),
  ('c1000000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000004', 'hq',      null,                                   'hq'),
  ('c1000000-0000-4000-8000-000000000005', 'a1000000-0000-4000-8000-000000000005', 'auditor', null,                                   'member');

insert into member_grants (member_id, grant_name) values ('c1000000-0000-4000-8000-000000000005', 'recordings');

-- The Monday of this Singapore week, worked out the same way as the column defaults.
create function pg_temp.this_week() returns date language sql stable as $$
  select (date_trunc('week', now() at time zone 'Asia/Singapore'))::date;
$$;

-- Counts rows the caller can see. Queries filter to fixture ids, so seed data doesn't matter.
create function pg_temp.n(sql text) returns int language plpgsql as $$
declare result int;
begin
  execute format('select count(*) from (%s) q', sql) into result;
  return result;
end $$;

grant execute on function pg_temp.n(text), pg_temp.this_week() to anon, authenticated, service_role;

-- ---------- schema and privileges ----------
select has_table('public', 'checkin_drafts', 'checkin_drafts exists');
select has_table('public', 'recording_notices', 'recording_notices exists');
select is(
  (select bool_and(relrowsecurity) from pg_class where oid in ('public.checkin_drafts'::regclass, 'public.recording_notices'::regclass)),
  true, 'RLS is on for checkin_drafts and recording_notices'
);
select columns_are('public', 'checkin_drafts',
  array['member_id', 'week_start', 'audio_path', 'mime_type', 'duration_ms', 'created_at'],
  'checkin_drafts has exactly the expected columns');
select has_column('public', 'checkins', c, format('checkins has %s', c))
  from unnest(array['submitted_at', 'audio_duration_ms', 'transcript_model', 'transcript_warnings', 'grader_model', 'graded_at',
                    'processing_started_at', 'processing_attempts', 'processing_error']) c;
select table_privs_are('public', t, 'anon', array[]::text[], format('anon has no privileges on %s', t))
  from unnest(array['checkin_drafts', 'recording_notices']) t;
select table_privs_are('public', t, 'authenticated', array['SELECT'], format('signed-in users only read %s', t))
  from unnest(array['checkin_drafts', 'recording_notices']) t;
select table_privs_are(
  'public', t, 'service_role', array['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'],
  format('the server (service_role) has full access to %s', t)
) from unnest(array['checkin_drafts', 'recording_notices']) t;
select function_privs_are('public', f, args, r, array[]::text[], format('%s cannot call %s', r, f))
  from (values
    ('save_checkin_draft', array['uuid', 'text', 'text', 'integer']),
    ('delete_checkin_draft', array['uuid']),
    ('submit_checkin_draft', array['uuid']),
    ('claim_checkin_processing', array['uuid'])
  ) fn (f, args)
  cross join unnest(array['anon', 'authenticated']) r;
select function_privs_are('public', f, args, 'service_role', array['EXECUTE'], format('the server can call %s', f))
  from (values
    ('save_checkin_draft', array['uuid', 'text', 'text', 'integer']),
    ('delete_checkin_draft', array['uuid']),
    ('submit_checkin_draft', array['uuid']),
    ('claim_checkin_processing', array['uuid'])
  ) fn (f, args);
select function_privs_are('public', 'app_checkin_audio_is_draft', array['text'], 'anon', array[]::text[],
  'anon cannot call app_checkin_audio_is_draft');
select is(
  (select proconfig from pg_proc where oid = f::regprocedure),
  array['search_path=""'], format('%s runs with an empty search_path', f)
) from unnest(array[
  'public.app_checkin_audio_is_draft(text)', 'public.save_checkin_draft(uuid,text,text,integer)',
  'public.delete_checkin_draft(uuid)', 'public.submit_checkin_draft(uuid)', 'public.claim_checkin_processing(uuid)'
]) f;

-- ---------- the server saves, replaces and deletes drafts ----------
set local role service_role;

select is(
  save_checkin_draft('c1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002/take-1.webm', 'audio/webm', 61000),
  null, 'a first take replaces nothing'
);
select is(
  (select week_start from checkin_drafts where member_id = 'c1000000-0000-4000-8000-000000000002'),
  pg_temp.this_week(), 'a draft belongs to this Singapore week'
);
select is(
  save_checkin_draft('c1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002/take-2.webm', 'audio/webm', 59000),
  'c1000000-0000-4000-8000-000000000002/take-1.webm', 'a new take returns the replaced one, for the server to delete'
);
select is(
  (select audio_path from checkin_drafts where member_id = 'c1000000-0000-4000-8000-000000000002'),
  'c1000000-0000-4000-8000-000000000002/take-2.webm', 'one draft per member per week: the latest take'
);
select is(
  save_checkin_draft('c1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002/take-2.webm', 'audio/webm', 59000),
  null, 'saving the same take again returns nothing to delete'
);
select throws_ok(
  $$select save_checkin_draft('c1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000003/take.webm', 'audio/webm', null)$$,
  '23514', null, 'a draft cannot point at another member''s folder'
);
select throws_ok(
  $$select save_checkin_draft('c1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002/../c1000000-0000-4000-8000-000000000003/take.webm', 'audio/webm', null)$$,
  '23514', null, 'a draft path cannot climb out of the member''s folder'
);
select throws_ok(
  $$select save_checkin_draft('c1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002/take-3.webm', 'video/webm', null)$$,
  '23514', null, 'a draft must be audio'
);
select is(
  delete_checkin_draft('c1000000-0000-4000-8000-000000000002'),
  'c1000000-0000-4000-8000-000000000002/take-2.webm', 'deleting a draft returns its recording, for the server to delete'
);
select is(
  pg_temp.n($$select 1 from checkin_drafts where member_id = 'c1000000-0000-4000-8000-000000000002'$$),
  0, 'the draft is gone'
);
select is(delete_checkin_draft('c1000000-0000-4000-8000-000000000002'), null, 'deleting when there is no draft returns nothing');

-- ---------- submitting ----------
select throws_ok(
  $$select submit_checkin_draft('c1000000-0000-4000-8000-000000000002')$$,
  'P0001', 'no_draft', 'nothing to submit without a draft'
);
select lives_ok(
  $$select save_checkin_draft('c1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002/take-4.webm', 'audio/webm', 70000)$$,
  'm1 records again'
);
create temp table submitted as
  select submit_checkin_draft('c1000000-0000-4000-8000-000000000002') as id;
select isnt((select id from submitted), null, 'submitting returns the new check-in');
select is(
  (select (week_start, team_id, audio_path, audio_duration_ms, submitted_at is not null, activity_score is null)::text
     from checkins where id = (select id from submitted)),
  (pg_temp.this_week(), 'b1000000-0000-4000-8000-000000000001'::uuid,
   'c1000000-0000-4000-8000-000000000002/take-4.webm', 70000, true, true)::text,
  'the check-in takes this week, the member''s team, the recording, its length and the submit time, ungraded'
);
select is(
  pg_temp.n($$select 1 from checkin_drafts where member_id = 'c1000000-0000-4000-8000-000000000002'$$),
  0, 'submitting removes the draft'
);
select throws_ok(
  $$select submit_checkin_draft('c1000000-0000-4000-8000-000000000002')$$,
  'P0001', 'already_submitted', 'a week is submitted once'
);
select throws_ok(
  $$select save_checkin_draft('c1000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000002/retake.webm', 'audio/webm', null)$$,
  'P0001', 'already_submitted', 'no retake after submitting'
);

-- ---------- processing claims ----------
select is(
  (select attempts from claim_checkin_processing((select id from submitted))),
  1, 'the first claim gets attempt 1'
);
select is(
  pg_temp.n(format('select 1 from claim_checkin_processing(%L)', (select id from submitted))),
  0, 'no second claim while an attempt is running'
);
update checkins set processing_error = 'transcription_failed: test' where id = (select id from submitted);
select is(
  (select attempts from claim_checkin_processing((select id from submitted))),
  2, 'a failed attempt can be retried straight away'
);
select is(
  (select processing_error from checkins where id = (select id from submitted)),
  null, 'a new claim clears the last error'
);
update checkins set processing_started_at = now() - interval '11 minutes' where id = (select id from submitted);
select is(
  (select attempts from claim_checkin_processing((select id from submitted))),
  3, 'an attempt that stalled for 10 minutes can be claimed again'
);
update checkins set processing_attempts = 5, processing_error = 'grading_api: test' where id = (select id from submitted);
select is(
  pg_temp.n(format('select 1 from claim_checkin_processing(%L)', (select id from submitted))),
  0, 'no more than five attempts'
);
update checkins
  set processing_attempts = 1, processing_error = null, graded_at = now(),
      activity_score = 3, excellence_score = 3, morale_score = 3, category = 'growth'
  where id = (select id from submitted);
select is(
  pg_temp.n(format('select 1 from claim_checkin_processing(%L)', (select id from submitted))),
  0, 'a graded check-in is never processed again'
);
select throws_ok(
  format($$update checkins set category = 'green' where id = %L$$, (select id from submitted)),
  '23514', null, 'category is a theme, never a colour'
);
select throws_ok(
  format($$update checkins set category = 'on track' where id = %L$$, (select id from submitted)),
  '23514', null, 'category is one of the five themes'
);

-- m2 keeps a draft for the visibility checks below; m1's submitted recording and m2's draft are in
-- Storage. A privacy-notice acknowledgement for m1.
select lives_ok(
  $$select save_checkin_draft('c1000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000003/draft.webm', 'audio/webm', 30000)$$,
  'm2 records a draft'
);
insert into storage.objects (bucket_id, name) values
  ('checkin-audio', 'c1000000-0000-4000-8000-000000000002/take-4.webm'),
  ('checkin-audio', 'c1000000-0000-4000-8000-000000000003/draft.webm');
insert into recording_notices (member_id, notice_version) values ('c1000000-0000-4000-8000-000000000002', 'test.openai');
reset role;

-- ---------- m2: their own draft only, no writes ----------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000003", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from checkin_drafts where member_id::text like 'c1000000-%'$$), 1, 'm2 sees their own draft');
select is(pg_temp.n($$select 1 from recording_notices where member_id::text like 'c1000000-%'$$), 0, 'm2 sees no one else''s notice');
select is(
  pg_temp.n($$select 1 from storage.objects where bucket_id = 'checkin-audio' and name like 'c1000000-0000-4000-8000-000000000003/%'$$),
  1, 'm2 can play their own draft'
);
select throws_ok(
  $$insert into checkin_drafts (member_id, audio_path, mime_type) values ('c1000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000003/x.webm', 'audio/webm')$$,
  '42501', null, 'm2 cannot write a draft directly'
);
select throws_ok(
  $$update checkin_drafts set audio_path = 'c1000000-0000-4000-8000-000000000003/y.webm'$$,
  '42501', null, 'm2 cannot change a draft directly'
);
select throws_ok($$delete from checkin_drafts$$, '42501', null, 'm2 cannot delete a draft directly');
select throws_ok(
  $$insert into recording_notices (member_id, notice_version) values ('c1000000-0000-4000-8000-000000000003', 'x')$$,
  '42501', null, 'm2 cannot record a notice acknowledgement directly'
);
select throws_ok(
  $$select submit_checkin_draft('c1000000-0000-4000-8000-000000000003')$$,
  '42501', null, 'm2 cannot call submit_checkin_draft'
);
select throws_ok(
  $$select save_checkin_draft('c1000000-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000003/z.webm', 'audio/webm', null)$$,
  '42501', null, 'm2 cannot call save_checkin_draft'
);
select throws_ok(
  $$select * from claim_checkin_processing('00000000-0000-4000-8000-000000000000')$$,
  '42501', null, 'm2 cannot claim processing'
);
select throws_ok(
  $$update checkins set submitted_at = now(), graded_at = now() where member_id = 'c1000000-0000-4000-8000-000000000003'$$,
  '42501', null, 'm2 cannot write the new check-in columns'
);

-- ---------- m1: their own notice and submitted check-in ----------
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from checkin_drafts where member_id::text like 'c1000000-%'$$), 0, 'm1 cannot see m2''s draft');
select is(pg_temp.n($$select 1 from recording_notices where member_id::text like 'c1000000-%'$$), 1, 'm1 sees their own notice acknowledgement');
select is(
  pg_temp.n($$select 1 from storage.objects where bucket_id = 'checkin-audio' and name like 'c1000000-%'$$),
  1, 'm1 can play only their own recording'
);

-- ---------- leader, hq, auditor: no drafts ----------
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from checkin_drafts where member_id::text like 'c1000000-%'$$), 0, 'lead_r cannot see the team''s drafts');
select is(
  pg_temp.n($$select 1 from checkins where member_id::text like 'c1000000-%' and submitted_at is not null$$),
  1, 'lead_r sees the team''s submitted check-in'
);

set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000004", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from checkin_drafts where member_id::text like 'c1000000-%'$$), 0, 'hq cannot see drafts');
select is(pg_temp.n($$select 1 from recording_notices where member_id::text like 'c1000000-%'$$), 0, 'hq cannot see notice acknowledgements');

set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000005", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from checkin_drafts where member_id::text like 'c1000000-%'$$), 0, 'the auditor cannot see drafts');
select is(
  pg_temp.n($$select 1 from storage.objects where bucket_id = 'checkin-audio' and name = 'c1000000-0000-4000-8000-000000000002/take-4.webm'$$),
  1, 'the recordings grant plays a submitted recording'
);
select is(
  pg_temp.n($$select 1 from storage.objects where bucket_id = 'checkin-audio' and name = 'c1000000-0000-4000-8000-000000000003/draft.webm'$$),
  0, 'the recordings grant cannot play a draft'
);

set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000006", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from checkin_drafts where member_id::text like 'c1000000-%'$$), 0, 'a login without a member row sees no drafts');
reset role;

-- ---------- once submitted, the recording is no longer a draft ----------
set local role service_role;
select lives_ok($$select submit_checkin_draft('c1000000-0000-4000-8000-000000000003')$$, 'm2 submits');
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub": "a1000000-0000-4000-8000-000000000005", "role": "authenticated"}';
select is(
  pg_temp.n($$select 1 from storage.objects where bucket_id = 'checkin-audio' and name = 'c1000000-0000-4000-8000-000000000003/draft.webm'$$),
  1, 'the recordings grant plays it once it is submitted'
);
reset role;

select * from finish();
rollback;
