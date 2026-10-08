-- Development data. `supabase db start` / `db reset` (and CI) load it after the migrations, and so
-- would Supabase preview branches if they're turned on. Production never runs it: `db push` and
-- the GitHub integration's production deploy apply migrations only.
--
-- Sign in at http://localhost:3000/login as any of these, then open the link from Mailpit
-- (http://127.0.0.1:54324):
--   hq@example.com      hq and admin, with the recordings and big_five grants: sees and edits everything
--   leader@example.com  leader of Product: sees Product's check-ins (transcripts, not recordings)
--   member@example.com  member of Product: sees only their own check-ins (none yet this week)
--
-- Eight weeks of check-ins, ending this week, tell a story on the heat-map under the default scoring
-- settings (scoring_settings): Product stays green apart from a yellow dip, Sales slides from green
-- to red, and Ops climbs from red to green. Some weeks are missed, and one check-in from this week
-- is still waiting for the grader. Re-running `db reset` moves the weeks to end at the current one.

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
  ('5eed0000-0000-4000-8000-000000000003'::uuid, 'member@example.com')
) as u (id, email);

insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select id::text, id, jsonb_build_object('sub', id::text, 'email', email, 'email_verified', true),
       'email', now(), now(), now()
from auth.users
where id in (
  '5eed0000-0000-4000-8000-000000000001',
  '5eed0000-0000-4000-8000-000000000002',
  '5eed0000-0000-4000-8000-000000000003'
);

-- ---------- teams and members ----------
insert into teams (id, name, division) values
  ('7ea30000-0000-4000-8000-000000000001', 'Product', 'Studio'),
  ('7ea30000-0000-4000-8000-000000000002', 'Sales', 'Growth'),
  ('7ea30000-0000-4000-8000-000000000003', 'Ops', 'Operations');

insert into members (id, auth_user_id, name, team_id, role) values
  ('3e3b0000-0000-4000-8000-000000000001', '5eed0000-0000-4000-8000-000000000001', 'Hana Lim',    null,                                   'hq'),
  ('3e3b0000-0000-4000-8000-000000000002', '5eed0000-0000-4000-8000-000000000002', 'Leo Tan',     '7ea30000-0000-4000-8000-000000000001', 'leader'),
  ('3e3b0000-0000-4000-8000-000000000003', '5eed0000-0000-4000-8000-000000000003', 'Mei Wong',    '7ea30000-0000-4000-8000-000000000001', 'member'),
  ('3e3b0000-0000-4000-8000-000000000004', null,                                   'Ravi Kumar',  '7ea30000-0000-4000-8000-000000000001', 'member'),
  ('3e3b0000-0000-4000-8000-000000000005', null,                                   'Siti Rahman', '7ea30000-0000-4000-8000-000000000001', 'member'),
  ('3e3b0000-0000-4000-8000-000000000006', null,                                   'Ben Ong',     '7ea30000-0000-4000-8000-000000000002', 'leader'),
  ('3e3b0000-0000-4000-8000-000000000007', null,                                   'Aisha Noor',  '7ea30000-0000-4000-8000-000000000002', 'member'),
  ('3e3b0000-0000-4000-8000-000000000008', null,                                   'Daniel Goh',  '7ea30000-0000-4000-8000-000000000002', 'member'),
  ('3e3b0000-0000-4000-8000-000000000009', null,                                   'Wei Chen',    '7ea30000-0000-4000-8000-000000000003', 'leader'),
  ('3e3b0000-0000-4000-8000-000000000010', null,                                   'Priya Nair',  '7ea30000-0000-4000-8000-000000000003', 'member'),
  ('3e3b0000-0000-4000-8000-000000000011', null,                                   'Farah Aziz',  '7ea30000-0000-4000-8000-000000000003', 'member');

-- In production the project owner adds grants in the Supabase dashboard; here hq gets all three.
insert into member_grants (member_id, grant_name) values
  ('3e3b0000-0000-4000-8000-000000000001', 'admin'),
  ('3e3b0000-0000-4000-8000-000000000001', 'recordings'),
  ('3e3b0000-0000-4000-8000-000000000001', 'big_five');

-- ---------- check-ins ----------
-- Each team's typical (activity, excellence, morale) for each week, by weeks before this one.
-- Each member adds a small fixed nudge (ja, je, jm) so check-ins within a team differ.
with trend (team, weeks_ago, a, e, m) as (values
  ('Product', 7, 4, 4, 4), ('Product', 6, 4, 4, 4), ('Product', 5, 4, 4, 3), ('Product', 4, 4, 3, 3),
  ('Product', 3, 3, 3, 2), ('Product', 2, 4, 3, 3), ('Product', 1, 4, 4, 4), ('Product', 0, 4, 4, 4),
  ('Sales',   7, 4, 4, 4), ('Sales',   6, 4, 4, 3), ('Sales',   5, 4, 3, 3), ('Sales',   4, 3, 3, 3),
  ('Sales',   3, 3, 3, 2), ('Sales',   2, 3, 2, 2), ('Sales',   1, 2, 2, 2), ('Sales',   0, 2, 2, 1),
  ('Ops',     7, 2, 2, 2), ('Ops',     6, 2, 3, 2), ('Ops',     5, 3, 3, 2), ('Ops',     4, 3, 3, 3),
  ('Ops',     3, 3, 4, 3), ('Ops',     2, 4, 4, 3), ('Ops',     1, 4, 4, 4), ('Ops',     0, 5, 4, 4)
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
  join teams tm on tm.name = t.team
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
