-- Module One — RLS hardening and check-in recordings.
--
-- After this migration:
--   * Signed-in users can only READ through the Data API and Storage. Every write (check-ins,
--     transcripts, scores, mentions, recordings) happens in server code with the service-role key,
--     which takes the member from the session, never from the request. Under 0001 a member could
--     grade their own check-in (set their own scores, category and review) or file one for any date.
--   * Signed-out (anon) requests can't touch these tables or the helper functions at all.
--   * 360 mentions are visible exactly when the check-in they came from is. 0001's policy read as if
--     every teammate could see every mention, but its subquery on checkins is itself filtered by
--     RLS, so it already behaved like this, except that it hid a team-less member's own mentions.
--   * Big Five data moves out of `members` (which every teammate can read) into member_profiles,
--     readable only by the member and hq.
--   * Recordings live in the private 'checkin-audio' bucket as '<member_id>/<file>'. Only the speaker
--     and hq can play them; leaders see the transcript and scores, as before.

-- ---------- new objects start with no access ----------
-- Hosted Supabase stopped granting anon, authenticated and service_role access to new public tables
-- for projects created since 30 May 2026, and stops for every project on 30 Oct 2026. The local CLI
-- still grants. Revoke those defaults so local matches hosted: each future table, sequence or
-- function needs explicit grants in its own migration, and a missing one fails locally too.
-- (Postgres itself still lets PUBLIC execute every new function; revoke that per function, as below.)
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated, service_role;

-- ---------- table privileges: read-only for signed-in users, nothing for anon ----------
-- Locally (and on older hosted projects) 0001's tables got every privilege for anon and
-- authenticated, so RLS was the only thing standing between them and a write. On a new hosted
-- project they got no grants at all, so even the service role couldn't use them. Either way, grant
-- exactly what the app needs.
revoke all on table teams, members, checkins, checkin_mentions from anon, authenticated;
grant select on table teams, members, checkins, checkin_mentions to authenticated;
grant all on table teams, members, checkins, checkin_mentions to service_role;

-- The grader and the check-in action write with the service role, which bypasses RLS, so these
-- policies only ever let a member write through the Data API. Remove them.
drop policy checkins_insert on checkins;
drop policy checkins_update on checkins;

-- ---------- helper functions: signed-in users only, fixed search_path ----------
-- An empty search_path (with every name qualified) stops a session's temporary tables from
-- shadowing public.members inside these SECURITY DEFINER functions.
create or replace function app_current_team() returns uuid
  language sql stable security definer set search_path = '' as $$
    select team_id from public.members where auth_user_id = auth.uid() limit 1;
$$;

create or replace function app_current_role() returns text
  language sql stable security definer set search_path = '' as $$
    select role from public.members where auth_user_id = auth.uid() limit 1;
$$;

create or replace function app_current_member_id() returns uuid
  language sql stable security definer set search_path = '' as $$
    select id from public.members where auth_user_id = auth.uid() limit 1;
$$;

-- The RLS and storage policies call these as `authenticated`, so that grant must stay.
revoke execute on function app_current_team(), app_current_role(), app_current_member_id()
  from public, anon;
grant execute on function app_current_team(), app_current_role(), app_current_member_id()
  to authenticated, service_role;

-- ---------- checkins: Monday weeks, whole grades, recordings ----------
-- Fail with a clear message, rather than a bare constraint error, if someone entered check-ins by hand.
do $$
begin
  if exists (select 1 from checkins where extract(isodow from week_start) <> 1) then
    raise exception 'checkins has rows whose week_start is not a Monday. Move each to the Monday of its week (watch for two rows landing on the same member and week), then re-run 0002.';
  end if;
  if exists (
    select 1 from checkins
    where num_nulls(activity_score, excellence_score, morale_score) not in (0, 3)
  ) then
    raise exception 'checkins has rows with only some of activity_score, excellence_score and morale_score set. Set all three or clear all three, then re-run 0002.';
  end if;
end $$;

alter table checkins
  add column audio_path text,
  -- The team works in Singapore time, but the database and Vercel run in UTC: a check-in made
  -- between Monday 00:00 and 07:59 SGT would land in the previous week if the week were worked out in
  -- UTC. The server leaves week_start out and lets this default pick the week.
  alter column week_start set default (date_trunc('week', now() at time zone 'Asia/Singapore'))::date,
  -- One check-in per member per week only works if every week starts on the same day.
  add constraint checkins_week_start_monday check (extract(isodow from week_start) = 1),
  -- The grader writes all three scores at once; a half-graded row would quietly drop off the heat-map.
  add constraint checkins_scores_all_or_none
    check (num_nulls(activity_score, excellence_score, morale_score) in (0, 3)),
  -- Relative to the 'checkin-audio' bucket: exactly '<member_id>/<file name>'. Storage resolves '..'
  -- and '%2e%2e', so checking only the first segment would let '<own id>/../<other id>/x' through,
  -- and the server (which reads recordings as the service role) would open someone else's.
  add constraint checkins_audio_path_own_folder
    check (audio_path is null or audio_path ~ ('^' || member_id::text || '/[A-Za-z0-9][A-Za-z0-9._-]*$'));

-- ---------- 360 mentions: inherit the check-in's visibility ----------
-- The subquery runs under the caller's RLS on checkins, so a mention is visible exactly when its
-- check-in is: your own, your team's as a leader, or anything as hq. (0001's version also required
-- the check-in's author to share your team, which hid a team-less member's own mentions from them.)
drop policy mentions_select on checkin_mentions;
create policy mentions_select on checkin_mentions for select to authenticated
  using (exists (select 1 from checkins c where c.id = checkin_mentions.checkin_id));

-- ---------- member_profiles: Big Five out of the team-visible members table ----------
create table member_profiles (
  member_id  uuid primary key references members(id) on delete cascade,
  big_five   jsonb
);
alter table member_profiles enable row level security;

grant select on table member_profiles to authenticated;
grant all on table member_profiles to service_role;

-- Personality data: yourself and hq only. Leaders don't need it to read the heat-map.
create policy member_profiles_select on member_profiles for select to authenticated
  using (member_id = app_current_member_id() or app_current_role() = 'hq');

insert into member_profiles (member_id, big_five)
  select id, big_five from members where big_five is not null;
alter table members drop column big_five;

-- ---------- storage: private bucket for check-in recordings ----------
-- 25 MiB covers well over 5 minutes of browser audio (Chrome's default Opus is about 1 MB a minute).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('checkin-audio', 'checkin-audio', false, 26214400, array['audio/*'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- No insert, update or delete policy: members can't write to the bucket themselves. To record, the
-- server (service role) picks the path '<member_id>/<new file>' from the session and creates a
-- signed upload URL for it with upsert off; the browser uploads straight to Storage (so Vercel's
-- 4.5 MB request limit doesn't apply), and the URL can't overwrite an existing recording.
-- A member-facing insert policy would let members mint their own signed upload URLs, and Storage
-- checks RLS only when such a URL is created, so an upsert URL could later replace a graded recording.

-- Listen to: your own recordings, or anyone's as hq. Leaders get the transcript and scores through
-- checkins but not the voice itself: a recording is more sensitive personal data than its
-- transcript, so it goes no further than it has to (PDPA data minimisation).
create policy checkin_audio_select on storage.objects for select to authenticated
  using (
    bucket_id = 'checkin-audio'
    and (
      (storage.foldername(objects.name))[1] = public.app_current_member_id()::text
      or public.app_current_role() = 'hq'
    )
  );
