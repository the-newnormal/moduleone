-- Removing people from Module One, and whether a sign-in email is taken (migration 0009).
-- Run: supabase test db. Builds its own fixtures inside the transaction and rolls back.
--
-- Fixtures (ids b7… teams, c7… members, a7… logins, d7… check-ins):
--   The New Normal (the organisation)  president (sits in it, so leads it)
--     RP Division  (head: a leader with a login, who also leads RP Other domain and RP Team)
--       RP Domain  (deputy: a leader who also leads the organisation)
--         RP Team  (lead, auditor, mistake, witness, and everyone with history below)
--       RP Other domain  (spare lead: a leader who leads RP Team, never signed in, nothing recorded)
--   admin    no team, grant admin                 hq        role hq, no team
--   lead     the leader of RP Team, signed in     auditor   a member holding the recordings grant
--   mistake  added by mistake: no login, nothing recorded
--   witness  a member with a login, whose check-in mentions someone; their login was given by
--            giver and their sign-in email changed by changer
--   gone     removed a week ago by remover        changed   no login now, but an admin once changed
--                                                          their sign-in email (so they had one)
--   One person in RP Team for each kind of history, with nothing else: signed in (a login now),
--   given before (a login given earlier, unlinked since), checked in, drafted, mentioned (in
--   witness's check-in), profiled (Big Five), noticed (an accepted privacy notice), recorded (a file
--   in their recordings folder), giver, remover, changer (see witness and gone), and settings (made
--   the last scoring settings change).
begin;
select plan(82);

-- 'SQLSTATE: message' for a statement that fails, so a test can check both; 'no error' otherwise.
create function pg_temp.error_of(sql text) returns text language plpgsql as $$
begin
  execute sql;
  return 'no error';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;

-- Rows changed by a write that RLS filters silently (an UPDATE whose USING hides the rows).
create function pg_temp.changed(sql text) returns int language plpgsql as $$
declare result int;
begin
  execute sql;
  get diagnostics result = row_count;
  return result;
end $$;

-- Counts rows the caller can see.
create function pg_temp.n(sql text) returns int language plpgsql as $$
declare result int;
begin
  execute format('select count(*) from (%s) q', sql) into result;
  return result;
end $$;

-- The organisation's id.
create function pg_temp.org() returns uuid language sql stable as $$
  select id from public.teams where kind = 'organisation'
$$;

grant execute on function pg_temp.error_of(text), pg_temp.changed(text), pg_temp.n(text), pg_temp.org()
  to anon, authenticated, service_role;

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('a7000000-0000-4000-8000-000000000001', 'admin@remove.test'),
  ('a7000000-0000-4000-8000-000000000002', 'lead@remove.test'),
  ('a7000000-0000-4000-8000-000000000010', 'login@remove.test'),
  ('a7000000-0000-4000-8000-000000000016', 'notice@remove.test'),
  ('a7000000-0000-4000-8000-000000000022', 'head@remove.test'),
  ('a7000000-0000-4000-8000-000000000030', 'witness@remove.test'),
  ('a7000000-0000-4000-8000-000000000040', 'spare@remove.test'),
  ('a7000000-0000-4000-8000-000000000041', 'Mixed.Case@Remove.Test');

insert into teams (id, name, kind) values ('b7000000-0000-4000-8000-000000000001', 'RP Division', 'division');
insert into teams (id, name, kind, parent_id) values
  ('b7000000-0000-4000-8000-000000000002', 'RP Domain',       'domain', 'b7000000-0000-4000-8000-000000000001'),
  ('b7000000-0000-4000-8000-000000000004', 'RP Other domain', 'domain', 'b7000000-0000-4000-8000-000000000001');
insert into teams (id, name, kind, parent_id) values
  ('b7000000-0000-4000-8000-000000000003', 'RP Team', 'team', 'b7000000-0000-4000-8000-000000000002');

insert into members (id, auth_user_id, name, team_id, role) values
  ('c7000000-0000-4000-8000-000000000001', 'a7000000-0000-4000-8000-000000000001', 'RP admin',      null,                                   'member'),
  ('c7000000-0000-4000-8000-000000000002', 'a7000000-0000-4000-8000-000000000002', 'RP lead',       'b7000000-0000-4000-8000-000000000003', 'leader'),
  ('c7000000-0000-4000-8000-000000000003', null,                                   'RP hq',         null,                                   'hq'),
  ('c7000000-0000-4000-8000-000000000004', null,                                   'RP auditor',    'b7000000-0000-4000-8000-000000000003', 'member'),
  ('c7000000-0000-4000-8000-000000000006', null,                                   'RP deputy',     'b7000000-0000-4000-8000-000000000002', 'leader'),
  ('c7000000-0000-4000-8000-000000000007', null,                                   'RP mistake',    'b7000000-0000-4000-8000-000000000003', 'member'),
  ('c7000000-0000-4000-8000-000000000008', null,                                   'RP spare lead', 'b7000000-0000-4000-8000-000000000004', 'leader'),
  ('c7000000-0000-4000-8000-000000000010', 'a7000000-0000-4000-8000-000000000010', 'RP signed in',  'b7000000-0000-4000-8000-000000000003', 'member'),
  ('c7000000-0000-4000-8000-000000000012', null,                                   'RP checked in', 'b7000000-0000-4000-8000-000000000003', 'member'),
  ('c7000000-0000-4000-8000-000000000013', null,                                   'RP drafted',    'b7000000-0000-4000-8000-000000000003', 'member'),
  ('c7000000-0000-4000-8000-000000000014', null,                                   'RP mentioned',  'b7000000-0000-4000-8000-000000000003', 'member'),
  ('c7000000-0000-4000-8000-000000000015', null,                                   'RP profiled',   'b7000000-0000-4000-8000-000000000003', 'member'),
  ('c7000000-0000-4000-8000-000000000016', null,                                   'RP noticed',    'b7000000-0000-4000-8000-000000000003', 'member'),
  ('c7000000-0000-4000-8000-000000000017', null,                                   'RP recorded',   'b7000000-0000-4000-8000-000000000003', 'member'),
  ('c7000000-0000-4000-8000-000000000018', null,                                   'RP giver',      'b7000000-0000-4000-8000-000000000003', 'member'),
  ('c7000000-0000-4000-8000-000000000019', null,                                   'RP remover',    'b7000000-0000-4000-8000-000000000003', 'member'),
  ('c7000000-0000-4000-8000-000000000020', null,                                   'RP changer',    'b7000000-0000-4000-8000-000000000003', 'member'),
  ('c7000000-0000-4000-8000-000000000021', null,                                   'RP settings',   'b7000000-0000-4000-8000-000000000003', 'member'),
  ('c7000000-0000-4000-8000-000000000022', 'a7000000-0000-4000-8000-000000000022', 'RP head',       'b7000000-0000-4000-8000-000000000001', 'leader');
insert into member_grants (member_id, grant_name) values
  ('c7000000-0000-4000-8000-000000000001', 'admin'),
  ('c7000000-0000-4000-8000-000000000004', 'recordings');

-- The project owner places president in the organisation and makes deputy a lead of it.
insert into members (id, name, team_id) values ('c7000000-0000-4000-8000-000000000005', 'RP president', pg_temp.org());
insert into team_leads (team_id, member_id) values
  (pg_temp.org(), 'c7000000-0000-4000-8000-000000000006'),
  ('b7000000-0000-4000-8000-000000000003', 'c7000000-0000-4000-8000-000000000008'),
  ('b7000000-0000-4000-8000-000000000004', 'c7000000-0000-4000-8000-000000000022'),
  ('b7000000-0000-4000-8000-000000000003', 'c7000000-0000-4000-8000-000000000022');

-- History that points at someone from another row.
insert into members (id, auth_user_id, name, team_id, login_given_by, login_given_at, login_email_changed_by, login_email_changed_at) values
  ('c7000000-0000-4000-8000-000000000030', 'a7000000-0000-4000-8000-000000000030', 'RP witness', 'b7000000-0000-4000-8000-000000000003',
   'c7000000-0000-4000-8000-000000000018', now() - interval '30 days', 'c7000000-0000-4000-8000-000000000020', now() - interval '10 days');
insert into members (id, name, team_id, login_given_by, login_given_at) values
  ('c7000000-0000-4000-8000-000000000011', 'RP given before', 'b7000000-0000-4000-8000-000000000003',
   'c7000000-0000-4000-8000-000000000001', now() - interval '30 days');
insert into members (id, name, team_id, login_email_changed_by, login_email_changed_at) values
  ('c7000000-0000-4000-8000-000000000032', 'RP changed', 'b7000000-0000-4000-8000-000000000003',
   'c7000000-0000-4000-8000-000000000001', now() - interval '10 days');
insert into members (id, name, removed_at, removed_by) values
  ('c7000000-0000-4000-8000-000000000031', 'RP gone', now() - interval '7 days', 'c7000000-0000-4000-8000-000000000019');

insert into checkins (id, member_id, week_start) values
  ('d7000000-0000-4000-8000-000000000012', 'c7000000-0000-4000-8000-000000000012', '2026-10-05'),
  ('d7000000-0000-4000-8000-000000000030', 'c7000000-0000-4000-8000-000000000030', '2026-10-05');
insert into checkin_mentions (checkin_id, about_member_id, sentiment) values
  ('d7000000-0000-4000-8000-000000000030', 'c7000000-0000-4000-8000-000000000014', 1);
insert into checkin_drafts (member_id, audio_path, mime_type) values
  ('c7000000-0000-4000-8000-000000000013', 'c7000000-0000-4000-8000-000000000013/take.webm', 'audio/webm');
insert into member_profiles (member_id, big_five) values ('c7000000-0000-4000-8000-000000000015', '{"openness": 3}');
insert into recording_notices (member_id, auth_user_id, notice_version) values
  ('c7000000-0000-4000-8000-000000000016', 'a7000000-0000-4000-8000-000000000016', 'v1');
-- scoring_settings_check stamps updated_by with whoever is signed in, so set it with the trigger off.
alter table scoring_settings disable trigger scoring_settings_check;
update scoring_settings set updated_by = 'c7000000-0000-4000-8000-000000000021';
alter table scoring_settings enable trigger scoring_settings_check;

-- The storage tables belong to Supabase's storage role, so add the recordings as service_role. The
-- second file only has mistake's id in its name, in witness's folder: it isn't mistake's.
set local role service_role;
insert into storage.objects (bucket_id, name) values
  ('checkin-audio', 'c7000000-0000-4000-8000-000000000017/2026-10-05.webm'),
  ('checkin-audio', 'c7000000-0000-4000-8000-000000000030/c7000000-0000-4000-8000-000000000007.webm');
reset role;

-- ---------- schema and privileges ----------
select has_column('public', 'members', c, format('members has %s', c))
  from unnest(array['removed_at', 'removed_by', 'removed_login_id', 'login_email_changed_by', 'login_email_changed_at']) c;
select is(
  (select array_agg(a.attname::text || ' -> ' || c.confrelid::regclass::text || ', on delete ' || c.confdeltype::text order by a.attname)
   from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
   where c.conrelid = 'public.members'::regclass and c.contype = 'f'
     and a.attname in ('removed_by', 'removed_login_id', 'login_email_changed_by')),
  array['login_email_changed_by -> members, on delete n', 'removed_by -> members, on delete n',
        'removed_login_id -> auth.users, on delete n'],
  'removed_by and login_email_changed_by point at a member and removed_login_id at a login; deleting it clears them (on delete set null)'
);
select is(
  (select array_agg(a.attname || ':' || p order by a.attname, p)
   from pg_attribute a, unnest(array['insert', 'update']) p
   where a.attrelid = 'public.members'::regclass and a.attnum > 0 and not a.attisdropped
     and has_column_privilege('authenticated', 'public.members', a.attname, p)),
  array['name:insert', 'name:update', 'role:insert', 'role:update', 'team_id:insert', 'team_id:update'],
  'signed-in users (admins too) still write only name, team_id and role on members, none of the new columns'
);
select is(
  (select bool_and(has_column_privilege('authenticated', 'public.members', c, 'select'))
   from unnest(array['removed_at', 'removed_by', 'removed_login_id', 'login_email_changed_by', 'login_email_changed_at']) c),
  true, 'signed-in users can read the new columns (RLS decides which rows)'
);
select function_privs_are('public', 'admin_remove_member', array['uuid'], 'anon', array[]::text[],
  'anon cannot call admin_remove_member');
select function_privs_are('public', 'admin_remove_member', array['uuid'], 'authenticated', array['EXECUTE'],
  'signed-in users can call admin_remove_member (it checks for the admin grant itself)');
select function_privs_are('public', 'admin_remove_member', array['uuid'], 'service_role', array['EXECUTE'],
  'the server can call admin_remove_member');
select function_privs_are('public', 'login_email_in_use', array['text'], r, array[]::text[],
  format('%s cannot call login_email_in_use', r))
  from unnest(array['anon', 'authenticated']) r;
select function_privs_are('public', 'login_email_in_use', array['text'], 'service_role', array['EXECUTE'],
  'only the server can call login_email_in_use');
select is(
  (select bool_or(has_function_privilege('public', f, 'execute'))
   from unnest(array['public.admin_remove_member(uuid)', 'public.login_email_in_use(text)']) f),
  false, 'PUBLIC cannot call either function'
);
select is(
  (select array_agg(proname::text || '=' || prosecdef order by proname) from pg_proc
   where pronamespace = 'public'::regnamespace and proname in ('admin_remove_member', 'login_email_in_use')),
  array['admin_remove_member=true', 'login_email_in_use=true'],
  'both run as the owner: admins can''t delete members or write removed_at, and the server can''t read auth.users'
);
select is(
  (select proconfig from pg_proc where oid = f::regprocedure),
  array['search_path=""'], format('%s runs with an empty search_path', f)
) from unnest(array['public.admin_remove_member(uuid)', 'public.login_email_in_use(text)']) f;

-- ---------- only admins remove, and never these people ----------
set local role anon;
set local request.jwt.claims to '{"role": "anon"}';
select is(
  pg_temp.error_of($$select admin_remove_member('c7000000-0000-4000-8000-000000000007')$$),
  '42501: permission denied for function admin_remove_member', 'anon cannot remove anyone'
);
set local role authenticated;
set local request.jwt.claims to '{"sub": "a7000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select is(
  pg_temp.error_of($$select admin_remove_member('c7000000-0000-4000-8000-000000000007')$$),
  '42501: Only admins can remove people.', 'a leader cannot remove someone from their own team'
);
set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
select is(
  pg_temp.error_of($$select admin_remove_member('c7000000-0000-4000-8000-000000000007')$$),
  '42501: Only admins can remove people.', 'nor can the server on its own: it removes people only as the admin asking'
);
set local role authenticated;
set local request.jwt.claims to '{"sub": "a7000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  pg_temp.error_of($$select admin_remove_member('c7000000-0000-4000-8000-000000000003')$$),
  '23514: Master Admins can''t be removed here. The project owner looks after them.', 'an admin cannot remove an hq member'
);
select is(
  pg_temp.error_of($$select admin_remove_member('c7000000-0000-4000-8000-000000000001')$$),
  '23514: You can''t remove yourself.', 'nor themselves'
);
select is(
  pg_temp.error_of($$select admin_remove_member('c7000000-0000-4000-8000-000000000004')$$),
  '23514: This person holds grants (such as admin), so only the project owner can remove them.',
  'nor someone holding a grant'
);
select is(
  pg_temp.error_of($$select admin_remove_member('c7000000-0000-4000-8000-000000000005')$$),
  '23514: This person sits in or leads the organisation, so only the project owner can remove them.',
  'nor someone sitting in the organisation'
);
select is(
  pg_temp.error_of($$select admin_remove_member('c7000000-0000-4000-8000-000000000006')$$),
  '23514: This person sits in or leads the organisation, so only the project owner can remove them.',
  'nor someone leading it from elsewhere (a team_leads row)'
);
reset role;
select results_eq(
  $$select m.name, coalesce(t.name, 'no team'), m.role, m.auth_user_id is not null, m.removed_at is null
    from members m left join teams t on t.id = m.team_id
    where m.id in ('c7000000-0000-4000-8000-000000000001', 'c7000000-0000-4000-8000-000000000003',
                   'c7000000-0000-4000-8000-000000000004', 'c7000000-0000-4000-8000-000000000005',
                   'c7000000-0000-4000-8000-000000000006', 'c7000000-0000-4000-8000-000000000007')
    order by m.id$$,
  $$values ('RP admin'::text, 'no team'::text, 'member'::text, true, true),
           ('RP hq', 'no team', 'hq', false, true),
           ('RP auditor', 'RP Team', 'member', false, true),
           ('RP president', 'The New Normal', 'leader', false, true),
           ('RP deputy', 'RP Domain', 'leader', false, true),
           ('RP mistake', 'RP Team', 'member', false, true)$$,
  'a refused removal changes nothing: each of them keeps their place, role and login'
);
select is(
  (select count(*)::int from team_leads where member_id = 'c7000000-0000-4000-8000-000000000006' and team_id = pg_temp.org()),
  1, 'and deputy still leads the organisation'
);

-- ---------- nothing recorded: deleted outright ----------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a7000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  admin_remove_member('c7000000-0000-4000-8000-000000000007'),
  '{"outcome": "deleted", "login_id": null}'::jsonb,
  'someone who never had a login and has nothing recorded is deleted outright (a file that only has their id in its name doesn''t count)'
);
select is(
  admin_remove_member('c7000000-0000-4000-8000-000000000008'),
  '{"outcome": "deleted", "login_id": null}'::jsonb,
  'so is a leader who never signed in: lead rows are no history'
);
select is(
  admin_remove_member('c7000000-0000-4000-8000-000000000007'),
  '{"outcome": "deleted", "login_id": null}'::jsonb,
  'removing someone already deleted reports them deleted (another admin got there first)'
);
select is(
  admin_remove_member('c7000000-0000-4000-8000-000000000099'),
  '{"outcome": "deleted", "login_id": null}'::jsonb,
  'and so does an id nobody has'
);
reset role;
select is(
  (select count(*)::int from members where id in ('c7000000-0000-4000-8000-000000000007', 'c7000000-0000-4000-8000-000000000008')),
  0, 'their rows are gone'
);
select is(
  (select count(*)::int from team_leads where member_id = 'c7000000-0000-4000-8000-000000000008'),
  0, 'and the spare lead''s lead row with them'
);

-- ---------- anything recorded: kept, marked removed ----------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a7000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  admin_remove_member(x.id),
  jsonb_build_object('outcome', 'removed', 'login_id', x.login),
  format('someone with %s is kept, marked removed', x.history)
) from (values
  ('c7000000-0000-4000-8000-000000000010'::uuid, 'a7000000-0000-4000-8000-000000000010'::uuid,
   'a login (handed back for the server to delete)'),
  ('c7000000-0000-4000-8000-000000000011', null, 'no login now but one given earlier'),
  ('c7000000-0000-4000-8000-000000000012', null, 'a check-in'),
  ('c7000000-0000-4000-8000-000000000013', null, 'a recording draft'),
  ('c7000000-0000-4000-8000-000000000014', null, 'a mention in someone else''s check-in'),
  ('c7000000-0000-4000-8000-000000000015', null, 'a Big Five profile'),
  ('c7000000-0000-4000-8000-000000000016', null, 'an accepted privacy notice'),
  ('c7000000-0000-4000-8000-000000000017', null, 'a file in their recordings folder'),
  ('c7000000-0000-4000-8000-000000000018', null, 'a login they gave someone'),
  ('c7000000-0000-4000-8000-000000000019', null, 'a removal they made'),
  ('c7000000-0000-4000-8000-000000000020', null, 'a sign-in email change they made'),
  ('c7000000-0000-4000-8000-000000000021', null, 'the last scoring settings change'),
  ('c7000000-0000-4000-8000-000000000022', 'a7000000-0000-4000-8000-000000000022',
   'a login, a seat in a division and lead rows')
) x (id, login, history);
reset role;
select results_eq(
  $$select m.name, r.name, coalesce(u.email::text, 'nothing'), coalesce(m.auth_user_id::text, 'no login'),
           coalesce(m.team_id::text, 'no team'), m.role, m.removed_at = now()
    from members m
    left join members r on r.id = m.removed_by
    left join auth.users u on u.id = m.removed_login_id
    where m.id between 'c7000000-0000-4000-8000-000000000010' and 'c7000000-0000-4000-8000-000000000022'
    order by m.id$$,
  $$values ('RP signed in'::text, 'RP admin'::text, 'login@remove.test'::text, 'no login'::text, 'no team'::text, 'member'::text, true),
           ('RP given before', 'RP admin', 'nothing', 'no login', 'no team', 'member', true),
           ('RP checked in',   'RP admin', 'nothing', 'no login', 'no team', 'member', true),
           ('RP drafted',      'RP admin', 'nothing', 'no login', 'no team', 'member', true),
           ('RP mentioned',    'RP admin', 'nothing', 'no login', 'no team', 'member', true),
           ('RP profiled',     'RP admin', 'nothing', 'no login', 'no team', 'member', true),
           ('RP noticed',      'RP admin', 'nothing', 'no login', 'no team', 'member', true),
           ('RP recorded',     'RP admin', 'nothing', 'no login', 'no team', 'member', true),
           ('RP giver',        'RP admin', 'nothing', 'no login', 'no team', 'member', true),
           ('RP remover',      'RP admin', 'nothing', 'no login', 'no team', 'member', true),
           ('RP changer',      'RP admin', 'nothing', 'no login', 'no team', 'member', true),
           ('RP settings',     'RP admin', 'nothing', 'no login', 'no team', 'member', true),
           ('RP head',         'RP admin', 'head@remove.test', 'no login', 'no team', 'member', true)$$,
  'each is removed now, by the admin, with no login, no team and the member role; an unlinked login waits in removed_login_id'
);
select is(
  (select count(*)::int from team_leads where member_id = 'c7000000-0000-4000-8000-000000000022'),
  0, 'a removed leader leads nothing any more'
);
select is(
  (select team_id from checkins where id = 'd7000000-0000-4000-8000-000000000012'),
  'b7000000-0000-4000-8000-000000000003'::uuid, 'a removed person''s check-in stays, in the team it was made in'
);
select is(
  array[
    exists (select 1 from checkin_drafts where member_id = 'c7000000-0000-4000-8000-000000000013'),
    exists (select 1 from checkin_mentions where about_member_id = 'c7000000-0000-4000-8000-000000000014'),
    exists (select 1 from member_profiles where member_id = 'c7000000-0000-4000-8000-000000000015'),
    exists (select 1 from recording_notices where member_id = 'c7000000-0000-4000-8000-000000000016'),
    exists (select 1 from storage.objects where bucket_id = 'checkin-audio'
              and name = 'c7000000-0000-4000-8000-000000000017/2026-10-05.webm'),
    exists (select 1 from members where id = 'c7000000-0000-4000-8000-000000000030'
              and login_given_by = 'c7000000-0000-4000-8000-000000000018'
              and login_email_changed_by = 'c7000000-0000-4000-8000-000000000020'),
    exists (select 1 from members where id = 'c7000000-0000-4000-8000-000000000031'
              and removed_by = 'c7000000-0000-4000-8000-000000000019'),
    exists (select 1 from scoring_settings where updated_by = 'c7000000-0000-4000-8000-000000000021')
  ],
  array[true, true, true, true, true, true, true, true],
  'and so does everything else they left behind, and every record of what they did'
);

set local role authenticated;
set local request.jwt.claims to '{"sub": "a7000000-0000-4000-8000-000000000010", "role": "authenticated"}';
select is(
  pg_temp.n($$select 1 from members$$) + pg_temp.n($$select 1 from checkins where id::text like 'd7000000-%'$$),
  0, 'the login a removal unlinked reads nothing any more (it maps to no member)'
);
set local request.jwt.claims to '{"sub": "a7000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select is(pg_temp.n($$select 1 from checkins where id = 'd7000000-0000-4000-8000-000000000012'$$), 1,
  'the leader of their old team still sees their past check-in, so past weeks on the heat-map don''t change');
select is(pg_temp.n($$select 1 from members where id = 'c7000000-0000-4000-8000-000000000012'$$), 1,
  'and still sees their name on it');

-- ---------- removing again ----------
set local request.jwt.claims to '{"sub": "a7000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  admin_remove_member('c7000000-0000-4000-8000-000000000010'),
  '{"outcome": "removed", "login_id": "a7000000-0000-4000-8000-000000000010"}'::jsonb,
  'removing someone again reports them removed, with the login still to delete (a retry finishes the job)'
);
select is(
  admin_remove_member('c7000000-0000-4000-8000-000000000031'),
  '{"outcome": "removed", "login_id": null}'::jsonb,
  'someone removed earlier by another admin counts as removed, with no login to delete'
);
reset role;
select is(
  (select (r.name, m.removed_at < now())::text from members m join members r on r.id = m.removed_by
   where m.id = 'c7000000-0000-4000-8000-000000000031'),
  '("RP remover",t)', 'and their removal still says who did it, and when'
);
set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
select is(
  pg_temp.changed($$update members set removed_login_id = null
    where id = 'c7000000-0000-4000-8000-000000000010' and removed_login_id = 'a7000000-0000-4000-8000-000000000010'$$),
  1, 'the server clears removed_login_id once it has deleted the login'
);
set local role authenticated;
set local request.jwt.claims to '{"sub": "a7000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  admin_remove_member('c7000000-0000-4000-8000-000000000010'),
  '{"outcome": "removed", "login_id": null}'::jsonb,
  'after which removing them again has no login to hand back'
);
reset role;
delete from auth.users where id = 'a7000000-0000-4000-8000-000000000022';
select is(
  (select removed_login_id from members where id = 'c7000000-0000-4000-8000-000000000022'), null,
  'the project owner deleting the login in the dashboard clears removed_login_id too'
);

-- ---------- nobody edits, places or signs in a removed person ----------
set local role authenticated;
set local request.jwt.claims to '{"sub": "a7000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  pg_temp.changed($$update members set name = 'RP back' where id = 'c7000000-0000-4000-8000-000000000012'$$),
  0, 'an admin can no longer rename someone removed'
);
select is(
  pg_temp.changed($$update members set team_id = 'b7000000-0000-4000-8000-000000000003', role = 'member'
    where id = 'c7000000-0000-4000-8000-000000000012'$$),
  0, 'nor place them in a team'
);
select is(
  pg_temp.changed($$update members set name = 'RP witness renamed' where id = 'c7000000-0000-4000-8000-000000000030'$$),
  1, 'but still renames someone who isn''t removed'
);
reset role;
set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
select is(
  pg_temp.error_of($$update members set team_id = 'b7000000-0000-4000-8000-000000000003' where id = 'c7000000-0000-4000-8000-000000000012'$$),
  '23514: new row for relation "members" violates check constraint "members_removed_cleared"',
  'the server cannot place someone removed either (members_removed_cleared)'
);
select is(
  pg_temp.error_of($$update members set auth_user_id = 'a7000000-0000-4000-8000-000000000040' where id = 'c7000000-0000-4000-8000-000000000012'$$),
  '23514: new row for relation "members" violates check constraint "members_removed_cleared"',
  'nor give them a login'
);
select is(
  pg_temp.error_of($$update members set role = 'leader' where id = 'c7000000-0000-4000-8000-000000000012'$$),
  '23514: new row for relation "members" violates check constraint "members_removed_cleared"',
  'nor make them a leader'
);
reset role;
select is(
  pg_temp.error_of($$update members set team_id = 'b7000000-0000-4000-8000-000000000003', auth_user_id = 'a7000000-0000-4000-8000-000000000040'
    where id = 'c7000000-0000-4000-8000-000000000012'$$),
  '23514: new row for relation "members" violates check constraint "members_removed_cleared"',
  'nor can the project owner in the dashboard'
);
select is(
  pg_temp.error_of($$update members set removed_at = null where id = 'c7000000-0000-4000-8000-000000000012'$$),
  '23514: new row for relation "members" violates check constraint "members_removed_pair"',
  'clearing removed_at alone doesn''t bring someone back: removed_by needs it (members_removed_pair)'
);
-- ---------- no check-ins for a removed person ----------
set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
select is(
  pg_temp.error_of($$insert into checkins (member_id, week_start) values ('c7000000-0000-4000-8000-000000000012', '2026-10-12')$$),
  '23514: That person was removed from Module One.', 'a check-in for someone removed is refused'
);
select is(
  pg_temp.error_of($$insert into checkins (member_id, team_id, week_start)
    values ('c7000000-0000-4000-8000-000000000012', 'b7000000-0000-4000-8000-000000000003', '2026-10-12')$$),
  '23514: That person was removed from Module One.', 'even one that names the team it was made in'
);
select is(
  pg_temp.error_of($$insert into checkins (id, member_id, week_start)
    values ('d7000000-0000-4000-8000-000000000031', 'c7000000-0000-4000-8000-000000000030', '2026-10-12')$$),
  'no error', 'someone who isn''t removed still checks in'
);
select is(
  (select team_id from checkins where id = 'd7000000-0000-4000-8000-000000000031'),
  'b7000000-0000-4000-8000-000000000003'::uuid, 'in their team'
);
reset role;

-- ---------- login_email_in_use ----------
set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
select is(login_email_in_use('login@remove.test'), true, 'an address with a login is in use');
select is(login_email_in_use('  LOGIN@Remove.test '), true, 'whatever its case, and with spaces around it');
select is(login_email_in_use('mixed.case@remove.test'), true, 'even when the login''s address was saved in mixed case');
select is(login_email_in_use('nobody@remove.test'), false, 'an address with no login is free');
set local role authenticated;
set local request.jwt.claims to '{"sub": "a7000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  pg_temp.error_of($$select login_email_in_use('login@remove.test')$$),
  '42501: permission denied for function login_email_in_use', 'signed-in users, admins too, cannot ask whether an address is in use'
);
set local role anon;
set local request.jwt.claims to '{"role": "anon"}';
select is(
  pg_temp.error_of($$select login_email_in_use('login@remove.test')$$),
  '42501: permission denied for function login_email_in_use', 'nor can anon'
);
reset role;

-- ---------- a login only an email change remembers ----------
-- changed's login is gone (the owner linked it in the dashboard, so no login_given_at, and later
-- deleted it), but login_email_changed_at shows they had one: they're kept, not deleted.
set local role authenticated;
set local request.jwt.claims to '{"sub": "a7000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  admin_remove_member('c7000000-0000-4000-8000-000000000032') ->> 'outcome', 'removed',
  'someone whose sign-in email an admin changed had a login, so they are kept even once it is gone'
);
reset role;

-- ---------- a Master Admin's check-in reset (0007) ----------
-- Whose check-in was reset, and who reset it, are both in checkin_resets: deleting either person
-- would blank that, so both are kept.
insert into members (id, auth_user_id, name, team_id, role) values
  ('c7000000-0000-4000-8000-000000000040', null, 'RP was reset', 'b7000000-0000-4000-8000-000000000003', 'member'),
  ('c7000000-0000-4000-8000-000000000041', null, 'RP reset someone', 'b7000000-0000-4000-8000-000000000003', 'member');
insert into checkin_resets (member_id, week_start, team_id, action, done_by) values
  ('c7000000-0000-4000-8000-000000000040', '2026-10-05', 'b7000000-0000-4000-8000-000000000003', 'checkin_reset', null),
  (null, '2026-10-05', 'b7000000-0000-4000-8000-000000000003', 'recording_deleted', 'c7000000-0000-4000-8000-000000000041');
set local role authenticated;
set local request.jwt.claims to '{"sub": "a7000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  admin_remove_member('c7000000-0000-4000-8000-000000000040') ->> 'outcome', 'removed',
  'someone whose check-in a Master Admin reset is kept'
);
select is(
  admin_remove_member('c7000000-0000-4000-8000-000000000041') ->> 'outcome', 'removed',
  'so is whoever did a reset'
);
reset role;

-- ---------- check-ins and removals don't overlap ----------
-- The check-in trigger reads the member FOR SHARE, which conflicts with the removal's FOR UPDATE:
-- whichever comes first finishes before the other goes on (a second session can't be driven
-- from here, so this checks the lock is taken).
select ok(
  pg_get_functiondef('public.checkins_set_team()'::regprocedure) ~* 'from public\.members m where m\.id = new\.member_id\s+for share',
  'the check-in trigger locks the member row while it checks for a removal'
);

select * from finish();
rollback;
