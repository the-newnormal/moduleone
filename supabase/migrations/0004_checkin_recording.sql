-- Module One — recording, transcribing and grading the weekly check-in.
--
-- After this migration:
--   * A member records the week's check-in as a draft: each take is uploaded to the private
--     'checkin-audio' bucket and remembered in checkin_drafts. They can play it back, delete it and
--     record again, and submit whenever they like during the week (Monday–Sunday, Singapore time).
--   * Submitting turns the draft into the week's checkins row in one transaction, so two tabs can't
--     both submit. After that there is no retake.
--   * The server transcribes and grades each submitted check-in, and records which models did so.
--     A failed attempt is retried on the same recording, up to five times.
--   * A recording is the speaker's alone (not leaders, not hq, not the recordings grant) until the
--     member submits it: drafts, and takes that were uploaded but never saved or were thrown away.
--   * Members acknowledge a privacy notice once (per notice version) before their first recording.
-- As in 0002, members only read: every write goes through server code with the service role, which
-- takes the member from the session. The functions below are for that server code only.

-- ---------- checkins: who transcribed and graded it, and processing state ----------
alter table checkins
  -- When the member pressed Submit. Null for check-ins made before this migration.
  add column submitted_at timestamptz,
  -- The recording's length as the recorder reported it (from the draft). Only a hint: it lets the
  -- server flag a transcript with far too few words for the recording's length.
  add column audio_duration_ms int check (audio_duration_ms is null or audio_duration_ms between 0 and 3600000),
  add column transcript_model text,
  -- Stable codes from transcribe() (src/lib/stt/warnings.ts), e.g. 'low_words_per_minute' or
  -- 'used_fallback:openai:whisper-1': reasons to read the grade with care.
  add column transcript_warnings text[] not null default '{}',
  -- The model that actually produced the grade (after any refusal fallback).
  add column grader_model text,
  add column graded_at timestamptz,
  -- Processing claims (see claim_checkin_processing): when the latest attempt started, how many
  -- there have been, and why the last one failed.
  add column processing_started_at timestamptz,
  add column processing_attempts int not null default 0 check (processing_attempts >= 0),
  add column processing_error text,
  -- The check-in's main theme. Never a colour: heat-map colours come only from the scores and
  -- scoring_settings (src/lib/health).
  add constraint checkins_category_theme
    check (category is null or category in ('delivery', 'collaboration', 'growth', 'wellbeing', 'blockers'));

-- 0002's table-wide `grant select on checkins to authenticated` covers the new columns too, and RLS
-- still decides whose rows: members see their own, leaders their team's, hq everyone's.

-- The server looks for check-ins that were submitted but never graded.
create index checkins_ungraded on checkins (submitted_at) where submitted_at is not null and graded_at is null;
-- Storage asks whether a file is a check-in's recording (app_checkin_audio_is_checkin below).
create index checkins_audio_path on checkins (audio_path) where audio_path is not null;

-- ---------- checkin_drafts: this week's take, before it is submitted ----------
create table checkin_drafts (
  member_id    uuid not null references members(id) on delete cascade,
  -- Same Singapore week as checkins.week_start (see 0002).
  week_start   date not null default (date_trunc('week', now() at time zone 'Asia/Singapore'))::date,
  audio_path   text not null,
  mime_type    text not null,
  -- From the recorder; only used to sanity-check the transcript's length.
  duration_ms  int,
  -- When the take was recorded, by the browser's clock (capped at now). A take recorded earlier
  -- that arrives late never replaces this one (save_checkin_draft).
  recorded_at  timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  primary key (member_id, week_start),
  constraint checkin_drafts_week_start_monday check (extract(isodow from week_start) = 1),
  -- Exactly '<member_id>/<file name>', as for checkins.audio_path in 0002: Storage resolves '..'
  -- and '%2e%2e', so a looser check would let the server open someone else's recording.
  constraint checkin_drafts_audio_path_own_folder
    check (audio_path ~ ('^' || member_id::text || '/[A-Za-z0-9][A-Za-z0-9._-]*$')),
  constraint checkin_drafts_mime_type_audio check (mime_type like 'audio/%'),
  constraint checkin_drafts_duration_range check (duration_ms is null or duration_ms between 0 and 3600000)
);
create unique index checkin_drafts_audio_path on checkin_drafts (audio_path);
alter table checkin_drafts enable row level security;

grant select on table checkin_drafts to authenticated;
grant all on table checkin_drafts to service_role;

-- Your own drafts only. A draft is a take the member may still throw away, so leaders and hq don't
-- see it until it is submitted.
create policy checkin_drafts_select on checkin_drafts for select to authenticated
  using (member_id = app_current_member_id());

-- ---------- recording_notices: the one-time privacy notice ----------
-- Before their first recording a member reads what is recorded, who processes it (and where), who
-- sees the results and how long recordings are kept. A new notice version (say, a different
-- transcription provider) asks again.
create table recording_notices (
  member_id       uuid not null references members(id) on delete cascade,
  notice_version  text not null check (length(notice_version) between 1 and 100),
  accepted_at     timestamptz not null default now(),
  primary key (member_id, notice_version)
);
alter table recording_notices enable row level security;

grant select on table recording_notices to authenticated;
grant all on table recording_notices to service_role;

create policy recording_notices_select on recording_notices for select to authenticated
  using (member_id = app_current_member_id());

-- ---------- storage: a recording is private to the speaker until it is submitted ----------
-- 0002 lets holders of the recordings grant play every file in 'checkin-audio'. This restrictive
-- policy (AND-ed with every other select policy) narrows that to files a check-in points at, so
-- everything else stays with its speaker: a draft, a take that was uploaded but never saved (the
-- save failed, or the member threw it away), and a replaced take whose removal failed. Naming what
-- others may see, rather than what they may not, keeps a file nothing points at private by
-- default. Submitting creates the check-in in one transaction, so a recording becomes playable by
-- grant holders exactly when it is submitted.
create function app_checkin_audio_is_checkin(object_name text) returns boolean
  language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.checkins c where c.audio_path = app_checkin_audio_is_checkin.object_name);
$$;
revoke execute on function app_checkin_audio_is_checkin(text) from public, anon;
grant execute on function app_checkin_audio_is_checkin(text) to authenticated, service_role;

create policy checkin_audio_unsubmitted_speaker_only on storage.objects as restrictive for select to authenticated
  using (
    bucket_id is distinct from 'checkin-audio'
    or (storage.foldername(objects.name))[1] = public.app_current_member_id()::text
    or public.app_checkin_audio_is_checkin(objects.name)
  );

-- ---------- server-only functions: save, delete and submit drafts; claim processing ----------
-- Called by server code with the service role after it has taken the member from the session.
-- Each works on the current Singapore week, worked out exactly as the column defaults do, so a
-- draft and its check-in can't land in different weeks. Errors use SQLSTATE P0001 with a stable
-- message ('already_submitted', 'no_draft', 'bad_path', 'newer_draft') for the app to act on.

-- Saves the member's take for this week, replacing any earlier one. Returns the replaced take's
-- audio_path (or null) so the caller can delete that file. A take recorded before the current
-- draft raises 'newer_draft' instead: it arrived late (a save that timed out and finished anyway,
-- or one retried from another tab or device), and must not replace the newer take.
create function save_checkin_draft(
  p_member_id uuid, p_audio_path text, p_mime_type text, p_duration_ms int, p_recorded_at timestamptz default null
)
  returns text
  language plpgsql set search_path = '' as $$
declare
  v_week date := (date_trunc('week', now() at time zone 'Asia/Singapore'))::date;
  v_recorded timestamptz := least(coalesce(p_recorded_at, now()), now());
  v_old text;
  v_old_recorded timestamptz;
begin
  -- Only a take made for this week ('<member_id>/<yyyy-mm-dd>-…', as the server names it), and
  -- never a file a check-in already uses. The app checks the week too, but on its own clock: a
  -- request that crosses Sunday midnight would otherwise turn an old take, or a submitted check-in's
  -- recording, into next week's draft, which housekeeping later deletes.
  if not starts_with(p_audio_path, p_member_id::text || '/' || to_char(v_week, 'YYYY-MM-DD') || '-')
     or exists (select 1 from public.checkins c where c.audio_path = p_audio_path) then
    raise exception using errcode = 'P0001', message = 'bad_path';
  end if;
  -- Serialise this member's draft changes for the week (also covers the no-draft-yet case).
  perform pg_advisory_xact_lock(hashtextextended(p_member_id::text || v_week::text, 0));
  if exists (select 1 from public.checkins c where c.member_id = p_member_id and c.week_start = v_week) then
    raise exception using errcode = 'P0001', message = 'already_submitted';
  end if;
  select d.audio_path, d.recorded_at into v_old, v_old_recorded
    from public.checkin_drafts d
    where d.member_id = p_member_id and d.week_start = v_week;
  if v_old is distinct from p_audio_path and v_old_recorded > v_recorded then
    raise exception using errcode = 'P0001', message = 'newer_draft';
  end if;
  insert into public.checkin_drafts (member_id, week_start, audio_path, mime_type, duration_ms, recorded_at)
    values (p_member_id, v_week, p_audio_path, p_mime_type, p_duration_ms, v_recorded)
    on conflict (member_id, week_start) do update
      set audio_path = excluded.audio_path,
          mime_type = excluded.mime_type,
          duration_ms = excluded.duration_ms,
          recorded_at = excluded.recorded_at,
          created_at = now();
  return case when v_old is distinct from p_audio_path then v_old end;
end $$;

-- Deletes the member's take for this week. Returns its audio_path (or null if there was none).
create function delete_checkin_draft(p_member_id uuid) returns text
  language plpgsql set search_path = '' as $$
declare
  v_week date := (date_trunc('week', now() at time zone 'Asia/Singapore'))::date;
  v_path text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_member_id::text || v_week::text, 0));
  delete from public.checkin_drafts d
    where d.member_id = p_member_id and d.week_start = v_week
    returning d.audio_path into v_path;
  return v_path;
end $$;

-- Turns the member's take for this week into the week's check-in. Returns the new check-in's id.
-- week_start and team_id come from the column default and 0002's trigger, as for any check-in.
create function submit_checkin_draft(p_member_id uuid) returns uuid
  language plpgsql set search_path = '' as $$
declare
  v_week date := (date_trunc('week', now() at time zone 'Asia/Singapore'))::date;
  v_draft public.checkin_drafts%rowtype;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_member_id::text || v_week::text, 0));
  -- Locked as well: housekeeping deletes old drafts without the advisory lock, so a submit just
  -- before midnight either waits for that delete (and finds no draft) or makes it wait until the
  -- draft has become the check-in.
  select * into v_draft
    from public.checkin_drafts d
    where d.member_id = p_member_id and d.week_start = v_week
    for update;
  if not found then
    -- Already submitted (the draft is gone) or nothing recorded yet.
    if exists (select 1 from public.checkins c where c.member_id = p_member_id and c.week_start = v_week) then
      raise exception using errcode = 'P0001', message = 'already_submitted';
    end if;
    raise exception using errcode = 'P0001', message = 'no_draft';
  end if;
  insert into public.checkins (member_id, week_start, audio_path, audio_duration_ms, submitted_at)
    values (p_member_id, v_week, v_draft.audio_path, v_draft.duration_ms, now())
    on conflict (member_id, week_start) do nothing
    returning id into v_id;
  if v_id is null then
    raise exception using errcode = 'P0001', message = 'already_submitted';
  end if;
  delete from public.checkin_drafts d where d.member_id = p_member_id and d.week_start = v_week;
  return v_id;
end $$;

-- Claims a submitted, ungraded check-in for one processing attempt. Returns one row (who, which
-- recording and how long it is, any transcript an earlier attempt saved, which attempt this is) if the caller should process it now, or no rows if it is already
-- graded, another attempt started less than 10 minutes ago, or it has used up its five attempts.
-- A failed attempt (processing_error set) can be retried straight away.
create function claim_checkin_processing(p_checkin_id uuid)
  returns table (member_id uuid, audio_path text, audio_duration_ms int, transcript text, attempts int)
  language sql set search_path = '' as $$
    update public.checkins c
      set processing_started_at = now(),
          processing_attempts = c.processing_attempts + 1,
          processing_error = null
      where c.id = p_checkin_id
        and c.submitted_at is not null
        and c.graded_at is null
        and c.audio_path is not null
        and c.processing_attempts < 5
        and (
          c.processing_started_at is null
          or c.processing_error is not null
          or c.processing_started_at < now() - interval '10 minutes'
        )
      returning c.member_id, c.audio_path, c.audio_duration_ms, c.transcript, c.processing_attempts;
$$;

revoke execute on function
  save_checkin_draft(uuid, text, text, int, timestamptz), delete_checkin_draft(uuid),
  submit_checkin_draft(uuid), claim_checkin_processing(uuid)
  from public, anon, authenticated;
grant execute on function
  save_checkin_draft(uuid, text, text, int, timestamptz), delete_checkin_draft(uuid),
  submit_checkin_draft(uuid), claim_checkin_processing(uuid)
  to service_role;

-- ---------- retention: recordings are deleted after 90 days ----------
-- The privacy notice promises it. Each night the server (src/app/api/cron/process-checkins) calls
-- this, then deletes the returned files through the Storage API (Storage doesn't let SQL delete
-- its files). It takes every 'checkin-audio' file older than 90 days off the check-in or draft
-- that points at it, so nothing refers to a deleted file; transcripts and scores stay. A file the
-- server fails to delete is still in storage.objects, so the next run returns it again.
create function forget_expired_checkin_audio(p_limit int default 500) returns setof text
  language plpgsql set search_path = '' as $$
declare
  v_names text[];
begin
  select coalesce(array_agg(o.name order by o.created_at), '{}') into v_names
    from (
      select s.name, s.created_at from storage.objects s
        where s.bucket_id = 'checkin-audio' and s.created_at < now() - interval '90 days'
        order by s.created_at
        limit p_limit
    ) o;
  update public.checkins c set audio_path = null where c.audio_path = any(v_names);
  delete from public.checkin_drafts d where d.audio_path = any(v_names);
  return query select unnest(v_names);
end $$;
revoke execute on function forget_expired_checkin_audio(int) from public, anon, authenticated;
grant execute on function forget_expired_checkin_audio(int) to service_role;
