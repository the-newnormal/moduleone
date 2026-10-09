-- Seat a Master Admin (members.role = 'hq') in a division, so their own check-ins count for it.
--
-- A Master Admin sees everything wherever they sit, but a check-in is filed under the team its
-- maker sits in (checkins.team_id, from members.team_id). One with no seat checks in under no
-- team, so their check-ins never reach the heat-map. Sitting in a division fixes that: they stay
-- Master Admin (members_lead_where_placed leaves hq as it is), and show with the division's
-- leader title ("Director", say: admins set it on the division's page).
--
-- Admins can't do this in the app (nobody edits an hq row there, nor their own), so the project
-- owner runs it in the Supabase dashboard's SQL editor, which runs under READ COMMITTED as the
-- tree rules need. Set the three values below, then run it. It refuses in words if anything
-- doesn't match, and changes nothing then.
do $$
declare
  -- Whose login: the email they sign in with.
  v_email      text := 'ashton@newnormal.sg';
  -- Where they sit: an active division's name.
  v_division   text := 'HQ';
  -- Also file their earlier check-ins, made with no seat, under that division.
  v_backfill   boolean := true;

  v_member     uuid;
  v_role       text;
  v_team       uuid;
  v_moved      int;
begin
  select m.id, m.role into v_member, v_role
  from public.members m join auth.users u on u.id = m.auth_user_id
  where lower(u.email) = lower(v_email);
  if v_member is null then
    raise exception 'No member signs in as %.', v_email;
  elsif v_role <> 'hq' then
    raise exception '% is a %, not a Master Admin: an admin places them on the division''s page.', v_email, v_role;
  end if;

  select t.id into v_team from public.teams t
  where t.kind = 'division' and t.name = v_division and t.archived_at is null;
  if v_team is null then
    raise exception 'No active division is named %.', v_division;
  end if;

  update public.members set team_id = v_team where id = v_member;

  if v_backfill then
    update public.checkins set team_id = v_team where member_id = v_member and team_id is null;
    get diagnostics v_moved = row_count;
  end if;

  raise notice '% now sits in %, still Master Admin; % earlier check-in(s) filed there.',
    v_email, v_division, coalesce(v_moved, 0);
end $$;
