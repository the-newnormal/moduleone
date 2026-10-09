-- Development data. `supabase db start` / `db reset` (and CI) load it after the migrations, and so
-- would Supabase preview branches if they're turned on. Production never runs it: `db push` and
-- the GitHub integration's production deploy apply migrations only.
--
-- The divisions, domains and teams come from migration 0003 (the founding structure); this file
-- puts people in three of its teams, found by code: IP Lab 1 (IP.1, under Gather › IP Lab), Atlas
-- (AT.X, a Culture domain) and Youth Day 1 (YD.1, under Special Projects › Youth Day), a division
-- head, Nora Lee, in the Gather division itself (found by kind and name), and Grace Lim above every
-- division, in the organisation itself (0006).
--
-- Sign in at http://localhost:3000/login as any of these, then open the link from Mailpit
-- (http://127.0.0.1:54324):
--   hq@example.com      hq (sees every team, member and check-in) and admin, with the recordings grant
--                       (can play, not change, recordings) and the big_five grant; as an admin it can't
--                       edit its own or other hq rows
--   leader@example.com  leader of IP Lab 1 who also leads IP Lab 2 (team_leads): sees check-ins made
--                       in either (transcripts, not recordings; IP Lab 2 has none yet), and the nodes
--                       above them (IP Lab, Gather) but not check-ins made in those. A lead covers
--                       everything under the led node, so a leader of a domain (as their own team or
--                       through team_leads) would also see its sub-teams' check-ins
--   member@example.com  member of IP Lab 1: sees only their own check-ins (none yet this week), their
--                       teammates, and IP Lab 1, IP Lab and Gather
--   head@example.com    Nora Lee, head of Gather: a leader who sits in the Gather division itself
--                       (0005), so her check-ins are Gather's own and she sees every check-in in Gather
-- (Ben Ong, a leader with no login, sits in the domain Atlas itself, which has no sub-teams. Grace
-- Lim, with no login, sits in the organisation, The New Normal, so she leads every division; only
-- the project owner places people there.)
--
-- Eight weeks of check-ins, ending this week, tell a story on the heat-map under the default scoring
-- settings (scoring_settings): IP Lab 1 stays green apart from a yellow dip, Atlas slides from green
-- to red, and Youth Day 1 climbs from red to green. Some weeks are missed, and one check-in from this
-- week is still waiting for the grader. Re-running `db reset` moves the weeks to end at the current one.

-- ---------- logins ----------
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  confirmation_token, recovery_token, email_change_token_new, email_change,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
select
  '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', email, '', now(),
  -- GoTrue can't read NULL in these token columns, so they must be empty strings.
  '', '', '', '',
  '{"provider": "email", "providers": ["email"]}', '{}', now(), now()
from (values
  ('5eed0000-0000-4000-8000-000000000001'::uuid, 'hq@example.com'),
  ('5eed0000-0000-4000-8000-000000000002'::uuid, 'leader@example.com'),
  ('5eed0000-0000-4000-8000-000000000003'::uuid, 'member@example.com'),
  ('5eed0000-0000-4000-8000-000000000004'::uuid, 'head@example.com')
) as u (id, email);

insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select id::text, id, jsonb_build_object('sub', id::text, 'email', email, 'email_verified', true),
       'email', now(), now(), now()
from auth.users
where id in (
  '5eed0000-0000-4000-8000-000000000001',
  '5eed0000-0000-4000-8000-000000000002',
  '5eed0000-0000-4000-8000-000000000003',
  '5eed0000-0000-4000-8000-000000000004'
);

-- ---------- members ----------
insert into members (id, auth_user_id, name, team_id, role)
select v.id, v.auth_user_id, v.name, t.id, v.role
from (values
  ('3e3b0000-0000-4000-8000-000000000001'::uuid, '5eed0000-0000-4000-8000-000000000001'::uuid, 'Hana Lim',    null,   'hq'),
  ('3e3b0000-0000-4000-8000-000000000002',       '5eed0000-0000-4000-8000-000000000002',       'Leo Tan',     'IP.1', 'leader'),
  ('3e3b0000-0000-4000-8000-000000000003',       '5eed0000-0000-4000-8000-000000000003',       'Mei Wong',    'IP.1', 'member'),
  ('3e3b0000-0000-4000-8000-000000000004',       null,                                         'Ravi Kumar',  'IP.1', 'member'),
  ('3e3b0000-0000-4000-8000-000000000005',       null,                                         'Siti Rahman', 'IP.1', 'member'),
  ('3e3b0000-0000-4000-8000-000000000006',       null,                                         'Ben Ong',     'AT.X', 'leader'),
  ('3e3b0000-0000-4000-8000-000000000007',       null,                                         'Aisha Noor',  'AT.X', 'member'),
  ('3e3b0000-0000-4000-8000-000000000008',       null,                                         'Daniel Goh',  'AT.X', 'member'),
  ('3e3b0000-0000-4000-8000-000000000009',       null,                                         'Wei Chen',    'YD.1', 'leader'),
  ('3e3b0000-0000-4000-8000-000000000010',       null,                                         'Priya Nair',  'YD.1', 'member'),
  ('3e3b0000-0000-4000-8000-000000000011',       null,                                         'Farah Aziz',  'YD.1', 'member')
) as v (id, auth_user_id, name, team_code, role)
left join teams t on t.code = v.team_code;

-- Nora heads Gather from the division itself (divisions have no code).
insert into members (id, auth_user_id, name, team_id, role)
select '3e3b0000-0000-4000-8000-000000000012', '5eed0000-0000-4000-8000-000000000004', 'Nora Lee', t.id, 'leader'
from teams t where t.kind = 'division' and t.name = 'Gather';

-- Grace sits above every division, in the organisation itself. Placing her there makes her a
-- leader (0006); in production only the project owner does this, from the dashboard.
insert into members (id, name, team_id, role)
select '3e3b0000-0000-4000-8000-000000000013', 'Grace Lim', t.id, 'member'
from teams t where t.kind = 'organisation';

-- Leo also leads IP Lab 2 (in production, admins maintain team_leads in the app).
insert into team_leads (team_id, member_id)
select t.id, '3e3b0000-0000-4000-8000-000000000002' from teams t where t.code = 'IP.2';

-- In production the project owner adds grants in the Supabase dashboard; here hq gets all three.
insert into member_grants (member_id, grant_name) values
  ('3e3b0000-0000-4000-8000-000000000001', 'admin'),
  ('3e3b0000-0000-4000-8000-000000000001', 'recordings'),
  ('3e3b0000-0000-4000-8000-000000000001', 'big_five');

-- ---------- check-ins ----------
-- Each team's typical (activity, excellence, morale) for each week, by weeks before this one.
-- Each member adds a small fixed nudge (ja, je, jm) so check-ins within a team differ.
with trend (team_code, weeks_ago, a, e, m) as (values
  ('IP.1', 7, 4, 4, 4), ('IP.1', 6, 4, 4, 4), ('IP.1', 5, 4, 4, 3), ('IP.1', 4, 4, 3, 3),
  ('IP.1', 3, 3, 3, 2), ('IP.1', 2, 4, 3, 3), ('IP.1', 1, 4, 4, 4), ('IP.1', 0, 4, 4, 4),
  ('AT.X', 7, 4, 4, 4), ('AT.X', 6, 4, 4, 3), ('AT.X', 5, 4, 3, 3), ('AT.X', 4, 3, 3, 3),
  ('AT.X', 3, 3, 3, 2), ('AT.X', 2, 3, 2, 2), ('AT.X', 1, 2, 2, 2), ('AT.X', 0, 2, 2, 1),
  ('YD.1', 7, 2, 2, 2), ('YD.1', 6, 2, 3, 2), ('YD.1', 5, 3, 3, 2), ('YD.1', 4, 3, 3, 3),
  ('YD.1', 3, 3, 4, 3), ('YD.1', 2, 4, 4, 3), ('YD.1', 1, 4, 4, 4), ('YD.1', 0, 5, 4, 4)
),
nudge (member_name, seq, ja, je, jm) as (values
  ('Leo Tan',     1,  0,  1,  0), ('Mei Wong',   2,  1,  0,  0), ('Ravi Kumar', 3, -1,  0,  0),
  ('Siti Rahman', 4,  0, -1,  1), ('Ben Ong',    5,  0,  0,  1), ('Aisha Noor', 6,  1, -1,  0),
  ('Daniel Goh',  7, -1,  0, -1), ('Wei Chen',   8,  0,  1,  0), ('Priya Nair', 9,  1,  0, -1),
  ('Farah Aziz', 10, -1,  0,  1)
),
rows as (
  select
    mb.id as member_id,
    mb.name,
    n.seq,
    t.weeks_ago,
    -- The same Singapore-time week as the checkins.week_start default.
    (date_trunc('week', now() at time zone 'Asia/Singapore'))::date - 7 * t.weeks_ago as week_start,
    least(5, greatest(1, t.a + n.ja)) as a,
    least(5, greatest(1, t.e + n.je)) as e,
    least(5, greatest(1, t.m + n.jm)) as m
  from trend t
  join teams tm on tm.code = t.team_code
  join members mb on mb.team_id = tm.id
  join nudge n on n.member_name = mb.name
)
insert into checkins (
  member_id, week_start, transcript, activity_score, excellence_score, morale_score, rubric_review
)
select
  member_id,
  week_start,
  format('Seed check-in from %s for the week of %s.', name, week_start),
  -- Ravi's check-in this week hasn't been graded yet.
  case when pending then null else a end,
  case when pending then null else e end,
  case when pending then null else m end,
  case when pending then null else 'Seed data: scores come from supabase/seed.sql, not the grader.' end
from (select *, (weeks_ago = 0 and name = 'Ravi Kumar') as pending from rows) r
-- About one past week in five is missed. This week, only half the members (not Mei) have checked in.
where case
  when weeks_ago = 0 then seq % 2 = 1
  else (seq + weeks_ago) % 5 <> 4
end;

-- Nora's check-ins, made in Gather itself: steady, with every third week missed.
insert into checkins (
  member_id, week_start, transcript, activity_score, excellence_score, morale_score, rubric_review
)
select
  '3e3b0000-0000-4000-8000-000000000012',
  (date_trunc('week', now() at time zone 'Asia/Singapore'))::date - 7 * w,
  format('Seed check-in from Nora Lee for the week of %s.', (date_trunc('week', now() at time zone 'Asia/Singapore'))::date - 7 * w),
  4, 4, case when w % 2 = 0 then 4 else 3 end,
  'Seed data: scores come from supabase/seed.sql, not the grader.'
from generate_series(0, 7) w
where w % 3 <> 2;

-- Grace's check-ins, made in the organisation itself: a quiet dip three weeks ago, otherwise steady.
insert into checkins (
  member_id, week_start, transcript, activity_score, excellence_score, morale_score, rubric_review
)
select
  '3e3b0000-0000-4000-8000-000000000013',
  (date_trunc('week', now() at time zone 'Asia/Singapore'))::date - 7 * w,
  format('Seed check-in from Grace Lim for the week of %s.', (date_trunc('week', now() at time zone 'Asia/Singapore'))::date - 7 * w),
  case when w = 3 then 3 else 4 end, 4, case when w = 3 then 3 else 4 end,
  'Seed data: scores come from supabase/seed.sql, not the grader.'
from generate_series(0, 7) w
where w <> 5;
