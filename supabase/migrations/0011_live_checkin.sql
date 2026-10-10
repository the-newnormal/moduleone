-- 0011: the live check-in, and which rubric graded each check-in.
--
-- With the live check-in on (LIVE_CHECKIN=on), a member starts with one open question; while they
-- talk, their words are transcribed as they speak (OpenAI's realtime API, straight from the
-- browser with a short-lived key the server mints for them), and Claude reads what they have said
-- so far and suggests the next question (src/lib/coach, rubrics/coach.md). The recording itself is
-- unchanged: it is uploaded, transcribed again after submit and graded from that transcript, as
-- before. The live text and the questions' wording are never stored.
--
-- After this migration:
--   * live_checkin_sessions: one row per recording made in live mode. The server creates it, for
--     the member it takes from the session, before minting the realtime key, and checks it on every
--     coach call: whose it is, that it hasn't expired, and how many calls it has had, so nobody can
--     run up the bill. It keeps the coach's working out (coach_state): which topics were covered
--     and how far, which were asked and counts, by topic id only, never the member's words. Only
--     the server reads or writes it: the coach's reading of how much someone said is close to a
--     judgement, so members don't see it, and nor does anyone else through the app.
--   * The row is linked to the take once it is saved as a draft (audio_path), then to the check-in
--     it became (checkin_id), so the coach's coverage can be compared with the grade. A session
--     whose take was never submitted is deleted after 14 days (tidy_live_checkin_sessions).
--   * processing_costs (0008) also logs live transcription minutes and coach calls, against the
--     live session instead of a check-in. Still no member, no transcript and no grade.
--   * checkins.rubric_version: a fingerprint of the grading instructions (rubrics/grading.md plus
--     the fixed rules around it) that graded the check-in, so grades before and after a rubric
--     edit can be told apart.
-- As in 0004, members only read: every write here goes through server code with the service role.

-- ---------- checkins: which rubric graded it ----------
alter table checkins
  add column rubric_version text check (rubric_version is null or rubric_version ~ '^[0-9a-f]{12}$');
-- 0002's table-wide select grant covers it; a fingerprint says nothing about anyone.

-- ---------- live_checkin_sessions ----------
create table live_checkin_sessions (
  id              uuid primary key default gen_random_uuid(),
  -- Deleted with the member row, which 0009 only ever deletes for someone who never had a login
  -- (and so never had a session) or left nothing behind.
  member_id       uuid not null references members(id) on delete cascade,
  -- Same Singapore week as checkins.week_start (0002).
  week_start      date not null default (date_trunc('week', now() at time zone 'Asia/Singapore'))::date,
  started_at      timestamptz not null default now(),
  -- The coach stops answering after this. A recording stops at 10 minutes.
  expires_at      timestamptz not null,
  -- e.g. 'openai:gpt-live-transcribe', 'claude-haiku-5-5', and the fingerprint of rubrics/coach.md.
  stt_model       text not null check (length(stt_model) between 1 and 200),
  coach_model     text not null check (length(coach_model) between 1 and 200),
  coach_rubric    text not null check (coach_rubric ~ '^[0-9a-f]{12}$'),
  coach_calls     int not null default 0 check (coach_calls between 0 and 1000),
  last_coach_at   timestamptz,
  -- Topic ids, levels and counts (src/lib/coach/policy.ts CoachState); no words.
  coach_state     jsonb not null default '{}'::jsonb check (jsonb_typeof(coach_state) = 'object'),
  -- How far into the recording the latest coach call was, then how long the recording ran, as the
  -- browser said, capped at the time since started_at: what live transcription is billed on.
  recorded_ms     int not null default 0 check (recorded_ms between 0 and 3600000),
  ended_at        timestamptz,
  -- The take this session recorded, once saved as a draft; cleared when it becomes a check-in.
  audio_path      text,
  checkin_id      uuid references checkins(id) on delete set null,
  constraint live_checkin_sessions_week_start_monday check (extract(isodow from week_start) = 1),
  constraint live_checkin_sessions_expiry check (expires_at > started_at),
  -- Exactly '<member_id>/<file name>', as for checkins.audio_path (0002) and checkin_drafts (0004).
  constraint live_checkin_sessions_audio_path_own_folder
    check (audio_path is null or audio_path ~ ('^' || member_id::text || '/[A-Za-z0-9][A-Za-z0-9._-]*$'))
);
-- Sessions started per member per day (the start limit), and the takes they recorded.
create index live_checkin_sessions_member_started on live_checkin_sessions (member_id, started_at);
create index live_checkin_sessions_audio_path on live_checkin_sessions (audio_path) where audio_path is not null;
create index live_checkin_sessions_checkin on live_checkin_sessions (checkin_id) where checkin_id is not null;
-- The daily job's lists: sessions never ended, and unsubmitted ones to delete.
create index live_checkin_sessions_open on live_checkin_sessions (expires_at) where ended_at is null;
create index live_checkin_sessions_unlinked on live_checkin_sessions (started_at) where checkin_id is null;
alter table live_checkin_sessions enable row level security;

-- The server only. No grant and no policy for anon or authenticated, so the Data API returns
-- nothing to anyone.
grant all on table live_checkin_sessions to service_role;

-- ---------- processing_costs: live transcription and coach calls ----------
-- A live session's calls are paid for before (and whether or not) there is a check-in, so those
-- rows name the live session instead. Like checkin_id, live_session_id is not a foreign key: the
-- costs stay when the session is deleted, and the id says nothing about anyone once it is.
alter table processing_costs
  add column live_session_id uuid,
  alter column checkin_id drop not null,
  drop constraint processing_costs_step_check,
  add constraint processing_costs_step_check
    check (step in ('transcription', 'grading', 'live_transcription', 'coaching')),
  drop constraint processing_costs_step_fields,
  add constraint processing_costs_step_fields check (
    case step
      when 'transcription' then input_tokens is null and output_tokens is null
                                and cache_read_tokens is null and cache_write_tokens is null
      when 'live_transcription' then input_tokens is null and output_tokens is null
                                     and cache_read_tokens is null and cache_write_tokens is null
      else audio_ms is null and input_tokens is not null and output_tokens is not null
           and cache_read_tokens is not null and cache_write_tokens is not null
    end
  ),
  -- A check-in's steps name the check-in; a live session's name the session.
  add constraint processing_costs_subject check (
    case
      when step in ('transcription', 'grading') then checkin_id is not null and live_session_id is null
      else checkin_id is null and live_session_id is not null
    end
  );
create index processing_costs_live_session on processing_costs (live_session_id) where live_session_id is not null;

-- ---------- server-only functions ----------
-- Called by server code with the service role after it has taken the member from the session
-- (src/lib/checkin/live-sessions.ts). Errors use SQLSTATE P0001 with a stable message for the app
-- to act on: 'already_submitted', 'too_many_sessions', 'no_session', 'session_over',
-- 'too_many_calls', 'too_soon', 'bad_request'.

-- Starts a live session for the member's current week and returns its id. Refuses once this week's
-- check-in is in, and when the member has started p_max_per_day sessions in the last 24 hours.
-- Takes the same per-member, per-week lock as the draft functions (0004), so two starts can't both
-- slip under the limit.
create function start_live_checkin_session(
  p_member_id uuid, p_stt_model text, p_coach_model text, p_coach_rubric text, p_ttl_seconds int, p_max_per_day int
)
  returns uuid
  language plpgsql set search_path = '' as $$
declare
  v_week date := (date_trunc('week', now() at time zone 'Asia/Singapore'))::date;
  v_id uuid;
begin
  if p_ttl_seconds is null or p_ttl_seconds not between 60 and 3600
     or p_max_per_day is null or p_max_per_day not between 1 and 100 then
    raise exception using errcode = 'P0001', message = 'bad_request';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_member_id::text || v_week::text, 0));
  if exists (select 1 from public.checkins c where c.member_id = p_member_id and c.week_start = v_week) then
    raise exception using errcode = 'P0001', message = 'already_submitted';
  end if;
  if (select count(*) from public.live_checkin_sessions s
        where s.member_id = p_member_id and s.started_at > now() - interval '1 day') >= p_max_per_day then
    raise exception using errcode = 'P0001', message = 'too_many_sessions';
  end if;
  insert into public.live_checkin_sessions (member_id, week_start, expires_at, stt_model, coach_model, coach_rubric)
    values (p_member_id, v_week, now() + make_interval(secs => p_ttl_seconds), p_stt_model, p_coach_model, p_coach_rubric)
    returning id into v_id;
  return v_id;
end $$;

-- Claims one coach call on the member's own session and returns its state, when it started and
-- which call this is. Refuses a session that isn't theirs (or doesn't exist), one that has ended or
-- expired, one past p_max_calls, and a call less than p_min_interval_ms after the last one.
create function claim_live_coach_call(p_session_id uuid, p_member_id uuid, p_max_calls int, p_min_interval_ms int)
  returns table (coach_state jsonb, started_at timestamptz, call_number int)
  language plpgsql set search_path = '' as $$
declare
  v public.live_checkin_sessions%rowtype;
begin
  select * into v from public.live_checkin_sessions s
    where s.id = p_session_id and s.member_id = p_member_id
    for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'no_session';
  end if;
  if v.ended_at is not null or v.expires_at <= now() then
    raise exception using errcode = 'P0001', message = 'session_over';
  end if;
  if v.coach_calls >= p_max_calls then
    raise exception using errcode = 'P0001', message = 'too_many_calls';
  end if;
  if v.last_coach_at is not null
     and v.last_coach_at > now() - make_interval(secs => greatest(p_min_interval_ms, 0) / 1000.0) then
    raise exception using errcode = 'P0001', message = 'too_soon';
  end if;
  update public.live_checkin_sessions s
    set coach_calls = s.coach_calls + 1, last_coach_at = now()
    where s.id = p_session_id;
  return query select v.coach_state, v.started_at, v.coach_calls + 1;
end $$;

-- Saves the state a coach call worked out, and how far into the recording it was. Only if no later
-- call has been claimed since (call_number is still the latest) and the session is still open, so
-- a slow call never overwrites a newer one's state. Returns whether it saved.
create function save_live_coach_state(
  p_session_id uuid, p_member_id uuid, p_call_number int, p_coach_state jsonb, p_recorded_ms int
)
  returns boolean
  language plpgsql set search_path = '' as $$
declare
  v_saved boolean;
begin
  if p_coach_state is null or jsonb_typeof(p_coach_state) <> 'object' then
    raise exception using errcode = 'P0001', message = 'bad_request';
  end if;
  update public.live_checkin_sessions s
    set coach_state = p_coach_state,
        recorded_ms = least(greatest(coalesce(p_recorded_ms, 0), s.recorded_ms, 0),
                            extract(epoch from now() - s.started_at) * 1000, 3600000)
    where s.id = p_session_id and s.member_id = p_member_id
      and s.coach_calls = p_call_number and s.ended_at is null
    returning true into v_saved;
  return coalesce(v_saved, false);
end $$;

-- Ends the member's session (the recorder finished, or the page went away) and returns how long
-- the recording ran, capped at the time since it started, for the live transcription cost. Returns
-- null if there's no such session or it had already ended, so a repeated call logs nothing twice.
create function end_live_checkin_session(p_session_id uuid, p_member_id uuid, p_recorded_ms int)
  returns int
  language plpgsql set search_path = '' as $$
declare
  v_ms int;
begin
  -- The time since it started stays numeric until capped: as an int it overflows after 24 days, and
  -- a session the daily job missed could be that old.
  update public.live_checkin_sessions s
    set ended_at = now(),
        recorded_ms = least(greatest(coalesce(p_recorded_ms, 0), s.recorded_ms, 0),
                            extract(epoch from now() - s.started_at) * 1000, 3600000)
    where s.id = p_session_id and s.member_id = p_member_id and s.ended_at is null
    returning s.recorded_ms into v_ms;
  return v_ms;
end $$;

-- The daily job. Ends sessions the browser never ended (closed tab, lost connection) once they are
-- an hour past their expiry, returning each with the recording length the coach last heard of, so
-- the server can log its live transcription; then deletes sessions whose take never became a check-in
-- (never saved, replaced, deleted, or the check-in was reset) after 14 days.
create function tidy_live_checkin_sessions(p_limit int default 500)
  returns table (session_id uuid, stt_model text, recorded_ms int)
  language plpgsql set search_path = '' as $$
begin
  return query
    with stale as (
      select s.id from public.live_checkin_sessions s
        where s.ended_at is null and s.expires_at < now() - interval '1 hour'
        order by s.expires_at
        limit greatest(p_limit, 0)
        for update skip locked
    )
    update public.live_checkin_sessions s
      set ended_at = now()
      from stale
      where s.id = stale.id
      returning s.id, s.stt_model, s.recorded_ms;
  delete from public.live_checkin_sessions s
    where s.checkin_id is null and s.started_at < now() - interval '14 days';
end $$;

revoke execute on function
  start_live_checkin_session(uuid, text, text, text, int, int),
  claim_live_coach_call(uuid, uuid, int, int),
  save_live_coach_state(uuid, uuid, int, jsonb, int),
  end_live_checkin_session(uuid, uuid, int),
  tidy_live_checkin_sessions(int)
  from public, anon, authenticated;
grant execute on function
  start_live_checkin_session(uuid, text, text, text, int, int),
  claim_live_coach_call(uuid, uuid, int, int),
  save_live_coach_state(uuid, uuid, int, jsonb, int),
  end_live_checkin_session(uuid, uuid, int),
  tidy_live_checkin_sessions(int)
  to service_role;
