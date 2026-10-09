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

revoke execute on function hq_delete_checkin_recording(uuid), hq_reset_checkin(uuid) from public, anon;
grant execute on function hq_delete_checkin_recording(uuid), hq_reset_checkin(uuid) to authenticated;
