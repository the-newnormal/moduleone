-- Module One — the Diary: members listen back to their own recordings, kept for a year.
--
-- After this migration:
--   * Each privacy-notice acceptance records how long the notice it accepted promised to keep the
--     recordings a member submits (recording_notices.recording_keep_days): 90 for every notice so far
--     (the default), 365 for the Diary's notice (the server's acceptNotice writes it).
--   * Submitting stamps the check-in with how long its recording is kept (audio_keep_days) and when it
--     is due to go (audio_delete_after: when Storage received the file, plus those days). 365 only if,
--     when the take started, the member's login had accepted a one-year notice and has accepted
--     nothing shorter since; otherwise 90, as the notice it was recorded under said. Check-ins made
--     before this migration keep 90.
--   * forget_expired_checkin_audio deletes a check-in's recording when its time is up (the earlier of
--     upload + audio_keep_days and audio_delete_after), and any other file (a draft, a take never
--     saved, a reset's leftover) after 90 days, as before. Nothing goes before 90 days.
-- No function signature changes, so the app before the Diary keeps working against this: its
-- acceptances and check-ins get 90 days, as its notice says. Members still only read: 0002's and
-- 0004's table-wide select grants cover the new columns, RLS decides whose rows, and only the
-- server writes them.

-- ---------- what each acceptance promised ----------
alter table public.recording_notices
  add column recording_keep_days smallint not null default 90,
  add constraint recording_notices_recording_keep_days check (recording_keep_days in (90, 365));

-- ---------- how long each check-in's recording is kept ----------
alter table public.checkins
  -- The promise its recording was made under. No notice promises more than a year.
  add column audio_keep_days smallint not null default 90,
  -- When the recording is due to be deleted: when Storage received the file, plus audio_keep_days.
  -- The Diary shows it. Null when there was no file to stamp from; meaningless once audio_path is null.
  add column audio_delete_after timestamptz,
  add constraint checkins_audio_keep_days check (audio_keep_days in (90, 365));

-- Every recording that exists was made under a 90-day notice: due when 0004 would have deleted it.
-- (checkins_set_team runs before insert only, so this update fires nothing.)
update public.checkins c
  set audio_delete_after = o.created_at + interval '90 days'
  from storage.objects o
  where o.bucket_id = 'checkin-audio' and o.name = c.audio_path;

-- ---------- submitting stamps the promise ----------
-- 0004's function, plus how long the recording is kept. Same signature, so 0004's grants carry over
-- (restated below).
create or replace function public.submit_checkin_draft(p_member_id uuid, p_audio_path text) returns uuid
  language plpgsql set search_path = '' as $$
declare
  v_week date := (date_trunc('week', now() at time zone 'Asia/Singapore'))::date;
  v_draft public.checkin_drafts%rowtype;
  v_login uuid;
  v_started timestamptz;
  v_in_force timestamptz;
  v_keep smallint;
  v_uploaded timestamptz;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_member_id::text || v_week::text, 0));
  -- Locked as well: housekeeping deletes old drafts without the advisory lock (see 0004).
  select * into v_draft
    from public.checkin_drafts d
    where d.member_id = p_member_id and d.week_start = v_week
    for update;
  if not found then
    if exists (select 1 from public.checkins c where c.member_id = p_member_id and c.week_start = v_week) then
      raise exception using errcode = 'P0001', message = 'already_submitted';
    end if;
    raise exception using errcode = 'P0001', message = 'no_draft';
  end if;
  if v_draft.audio_path is distinct from p_audio_path then
    raise exception using errcode = 'P0001', message = 'draft_changed';
  end if;

  -- The member's login: the server submits only for the session's own member, found by that login
  -- (src/lib/checkin/session.ts), so this is who recorded the take and accepted the notice.
  select m.auth_user_id into v_login from public.members m where m.id = p_member_id;
  -- When the take started: it stopped at recorded_at ('-infinity' when unknown), after duration_ms
  -- (unknown: an hour, the longest a take can be). A doubtful start is early, and early means 90.
  v_started := v_draft.recorded_at - coalesce(v_draft.duration_ms, 3600000) * interval '1 millisecond';
  -- The acceptance in force then: the latest this login had made.
  select max(n.accepted_at) into v_in_force
    from public.recording_notices n
    where n.member_id = p_member_id and n.auth_user_id = v_login and n.accepted_at <= v_started;
  -- The shortest promise from that one on, so a later, shorter notice wins; 90 when none was in force.
  select coalesce(min(n.recording_keep_days), 90) into v_keep
    from public.recording_notices n
    where v_in_force is not null
      and n.member_id = p_member_id and n.auth_user_id = v_login and n.accepted_at >= v_in_force;
  -- Counted from when Storage received the file: the clock forget_expired_checkin_audio uses.
  select o.created_at into v_uploaded
    from storage.objects o
    where o.bucket_id = 'checkin-audio' and o.name = v_draft.audio_path;

  insert into public.checkins
      (member_id, week_start, audio_path, audio_duration_ms, submitted_at, audio_keep_days, audio_delete_after)
    values (p_member_id, v_week, v_draft.audio_path, v_draft.duration_ms, now(), v_keep,
            v_uploaded + make_interval(days => v_keep))
    on conflict (member_id, week_start) do nothing
    returning id into v_id;
  if v_id is null then
    raise exception using errcode = 'P0001', message = 'already_submitted';
  end if;
  delete from public.checkin_drafts d where d.member_id = p_member_id and d.week_start = v_week;
  return v_id;
end $$;
revoke execute on function public.submit_checkin_draft(uuid, text) from public, anon, authenticated;
grant execute on function public.submit_checkin_draft(uuid, text) to service_role;

-- ---------- each recording goes when its own time is up ----------
-- 0004's function, deleting each check-in's recording at the earlier of its promise (from the upload)
-- and its stamp. Same signature, so the daily job (housekeeping.ts) and 0004's grants are unchanged.
-- Files still kept are filtered out before the limit, so a year of them never fills a batch.
create or replace function public.forget_expired_checkin_audio(p_limit int default 500) returns setof text
  language plpgsql set search_path = '' as $$
declare
  v_names text[];
begin
  select coalesce(array_agg(o.name order by o.created_at), '{}') into v_names
    from (
      select s.name, s.created_at from storage.objects s
        where s.bucket_id = 'checkin-audio'
          -- Nothing goes before 90 days: every notice promised at least that.
          and s.created_at < now() - interval '90 days'
          and (
            -- A file no check-in points at: a draft, a take never saved, a reset's leftover.
            not exists (select 1 from public.checkins c where c.audio_path = s.name)
            -- A check-in's recording whose time is up: the shortest promise of any check-in that
            -- points at it, counted from the upload, or its stamp if that is sooner.
            or exists (
              select 1 from public.checkins c
                where c.audio_path = s.name
                  and (s.created_at + make_interval(days => c.audio_keep_days) <= now()
                       or c.audio_delete_after <= now())
            )
          )
        order by s.created_at
        limit p_limit
    ) o;
  update public.checkins c set audio_path = null where c.audio_path = any(v_names);
  delete from public.checkin_drafts d where d.audio_path = any(v_names);
  return query select unnest(v_names);
end $$;
revoke execute on function public.forget_expired_checkin_audio(int) from public, anon, authenticated;
grant execute on function public.forget_expired_checkin_audio(int) to service_role;
