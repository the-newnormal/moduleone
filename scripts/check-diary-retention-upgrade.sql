-- Run by scripts/check-diary-retention-upgrade.sh (see there) on a database at migration 0012, with
-- the psql variable migration (0013's file). Stops at the first broken expectation, and rolls
-- everything back.
begin;

-- What production may hold before 0013: a member who accepted the privacy notice, and graded
-- check-ins pointing at a recording Storage received 10 days ago, one received 100 days ago (the
-- daily job hasn't run yet), and a file Storage no longer has.
insert into auth.users (id, email) values ('0d000000-0000-4000-8000-000000000001', 'diary@upgrade.test');
insert into teams (id, name) values ('0d000000-0000-4000-8000-000000000002', 'Upgrade team');
insert into members (id, auth_user_id, name, team_id, role) values
  ('0d000000-0000-4000-8000-000000000003', '0d000000-0000-4000-8000-000000000001', 'Speaker',
   '0d000000-0000-4000-8000-000000000002', 'member');
insert into recording_notices (member_id, auth_user_id, notice_version, accepted_at) values
  ('0d000000-0000-4000-8000-000000000003', '0d000000-0000-4000-8000-000000000001', '2026-10-10.openai', now() - interval '120 days');
insert into storage.objects (bucket_id, name, created_at) values
  ('checkin-audio', '0d000000-0000-4000-8000-000000000003/recent.webm', now() - interval '10 days'),
  ('checkin-audio', '0d000000-0000-4000-8000-000000000003/old.webm',    now() - interval '100 days');
insert into checkins (id, member_id, week_start, audio_path, submitted_at, audio_duration_ms, transcript,
                      activity_score, excellence_score, morale_score, category, rubric_review, graded_at) values
  ('0d000000-0000-4000-8000-000000000011', '0d000000-0000-4000-8000-000000000003', '2026-09-28',
   '0d000000-0000-4000-8000-000000000003/recent.webm', now() - interval '10 days', 61000, 'Recent.', 4, 3, 4, 'delivery', 'Fine.', now()),
  ('0d000000-0000-4000-8000-000000000012', '0d000000-0000-4000-8000-000000000003', '2026-06-29',
   '0d000000-0000-4000-8000-000000000003/old.webm', now() - interval '100 days', 59000, 'Old.', 3, 3, 3, 'growth', 'Fine.', now()),
  ('0d000000-0000-4000-8000-000000000013', '0d000000-0000-4000-8000-000000000003', '2026-06-22',
   '0d000000-0000-4000-8000-000000000003/gone.webm', now() - interval '107 days', 60000, 'Gone.', 2, 2, 2, 'blockers', 'Fine.', now());

-- Everything 0013 should leave alone: every column of every check-in and acceptance it had before.
create temp table old_rows as
  select id::text as id, to_jsonb(c) as v from checkins c
  union all
  select concat_ws('|', member_id, auth_user_id, notice_version), to_jsonb(n) from recording_notices n;

\i :migration

do $$
declare
  got text;
begin
  select string_agg(distinct audio_keep_days::text, ', ') into got from checkins;
  if got is distinct from '90' then
    raise exception 'every existing check-in should keep its recording 90 days, as its notice said; got %', got;
  end if;
  select string_agg(distinct recording_keep_days::text, ', ') into got from recording_notices;
  if got is distinct from '90' then
    raise exception 'every existing acceptance should have promised 90 days; got %', got;
  end if;

  select string_agg(c.id::text, ', ' order by c.id) into got
  from checkins c join storage.objects o on o.bucket_id = 'checkin-audio' and o.name = c.audio_path
  where c.audio_delete_after is distinct from o.created_at + interval '90 days';
  if got is not null then
    raise exception 'each recording should be due 90 days after Storage received it, when 0004 would have deleted it; got %', got;
  end if;
  select string_agg(id::text || ':' || coalesce(audio_delete_after::text, '-'), ', ' order by id) into got
  from checkins where id::text like '0d000000-%';
  if got is distinct from format('0d000000-0000-4000-8000-000000000011:%s, 0d000000-0000-4000-8000-000000000012:%s, 0d000000-0000-4000-8000-000000000013:-',
                                 now() - interval '10 days' + interval '90 days', now() - interval '100 days' + interval '90 days') then
    raise exception 'the two recordings Storage has should be due 90 days after their upload, and the missing one undated; got %', got;
  end if;

  select string_agg(id, ', ' order by id) into got
  from (
    select id::text as id, to_jsonb(c) - 'audio_keep_days' - 'audio_delete_after' as v from checkins c
    union all
    select concat_ws('|', member_id, auth_user_id, notice_version), to_jsonb(n) - 'recording_keep_days' from recording_notices n
  ) now_rows
  full join old_rows using (id)
  where now_rows.v is distinct from old_rows.v;
  if got is not null then
    raise exception 'these rows changed (or appeared, or went missing) beyond what 0013 should do: %', got;
  end if;

  select string_agg(f, ', ' order by f) into got
  from public.forget_expired_checkin_audio() f where f like '0d000000-%';
  if got is distinct from '0d000000-0000-4000-8000-000000000003/old.webm' then
    raise exception 'the daily job should still delete exactly the recording older than 90 days; got %', got;
  end if;
end $$;

rollback;
