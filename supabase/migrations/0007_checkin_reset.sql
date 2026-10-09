-- Module One — Master Admins (role hq) delete a week's recording, or reset the week's check-in.
--
-- After this migration:
--   * A Master Admin can take the recording off someone's check-in for a week: the file is deleted,
--     and the transcript and scores stay (as when a recording expires after 90 days).
--   * A Master Admin can reset someone's check-in for a week: the check-in (scores, transcript,
--     review, mentions) is deleted along with its recording. In the current week the member can
--     then record and submit again; for an earlier week the check-in is simply gone.
--   * Each of these is written to checkin_resets (who, whose, which week, when), which only Master
--     Admins read. Nobody writes it through the API.
-- Only the hq role may do either; the admin and recordings grants don't. Deleting a recording
-- doesn't need the recordings grant, as nobody hears it.
-- The functions below check the caller themselves (security definer, as the signed-in user) and
-- return the log row and the files to delete. Storage doesn't let SQL delete its files, so the
-- server action (src/app/portal/dashboard/[teamId]/[week]/actions.ts) then removes them with the
-- service role and stamps the row's files_removed_at. A file it fails to remove stays listed on an
-- unstamped row, which the daily job (removeResetRecordings) retries; until then nothing points at
-- it, so only the speaker can open it (0004).

-- ---------- checkin_resets: what Master Admins deleted ----------
create table checkin_resets (
  id          uuid primary key default gen_random_uuid(),
  -- Whose check-in it was. Kept (null) if their member row is ever deleted, like done_by.
  member_id   uuid references members(id) on delete set null,
  week_start  date not null,
  -- The team the check-in was made in.
  team_id     uuid references teams(id),
  action      text not null,
  -- The Master Admin who did it. Kept (null) if their member row is ever deleted.
  done_by     uuid references members(id) on delete set null,
  done_at     timestamptz not null default now(),
  -- The files to delete from Storage, and when they were deleted (null while any is left).
  audio_paths text[] not null default '{}',
  files_removed_at timestamptz,
  constraint checkin_resets_action check (action in ('recording_deleted', 'checkin_reset')),
  constraint checkin_resets_week_start_monday check (extract(isodow from week_start) = 1)
);
create index checkin_resets_member_week on checkin_resets (member_id, week_start);
-- The daily job's retry list.
create index checkin_resets_files_pending on checkin_resets (done_at)
  where files_removed_at is null and audio_paths <> '{}';
alter table checkin_resets enable row level security;

grant select on table checkin_resets to authenticated;
grant all on table checkin_resets to service_role;

create policy checkin_resets_select on checkin_resets for select to authenticated
  using ((select app_current_role()) = 'hq');

-- ---------- the two actions ----------
-- Both take the check-in's id and lock the member's week as the draft functions in 0004 do, so a
-- reset and a submit (or a take being saved) can't interleave. Errors: 42501 for anyone but a
-- Master Admin; P0001 'no_checkin' when the check-in doesn't exist (or is already gone).

-- Takes the recording off a check-in and returns the log row and its file, or no row if it had
-- none (nothing is logged then). A check-in waiting for the grader (submitted, not graded yet)
-- still needs its recording, so that raises P0001 'not_graded' instead: reset it, or wait. A
-- check-in from before 0004 (never submitted through the app, so never graded by it) has no
-- grader to wait for.
create function hq_delete_checkin_recording(p_checkin_id uuid)
  returns table (reset_id uuid, audio_paths text[])
  language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := public.app_current_member_id();
  v_checkin public.checkins%rowtype;
begin
  if v_actor is null or public.app_current_role() is distinct from 'hq' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'Only a Master Admin can delete recordings.';
  end if;
  select * into v_checkin from public.checkins c where c.id = p_checkin_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'no_checkin';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_checkin.member_id::text || v_checkin.week_start::text, 0));
  select * into v_checkin from public.checkins c where c.id = p_checkin_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'no_checkin';
  end if;
  if v_checkin.audio_path is null then
    return;
  end if;
  if v_checkin.submitted_at is not null and v_checkin.graded_at is null then
    raise exception using errcode = 'P0001', message = 'not_graded';
  end if;
  update public.checkins c set audio_path = null where c.id = p_checkin_id;
  return query
    insert into public.checkin_resets as r (member_id, week_start, team_id, action, done_by, audio_paths)
      values (v_checkin.member_id, v_checkin.week_start, v_checkin.team_id, 'recording_deleted', v_actor,
              array[v_checkin.audio_path])
      returning r.id, r.audio_paths;
end $$;

-- Deletes a check-in, and returns the log row and the files to delete: its recording and, should
-- one exist, a draft take for the same week (none can while the check-in does; checked anyway).
-- The files are an empty array for a check-in without a recording.
create function hq_reset_checkin(p_checkin_id uuid)
  returns table (reset_id uuid, audio_paths text[])
  language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := public.app_current_member_id();
  v_checkin public.checkins%rowtype;
  v_draft text;
begin
  if v_actor is null or public.app_current_role() is distinct from 'hq' then
    raise exception using errcode = 'insufficient_privilege',
      message = 'Only a Master Admin can reset check-ins.';
  end if;
  select * into v_checkin from public.checkins c where c.id = p_checkin_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'no_checkin';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_checkin.member_id::text || v_checkin.week_start::text, 0));
  select * into v_checkin from public.checkins c where c.id = p_checkin_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'no_checkin';
  end if;
  delete from public.checkin_drafts d
    where d.member_id = v_checkin.member_id and d.week_start = v_checkin.week_start
    returning d.audio_path into v_draft;
  -- checkin_mentions go with it (on delete cascade).
  delete from public.checkins c where c.id = p_checkin_id;
  return query
    insert into public.checkin_resets as r (member_id, week_start, team_id, action, done_by, audio_paths)
      values (v_checkin.member_id, v_checkin.week_start, v_checkin.team_id, 'checkin_reset', v_actor,
              array_remove(array[v_checkin.audio_path, v_draft], null))
      returning r.id, r.audio_paths;
end $$;

-- ---------- a deleted recording never comes back ----------
-- 0004's save_checkin_draft, plus one check: a take whose file a Master Admin deleted can't be
-- saved as a draft again. Without it, a save of the old take that arrives after a reset (a retry
-- from another tab, or a slow request) would bring back the recording the admin deleted, and the
-- file would then be in use again, so the daily retry couldn't remove it. Grants carry over (0004).
create or replace function save_checkin_draft(
  p_member_id uuid, p_audio_path text, p_mime_type text, p_duration_ms int, p_recorded_at timestamptz default null
)
  returns text
  language plpgsql set search_path = '' as $$
declare
  v_week date := (date_trunc('week', now() at time zone 'Asia/Singapore'))::date;
  -- Unknown counts as earliest, so any take with a time replaces it.
  v_recorded timestamptz := least(coalesce(p_recorded_at, '-infinity'), now());
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
  -- Never a file a Master Admin deleted (0007): a save that arrives after the reset (retried, or
  -- slow) must not bring the recording back as a draft. Checked under the lock, which the reset
  -- takes too, so a reset in progress has committed (or not) by now.
  if exists (select 1 from public.checkin_resets r where r.audio_paths @> array[p_audio_path]) then
    raise exception using errcode = 'P0001', message = 'bad_path';
  end if;
  if exists (select 1 from public.checkins c where c.member_id = p_member_id and c.week_start = v_week) then
    raise exception using errcode = 'P0001', message = 'already_submitted';
  end if;
  select d.audio_path, d.recorded_at into v_old, v_old_recorded
    from public.checkin_drafts d
    where d.member_id = p_member_id and d.week_start = v_week;
  if v_old <> p_audio_path then
    if p_recorded_at is null then
      raise exception using errcode = 'P0001', message = 'unknown_order';
    elsif v_old_recorded > v_recorded then
      raise exception using errcode = 'P0001', message = 'newer_draft';
    end if;
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

-- save_checkin_draft looks paths up here.
create index checkin_resets_audio_paths on checkin_resets using gin (audio_paths);

revoke execute on function hq_delete_checkin_recording(uuid), hq_reset_checkin(uuid) from public, anon;
grant execute on function hq_delete_checkin_recording(uuid), hq_reset_checkin(uuid) to authenticated;
