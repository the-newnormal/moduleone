-- Module One — access rules, check-in teams, recordings and scoring settings.
--
-- After this migration:
--   * Members only READ through the Data API and Storage. Check-in writes (transcripts, scores,
--     mentions, recordings) happen in server code with the service-role key, which takes the member
--     from the session, never from the request. Under 0001 a member could grade their own check-in
--     (set their own scores, category and review) or file one for any date.
--   * Selected admins hold grants in member_grants, which only the project owner can change (in the
--     Supabase dashboard), so no one can promote themselves through the app:
--       admin       edit teams, other members (not hq, not themselves) and the scoring settings;
--                   only the project owner makes someone hq
--       recordings  play anyone's check-in recording
--       big_five    read and edit anyone's Big Five profile
--   * Each check-in records the team it was made in, so the heat-map stays accurate when someone
--     changes team, and leaders see their team's check-ins, not a newcomer's history.
--   * Scoring (the R/Y/G rules) lives in scoring_settings, editable by admins. The database refuses
--     settings that leave any colour unreachable.
--   * Signed-out (anon) requests can't touch these tables or the helper functions at all.

-- ---------- new objects start with no access ----------
-- Hosted Supabase stopped granting anon, authenticated and service_role access to new public tables
-- for projects created since 30 May 2026, and stops for every project on 30 Oct 2026. The local CLI
-- still grants. Revoke those defaults so local matches hosted: each table, sequence or function
-- needs explicit grants in its own migration, and a missing one fails locally too.
-- (Postgres itself still lets PUBLIC execute every new function; revoke that per function, as below.)
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated, service_role;

-- ---------- 0001's tables: read-only for members, nothing for anon ----------
-- Locally (and on older hosted projects) 0001's tables got every privilege for anon and
-- authenticated, so RLS was the only thing standing between them and a write. On a new hosted
-- project they got no grants at all, so even the service role couldn't use them. Either way, grant
-- exactly what the app needs. Admin writes to teams and members are granted column by column below.
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

-- ---------- member_grants: what selected admins may do ----------
create table member_grants (
  member_id   uuid not null references members(id) on delete cascade,
  grant_name  text not null check (grant_name in ('admin', 'recordings', 'big_five')),
  granted_at  timestamptz not null default now(),
  primary key (member_id, grant_name)
);
alter table member_grants enable row level security;

-- Read-only through the API, even for admins: grants are changed in the Supabase dashboard.
grant select on table member_grants to authenticated;
grant all on table member_grants to service_role;

create function app_has_grant(requested text) returns boolean
  language sql stable security definer set search_path = '' as $$
    select exists (
      select 1
      from public.member_grants g
      join public.members m on m.id = g.member_id
      where m.auth_user_id = auth.uid() and g.grant_name = app_has_grant.requested
    );
$$;

-- The RLS and storage policies call these as `authenticated`, so that grant must stay.
revoke execute on function
  app_current_team(), app_current_role(), app_current_member_id(), app_has_grant(text)
  from public, anon;
grant execute on function
  app_current_team(), app_current_role(), app_current_member_id(), app_has_grant(text)
  to authenticated, service_role;

-- You see your own grants; admins see everyone's.
create policy member_grants_select on member_grants for select to authenticated
  using (member_id = app_current_member_id() or app_has_grant('admin'));

-- ---------- teams and members: admins maintain the team structure ----------
-- Teams are archived, never deleted, so past check-ins keep their team.
alter table teams add column archived_at timestamptz;

grant insert (name, division), update (name, division, archived_at) on table teams to authenticated;
-- Admins place people in teams and set their role (member or leader). Linking a member to a login
-- (auth_user_id) happens in server code when they are invited, so an admin can't take over someone's
-- member row.
grant insert (name, team_id, role), update (name, team_id, role) on table members to authenticated;

drop policy teams_select on teams;
create policy teams_select on teams for select to authenticated
  using (id = app_current_team() or app_current_role() = 'hq' or app_has_grant('admin'));
create policy teams_admin_insert on teams for insert to authenticated
  with check (app_has_grant('admin'));
create policy teams_admin_update on teams for update to authenticated
  using (app_has_grant('admin')) with check (app_has_grant('admin'));

-- ---------- checkins: team at the time, Monday weeks, whole grades, recordings ----------
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
  -- The team the member was in when they checked in. Filled in from members.team_id on insert, so
  -- moving someone to another team doesn't move their history on the heat-map.
  add column team_id uuid references teams(id),
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

-- Existing check-ins take the member's current team: the best record there is.
update checkins c set team_id = m.team_id from members m where m.id = c.member_id;

create function checkins_set_team() returns trigger
  language plpgsql set search_path = '' as $$
begin
  if new.team_id is null then
    select m.team_id into new.team_id from public.members m where m.id = new.member_id;
  end if;
  return new;
end $$;
revoke execute on function checkins_set_team() from public, anon, authenticated;

create trigger checkins_set_team before insert on checkins
  for each row execute function checkins_set_team();

create index checkins_team_week on checkins (team_id, week_start);

-- ---------- members: who can see and edit whom ----------
-- Leaders also see anyone who checked in while in their team, so the drill-in on past weeks still
-- shows names after someone moves on.
drop policy members_select on members;
create policy members_select on members for select to authenticated
  using (
    auth_user_id = auth.uid()
    or team_id = app_current_team()
    or app_current_role() = 'hq'
    or app_has_grant('admin')
    or (
      app_current_role() = 'leader'
      and exists (
        select 1 from checkins c where c.member_id = members.id and c.team_id = app_current_team()
      )
    )
  );
-- hq sees every check-in, so only the project owner makes someone hq (or changes an hq member's
-- row). Admins also can't edit their own row: otherwise they could make themselves leader of any
-- team and read its check-ins.
create policy members_admin_insert on members for insert to authenticated
  with check (app_has_grant('admin') and role <> 'hq');
create policy members_admin_update on members for update to authenticated
  using (app_has_grant('admin') and role <> 'hq' and auth_user_id is distinct from auth.uid())
  with check (app_has_grant('admin') and role <> 'hq' and auth_user_id is distinct from auth.uid());

-- Leaders see check-ins made in their team, by the check-in's own team, not the member's current one.
drop policy checkins_select on checkins;
create policy checkins_select on checkins for select to authenticated
  using (
    member_id = app_current_member_id()
    or app_current_role() = 'hq'
    or (app_current_role() = 'leader' and team_id = app_current_team())
  );

-- ---------- 360 mentions: inherit the check-in's visibility ----------
-- The subquery runs under the caller's RLS on checkins, so a mention is visible exactly when its
-- check-in is. (0001's version already behaved like this, except that it hid a team-less member's
-- own mentions from them.)
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
grant insert (member_id, big_five), update (big_five) on table member_profiles to authenticated;
grant all on table member_profiles to service_role;

-- Personality data: yourself, and admins with the big_five grant (who also maintain it).
create policy member_profiles_select on member_profiles for select to authenticated
  using (member_id = app_current_member_id() or app_has_grant('big_five'));
create policy member_profiles_insert on member_profiles for insert to authenticated
  with check (app_has_grant('big_five'));
create policy member_profiles_update on member_profiles for update to authenticated
  using (app_has_grant('big_five')) with check (app_has_grant('big_five'));

insert into member_profiles (member_id, big_five)
  select id, big_five from members where big_five is not null;
alter table members drop column big_five;

-- ---------- scoring_settings: the R/Y/G rules, editable by admins ----------
-- One row. A check-in's score is activity_<a> × excellence_<e> × morale_<m> for its three scores
-- (each 1–5). A score at or above green_threshold is green, at or above yellow_threshold yellow,
-- and red below that. A team's cell for a week uses the mean of its graded check-ins. Colours are
-- worked out from these values when a page loads, so an edit recolours past weeks too.
-- The defaults: activity × excellence × a morale multiplier of 0.6–1.2; green ≥ 12, yellow ≥ 6.
-- Values have two decimals, so products have at most six and never sit within the app's
-- floating-point tolerance (1e-9) of a threshold: the database and the app agree on every colour.
create table scoring_settings (
  id                smallint primary key default 1 check (id = 1),
  activity_1        numeric(6,2) not null default 1,
  activity_2        numeric(6,2) not null default 2,
  activity_3        numeric(6,2) not null default 3,
  activity_4        numeric(6,2) not null default 4,
  activity_5        numeric(6,2) not null default 5,
  excellence_1      numeric(6,2) not null default 1,
  excellence_2      numeric(6,2) not null default 2,
  excellence_3      numeric(6,2) not null default 3,
  excellence_4      numeric(6,2) not null default 4,
  excellence_5      numeric(6,2) not null default 5,
  morale_1          numeric(6,2) not null default 0.6,
  morale_2          numeric(6,2) not null default 0.8,
  morale_3          numeric(6,2) not null default 1.0,
  morale_4          numeric(6,2) not null default 1.1,
  morale_5          numeric(6,2) not null default 1.2,
  green_threshold   numeric(8,2) not null default 12,
  yellow_threshold  numeric(8,2) not null default 6,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references members(id) on delete set null,
  -- A better score never counts for less.
  constraint scoring_activity_order check (
    0 < activity_1 and activity_1 <= activity_2 and activity_2 <= activity_3
    and activity_3 <= activity_4 and activity_4 <= activity_5),
  constraint scoring_excellence_order check (
    0 < excellence_1 and excellence_1 <= excellence_2 and excellence_2 <= excellence_3
    and excellence_3 <= excellence_4 and excellence_4 <= excellence_5),
  constraint scoring_morale_order check (
    0 < morale_1 and morale_1 <= morale_2 and morale_2 <= morale_3
    and morale_3 <= morale_4 and morale_4 <= morale_5),
  constraint scoring_thresholds_order check (yellow_threshold < green_threshold),
  -- Finite and sensible. Postgres numeric allows NaN (which sorts above every number, so the order
  -- checks alone pass it) and Infinity; either would break the heat-map for everyone.
  constraint scoring_values_range check (
    activity_1 >= 0.01 and activity_5 <= 1000
    and excellence_1 >= 0.01 and excellence_5 <= 1000
    and morale_1 >= 0.01 and morale_5 <= 1000
    and yellow_threshold > 0 and green_threshold <= 1000000)
);
alter table scoring_settings enable row level security;

-- Every one of the 125 possible check-ins is scored; each colour must come up at least once.
-- Also stamps who changed the settings and when.
create function scoring_settings_check() returns trigger
  language plpgsql set search_path = '' as $$
declare
  greens int;
  yellows int;
  reds int;
begin
  select
    count(*) filter (where s >= new.green_threshold),
    count(*) filter (where s >= new.yellow_threshold and s < new.green_threshold),
    count(*) filter (where s < new.yellow_threshold)
  into greens, yellows, reds
  from (
    select a * e * m as s
    from unnest(array[new.activity_1, new.activity_2, new.activity_3, new.activity_4, new.activity_5]) a
    cross join unnest(array[new.excellence_1, new.excellence_2, new.excellence_3, new.excellence_4, new.excellence_5]) e
    cross join unnest(array[new.morale_1, new.morale_2, new.morale_3, new.morale_4, new.morale_5]) m
  ) scores;
  if greens = 0 or yellows = 0 or reds = 0 then
    raise exception using
      errcode = 'check_violation',
      message = format(
        'These scoring settings leave a colour that no check-in can reach (of 125 possible check-ins: %s green, %s yellow, %s red).',
        greens, yellows, reds);
  end if;
  new.updated_at := now();
  new.updated_by := public.app_current_member_id();
  return new;
end $$;
revoke execute on function scoring_settings_check() from public, anon, authenticated;

create trigger scoring_settings_check before insert or update on scoring_settings
  for each row execute function scoring_settings_check();

insert into scoring_settings default values;

grant select on table scoring_settings to authenticated;
grant update (
  activity_1, activity_2, activity_3, activity_4, activity_5,
  excellence_1, excellence_2, excellence_3, excellence_4, excellence_5,
  morale_1, morale_2, morale_3, morale_4, morale_5,
  green_threshold, yellow_threshold
) on table scoring_settings to authenticated;
grant all on table scoring_settings to service_role;

create policy scoring_settings_select on scoring_settings for select to authenticated using (true);
create policy scoring_settings_admin_update on scoring_settings for update to authenticated
  using (app_has_grant('admin')) with check (app_has_grant('admin'));

-- ---------- storage: private bucket for check-in recordings ----------
-- 25 MiB covers well over 5 minutes of browser audio (Chrome's default Opus is about 1 MB a minute).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('checkin-audio', 'checkin-audio', false, 26214400, array['audio/*'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Members can't write to the bucket themselves. To record, the server (service role) picks the
-- path '<member_id>/<new file>' from the session and creates a signed upload URL for it with upsert
-- off; the browser uploads straight to Storage (so Vercel's 4.5 MB request limit doesn't apply), and
-- the URL can't overwrite an existing recording. A member-facing insert policy would let members
-- mint their own signed upload URLs, and Storage checks RLS only when such a URL is created, so an
-- upsert URL could later replace a graded recording.

-- Listen to: your own recordings, or anyone's with the recordings grant. Leaders get the transcript
-- and scores through checkins but not the voice itself: a recording is more sensitive personal data
-- than its transcript, so it goes no further than it has to (PDPA data minimisation).
create policy checkin_audio_select on storage.objects for select to authenticated
  using (
    bucket_id = 'checkin-audio'
    and (
      (storage.foldername(objects.name))[1] = public.app_current_member_id()::text
      or public.app_has_grant('recordings')
    )
  );

-- Permissive policies are OR-ed together, so a broad storage policy created earlier in the
-- dashboard (say "authenticated users can read everything") would widen access to recordings.
-- These restrictive policies are AND-ed with every other policy, so this bucket and its files follow
-- the rules above whatever else exists. Other buckets are unaffected.
-- (anon gets its own rule without the helper functions, which it isn't allowed to call.)
create policy checkin_audio_guard_select on storage.objects as restrictive for select to authenticated
  using (
    bucket_id is distinct from 'checkin-audio'
    or (storage.foldername(objects.name))[1] = public.app_current_member_id()::text
    or public.app_has_grant('recordings')
  );
create policy checkin_audio_guard_select_anon on storage.objects as restrictive for select to anon
  using (bucket_id is distinct from 'checkin-audio');
create policy checkin_audio_guard_insert on storage.objects as restrictive for insert to anon, authenticated
  with check (bucket_id is distinct from 'checkin-audio');
create policy checkin_audio_guard_update on storage.objects as restrictive for update to anon, authenticated
  using (bucket_id is distinct from 'checkin-audio')
  with check (bucket_id is distinct from 'checkin-audio');
create policy checkin_audio_guard_delete on storage.objects as restrictive for delete to anon, authenticated
  using (bucket_id is distinct from 'checkin-audio');
-- The bucket row too: a broad bucket policy would otherwise let anyone flip checkin-audio to public,
-- and public URLs skip the object rules entirely.
create policy checkin_audio_bucket_guard_update on storage.buckets as restrictive for update to anon, authenticated
  using (id is distinct from 'checkin-audio')
  with check (id is distinct from 'checkin-audio');
create policy checkin_audio_bucket_guard_delete on storage.buckets as restrictive for delete to anon, authenticated
  using (id is distinct from 'checkin-audio');
