-- Who opened a check-in, for its owner's Diary (migration 0015, checkin_views and log_checkin_views).
-- Run: supabase test db. Builds its own fixtures inside the transaction and rolls back.
--
-- Fixtures (af… logins, bf… teams, cf… members, df… check-ins):
--   VL Division (D)
--     VL Domain
--       Team T: m1 (member; this week's check-in with a recording, last week's without),
--               m2 (member, check-in with a recording), lead (leader, own check-in with a
--               recording), lead_r (leader, recordings grant, own check-in with a recording),
--               x (removed from Module One, check-in made before), n (login unlinked, check-in)
--       Team U: u_lead (leader of U, own check-in)
--   dom_lead  a leader with no team, lead of VL Domain through team_leads
--   div_head  sits in VL Division (and so leads it)
--   hq        role hq, no team, no grants, own check-in (made with no team)
--   admin     member role, admin grant           auditor  member role, recordings grant
--   outsider  signed in, but no members row      and signed-out requests (anon)
-- Counts over the whole log filter to fixture owners (cf…), so rows the app wrote to a local
-- database (opening a drill-in in the seed data) don't matter.
begin;
select plan(102);

-- ---------- helpers ----------
-- 'SQLSTATE: message' for a statement that fails, so a test can check both; 'no error' otherwise.
create function pg_temp.error_of(sql text) returns text language plpgsql as $$
begin
  execute sql;
  return 'no error';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;

-- Counts rows the caller can see. Queries filter to fixture ids, so seed data doesn't matter.
create function pg_temp.n(sql text) returns int language plpgsql as $$
declare result int;
begin
  execute format('select count(*) from (%s) q', sql) into result;
  return result;
end $$;

-- The Monday of this Singapore week, worked out the same way as the column defaults.
create function pg_temp.this_week() returns date language sql stable as $$
  select (date_trunc('week', now() at time zone 'Asia/Singapore'))::date;
$$;

-- Today in Singapore, as log_checkin_views stamps viewed_on.
create function pg_temp.today() returns date language sql stable as $$
  select (now() at time zone 'Asia/Singapore')::date;
$$;

-- A take's path as the server names it: '<member_id>/<the week's Monday>-<name>'.
create function pg_temp.take(member uuid, week date, name text) returns text language sql stable as $$
  select member::text || '/' || to_char(week, 'YYYY-MM-DD') || '-' || name;
$$;

-- Signs in as the given login for the rest of the transaction.
create function pg_temp.as_user(auth_id text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', auth_id, 'role', 'authenticated')::text, true);
$$;

-- Signs in as the given login and notes these check-ins, as the app does.
create function pg_temp.log_as(auth_id text, ids uuid[], kind text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', auth_id, 'role', 'authenticated')::text, true);
  perform public.log_checkin_views(ids, kind);
end $$;

-- Every fixture check-in, the list each persona passes (as a drill-in passes every id it shows).
create function pg_temp.all_ids() returns uuid[] language sql immutable as $$
  select array[
    'df000000-0000-4000-8000-000000000001', 'df000000-0000-4000-8000-000000000002',
    'df000000-0000-4000-8000-000000000003', 'df000000-0000-4000-8000-000000000004',
    'df000000-0000-4000-8000-000000000005', 'df000000-0000-4000-8000-000000000006',
    'df000000-0000-4000-8000-000000000007', 'df000000-0000-4000-8000-000000000008',
    'df000000-0000-4000-8000-000000000009'
  ]::uuid[];
$$;

-- What a viewer has logged, and which rows an owner has, read as the test's own role (which owns
-- the table, so RLS doesn't apply): only the owner can read the log through the API.
create function pg_temp.logged(viewer uuid, k text) returns setof uuid language sql stable security definer as $$
  select v.checkin_id from public.checkin_views v where v.viewer_id = viewer and v.kind = k order by 1;
$$;
create function pg_temp.rows_of(owner uuid) returns setof uuid language sql stable security definer as $$
  select v.id from public.checkin_views v where v.owner_id = owner order by 1;
$$;
-- Whether a check-in's owner has a login (signed-in users can't read most members' rows).
create function pg_temp.has_login(member uuid) returns boolean language sql stable security definer as $$
  select exists (select 1 from public.members m where m.id = member and m.auth_user_id is not null);
$$;

grant execute on function pg_temp.error_of(text), pg_temp.n(text), pg_temp.this_week(), pg_temp.today(),
  pg_temp.take(uuid, date, text), pg_temp.as_user(text), pg_temp.log_as(text, uuid[], text), pg_temp.all_ids(),
  pg_temp.logged(uuid, text), pg_temp.rows_of(uuid), pg_temp.has_login(uuid)
  to anon, authenticated, service_role;

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('af000000-0000-4000-8000-000000000001', 'm1@views.test'),
  ('af000000-0000-4000-8000-000000000002', 'm2@views.test'),
  ('af000000-0000-4000-8000-000000000003', 'lead@views.test'),
  ('af000000-0000-4000-8000-000000000004', 'lead-r@views.test'),
  ('af000000-0000-4000-8000-000000000005', 'dom-lead@views.test'),
  ('af000000-0000-4000-8000-000000000006', 'div-head@views.test'),
  ('af000000-0000-4000-8000-000000000007', 'u-lead@views.test'),
  ('af000000-0000-4000-8000-000000000008', 'hq@views.test'),
  ('af000000-0000-4000-8000-000000000009', 'admin@views.test'),
  ('af000000-0000-4000-8000-000000000010', 'auditor@views.test'),
  ('af000000-0000-4000-8000-000000000011', 'x@views.test'),
  ('af000000-0000-4000-8000-000000000012', 'n@views.test'),
  ('af000000-0000-4000-8000-000000000013', 'outsider@views.test');

-- The division goes under the organisation (0006).
insert into teams (id, name, kind) values ('bf000000-0000-4000-8000-000000000001', 'VL Division', 'division');
insert into teams (id, name, kind, parent_id) values
  ('bf000000-0000-4000-8000-000000000002', 'VL Domain', 'domain', 'bf000000-0000-4000-8000-000000000001');
insert into teams (id, name, kind, parent_id) values
  ('bf000000-0000-4000-8000-000000000003', 'VL Team T', 'team', 'bf000000-0000-4000-8000-000000000002'),
  ('bf000000-0000-4000-8000-000000000004', 'VL Team U', 'team', 'bf000000-0000-4000-8000-000000000002');

insert into members (id, auth_user_id, name, team_id, role) values
  ('cf000000-0000-4000-8000-000000000001', 'af000000-0000-4000-8000-000000000001', 'VL m1',       'bf000000-0000-4000-8000-000000000003', 'member'),
  ('cf000000-0000-4000-8000-000000000002', 'af000000-0000-4000-8000-000000000002', 'VL m2',       'bf000000-0000-4000-8000-000000000003', 'member'),
  ('cf000000-0000-4000-8000-000000000003', 'af000000-0000-4000-8000-000000000003', 'VL lead',     'bf000000-0000-4000-8000-000000000003', 'leader'),
  ('cf000000-0000-4000-8000-000000000004', 'af000000-0000-4000-8000-000000000004', 'VL lead_r',   'bf000000-0000-4000-8000-000000000003', 'leader'),
  ('cf000000-0000-4000-8000-000000000005', 'af000000-0000-4000-8000-000000000005', 'VL dom_lead', null,                                   'leader'),
  ('cf000000-0000-4000-8000-000000000006', 'af000000-0000-4000-8000-000000000006', 'VL div_head', 'bf000000-0000-4000-8000-000000000001', 'leader'),
  ('cf000000-0000-4000-8000-000000000007', 'af000000-0000-4000-8000-000000000007', 'VL u_lead',   'bf000000-0000-4000-8000-000000000004', 'leader'),
  ('cf000000-0000-4000-8000-000000000008', 'af000000-0000-4000-8000-000000000008', 'VL hq',       null,                                   'hq'),
  ('cf000000-0000-4000-8000-000000000009', 'af000000-0000-4000-8000-000000000009', 'VL admin',    null,                                   'member'),
  ('cf000000-0000-4000-8000-000000000010', 'af000000-0000-4000-8000-000000000010', 'VL auditor',  null,                                   'member'),
  ('cf000000-0000-4000-8000-000000000011', 'af000000-0000-4000-8000-000000000011', 'VL x',        'bf000000-0000-4000-8000-000000000003', 'member'),
  ('cf000000-0000-4000-8000-000000000012', 'af000000-0000-4000-8000-000000000012', 'VL n',        'bf000000-0000-4000-8000-000000000003', 'member');

insert into team_leads (team_id, member_id) values
  ('bf000000-0000-4000-8000-000000000002', 'cf000000-0000-4000-8000-000000000005');

insert into member_grants (member_id, grant_name) values
  ('cf000000-0000-4000-8000-000000000004', 'recordings'),
  ('cf000000-0000-4000-8000-000000000009', 'admin'),
  ('cf000000-0000-4000-8000-000000000010', 'recordings');

-- No team_id given: the trigger takes each member's current team (none for hq).
insert into checkins (id, member_id, week_start, audio_path) values
  ('df000000-0000-4000-8000-000000000001', 'cf000000-0000-4000-8000-000000000001', pg_temp.this_week(),
   pg_temp.take('cf000000-0000-4000-8000-000000000001', pg_temp.this_week(), 'm1.webm')),
  ('df000000-0000-4000-8000-000000000002', 'cf000000-0000-4000-8000-000000000001', pg_temp.this_week() - 7, null),
  ('df000000-0000-4000-8000-000000000003', 'cf000000-0000-4000-8000-000000000002', pg_temp.this_week(),
   pg_temp.take('cf000000-0000-4000-8000-000000000002', pg_temp.this_week(), 'm2.webm')),
  ('df000000-0000-4000-8000-000000000004', 'cf000000-0000-4000-8000-000000000003', pg_temp.this_week(),
   pg_temp.take('cf000000-0000-4000-8000-000000000003', pg_temp.this_week(), 'lead.webm')),
  ('df000000-0000-4000-8000-000000000005', 'cf000000-0000-4000-8000-000000000004', pg_temp.this_week(),
   pg_temp.take('cf000000-0000-4000-8000-000000000004', pg_temp.this_week(), 'lead-r.webm')),
  ('df000000-0000-4000-8000-000000000006', 'cf000000-0000-4000-8000-000000000007', pg_temp.this_week(),
   pg_temp.take('cf000000-0000-4000-8000-000000000007', pg_temp.this_week(), 'u-lead.webm')),
  ('df000000-0000-4000-8000-000000000007', 'cf000000-0000-4000-8000-000000000008', pg_temp.this_week(), null),
  ('df000000-0000-4000-8000-000000000008', 'cf000000-0000-4000-8000-000000000011', pg_temp.this_week(),
   pg_temp.take('cf000000-0000-4000-8000-000000000011', pg_temp.this_week(), 'x.webm')),
  ('df000000-0000-4000-8000-000000000009', 'cf000000-0000-4000-8000-000000000012', pg_temp.this_week(),
   pg_temp.take('cf000000-0000-4000-8000-000000000012', pg_temp.this_week(), 'n.webm'));

-- x is removed (as admin_remove_member leaves a row with history); n's login is unlinked by hand.
update members
set removed_at = now(), removed_login_id = auth_user_id, auth_user_id = null, team_id = null
where id = 'cf000000-0000-4000-8000-000000000011';
update members set auth_user_id = null where id = 'cf000000-0000-4000-8000-000000000012';

-- ---------- 1. the table ----------
select has_table('public', 'checkin_views', 'checkin_views exists');
select is((select relrowsecurity from pg_class where oid = 'public.checkin_views'::regclass), true, 'RLS is on for checkin_views');
select columns_are('public', 'checkin_views',
  array['id', 'checkin_id', 'owner_id', 'week_start', 'viewer_id', 'viewer_name', 'viewer_role', 'kind',
        'viewed_on', 'viewed_at'],
  'checkin_views has exactly the expected columns: no count, no source page, no content');
select table_privs_are('public', 'checkin_views', 'anon', array[]::text[], 'anon has no privileges on checkin_views');
select table_privs_are('public', 'checkin_views', 'authenticated', array['SELECT'], 'signed-in users only read checkin_views');
select table_privs_are(
  'public', 'checkin_views', 'service_role',
  array['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'],
  'the server (service_role) has full access, as on every table'
);
select is(
  (select array_agg(a.attname::text || ' -> ' || c.confrelid::regclass::text || ', on delete ' || c.confdeltype::text order by a.attname)
   from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
   where c.conrelid = 'public.checkin_views'::regclass and c.contype = 'f'),
  array['checkin_id -> checkins, on delete n', 'owner_id -> members, on delete c', 'viewer_id -> members, on delete n'],
  'a reset keeps the rows (checkin_id set null), they go with the owner''s row, and outlive the viewer''s'
);
select col_is_unique('public', 'checkin_views', array['checkin_id', 'viewer_id', 'kind', 'viewed_on'],
  'one row per check-in, viewer, kind and day');

-- Every constraint refuses a bad row, even from the server. The good row: hq opened lead's check-in.
set local role service_role;
select is(
  pg_temp.error_of(format(
    $$insert into checkin_views (checkin_id, owner_id, week_start, viewer_id, viewer_name, viewer_role, kind, viewed_on)
      values ('df000000-0000-4000-8000-000000000004', %L, %L, %L, 'VL hq', %L, %L, %L)$$,
    s.owner, s.week, s.viewer, s.role, s.kind, pg_temp.today() - 30)),
  s.error, s.why)
from (values
  ('cf000000-0000-4000-8000-000000000003', pg_temp.this_week(),     'cf000000-0000-4000-8000-000000000008', 'hq',     'listened',
   '23514: new row for relation "checkin_views" violates check constraint "checkin_views_kind"', 'a kind other than opened or played is refused'),
  ('cf000000-0000-4000-8000-000000000003', pg_temp.this_week(),     'cf000000-0000-4000-8000-000000000008', 'member', 'opened',
   '23514: new row for relation "checkin_views" violates check constraint "checkin_views_viewer_role"', 'a viewer is a leader or hq, never a member'),
  ('cf000000-0000-4000-8000-000000000003', pg_temp.this_week(),     'cf000000-0000-4000-8000-000000000003', 'leader', 'opened',
   '23514: new row for relation "checkin_views" violates check constraint "checkin_views_not_owner"', 'nobody is logged viewing their own check-in'),
  ('cf000000-0000-4000-8000-000000000003', pg_temp.this_week() + 2, 'cf000000-0000-4000-8000-000000000008', 'hq',     'opened',
   '23514: new row for relation "checkin_views" violates check constraint "checkin_views_week_start_monday"', 'a week starts on a Monday')
) s(owner, week, viewer, role, kind, error, why);
select is(
  pg_temp.error_of(format(
    $$insert into checkin_views (checkin_id, owner_id, week_start, viewer_id, viewer_name, viewer_role, kind, viewed_on)
      values ('df000000-0000-4000-8000-000000000004', 'cf000000-0000-4000-8000-000000000003', %1$L,
              'cf000000-0000-4000-8000-000000000008', 'VL hq', 'hq', 'opened', %2$L),
             ('df000000-0000-4000-8000-000000000004', 'cf000000-0000-4000-8000-000000000003', %1$L,
              'cf000000-0000-4000-8000-000000000008', 'VL hq', 'hq', 'opened', %2$L)$$,
    pg_temp.this_week(), pg_temp.today() - 30)),
  '23505: duplicate key value violates unique constraint "checkin_views_once_a_day"',
  'a second row for the same check-in, viewer, kind and day is refused'
);
reset role;
select is((select count(*)::int from checkin_views where owner_id::text like 'cf000000-%'), 0, 'the refused rows left nothing behind');

-- ---------- 2. the function ----------
select function_privs_are('public', 'log_checkin_views', array['uuid[]', 'text'], r, array[]::text[],
  format('%s cannot call log_checkin_views', r))
  from unnest(array['anon', 'service_role']) r;
select function_privs_are('public', 'log_checkin_views', array['uuid[]', 'text'], 'authenticated', array['EXECUTE'],
  'signed-in users can call log_checkin_views (it notes only themselves)');
select is(has_function_privilege('public', 'public.log_checkin_views(uuid[], text)', 'execute'), false,
  'PUBLIC cannot call log_checkin_views');
select is((select prosecdef from pg_proc where oid = 'public.log_checkin_views(uuid[], text)'::regprocedure), true,
  'log_checkin_views runs as the owner: signed-in users can''t write the table');
select is((select proconfig from pg_proc where oid = 'public.log_checkin_views(uuid[], text)'::regprocedure),
  array['search_path=""'], 'log_checkin_views runs with an empty search_path');
select is((select provolatile from pg_proc where oid = 'public.log_checkin_views(uuid[], text)'::regprocedure), 'v'::"char",
  'log_checkin_views is volatile (it writes)');
select is(pg_get_function_result('public.log_checkin_views(uuid[], text)'::regprocedure), 'void',
  'it returns nothing, so it says nothing about the ids it skips');

-- ---------- 3. parity with checkins_select ----------
-- Each persona passes every fixture id. What it logs is exactly what RLS lets it read, less its own
-- check-ins and those whose owner has no login. This pins the function to checkins_select.
set local role authenticated;
select results_eq(
  format($$select pg_temp.logged(%L, 'opened')$$, p.member),
  $$select id from checkins
    where id = any (pg_temp.all_ids())
      and member_id is distinct from app_current_member_id()
      and pg_temp.has_login(member_id)
    order by 1$$,
  format('%s logs what checkins_select shows them, less their own and owners with no login', p.who)
)
from (values
  ('af000000-0000-4000-8000-000000000001', 'cf000000-0000-4000-8000-000000000001', 'm1 (a member)'),
  ('af000000-0000-4000-8000-000000000002', 'cf000000-0000-4000-8000-000000000002', 'm2 (a member)'),
  ('af000000-0000-4000-8000-000000000003', 'cf000000-0000-4000-8000-000000000003', 'lead (leader of T)'),
  ('af000000-0000-4000-8000-000000000004', 'cf000000-0000-4000-8000-000000000004', 'lead_r (leader of T, recordings grant)'),
  ('af000000-0000-4000-8000-000000000005', 'cf000000-0000-4000-8000-000000000005', 'dom_lead (domain lead through team_leads)'),
  ('af000000-0000-4000-8000-000000000006', 'cf000000-0000-4000-8000-000000000006', 'div_head (sits in the division)'),
  ('af000000-0000-4000-8000-000000000007', 'cf000000-0000-4000-8000-000000000007', 'u_lead (leader of U)'),
  ('af000000-0000-4000-8000-000000000008', 'cf000000-0000-4000-8000-000000000008', 'hq'),
  ('af000000-0000-4000-8000-000000000009', 'cf000000-0000-4000-8000-000000000009', 'admin (admin grant)'),
  ('af000000-0000-4000-8000-000000000010', 'cf000000-0000-4000-8000-000000000010', 'auditor (recordings grant)'),
  ('af000000-0000-4000-8000-000000000011', 'cf000000-0000-4000-8000-000000000011', 'x''s old login (removed)'),
  ('af000000-0000-4000-8000-000000000012', 'cf000000-0000-4000-8000-000000000012', 'n''s old login (unlinked)'),
  ('af000000-0000-4000-8000-000000000013', null,                                   'a login with no member row')
) p(login, member, who)
cross join lateral (select pg_temp.log_as(p.login, pg_temp.all_ids(), 'opened')) logged;
reset role;

-- ---------- 4. who logs what ----------
select is(
  array(select pg_temp.logged('cf000000-0000-4000-8000-000000000003', 'opened')),
  array['df000000-0000-4000-8000-000000000001', 'df000000-0000-4000-8000-000000000002',
        'df000000-0000-4000-8000-000000000003', 'df000000-0000-4000-8000-000000000005']::uuid[],
  'lead logs m1''s two check-ins, m2''s and lead_r''s: not its own, not U''s, not x''s or n''s'
);
select is(
  array(select pg_temp.logged(v, 'opened')),
  array['df000000-0000-4000-8000-000000000001', 'df000000-0000-4000-8000-000000000002',
        'df000000-0000-4000-8000-000000000003', 'df000000-0000-4000-8000-000000000004',
        'df000000-0000-4000-8000-000000000005', 'df000000-0000-4000-8000-000000000006']::uuid[],
  format('%s logs T''s and U''s check-ins (leading the domain or sitting in the division covers both)', who)
)
from (values ('cf000000-0000-4000-8000-000000000005'::uuid, 'dom_lead'),
             ('cf000000-0000-4000-8000-000000000006'::uuid, 'div_head')) d(v, who);
select is(
  array(select pg_temp.logged('cf000000-0000-4000-8000-000000000008', 'opened')),
  array['df000000-0000-4000-8000-000000000001', 'df000000-0000-4000-8000-000000000002',
        'df000000-0000-4000-8000-000000000003', 'df000000-0000-4000-8000-000000000004',
        'df000000-0000-4000-8000-000000000005', 'df000000-0000-4000-8000-000000000006']::uuid[],
  'hq logs everyone''s except its own, x''s (removed) and n''s (no login)'
);

set local role authenticated;
select is(pg_temp.error_of($$select log_checkin_views(pg_temp.all_ids(), 'opened')$$), 'no error',
          format('%s can call it, and nothing is logged', s.who))
  from (values ('af000000-0000-4000-8000-000000000002', 'm2 (a member)'),
               ('af000000-0000-4000-8000-000000000009', 'admin (the admin grant shows no check-ins)'),
               ('af000000-0000-4000-8000-000000000010', 'auditor (the recordings grant shows no check-ins)'),
               ('af000000-0000-4000-8000-000000000013', 'a login with no member row')) s(id, who)
  cross join lateral (select set_config('request.jwt.claims',
    json_build_object('sub', s.id, 'role', 'authenticated')::text, true)) signed_in;
reset role;
select is(
  (select array_agg(distinct viewer_name order by viewer_name) from checkin_views where owner_id::text like 'cf000000-%'),
  array['VL div_head', 'VL dom_lead', 'VL hq', 'VL lead', 'VL lead_r'],
  'only leaders and hq who could read someone else''s check-in are in the log'
);
select is((select count(*)::int from checkin_views where owner_id::text like 'cf000000-%'), 26,
  'one row for each check-in each of them opened (4 + 4 + 6 + 6 + 6)');

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);
select is(pg_temp.error_of($$select log_checkin_views(pg_temp.all_ids(), 'opened')$$),
  '42501: permission denied for function log_checkin_views', 'a signed-out visitor can''t call it');
reset role;

-- ---------- 5. plays ----------
set local role authenticated;
select pg_temp.log_as(s.id, pg_temp.all_ids(), 'played')
  from (values ('af000000-0000-4000-8000-000000000003'), ('af000000-0000-4000-8000-000000000004'),
               ('af000000-0000-4000-8000-000000000008'), ('af000000-0000-4000-8000-000000000010')) s(id);
reset role;
select is(array(select pg_temp.logged('cf000000-0000-4000-8000-000000000003', 'played')), array[]::uuid[],
  'lead (no recordings grant) logs no plays');
select is(array(select pg_temp.logged('cf000000-0000-4000-8000-000000000008', 'played')), array[]::uuid[],
  'nor does hq without the recordings grant');
select is(
  array(select pg_temp.logged('cf000000-0000-4000-8000-000000000004', 'played')),
  array['df000000-0000-4000-8000-000000000001', 'df000000-0000-4000-8000-000000000003',
        'df000000-0000-4000-8000-000000000004']::uuid[],
  'lead_r logs plays of T''s check-ins with a recording only: not m1''s last week (none), not its own, not x''s or n''s'
);
select is(array(select pg_temp.logged('cf000000-0000-4000-8000-000000000010', 'played')), array[]::uuid[],
  'auditor (the grant, but can''t read the check-ins) logs no plays');

-- ---------- 6. once a day ----------
-- The first time that day is kept: move lead's row back five minutes, then open everything again.
update checkin_views set viewed_at = viewed_at - interval '5 minutes'
where viewer_id = 'cf000000-0000-4000-8000-000000000003' and checkin_id = 'df000000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.log_as('af000000-0000-4000-8000-000000000003', pg_temp.all_ids(), 'opened');
reset role;
select is(
  (select array_agg(viewed_at) from checkin_views
   where viewer_id = 'cf000000-0000-4000-8000-000000000003' and checkin_id = 'df000000-0000-4000-8000-000000000001'),
  array[now() - interval '5 minutes'],
  'opening it again the same day adds no row and keeps the first time'
);
select is((select count(*)::int from checkin_views where viewer_id = 'cf000000-0000-4000-8000-000000000003'), 4,
  'lead still has one row per check-in');

delete from checkin_views where viewer_id = 'cf000000-0000-4000-8000-000000000005';
set local role authenticated;
select pg_temp.as_user('af000000-0000-4000-8000-000000000005');
select is(
  pg_temp.error_of($$select log_checkin_views(array['df000000-0000-4000-8000-000000000001', 'df000000-0000-4000-8000-000000000001',
    'df000000-0000-4000-8000-000000000006', 'df000000-0000-4000-8000-000000000006', 'df000000-0000-4000-8000-000000000006']::uuid[], 'opened')$$),
  'no error', 'the same id more than once in a call is no error'
);
reset role;
select is(
  array(select pg_temp.logged('cf000000-0000-4000-8000-000000000005', 'opened')),
  array['df000000-0000-4000-8000-000000000001', 'df000000-0000-4000-8000-000000000006']::uuid[],
  'and logs each check-in once'
);

-- Another day is another row.
update checkin_views set viewed_on = viewed_on - 1, viewed_at = viewed_at - interval '1 day'
where viewer_id = 'cf000000-0000-4000-8000-000000000005' and checkin_id = 'df000000-0000-4000-8000-000000000001';
set local role authenticated;
select pg_temp.log_as('af000000-0000-4000-8000-000000000005', array['df000000-0000-4000-8000-000000000001']::uuid[], 'opened');
reset role;
select is(
  (select array_agg(viewed_on order by viewed_on) from checkin_views
   where viewer_id = 'cf000000-0000-4000-8000-000000000005' and checkin_id = 'df000000-0000-4000-8000-000000000001'),
  array[pg_temp.today() - 1, pg_temp.today()],
  'opening it on a later day adds a row for that day'
);
select is(
  (select array_agg(distinct viewed_on) from checkin_views where viewed_at = now() and owner_id::text like 'cf000000-%'),
  array[pg_temp.today()],
  'viewed_on is the Singapore day the function stamped'
);

-- ---------- 7. what each row keeps ----------
select is(
  (select array_agg(distinct viewer_name || ' / ' || viewer_role order by viewer_name || ' / ' || viewer_role) from checkin_views
   where owner_id::text like 'cf000000-%'),
  array['VL div_head / leader', 'VL dom_lead / leader', 'VL hq / hq', 'VL lead / leader', 'VL lead_r / leader'],
  'each row has the viewer''s name and role as they were'
);
select is(
  (select count(*)::int from checkin_views v join checkins c on c.id = v.checkin_id
   where v.owner_id = c.member_id and v.week_start = c.week_start and v.owner_id::text like 'cf000000-%'),
  (select count(*)::int from checkin_views where owner_id::text like 'cf000000-%'),
  'and the check-in''s owner and week'
);
update members set name = 'VL lead, renamed' where id = 'cf000000-0000-4000-8000-000000000003';
select is(
  (select array_agg(distinct viewer_name) from checkin_views where viewer_id = 'cf000000-0000-4000-8000-000000000003'),
  array['VL lead'],
  'renaming the viewer later leaves their rows as they were'
);

-- ---------- 8. only the owner reads ----------
set local role authenticated;
select pg_temp.as_user('af000000-0000-4000-8000-000000000001');
select results_eq('select id from checkin_views order by id',
  $$select pg_temp.rows_of('cf000000-0000-4000-8000-000000000001')$$,
  'm1 reads exactly the rows about their own check-ins');
select is(
  (select array_agg(distinct viewer_name || ' / ' || viewer_role order by viewer_name || ' / ' || viewer_role) from checkin_views
   where viewer_name in ('VL hq', 'VL div_head')),
  array['VL div_head / leader', 'VL hq / hq'],
  'including the names of hq and the division head'
);
select is(pg_temp.n($$select 1 from members where id in ('cf000000-0000-4000-8000-000000000006', 'cf000000-0000-4000-8000-000000000008')$$), 0,
  'whose member rows m1 still can''t read');

select pg_temp.as_user('af000000-0000-4000-8000-000000000003');
select results_eq('select distinct owner_id from checkin_views',
  $$values ('cf000000-0000-4000-8000-000000000003'::uuid)$$,
  'lead reads who viewed their own check-in, and nothing they or others viewed of anyone else''s');

select is(pg_temp.n($$select 1 from checkin_views where owner_id = 'cf000000-0000-4000-8000-000000000001'$$), 0,
          format('%s reads none of m1''s rows', s.who))
  from (values ('af000000-0000-4000-8000-000000000002', 'm2 (a teammate)'),
               ('af000000-0000-4000-8000-000000000008', 'hq'),
               ('af000000-0000-4000-8000-000000000005', 'dom_lead (who viewed them)'),
               ('af000000-0000-4000-8000-000000000009', 'admin'),
               ('af000000-0000-4000-8000-000000000004', 'lead_r (leader, recordings grant, who played them)'),
               ('af000000-0000-4000-8000-000000000013', 'a login with no member row')) s(id, who)
  cross join lateral (select set_config('request.jwt.claims',
    json_build_object('sub', s.id, 'role', 'authenticated')::text, true)) signed_in;
reset role;

set local role anon;
select set_config('request.jwt.claims', '{"role": "anon"}', true);
select is(pg_temp.error_of('select 1 from checkin_views'), '42501: permission denied for table checkin_views',
  'a signed-out visitor can''t read the log');
reset role;

-- ---------- 9. nobody writes it directly ----------
set local role authenticated;
select is(pg_temp.error_of(w.sql), '42501: permission denied for table checkin_views',
          format('%s can''t %s the log directly', s.who, w.op))
  from (values ('af000000-0000-4000-8000-000000000001', 'the owner (m1)'),
               ('af000000-0000-4000-8000-000000000003', 'a viewer (lead)'),
               ('af000000-0000-4000-8000-000000000008', 'hq')) s(id, who)
  cross join (values
    ('insert into', format(
      $$insert into checkin_views (checkin_id, owner_id, week_start, viewer_id, viewer_name, viewer_role, kind, viewed_on)
        values ('df000000-0000-4000-8000-000000000001', 'cf000000-0000-4000-8000-000000000001', %L,
                'cf000000-0000-4000-8000-000000000003', 'VL lead', 'leader', 'opened', %L)$$,
      pg_temp.this_week(), pg_temp.today() - 30)),
    ('update', $$update checkin_views set viewed_at = now() - interval '1 year'$$),
    ('delete from', $$delete from checkin_views$$)
  ) w(op, sql)
  -- Refers to w as well, so it runs again for every statement, as the right person.
  cross join lateral (select set_config('request.jwt.claims',
    json_build_object('sub', s.id, 'role', 'authenticated')::text, true), w.op) signed_in;
reset role;

-- ---------- 10. what it refuses ----------
set local role authenticated;
select pg_temp.as_user('af000000-0000-4000-8000-000000000008');
select is(pg_temp.error_of(format('select log_checkin_views(pg_temp.all_ids(), %L)', k)), '22023: bad_kind',
          format('a kind of %s is refused', coalesce(k, 'null')))
  from unnest(array['viewed', 'Opened', null]) k;
select is(pg_temp.error_of(format('select log_checkin_views(%s, ''opened'')', a)), 'no error',
          format('an array of %s notes nothing, without an error', a))
  from unnest(array['null', '''{}''::uuid[]']) a;
reset role;
select is((select count(*)::int from checkin_views where owner_id::text like 'cf000000-%'), 26, 'none of those added a row');

-- ---------- 11. resets, deleted recordings, removals and deletions ----------
-- A Master Admin resets m1's check-in this week: its rows stay, without the check-in.
create temp table m1_this_week as
  select id from checkin_views where checkin_id = 'df000000-0000-4000-8000-000000000001';
grant select on pg_temp.m1_this_week to authenticated;
set local role authenticated;
select pg_temp.as_user('af000000-0000-4000-8000-000000000008');
select is((select count(*)::int from hq_reset_checkin('df000000-0000-4000-8000-000000000001')), 1,
  'hq resets m1''s check-in this week');
reset role;
select ok((select count(*) from m1_this_week) > 0, 'it had been opened and played');
select results_eq(
  $$select id from checkin_views where checkin_id is null and owner_id::text like 'cf000000-%' order by id$$,
  'select id from m1_this_week order by id',
  'after the reset its rows remain, with checkin_id null'
);
select is(
  (select array_agg(distinct owner_id::text || ' ' || week_start::text) from checkin_views where checkin_id is null and owner_id::text like 'cf000000-%'),
  array['cf000000-0000-4000-8000-000000000001 ' || pg_temp.this_week()::text],
  'still under m1 and that week'
);
set local role authenticated;
select pg_temp.as_user('af000000-0000-4000-8000-000000000001');
select is(pg_temp.n('select 1 from checkin_views where checkin_id is null'), (select count(*)::int from m1_this_week),
  'and m1 still reads them');
reset role;

-- A Master Admin deletes m2's recording: the check-in stays, and so do its rows.
create temp table m2_rows as
  select id, checkin_id, viewer_id, kind, viewed_on, viewed_at from checkin_views
  where checkin_id = 'df000000-0000-4000-8000-000000000003';
set local role authenticated;
select pg_temp.as_user('af000000-0000-4000-8000-000000000008');
select is((select count(*)::int from hq_delete_checkin_recording('df000000-0000-4000-8000-000000000003')), 1,
  'hq deletes m2''s recording');
reset role;
select results_eq(
  'select id, checkin_id, viewer_id, kind, viewed_on, viewed_at from checkin_views where checkin_id = ''df000000-0000-4000-8000-000000000003'' order by id',
  'select * from m2_rows order by id',
  'deleting a recording leaves the check-in''s rows as they were'
);
-- Move lead_r's play of it to yesterday: a play today would add a row, if there were still audio.
update checkin_views set viewed_on = viewed_on - 1
where viewer_id = 'cf000000-0000-4000-8000-000000000004' and checkin_id = 'df000000-0000-4000-8000-000000000003' and kind = 'played';
set local role authenticated;
select pg_temp.log_as('af000000-0000-4000-8000-000000000004', array['df000000-0000-4000-8000-000000000003']::uuid[], 'played');
reset role;
select is(
  (select count(*)::int from checkin_views
   where viewer_id = 'cf000000-0000-4000-8000-000000000004' and checkin_id = 'df000000-0000-4000-8000-000000000003' and kind = 'played'),
  1, 'with no recording left, nobody logs a play of it'
);

-- An admin removes dom_lead: they can't log any more, and their rows stay with their name.
delete from checkin_views
where viewer_id = 'cf000000-0000-4000-8000-000000000005' and viewed_on = pg_temp.today();
set local role authenticated;
select pg_temp.as_user('af000000-0000-4000-8000-000000000009');
select is(admin_remove_member('cf000000-0000-4000-8000-000000000005') ->> 'outcome', 'removed',
  'an admin removes dom_lead (kept, as they had a login)');
select pg_temp.as_user('af000000-0000-4000-8000-000000000005');
select is(pg_temp.error_of($$select log_checkin_views(pg_temp.all_ids(), 'opened')$$), 'no error',
  'their old login can still call it');
reset role;
select is(
  (select count(*)::int from checkin_views where viewer_id = 'cf000000-0000-4000-8000-000000000005' and viewed_on = pg_temp.today()),
  0, 'but nothing is logged'
);
select is(
  (select array_agg(viewer_name) from checkin_views where viewer_id = 'cf000000-0000-4000-8000-000000000005'),
  array['VL dom_lead'],
  'their earlier row keeps their name'
);

-- The project owner deletes div_head's member row: their rows stay, with the name.
create temp table div_head_rows as
  select id from checkin_views where viewer_id = 'cf000000-0000-4000-8000-000000000006';
delete from members where id = 'cf000000-0000-4000-8000-000000000006';
select ok((select count(*) from div_head_rows) > 0, 'div_head had viewed check-ins');
select results_eq(
  $$select id from checkin_views where viewer_id is null and viewer_name = 'VL div_head' order by id$$,
  'select id from div_head_rows order by id',
  'deleting a viewer''s member row keeps their rows, with viewer_id null and the name'
);

-- Deleting the owner's member row deletes their rows, including the reset week's.
select ok((select count(*) from checkin_views where owner_id = 'cf000000-0000-4000-8000-000000000001') > 0,
  'm1 has rows before');
delete from members where id = 'cf000000-0000-4000-8000-000000000001';
select is((select count(*)::int from checkin_views where owner_id = 'cf000000-0000-4000-8000-000000000001'), 0,
  'deleting the owner''s member row deletes their rows');
select is((select count(*)::int from checkin_views where checkin_id is null and owner_id::text like 'cf000000-%'), 0,
  'the reset week''s rows went with them');

select * from finish();
rollback;
