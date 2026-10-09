-- Who can sign in, for the admin pages (migration 0010, admin_login_states).
-- Run: supabase test db. Builds its own fixtures inside the transaction and rolls back.
--
-- Fixtures (a8… logins, c8… members, b8… a team):
--   admin     grant admin, signed in              member    no grants, signed in
--   leader    a leader of LS Domain, signed in      hq        role hq, no grants, signed in
--   invited   invited, never opened it           ready     set up confirmed, never signed in
--   active    invited long ago, opened it        unconfirmed  signed in without a confirmed address
--   closed    linked to a soft-deleted login     nologin   no login at all
--   gone      removed from Module One            (and a login no member row uses)
begin;
select plan(22);

-- 'SQLSTATE: message' for a statement that fails, so a test can check both; 'no error' otherwise.
create function pg_temp.error_of(sql text) returns text language plpgsql as $$
begin
  execute sql;
  return 'no error';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;
grant execute on function pg_temp.error_of(text) to anon, authenticated, service_role;

-- ---------- fixtures ----------
insert into auth.users (id, email, invited_at, email_confirmed_at, last_sign_in_at, deleted_at) values
  ('a8000000-0000-4000-8000-000000000001', 'admin@states.test',    null,                         now() - interval '60 days', now() - interval '1 day',  null),
  ('a8000000-0000-4000-8000-000000000002', 'member@states.test',   null,                         now() - interval '60 days', now() - interval '2 days', null),
  ('a8000000-0000-4000-8000-000000000003', 'leader@states.test',   null,                         now() - interval '60 days', now() - interval '3 days', null),
  ('a8000000-0000-4000-8000-000000000004', 'hq@states.test',       null,                         now() - interval '60 days', now() - interval '4 days', null),
  ('a8000000-0000-4000-8000-000000000010', 'invited@states.test',  '2026-10-03 02:00:00+00',     null,                       null,                      null),
  ('a8000000-0000-4000-8000-000000000011', 'ready@states.test',    '2026-09-01 02:00:00+00',     '2026-09-02 02:00:00+00',   null,                      null),
  ('a8000000-0000-4000-8000-000000000012', 'active@states.test',   '2026-09-01 02:00:00+00',     '2026-09-02 02:00:00+00',   '2026-10-08 09:30:00+00',  null),
  ('a8000000-0000-4000-8000-000000000013', 'unconfirmed@states.test', null,                      null,                       '2026-10-07 09:30:00+00',  null),
  ('a8000000-0000-4000-8000-000000000014', 'closed@states.test',   '2026-10-01 02:00:00+00',     null,                       null,                      now()),
  ('a8000000-0000-4000-8000-000000000015', 'nobody@states.test',   '2026-10-01 02:00:00+00',     null,                       null,                      null);

insert into teams (id, name, kind) values ('b8000000-0000-4000-8000-000000000001', 'LS Domain', 'domain');

insert into members (id, auth_user_id, name, team_id, role) values
  ('c8000000-0000-4000-8000-000000000001', 'a8000000-0000-4000-8000-000000000001', 'LS admin',       null,                                   'member'),
  ('c8000000-0000-4000-8000-000000000002', 'a8000000-0000-4000-8000-000000000002', 'LS member',      'b8000000-0000-4000-8000-000000000001', 'member'),
  ('c8000000-0000-4000-8000-000000000003', 'a8000000-0000-4000-8000-000000000003', 'LS leader',      'b8000000-0000-4000-8000-000000000001', 'leader'),
  ('c8000000-0000-4000-8000-000000000004', 'a8000000-0000-4000-8000-000000000004', 'LS hq',          null,                                   'hq'),
  ('c8000000-0000-4000-8000-000000000010', 'a8000000-0000-4000-8000-000000000010', 'LS invited',     'b8000000-0000-4000-8000-000000000001', 'member'),
  ('c8000000-0000-4000-8000-000000000011', 'a8000000-0000-4000-8000-000000000011', 'LS ready',       'b8000000-0000-4000-8000-000000000001', 'member'),
  ('c8000000-0000-4000-8000-000000000012', 'a8000000-0000-4000-8000-000000000012', 'LS active',      'b8000000-0000-4000-8000-000000000001', 'member'),
  ('c8000000-0000-4000-8000-000000000013', 'a8000000-0000-4000-8000-000000000013', 'LS unconfirmed', 'b8000000-0000-4000-8000-000000000001', 'member'),
  ('c8000000-0000-4000-8000-000000000014', 'a8000000-0000-4000-8000-000000000014', 'LS closed',      'b8000000-0000-4000-8000-000000000001', 'member'),
  ('c8000000-0000-4000-8000-000000000020', null,                                   'LS nologin',     'b8000000-0000-4000-8000-000000000001', 'member');
insert into members (id, name, removed_at) values ('c8000000-0000-4000-8000-000000000021', 'LS gone', now() - interval '7 days');
insert into member_grants (member_id, grant_name) values
  ('c8000000-0000-4000-8000-000000000001', 'admin'),
  ('c8000000-0000-4000-8000-000000000002', 'recordings'),
  ('c8000000-0000-4000-8000-000000000002', 'big_five');

-- ---------- the function itself ----------
select function_privs_are('public', 'admin_login_states', array[]::text[], 'authenticated', array['EXECUTE'],
  'signed-in users can call admin_login_states (it checks the admin grant itself)');
select function_privs_are('public', 'admin_login_states', array[]::text[], r, array[]::text[],
  format('%s cannot call admin_login_states', r))
  from unnest(array['anon', 'service_role']) r;
select is(has_function_privilege('public', 'public.admin_login_states()', 'execute'), false,
  'PUBLIC cannot call admin_login_states');
select is((select prosecdef from pg_proc where oid = 'public.admin_login_states()'::regprocedure), true,
  'admin_login_states runs as the owner: admins can''t read auth.users');
select is((select proconfig from pg_proc where oid = 'public.admin_login_states()'::regprocedure),
  array['search_path=""'], 'admin_login_states runs with an empty search_path');
select is((select provolatile from pg_proc where oid = 'public.admin_login_states()'::regprocedure), 's'::"char",
  'admin_login_states is stable, so it can''t write');
select is(pg_get_function_result('public.admin_login_states()'::regprocedure),
  'TABLE(member_id uuid, state text, invited_at timestamp with time zone, last_sign_in_at timestamp with time zone)',
  'it returns those four columns and nothing else: no email address');

-- ---------- only admins ----------
set local role anon;
set local request.jwt.claims to '{"role": "anon"}';
select is(pg_temp.error_of('select * from public.admin_login_states()'),
  '42501: permission denied for function admin_login_states', 'a signed-out visitor can''t call it');

set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
select is(pg_temp.error_of('select * from public.admin_login_states()'),
  '42501: permission denied for function admin_login_states', 'the service role isn''t given it (it has auth.users)');

set local role authenticated;
select is(pg_temp.error_of('select * from public.admin_login_states()'),
          '42501: Only admins can see who has signed in.', format('%s can''t see who has signed in', s.who))
  from (values ('a8000000-0000-4000-8000-000000000002', 'a member, even with the recordings and big_five grants'),
               ('a8000000-0000-4000-8000-000000000003', 'a leader'),
               ('a8000000-0000-4000-8000-000000000004', 'a Master Admin without the admin grant'),
               ('a8000000-0000-4000-8000-000000000015', 'a login no member uses')) s(id, who)
  cross join lateral (select set_config('request.jwt.claims',
    json_build_object('sub', s.id, 'role', 'authenticated')::text, true)) signed_in;

-- ---------- what an admin sees ----------
set local request.jwt.claims to '{"sub": "a8000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(pg_temp.error_of('select * from public.admin_login_states()'), 'no error', 'an admin can call it');

select results_eq(
  $$select member_id, state, invited_at, last_sign_in_at from public.admin_login_states()
    where member_id::text like 'c8%' and member_id::text >= 'c8000000-0000-4000-8000-000000000010'$$,
  $$values
    ('c8000000-0000-4000-8000-000000000010'::uuid, 'invited', '2026-10-03 02:00:00+00'::timestamptz, null::timestamptz),
    ('c8000000-0000-4000-8000-000000000011'::uuid, 'ready',   null,                                  null),
    ('c8000000-0000-4000-8000-000000000012'::uuid, 'active',  null,                                  '2026-10-08 09:30:00+00'),
    ('c8000000-0000-4000-8000-000000000013'::uuid, 'active',  null,                                  '2026-10-07 09:30:00+00')$$,
  'unused invites, ready logins and active ones, in member order; the invite date only while it''s unused'
);
select is(
  (select array_agg(state order by member_id) from public.admin_login_states() where member_id::text like 'c8%'
     and member_id::text < 'c8000000-0000-4000-8000-000000000010'),
  array['active', 'active', 'active', 'active'],
  'everyone with a login is listed, whatever their role or team: the admin, a member, a leader, a Master Admin'
);
select is(
  (select count(*)::int from public.admin_login_states() where member_id in (
    'c8000000-0000-4000-8000-000000000014', 'c8000000-0000-4000-8000-000000000020', 'c8000000-0000-4000-8000-000000000021')),
  0, 'nothing for a soft-deleted login, someone with no login, or someone removed'
);
select is(
  (select count(*)::int from public.admin_login_states() where member_id::text like 'c8%'),
  8, 'one row per linked login'
);
reset role; -- to count auth.users; still signed in as the admin
select is(
  (select count(*)::int from public.admin_login_states()),
  (select count(*)::int from public.members m join auth.users u on u.id = m.auth_user_id
   where m.removed_at is null and u.deleted_at is null),
  'every linked login in Module One, seed data included'
);
set local role authenticated;
select is(
  (select array_agg(member_id) from public.admin_login_states()),
  (select array_agg(member_id order by member_id) from public.admin_login_states()),
  'rows come in member order, so the page can read them in pages'
);

-- A login opened since: the invite date goes, and the sign-in shows.
reset role;
update auth.users set email_confirmed_at = now(), last_sign_in_at = now() where id = 'a8000000-0000-4000-8000-000000000010';
set local role authenticated;
select results_eq(
  $$select state, invited_at is null, last_sign_in_at is not null from public.admin_login_states()
    where member_id = 'c8000000-0000-4000-8000-000000000010'$$,
  $$values ('active', true, true)$$,
  'once the invite is opened, they''re active, with when they signed in'
);


reset role;
select * from finish();
rollback;
