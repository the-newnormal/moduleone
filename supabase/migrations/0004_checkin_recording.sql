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
--   * Drafts are the speaker's alone: not leaders, not hq, and not the recordings grant, until the
--     member submits.
--   * Members acknowledge a privacy notice once (per notice version) before their first recording.
-- As in 0002, members only read: every write goes through server code with the service role, which
-- takes the member from the session. The functions below are for that server code only.

-- ---------- checkins: who transcribed and graded it, and processing state ----------
alter table checkins
  -- When the member pressed Submit. Null for check-ins made before this migration.
  add column submitted_at timestamptz,
  add column transcript_model text,
  -- Stable codes from transcribe(), e.g. 'low_words_per_minute' or 'used_fallback:openai:whisper-1'.
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

-- ---------- checkin_drafts: this week's take, before it is submitted ----------
create table checkin_drafts (
  member_id    uuid not null references members(id) on delete cascade,
  -- Same Singapore week as checkins.week_start (see 0002).
  week_start   date not null default (date_trunc('week', now() at time zone 'Asia/Singapore'))::date,
  audio_path   text not null,
  mime_type    text not null,
  -- From the recorder; only used to sanity-check the transcript's length.
  duration_ms  int,
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

-- ---------- storage: drafts are private to the speaker ----------
-- 0002 lets holders of the recordings grant play every file in 'checkin-audio'. A draft isn't a
-- check-in yet, so this restrictive policy (AND-ed with every other select policy) keeps drafts to
-- their speaker. Submitting deletes the draft row in the same transaction as it creates the
-- check-in, so the recording becomes playable by grant holders exactly when it is submitted.
create function app_checkin_audio_is_draft(object_name text) returns boolean
  language sql stable security definer set search_path = '' as $$
    select exists (select 1 from public.checkin_drafts d where d.audio_path = app_checkin_audio_is_draft.object_name);
$$;
revoke execute on function app_checkin_audio_is_draft(text) from public, anon;
grant execute on function app_checkin_audio_is_draft(text) to authenticated, service_role;

create policy checkin_audio_drafts_speaker_only on storage.objects as restrictive for select to authenticated
  using (
    bucket_id is distinct from 'checkin-audio'
    or (storage.foldername(objects.name))[1] = public.app_current_member_id()::text
    or not public.app_checkin_audio_is_draft(objects.name)
  );

-- ---------- server-only functions: save, delete and submit drafts; claim processing ----------
-- Called by server code with the service role after it has taken the member from the session.
-- Each works on the current Singapore week, worked out exactly as the column defaults do, so a
-- draft and its check-in can't land in different weeks. Errors use SQLSTATE P0001 with a stable
-- message ('already_submitted', 'no_draft') for the app to act on.

-- Saves the member's take for this week, replacing any earlier one. Returns the replaced take's
-- audio_path (or null) so the caller can delete that file.
create function save_checkin_draft(p_member_id uuid, p_audio_path text, p_mime_type text, p_duration_ms int)
  returns text
  language plpgsql set search_path = '' as $$
declare
  v_week date := (date_trunc('week', now() at time zone 'Asia/Singapore'))::date;
  v_old text;
begin
  -- Serialise this member's draft changes for the week (also covers the no-draft-yet case).
  perform pg_advisory_xact_lock(hashtextextended(p_member_id::text || v_week::text, 0));
  if exists (select 1 from public.checkins c where c.member_id = p_member_id and c.week_start = v_week) then
    raise exception using errcode = 'P0001', message = 'already_submitted';
  end if;
  select d.audio_path into v_old
    from public.checkin_drafts d
    where d.member_id = p_member_id and d.week_start = v_week;
  insert into public.checkin_drafts (member_id, week_start, audio_path, mime_type, duration_ms)
    values (p_member_id, v_week, p_audio_path, p_mime_type, p_duration_ms)
    on conflict (member_id, week_start) do update
      set audio_path = excluded.audio_path,
          mime_type = excluded.mime_type,
          duration_ms = excluded.duration_ms,
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
  select * into v_draft
    from public.checkin_drafts d
    where d.member_id = p_member_id and d.week_start = v_week;
  if not found then
    -- Already submitted (the draft is gone) or nothing recorded yet.
    if exists (select 1 from public.checkins c where c.member_id = p_member_id and c.week_start = v_week) then
      raise exception using errcode = 'P0001', message = 'already_submitted';
    end if;
    raise exception using errcode = 'P0001', message = 'no_draft';
  end if;
  insert into public.checkins (member_id, week_start, audio_path, submitted_at)
    values (p_member_id, v_week, v_draft.audio_path, now())
    on conflict (member_id, week_start) do nothing
    returning id into v_id;
  if v_id is null then
    raise exception using errcode = 'P0001', message = 'already_submitted';
  end if;
  delete from public.checkin_drafts d where d.member_id = p_member_id and d.week_start = v_week;
  return v_id;
end $$;

-- Claims a submitted, ungraded check-in for one processing attempt. Returns one row (who, which
-- recording, which attempt this is) if the caller should process it now, or no rows if it is already
-- graded, another attempt started less than 10 minutes ago, or it has used up its five attempts.
-- A failed attempt (processing_error set) can be retried straight away.
create function claim_checkin_processing(p_checkin_id uuid)
  returns table (member_id uuid, audio_path text, attempts int)
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
      returning c.member_id, c.audio_path, c.processing_attempts;
$$;

revoke execute on function
  save_checkin_draft(uuid, text, text, int), delete_checkin_draft(uuid),
  submit_checkin_draft(uuid), claim_checkin_processing(uuid)
  from public, anon, authenticated;
grant execute on function
  save_checkin_draft(uuid, text, text, int), delete_checkin_draft(uuid),
  submit_checkin_draft(uuid), claim_checkin_processing(uuid)
  to service_role;
