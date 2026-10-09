-- Master Admins delete a week's recording or reset the week's check-in (0007). Run: supabase test db
-- Builds its own fixtures inside the transaction and rolls back, so it doesn't depend on seed.sql.
--
-- Fixtures (team T):
--   lead    leader of T                       m1  member, graded check-in this week, with a mention
--   m2      member, ungraded check-in         m3  member, graded check-in last week, no recording
--   hq      role hq, no team, no grants       admin  member, admin grant
--   auditor member, recordings grant          outsider  signed in, but no members row
--   m4      member, a scored check-in from before 0004 (never submitted through the app), with a
--           recording
begin;
select plan(51);

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('d7a00000-0000-4000-8000-000000000001', 'lead@reset.test'),
  ('d7a00000-0000-4000-8000-000000000002', 'm1@reset.test'),
  ('d7a00000-0000-4000-8000-000000000003', 'm2@reset.test'),
  ('d7a00000-0000-4000-8000-000000000004', 'm3@reset.test'),
  ('d7a00000-0000-4000-8000-000000000005', 'hq@reset.test'),
  ('d7a00000-0000-4000-8000-000000000006', 'admin@reset.test'),
  ('d7a00000-0000-4000-8000-000000000007', 'auditor@reset.test'),
  ('d7a00000-0000-4000-8000-000000000008', 'outsider@reset.test'),
  ('d7a00000-0000-4000-8000-000000000009', 'm4@reset.test');

insert into teams (id, name) values ('d7b00000-0000-4000-8000-000000000001', 'Reset team T');

insert into members (id, auth_user_id, name, team_id, role) values
  ('d7c00000-0000-4000-8000-000000000001', 'd7a00000-0000-4000-8000-000000000001', 'lead',    'd7b00000-0000-4000-8000-000000000001', 'leader'),
  ('d7c00000-0000-4000-8000-000000000002', 'd7a00000-0000-4000-8000-000000000002', 'm1',      'd7b00000-0000-4000-8000-000000000001', 'member'),
  ('d7c00000-0000-4000-8000-000000000003', 'd7a00000-0000-4000-8000-000000000003', 'm2',      'd7b00000-0000-4000-8000-000000000001', 'member'),
  ('d7c00000-0000-4000-8000-000000000004', 'd7a00000-0000-4000-8000-000000000004', 'm3',      'd7b00000-0000-4000-8000-000000000001', 'member'),
  ('d7c00000-0000-4000-8000-000000000005', 'd7a00000-0000-4000-8000-000000000005', 'hq',      null,                                   'hq'),
  ('d7c00000-0000-4000-8000-000000000006', 'd7a00000-0000-4000-8000-000000000006', 'admin',   null,                                   'member'),
  ('d7c00000-0000-4000-8000-000000000007', 'd7a00000-0000-4000-8000-000000000007', 'auditor', null,                                   'member'),
  ('d7c00000-0000-4000-8000-000000000008', 'd7a00000-0000-4000-8000-000000000009', 'm4',      'd7b00000-0000-4000-8000-000000000001', 'member');

insert into member_grants (member_id, grant_name) values
  ('d7c00000-0000-4000-8000-000000000006', 'admin'),
  ('d7c00000-0000-4000-8000-000000000007', 'recordings');

-- The Monday of this Singapore week, worked out the same way as the column defaults.
create function pg_temp.this_week() returns date language sql stable as $$
  select (date_trunc('week', now() at time zone 'Asia/Singapore'))::date;
$$;

-- A take's path as the server names it: '<member_id>/<the week's Monday>-<name>'.
create function pg_temp.take(member uuid, week date, name text) returns text language sql stable as $$
  select member::text || '/' || to_char(week, 'YYYY-MM-DD') || '-' || name;
$$;

-- Signs in as the given login for the rest of the transaction.
create function pg_temp.as_user(auth_id text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', auth_id, 'role', 'authenticated')::text, true);
$$;

grant execute on function pg_temp.this_week(), pg_temp.take(uuid, date, text), pg_temp.as_user(text)
  to anon, authenticated, service_role;

insert into checkins (id, member_id, week_start, audio_path, submitted_at, graded_at, transcript,
                      activity_score, excellence_score, morale_score, rubric_review) values
  ('d7d00000-0000-4000-8000-000000000001', 'd7c00000-0000-4000-8000-000000000002', pg_temp.this_week(),
   pg_temp.take('d7c00000-0000-4000-8000-000000000002', pg_temp.this_week(), 'm1.webm'), now(), now(), 'did things', 4, 4, 4, 'good'),
  ('d7d00000-0000-4000-8000-000000000002', 'd7c00000-0000-4000-8000-000000000003', pg_temp.this_week(),
   pg_temp.take('d7c00000-0000-4000-8000-000000000003', pg_temp.this_week(), 'm2.webm'), now(), null, null, null, null, null, null),
  ('d7d00000-0000-4000-8000-000000000003', 'd7c00000-0000-4000-8000-000000000004', pg_temp.this_week() - 7,
   null, now() - interval '7 days', now() - interval '7 days', 'last week', 3, 3, 3, 'ok'),
  ('d7d00000-0000-4000-8000-000000000004', 'd7c00000-0000-4000-8000-000000000008', pg_temp.this_week() - 14,
   pg_temp.take('d7c00000-0000-4000-8000-000000000008', pg_temp.this_week() - 14, 'm4.webm'), null, null, 'old', 2, 2, 2, 'scored by hand');
insert into checkin_mentions (checkin_id, about_member_id, sentiment) values
  ('d7d00000-0000-4000-8000-000000000002', 'd7c00000-0000-4000-8000-000000000002', 1);

-- ---------- schema and privileges ----------
select has_table('public', 'checkin_resets', 'checkin_resets exists');
select is((select relrowsecurity from pg_class where oid = 'public.checkin_resets'::regclass), true, 'RLS is on for checkin_resets');
select table_privs_are('public', 'checkin_resets', 'anon', array[]::text[], 'anon has no privileges on checkin_resets');
select table_privs_are('public', 'checkin_resets', 'authenticated', array['SELECT'], 'signed-in users only read checkin_resets');
select function_privs_are('public', f, array['uuid'], 'anon', array[]::text[], format('anon cannot call %s', f))
  from unnest(array['hq_delete_checkin_recording', 'hq_reset_checkin']) f;
select function_privs_are('public', f, array['uuid'], 'authenticated', array['EXECUTE'], format('signed-in users can call %s (it checks for hq)', f))
  from unnest(array['hq_delete_checkin_recording', 'hq_reset_checkin']) f;

-- ---------- nobody but hq ----------
set local role authenticated;

select pg_temp.as_user('d7a00000-0000-4000-8000-000000000002');
select throws_ok($$select hq_delete_checkin_recording('d7d00000-0000-4000-8000-000000000001')$$,
  '42501', 'Only a Master Admin can delete recordings.', 'a member cannot delete their own recording here');
select throws_ok($$select hq_reset_checkin('d7d00000-0000-4000-8000-000000000001')$$,
  '42501', 'Only a Master Admin can reset check-ins.', 'a member cannot reset their own check-in');

select pg_temp.as_user('d7a00000-0000-4000-8000-000000000001');
select throws_ok($$select hq_delete_checkin_recording('d7d00000-0000-4000-8000-000000000001')$$,
  '42501', null, 'a leader cannot delete their team''s recordings');
select throws_ok($$select hq_reset_checkin('d7d00000-0000-4000-8000-000000000001')$$,
  '42501', null, 'a leader cannot reset their team''s check-ins');

select pg_temp.as_user('d7a00000-0000-4000-8000-000000000006');
select throws_ok($$select hq_delete_checkin_recording('d7d00000-0000-4000-8000-000000000001')$$,
  '42501', null, 'the admin grant does not let anyone delete recordings');
select throws_ok($$select hq_reset_checkin('d7d00000-0000-4000-8000-000000000001')$$,
  '42501', null, 'the admin grant does not let anyone reset check-ins');

select pg_temp.as_user('d7a00000-0000-4000-8000-000000000007');
select throws_ok($$select hq_delete_checkin_recording('d7d00000-0000-4000-8000-000000000001')$$,
  '42501', null, 'the recordings grant does not let anyone delete recordings');
select throws_ok($$select hq_reset_checkin('d7d00000-0000-4000-8000-000000000001')$$,
  '42501', null, 'the recordings grant does not let anyone reset check-ins');

select pg_temp.as_user('d7a00000-0000-4000-8000-000000000008');
select throws_ok($$select hq_reset_checkin('d7d00000-0000-4000-8000-000000000001')$$,
  '42501', null, 'a login without a members row cannot reset check-ins');

reset role;
set local role anon;
select set_config('request.jwt.claims', '', true);
select throws_ok($$select hq_reset_checkin('d7d00000-0000-4000-8000-000000000001')$$,
  '42501', null, 'signed-out requests cannot call it at all');
reset role;

select is((select count(*)::int from checkins where id::text like 'd7d%' and audio_path is not null), 3,
  'the refused calls changed nothing');
select is((select count(*)::int from checkin_resets), 0, 'and logged nothing');

-- ---------- hq deletes a recording ----------
set local role authenticated;
select pg_temp.as_user('d7a00000-0000-4000-8000-000000000005');

select throws_ok($$select hq_delete_checkin_recording('d7d00000-0000-4000-8000-000000000002')$$,
  'P0001', 'not_graded', 'an ungraded check-in keeps its recording: the grader needs it');
select is(
  (select audio_paths from hq_delete_checkin_recording('d7d00000-0000-4000-8000-000000000001')),
  array[pg_temp.take('d7c00000-0000-4000-8000-000000000002', pg_temp.this_week(), 'm1.webm')],
  'deleting a recording hands back its file for the server to remove'
);
select is((select audio_path from checkins where id = 'd7d00000-0000-4000-8000-000000000001'), null,
  'the check-in no longer points at the recording');
select is(
  (select array[transcript, activity_score::text, rubric_review] from checkins where id = 'd7d00000-0000-4000-8000-000000000001'),
  array['did things', '4', 'good'], 'its transcript, scores and review stay'
);
select is((select count(*)::int from hq_delete_checkin_recording('d7d00000-0000-4000-8000-000000000001')), 0,
  'deleting it again hands back nothing');
select is((select count(*)::int from hq_delete_checkin_recording('d7d00000-0000-4000-8000-000000000003')), 0,
  'a check-in without a recording hands back nothing');
select is(
  (select audio_paths from hq_delete_checkin_recording('d7d00000-0000-4000-8000-000000000004')),
  array[pg_temp.take('d7c00000-0000-4000-8000-000000000008', pg_temp.this_week() - 14, 'm4.webm')],
  'a check-in scored before 0004 (no grader to wait for) can have its recording deleted'
);
select throws_ok($$select hq_delete_checkin_recording('d7d00000-0000-4000-8000-0000000000ff')$$,
  'P0001', 'no_checkin', 'an unknown check-in is refused');

-- ---------- hq resets a check-in ----------
select is(
  (select audio_paths from hq_reset_checkin('d7d00000-0000-4000-8000-000000000002')),
  array[pg_temp.take('d7c00000-0000-4000-8000-000000000003', pg_temp.this_week(), 'm2.webm')],
  'resetting a check-in hands back its recording for the server to remove'
);
reset role;
select is((select count(*)::int from checkins where id = 'd7d00000-0000-4000-8000-000000000002'), 0, 'the check-in is gone');
select is((select count(*)::int from checkin_mentions where checkin_id = 'd7d00000-0000-4000-8000-000000000002'), 0,
  'and its mentions with it');
set local role authenticated;
select pg_temp.as_user('d7a00000-0000-4000-8000-000000000005');
select throws_ok($$select hq_reset_checkin('d7d00000-0000-4000-8000-000000000002')$$,
  'P0001', 'no_checkin', 'resetting it again is refused');
select is((select audio_paths from hq_reset_checkin('d7d00000-0000-4000-8000-000000000003')), array[]::text[],
  'an earlier week''s check-in without a recording resets, handing back no files');

-- ---------- the log ----------
select is(
  (select array_agg(action || ':' || member_id::text || ':' || (week_start = pg_temp.this_week())::text || ':' || done_by::text order by member_id)
     from checkin_resets),
  array[
    'recording_deleted:d7c00000-0000-4000-8000-000000000002:true:d7c00000-0000-4000-8000-000000000005',
    'checkin_reset:d7c00000-0000-4000-8000-000000000003:true:d7c00000-0000-4000-8000-000000000005',
    'checkin_reset:d7c00000-0000-4000-8000-000000000004:false:d7c00000-0000-4000-8000-000000000005',
    'recording_deleted:d7c00000-0000-4000-8000-000000000008:false:d7c00000-0000-4000-8000-000000000005'
  ],
  'each change is logged once: what, whose, which week and by whom (a call that changed nothing is not)'
);
select is((select count(*)::int from checkin_resets where team_id = 'd7b00000-0000-4000-8000-000000000001'), 4,
  'with the team the check-in was made in');
select is(
  (select array_agg(cardinality(audio_paths) order by member_id) from checkin_resets where files_removed_at is null),
  array[1, 1, 0, 1],
  'with the files the server is to remove, none stamped removed yet (the server stamps them)'
);
select throws_ok($$insert into checkin_resets (member_id, week_start, action) values ('d7c00000-0000-4000-8000-000000000002', pg_temp.this_week(), 'checkin_reset')$$,
  '42501', null, 'even hq cannot write the log through the API');
select throws_ok($$delete from checkin_resets$$, '42501', null, 'nor delete from it');

select pg_temp.as_user('d7a00000-0000-4000-8000-000000000003');
select is((select count(*)::int from checkin_resets), 0, 'a member does not see the log, even about themselves');
select pg_temp.as_user('d7a00000-0000-4000-8000-000000000001');
select is((select count(*)::int from checkin_resets), 0, 'a leader does not see it');
select pg_temp.as_user('d7a00000-0000-4000-8000-000000000006');
select is((select count(*)::int from checkin_resets), 0, 'an admin does not see it');
select pg_temp.as_user('d7a00000-0000-4000-8000-000000000003');
select is((select count(*)::int from checkins where member_id = 'd7c00000-0000-4000-8000-000000000003'), 0,
  'the member no longer has a check-in this week');
reset role;

-- ---------- after a reset, the member records the week again ----------
set local role service_role;
select throws_ok(
  format($$select save_checkin_draft('d7c00000-0000-4000-8000-000000000003', %L, 'audio/webm', 30000, now())$$,
         pg_temp.take('d7c00000-0000-4000-8000-000000000003', pg_temp.this_week(), 'm2.webm')),
  'P0001', 'bad_path', 'a late save of the take the reset deleted cannot bring it back as a draft'
);
select is(
  save_checkin_draft('d7c00000-0000-4000-8000-000000000003', pg_temp.take('d7c00000-0000-4000-8000-000000000003', pg_temp.this_week(), 'again.webm'), 'audio/webm', 30000, now()),
  null, 'a reset member can save a new take this week'
);
select isnt(
  submit_checkin_draft('d7c00000-0000-4000-8000-000000000003', pg_temp.take('d7c00000-0000-4000-8000-000000000003', pg_temp.this_week(), 'again.webm')),
  null, 'and submit it as this week''s check-in'
);
select is(
  (select audio_path from checkins where member_id = 'd7c00000-0000-4000-8000-000000000003' and week_start = pg_temp.this_week()),
  pg_temp.take('d7c00000-0000-4000-8000-000000000003', pg_temp.this_week(), 'again.webm'), 'the new check-in has the new recording'
);
reset role;

-- A draft for the week, should one exist alongside the check-in, goes too.
insert into checkin_drafts (member_id, week_start, audio_path, mime_type)
  values ('d7c00000-0000-4000-8000-000000000003', pg_temp.this_week(),
          pg_temp.take('d7c00000-0000-4000-8000-000000000003', pg_temp.this_week(), 'stray.webm'), 'audio/webm');
set local role authenticated;
select pg_temp.as_user('d7a00000-0000-4000-8000-000000000005');
select is(
  (select audio_paths from hq_reset_checkin(
    (select id from checkins where member_id = 'd7c00000-0000-4000-8000-000000000003' and week_start = pg_temp.this_week())
  )),
  array[pg_temp.take('d7c00000-0000-4000-8000-000000000003', pg_temp.this_week(), 'again.webm'),
        pg_temp.take('d7c00000-0000-4000-8000-000000000003', pg_temp.this_week(), 'stray.webm')],
  'a reset hands back the check-in''s recording and any draft take for that week'
);
reset role;
select is((select count(*)::int from checkin_drafts where member_id = 'd7c00000-0000-4000-8000-000000000003'), 0,
  'and the draft is gone');

-- The server stamps a row once its files are gone; the daily retry only looks at unstamped ones.
set local role service_role;
update checkin_resets set files_removed_at = now() where member_id = 'd7c00000-0000-4000-8000-000000000002';
select is((select count(*)::int from checkin_resets where files_removed_at is null and audio_paths <> '{}'), 3,
  'the server (service_role) stamps a row whose files it removed');
reset role;

-- The log keeps its rows if the member, or the Master Admin, is ever deleted.
delete from members where id = 'd7c00000-0000-4000-8000-000000000003';
select is((select count(*)::int from checkin_resets where member_id is null), 2,
  'the log outlives the member whose check-in it was');
delete from members where id = 'd7c00000-0000-4000-8000-000000000005';
select is((select count(*)::int from checkin_resets where done_by is null), 5,
  'the log outlives the Master Admin''s member row');

select * from finish();
rollback;
