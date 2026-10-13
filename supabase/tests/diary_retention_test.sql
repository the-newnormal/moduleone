-- How long each recording is kept (0013). Run: supabase test db
-- Builds its own fixtures inside the transaction and rolls back, so it doesn't depend on seed.sql.
--
-- Fixtures: members r1–r11 and r13–r16 in one team, each with their own login (u1–u16; u12 is spare).
-- Submitting: each records a take this week under the notices the cases below describe; r13–r16 under
-- the Diary's onboarding note (src/lib/checkin/onboarding-note.ts), the only row the app writes since
-- the in-app notice went (13 October 2026).
-- Forgetting: check-ins for earlier weeks, drafts and loose files, with their uploads backdated.
begin;
select plan(52);

-- ---------- fixtures ----------
insert into auth.users (id, email)
  select format('ab000000-0000-4000-8000-%s', lpad(i::text, 12, '0'))::uuid, format('u%s@diary.test', i)
  from generate_series(1, 16) i;

insert into teams (id, name) values ('bb000000-0000-4000-8000-000000000001', 'Diary team');

insert into members (id, auth_user_id, name, team_id, role)
  select format('cb000000-0000-4000-8000-%s', lpad(i::text, 12, '0'))::uuid,
         format('ab000000-0000-4000-8000-%s', lpad(i::text, 12, '0'))::uuid,
         format('r%s', i), 'bb000000-0000-4000-8000-000000000001', 'member'
  from generate_series(1, 16) i where i <> 12;

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

-- Fixture ids: r(1) is member r1, u(1) is login u1.
create function pg_temp.r(i int) returns uuid language sql immutable as $$
  select format('cb000000-0000-4000-8000-%s', lpad(i::text, 12, '0'))::uuid;
$$;
create function pg_temp.u(i int) returns uuid language sql immutable as $$
  select format('ab000000-0000-4000-8000-%s', lpad(i::text, 12, '0'))::uuid;
$$;

-- A file's path as the server names it: '<member_id>/<the week's Monday>-<name>'.
create function pg_temp.take(member uuid, week date, name text) returns text language sql stable as $$
  select member::text || '/' || to_char(week, 'YYYY-MM-DD') || '-' || name;
$$;

-- What submitting stamped on the member's check-in this week: (audio_keep_days, audio_delete_after).
create function pg_temp.stamp(member uuid) returns text language sql stable as $$
  select (c.audio_keep_days, c.audio_delete_after)::text from checkins c
    where c.member_id = member and c.week_start = pg_temp.this_week();
$$;

-- The stamp for this week's take kept `days` days: due that long after Storage received it.
create function pg_temp.kept(member uuid, days int) returns text language sql stable as $$
  select (days, o.created_at + make_interval(days => days))::text from storage.objects o
    where o.bucket_id = 'checkin-audio' and o.name = pg_temp.take(member, pg_temp.this_week(), 'take.webm');
$$;

-- A check-in for an earlier week whose recording, '<label>.webm', Storage received `age` ago, kept
-- `keep` days and stamped as submitting does.
create function pg_temp.old_checkin(member uuid, weeks_ago int, label text, keep int, age interval) returns void
  language plpgsql as $$
declare
  v_week date := pg_temp.this_week() - 7 * weeks_ago;
  v_name text := pg_temp.take(member, v_week, label || '.webm');
begin
  insert into storage.objects (bucket_id, name, created_at) values ('checkin-audio', v_name, now() - age);
  insert into checkins (member_id, week_start, audio_path, submitted_at, audio_keep_days, audio_delete_after)
    values (member, v_week, v_name, now() - age, keep, now() - age + make_interval(days => keep));
end $$;

-- Whether forget_expired_checkin_audio handed over the fixture file '<label>.webm' for deletion.
create function pg_temp.forgot(label text) returns boolean language plpgsql as $$
begin
  return exists (select 1 from forgot f where f.name like 'cb000000-%-' || label || '.webm');
end $$;

grant execute on function pg_temp.this_week(), pg_temp.n(text), pg_temp.r(int), pg_temp.u(int),
  pg_temp.take(uuid, date, text), pg_temp.stamp(uuid), pg_temp.kept(uuid, int),
  pg_temp.old_checkin(uuid, int, text, int, interval), pg_temp.forgot(text)
  to anon, authenticated, service_role;

-- ---------- schema and privileges ----------
select has_column('public', 'checkins', 'audio_keep_days', 'checkins has audio_keep_days');
select col_default_is('public', 'checkins', 'audio_keep_days', 90, 'a check-in''s recording is kept 90 days unless submitting says otherwise');
select has_column('public', 'recording_notices', 'recording_keep_days', 'recording_notices has recording_keep_days');
select col_default_is('public', 'recording_notices', 'recording_keep_days', 90, 'an acceptance promises 90 days unless the server says otherwise');
select col_type_is('public', 'checkins', 'audio_delete_after', 'timestamp with time zone', 'audio_delete_after is a timestamptz');
select col_is_null('public', 'checkins', 'audio_delete_after', 'audio_delete_after can be empty (no file to stamp from)');
select throws_ok(
  format($$insert into checkins (member_id, week_start, audio_keep_days) values (%L, %L, %s)$$,
         pg_temp.r(1), pg_temp.this_week() - 7, days),
  '23514', null, format('a check-in''s recording cannot be kept %s days', days)
) from unnest(array[30, 180]) days;
select throws_ok(
  format($$insert into recording_notices (member_id, auth_user_id, notice_version, recording_keep_days) values (%L, %L, 'test', %s)$$,
         pg_temp.r(1), pg_temp.u(1), days),
  '23514', null, format('no notice promises %s days', days)
) from unnest(array[30, 180]) days;
select is(
  (select proconfig from pg_proc where oid = f::regprocedure),
  array['search_path=""'], format('%s runs with an empty search_path', f)
) from unnest(array['public.submit_checkin_draft(uuid,text)', 'public.forget_expired_checkin_audio(integer)']) f;
select function_privs_are('public', f, args, r, array[]::text[], format('%s cannot call %s', r, f))
  from (values ('submit_checkin_draft', array['uuid', 'text']), ('forget_expired_checkin_audio', array['integer'])) fn (f, args)
  cross join unnest(array['anon', 'authenticated']) r;
select function_privs_are('public', f, args, 'service_role', array['EXECUTE'], format('the server can call %s', f))
  from (values ('submit_checkin_draft', array['uuid', 'text']), ('forget_expired_checkin_audio', array['integer'])) fn (f, args);

-- ---------- submitting stamps how long the recording is kept ----------
-- Each member's take this week, uploaded 5 minutes ago (r11's never reached Storage), with when it
-- stopped and how long it ran, and the notices their login (or another) accepted.
set local role service_role;
insert into storage.objects (bucket_id, name, created_at)
  select 'checkin-audio', pg_temp.take(pg_temp.r(i), pg_temp.this_week(), 'take.webm'), now() - interval '5 minutes'
  from generate_series(1, 16) i where i not in (11, 12);
insert into checkin_drafts (member_id, audio_path, mime_type, recorded_at, duration_ms)
  select pg_temp.r(i), pg_temp.take(pg_temp.r(i), pg_temp.this_week(), 'take.webm'), 'audio/webm', recorded_at, duration_ms
  from (values
    (1,  now() - interval '1 minute',   120000),
    (2,  now() - interval '1 minute',   120000),
    (3,  now() - interval '30 seconds', 120000),
    (4,  '-infinity'::timestamptz,      120000),
    (5,  now() - interval '1 minute',   null),
    (6,  now() - interval '1 minute',   null),
    (7,  now() - interval '1 minute',   120000),
    (8,  now() - interval '58 minutes', 120000),
    (9,  now() - interval '58 minutes', 120000),
    (10, now() - interval '58 minutes', 120000),
    (11, now() - interval '1 minute',   120000),
    -- r13–r16: each take started 3 minutes ago (stopped a minute ago, after 2 minutes).
    (13, now() - interval '1 minute',   120000),
    (14, now() - interval '1 minute',   120000),
    (15, now() - interval '1 minute',   120000),
    (16, now() - interval '1 minute',   120000)
  ) as t (i, recorded_at, duration_ms);
insert into recording_notices (member_id, auth_user_id, notice_version, accepted_at, recording_keep_days)
  select pg_temp.r(member), pg_temp.u(login), version, now() - ago, days
  from (values
    (2,  2,  'diary.openai',   interval '1 hour',     365),
    (3,  3,  'diary.openai',   interval '1 minute',   365),
    (4,  4,  'diary.openai',   interval '1 hour',     365),
    (5,  5,  'diary.openai',   interval '30 minutes', 365),
    (6,  6,  'diary.openai',   interval '3 hours',    365),
    (7,  12, 'diary.openai',   interval '1 hour',     365),
    (7,  7,  'old.openai',     interval '2 hours',    90),
    (8,  8,  'diary.openai',   interval '3 hours',    365),
    (8,  8,  'shorter.openai', interval '2 hours',    90),
    (9,  9,  'diary.openai',   interval '3 hours',    365),
    (9,  9,  'diary.live',     interval '10 minutes', 365),
    (10, 10, 'diary.openai',   interval '3 hours',    365),
    (10, 10, 'shorter.openai', interval '5 minutes',  90),
    (11, 11, 'diary.openai',   interval '1 hour',     365),
    (13, 13, 'assumed:onboarding-form.2026-10-13', interval '1 hour',      365),
    (14, 14, 'old.openai',                         interval '3 hours',     90),
    (14, 14, 'assumed:onboarding-form.2026-10-13', interval '1 hour',      365),
    (15, 15, 'old.openai',                         interval '3 hours',     90),
    (15, 15, 'assumed:onboarding-form.2026-10-13', interval '2 minutes',   365),
    (16, 16, 'assumed:onboarding-form.2026-10-13', interval '2 minutes',   365)
  ) as t (member, login, version, ago, days);
select lives_ok(
  $$select submit_checkin_draft(pg_temp.r(i), pg_temp.take(pg_temp.r(i), pg_temp.this_week(), 'take.webm'))
      from generate_series(1, 16) i where i <> 12$$,
  'the server submits each member''s take (the two-argument call, unchanged)'
);
reset role;

select is(pg_temp.stamp(pg_temp.r(1)), pg_temp.kept(pg_temp.r(1), 90),
  'r1 never accepted a notice: 90 days from the upload');
select is(pg_temp.stamp(pg_temp.r(2)), pg_temp.kept(pg_temp.r(2), 365),
  'r2 accepted the one-year notice before the take started: a year from the upload');
select is(pg_temp.stamp(pg_temp.r(3)), pg_temp.kept(pg_temp.r(3), 90),
  'r3 accepted it only after the take started: 90 days, as the notice it was recorded under said');
select is(pg_temp.stamp(pg_temp.r(4)), pg_temp.kept(pg_temp.r(4), 90),
  'r4''s take has no known recording time: 90 days');
select is(pg_temp.stamp(pg_temp.r(5)), pg_temp.kept(pg_temp.r(5), 90),
  'r5''s take has no known length, so it may have started an hour before it stopped, before the acceptance: 90 days');
select is(pg_temp.stamp(pg_temp.r(6)), pg_temp.kept(pg_temp.r(6), 365),
  'r6 accepted more than an hour before the take stopped: a year');
select is(pg_temp.stamp(pg_temp.r(7)), pg_temp.kept(pg_temp.r(7), 90),
  'r7''s own login accepted only the 90-day notice; another login''s acceptance on the row doesn''t count');
select is(pg_temp.stamp(pg_temp.r(8)), pg_temp.kept(pg_temp.r(8), 90),
  'r8 accepted a shorter notice after the one-year one, before recording: 90 days');
select is(pg_temp.stamp(pg_temp.r(9)), pg_temp.kept(pg_temp.r(9), 365),
  'r9 accepted another one-year notice after recording: still a year');
select is(pg_temp.stamp(pg_temp.r(10)), pg_temp.kept(pg_temp.r(10), 90),
  'r10 accepted a shorter notice after recording: the later, shorter promise wins');
select is(pg_temp.stamp(pg_temp.r(11)), (365, null::timestamptz)::text,
  'r11''s file never reached Storage: a year, with no date to show');
select is(pg_temp.stamp(pg_temp.r(13)), pg_temp.kept(pg_temp.r(13), 365),
  'r13 never accepted a notice in the app; the Diary noted the onboarding form before the take: a year');
select is(pg_temp.stamp(pg_temp.r(14)), pg_temp.kept(pg_temp.r(14), 365),
  'r14 accepted only the 90-day notice, then the note came before this take: a year');
select is(pg_temp.stamp(pg_temp.r(15)), pg_temp.kept(pg_temp.r(15), 90),
  'r15''s take started before the note: 90 days, as the notice it was recorded under said');
select is(pg_temp.stamp(pg_temp.r(16)), pg_temp.kept(pg_temp.r(16), 90),
  'r16''s take started before the note, with no notice in force: 90 days');

-- Members read the new columns of their own rows, and can't change them.
set local role authenticated;
set local request.jwt.claims to '{"sub": "ab000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  (select audio_keep_days::int from checkins where member_id = pg_temp.r(1) and week_start = pg_temp.this_week()),
  90, 'r1 reads how long their recording is kept'
);
select throws_ok(
  $$update checkins set audio_keep_days = 365 where member_id = pg_temp.r(1)$$,
  '42501', null, 'r1 cannot keep their recording longer'
);
select throws_ok(
  $$update recording_notices set recording_keep_days = 365 where member_id = pg_temp.r(1)$$,
  '42501', null, 'r1 cannot change what a notice promised'
);
set local request.jwt.claims to '{"sub": "ab000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select is(
  (select recording_keep_days::int from recording_notices where member_id = pg_temp.r(2)),
  365, 'r2 reads what the notice they accepted promised'
);
reset role;

-- ---------- forgetting: each recording goes when its own time is up ----------
-- A batch is filled only with files that are due: a one-year recording 200 days old, older than
-- the one due, doesn't take the only place left. Files already due that aren't this test's (a local
-- database's backdated uploads, say) are counted first, so the batch has room for them and exactly
-- one more. (Counting takes them off their check-ins, which leaves them due; it is rolled back.)
set local role service_role;
create temp table already_due as select count(*)::int as n from forget_expired_checkin_audio(2147483647);
do $$ begin
  perform pg_temp.old_checkin(pg_temp.r(1), 29, 'limit-kept', 365, interval '200 days');
  perform pg_temp.old_checkin(pg_temp.r(2), 14, 'limit-due', 90, interval '95 days');
end $$;
create temp table forgot as select f as name from forget_expired_checkin_audio((select n + 1 from already_due)) f;
reset role;
select is(
  (select array_agg(name) from forgot where name like 'cb000000-%'),
  array[pg_temp.take(pg_temp.r(2), pg_temp.this_week() - 14 * 7, 'limit-due.webm')],
  'a batch with room for one more file holds the file that is due, not an older one still kept'
);

set local role service_role;
do $$ begin
  -- r1: one-year recordings at 91 days, a minute before a year, and a minute after.
  perform pg_temp.old_checkin(pg_temp.r(1), 13, 'year-91d', 365, interval '91 days');
  perform pg_temp.old_checkin(pg_temp.r(1), 53, 'year-nearly-up', 365, interval '365 days' - interval '1 minute');
  perform pg_temp.old_checkin(pg_temp.r(1), 54, 'year-up', 365, interval '365 days' + interval '1 minute');
  -- r2: 90-day recordings at 91 and 89 days.
  perform pg_temp.old_checkin(pg_temp.r(2), 13, 'ninety-91d', 90, interval '91 days');
  perform pg_temp.old_checkin(pg_temp.r(2), 12, 'ninety-89d', 90, interval '89 days');
  -- r3: a one-year recording at 100 days whose stamp says it was due yesterday.
  perform pg_temp.old_checkin(pg_temp.r(3), 15, 'stamp-sooner', 365, interval '100 days');
  -- r4: one 100-day file that a one-year check-in and a 90-day check-in both point at.
  perform pg_temp.old_checkin(pg_temp.r(4), 15, 'shared', 365, interval '100 days');
end $$;
-- r3's stamp: due yesterday.
update checkins set audio_delete_after = now() - interval '1 day'
  where member_id = pg_temp.r(3) and week_start = pg_temp.this_week() - 15 * 7;
insert into checkins (member_id, week_start, audio_path, submitted_at, audio_keep_days)
  values (pg_temp.r(4), pg_temp.this_week() - 16 * 7, pg_temp.take(pg_temp.r(4), pg_temp.this_week() - 15 * 7, 'shared.webm'), now() - interval '100 days', 90);
-- r5: files no check-in points at, at 91 and 89 days. r6: a draft from 13 weeks ago, at 91 days.
insert into storage.objects (bucket_id, name, created_at) values
  ('checkin-audio', pg_temp.take(pg_temp.r(5), pg_temp.this_week() - 13 * 7, 'loose-91d.webm'), now() - interval '91 days'),
  ('checkin-audio', pg_temp.take(pg_temp.r(5), pg_temp.this_week() - 12 * 7, 'loose-89d.webm'), now() - interval '89 days'),
  ('checkin-audio', pg_temp.take(pg_temp.r(6), pg_temp.this_week() - 13 * 7, 'old-draft.webm'), now() - interval '91 days');
insert into checkin_drafts (member_id, week_start, audio_path, mime_type)
  values (pg_temp.r(6), pg_temp.this_week() - 13 * 7, pg_temp.take(pg_temp.r(6), pg_temp.this_week() - 13 * 7, 'old-draft.webm'), 'audio/webm');
truncate forgot;
insert into forgot select * from forget_expired_checkin_audio();
reset role;

select ok(not pg_temp.forgot('year-91d'), 'a one-year recording is kept past 90 days');
select isnt(
  (select audio_path from checkins where member_id = pg_temp.r(1) and week_start = pg_temp.this_week() - 13 * 7),
  null, 'and its check-in still points at it'
);
select ok(not pg_temp.forgot('year-nearly-up'), 'a one-year recording is kept until its year is up');
select ok(pg_temp.forgot('year-up'), 'and handed over for deletion once it is');
select is(
  (select audio_path from checkins where member_id = pg_temp.r(1) and week_start = pg_temp.this_week() - 54 * 7),
  null, 'its check-in stops pointing at it (the check-in itself stays)'
);
select ok(pg_temp.forgot('ninety-91d'), 'a 90-day recording goes after 90 days');
select ok(not pg_temp.forgot('ninety-89d'), 'and not before');
select ok(pg_temp.forgot('stamp-sooner'), 'a recording whose stamp is sooner than its promise goes at the stamp');
select ok(pg_temp.forgot('shared'), 'a file two check-ins point at goes at the shorter of their promises');
select ok(pg_temp.forgot('loose-91d'), 'a file no check-in points at goes after 90 days');
select ok(not pg_temp.forgot('loose-89d'), 'and not before');
select ok(pg_temp.forgot('old-draft'), 'a draft''s recording goes after 90 days');
select is(
  pg_temp.n($$select 1 from checkin_drafts where member_id = 'cb000000-0000-4000-8000-000000000006'$$),
  0, 'and the draft with it'
);

select * from finish();
rollback;
