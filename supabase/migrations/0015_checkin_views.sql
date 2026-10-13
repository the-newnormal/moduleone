-- 0015: who opened a check-in, for its owner's Diary.
--
-- Each member's Diary lists the leaders and Master Admins (hq) who opened their check-ins in
-- Module One, or played their recordings, and when. The app notes a view in exactly two places, as
-- the signed-in viewer, before it hands anything over:
--   * opening a team's week (/portal/dashboard/[teamId]/[week]) notes 'opened' for every check-in
--     the page lists: the page sends each one's scores, review and transcript, even while the
--     transcript is folded;
--   * playing someone else's recording (/portal/dashboard/recording/[checkinId]) notes 'played'
--     before redirecting to the file.
-- One row per check-in, viewer, kind and Singapore day, keeping the first time that day: no count,
-- no page or link the view came from, no content. The owner's own reads are never noted.
--
--   * checkin_views: the log. Whose check-in it was and its week are copied onto each row (they
--     never change), so RLS needs no join and a reset doesn't orphan the row. The viewer's name and
--     Leader/HQ label are stored as they were when they looked: members_select (0003) hides most
--     viewers from the owner, and renaming someone later doesn't rewrite what they did.
--   * log_checkin_views: the one write open to signed-in users, like 0007's functions: SECURITY
--     DEFINER, and it notes only the caller, whom it takes from the session, never a parameter. It
--     re-states checkins_select (0003) to decide which of the ids passed the caller may read, so
--     it never notes a check-in they couldn't open: KEEP THE TWO IN STEP. A play also needs the
--     recordings grant and a recording. It skips the caller's own check-ins, and those whose owner
--     has no login (removed, or never linked), as nobody could read those rows. Nobody writes the
--     table any other way: signed-in users have no insert, update or delete on it.
--
-- Only the owner reads their log (owner_id): not leaders, hq, admins, grant holders, or the viewer
-- themselves. The project owner can still query it in the Supabase dashboard.
--
-- A Master Admin's reset (hq_reset_checkin, 0007) deletes the check-in but keeps its rows, with
-- checkin_id null: the owner still sees who opened the earlier check-in for that week, and whoever
-- resets it, who is also a viewer, can't erase their own viewing. Rows go only with the owner's
-- member row. Deleting a recording (hq_delete_checkin_recording, forget_expired_checkin_audio)
-- leaves them alone.
--
-- No existing function or policy changes.

-- ---------- checkin_views: who opened whose check-in ----------
create table checkin_views (
  id           uuid primary key default gen_random_uuid(),           -- uuid: selectAll pages by id
  -- The check-in. Null once a Master Admin resets (deletes) it; the owner still sees who opened it.
  checkin_id   uuid references checkins(id) on delete set null,
  -- Whose it is and which week (copied from the check-in, which never changes owner), so RLS needs
  -- no join and a reset doesn't orphan the row.
  owner_id     uuid not null references members(id) on delete cascade,
  week_start   date not null,
  -- Who looked. Kept (null) if their member row is ever deleted; the name stays.
  viewer_id    uuid references members(id) on delete set null,
  viewer_name  text not null,   -- members.name when they looked (members_select hides most viewers from the owner)
  viewer_role  text not null,   -- 'leader' | 'hq' when they looked
  kind         text not null,   -- 'opened' (drill-in) | 'played' (recording route)
  viewed_on    date not null,   -- Singapore day, set by the function
  viewed_at    timestamptz not null default now(),   -- the first time that day
  constraint checkin_views_kind check (kind in ('opened', 'played')),
  constraint checkin_views_viewer_role check (viewer_role in ('leader', 'hq')),
  constraint checkin_views_not_owner check (viewer_id is distinct from owner_id),
  constraint checkin_views_week_start_monday check (extract(isodow from week_start) = 1),
  constraint checkin_views_once_a_day unique (checkin_id, viewer_id, kind, viewed_on)  -- also serves the checkin_id FK
);
create index checkin_views_owner on checkin_views (owner_id, id);   -- the Diary's paged read
create index checkin_views_viewer on checkin_views (viewer_id);     -- the on-delete-set-null
alter table checkin_views enable row level security;

grant select on table checkin_views to authenticated;
grant all on table checkin_views to service_role;
-- Only the owner: no exception for hq, admins, grant holders or the viewer. Deliberately NOT the
-- mentions pattern (exists … checkins), which would hand leaders and hq other people's logs.
create policy checkin_views_select on checkin_views for select to authenticated
  using (owner_id = (select app_current_member_id()));

-- ---------- log_checkin_views: the viewer notes what they opened ----------
-- Notes that the signed-in viewer opened these check-ins, or played this one's recording. Pass every
-- id shown: it keeps only those checkins_select (0003) lets them read, never their own, only owners
-- with a login, and for 'played' only with the recordings grant and a recording. Returns nothing,
-- so it says nothing about ids it skips. Errors: 22023 'bad_kind' for any kind but those two.
--
-- Rows are taken in id order and held FOR KEY SHARE, so two tabs logging overlapping lists lock
-- them in the same order (no deadlock), and a reset in progress is waited for, after which its
-- check-in is skipped (no foreign-key error). ON CONFLICT DO NOTHING keeps the day's first row.
create function log_checkin_views(p_checkin_ids uuid[], p_kind text) returns void
  language plpgsql security definer set search_path = '' as $$
declare
  v_viewer public.members%rowtype;
  v_led    uuid[];
begin
  if p_kind is null or p_kind not in ('opened', 'played') then
    raise exception using errcode = 'invalid_parameter_value', message = 'bad_kind';
  end if;
  -- The viewer is whoever is signed in, never a parameter. No member row, or removed: nothing.
  select * into v_viewer from public.members m where m.id = public.app_current_member_id();
  if not found or coalesce(cardinality(p_checkin_ids), 0) = 0 then
    return;
  end if;
  if p_kind = 'played' and not coalesce(public.app_has_grant('recordings'), false) then
    return;
  end if;
  v_led := public.app_led_team_ids();   -- once, not per row
  insert into public.checkin_views
      (checkin_id, owner_id, week_start, viewer_id, viewer_name, viewer_role, kind, viewed_on)
    select c.id, c.member_id, c.week_start, v_viewer.id, v_viewer.name, v_viewer.role, p_kind,
           (now() at time zone 'Asia/Singapore')::date
    from public.checkins c
    join public.members o on o.id = c.member_id
    where c.id = any (p_checkin_ids)
      and c.member_id <> v_viewer.id                               -- never your own
      and (v_viewer.role = 'hq' or c.team_id = any (v_led))        -- checkins_select's other two arms
      and (p_kind = 'opened' or c.audio_path is not null)
      and o.auth_user_id is not null                               -- an owner who can read it
    order by c.id                                                  -- one lock order across tabs
    for key share of c                                             -- a reset in progress is waited for, then skipped
  on conflict (checkin_id, viewer_id, kind, viewed_on) do nothing;
end $$;
revoke execute on function log_checkin_views(uuid[], text) from public, anon;
grant execute on function log_checkin_views(uuid[], text) to authenticated;
