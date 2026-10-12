-- Noting someone's email before their first invite, and adding a list of people at once (migration 0014).
-- Run: supabase test db. Builds its own fixtures inside the transaction and rolls back.
--
-- Fixtures (ids ae… logins, be… nodes, ce… members, de… a check-in):
--   The New Normal (the organisation)
--     PE Division
--       PE Domain
--         PE Team      (member, leader, and everyone an address is noted for)
--         PE Archived  (archived)
--   admin, second admin   grant admin, signed in, no team
--   member                a member of PE Team, signed in      leader   the leader of PE Team, signed in
--   hq                    role hq, no grants, signed in
--   newcomer, other       no login: the people admins note addresses for
--   signed in             a member with a login               master   role hq, no login
--   granted               holds the recordings grant, no login
--   gone                  removed from Module One a week ago
--   later granted         given a grant by the project owner after an address was noted for them
--   One person in PE Team for each way a noted address goes or stays: linked (given a login),
--   checked in (removed, kept for their check-in), mistake (removed, deleted outright), promoted
--   (made a Master Admin), stays (renamed, moved, made a leader, taken out of the team) and deleted
--   (deleted by the project owner).
begin;
select plan(138);

-- 'SQLSTATE: message' for a statement that fails, so a test can check both; 'no error' otherwise.
create function pg_temp.error_of(sql text) returns text language plpgsql as $$
begin
  execute sql;
  return 'no error';
exception when others then
  return sqlstate || ': ' || sqlerrm;
end $$;

-- Rows changed by a write that RLS filters silently (an UPDATE or DELETE whose USING hides the rows).
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

-- The organisation's id, whoever is asking.
create function pg_temp.org() returns uuid language sql security definer as $$
  select id from public.teams where kind = 'organisation'
$$;

-- The columns of a table that a role may insert and update, as 'column:privilege', sorted.
create function pg_temp.column_privs(role_name text, tbl text) returns text[] language sql as $$
  select array_agg(a.attname || ':' || p order by a.attname, p)
  from pg_attribute a, unnest(array['insert', 'update']) p
  where a.attrelid = tbl::regclass and a.attnum > 0 and not a.attisdropped
    and has_column_privilege(role_name, tbl, a.attname, p);
$$;

-- A list of n people for admin_add_members, each with their own address.
create function pg_temp.people(n int, prefix text) returns jsonb language sql as $$
  select jsonb_agg(jsonb_build_object('name', 'PE ' || prefix || ' ' || i, 'role', 'member',
                                      'email', prefix || i || '@pending.test') order by i)
  from generate_series(1, n) i;
$$;

grant execute on function pg_temp.error_of(text), pg_temp.changed(text), pg_temp.n(text), pg_temp.org(),
  pg_temp.people(int, text)
  to anon, authenticated, service_role;

-- ---------- fixtures ----------
insert into auth.users (id, email) values
  ('ae000000-0000-4000-8000-000000000001', 'admin@pending.test'),
  ('ae000000-0000-4000-8000-000000000002', 'member@pending.test'),
  ('ae000000-0000-4000-8000-000000000003', 'leader@pending.test'),
  ('ae000000-0000-4000-8000-000000000004', 'hq@pending.test'),
  ('ae000000-0000-4000-8000-000000000005', 'second@pending.test'),
  ('ae000000-0000-4000-8000-000000000006', 'signed.in@pending.test'),
  ('ae000000-0000-4000-8000-000000000007', 'invited@pending.test');

insert into teams (id, name, kind) values ('be000000-0000-4000-8000-000000000001', 'PE Division', 'division');
insert into teams (id, name, kind, parent_id) values
  ('be000000-0000-4000-8000-000000000002', 'PE Domain', 'domain', 'be000000-0000-4000-8000-000000000001');
insert into teams (id, name, kind, parent_id, archived_at) values
  ('be000000-0000-4000-8000-000000000003', 'PE Team',     'team', 'be000000-0000-4000-8000-000000000002', null),
  ('be000000-0000-4000-8000-000000000004', 'PE Archived', 'team', 'be000000-0000-4000-8000-000000000002', now() - interval '30 days');

insert into members (id, auth_user_id, name, team_id, role) values
  ('ce000000-0000-4000-8000-000000000001', 'ae000000-0000-4000-8000-000000000001', 'PE admin',         null,                                   'member'),
  ('ce000000-0000-4000-8000-000000000002', 'ae000000-0000-4000-8000-000000000002', 'PE member',        'be000000-0000-4000-8000-000000000003', 'member'),
  ('ce000000-0000-4000-8000-000000000003', 'ae000000-0000-4000-8000-000000000003', 'PE leader',        'be000000-0000-4000-8000-000000000003', 'leader'),
  ('ce000000-0000-4000-8000-000000000004', 'ae000000-0000-4000-8000-000000000004', 'PE hq',            null,                                   'hq'),
  ('ce000000-0000-4000-8000-000000000005', 'ae000000-0000-4000-8000-000000000005', 'PE second admin',  null,                                   'member'),
  ('ce000000-0000-4000-8000-000000000010', null,                                   'PE newcomer',      'be000000-0000-4000-8000-000000000003', 'member'),
  ('ce000000-0000-4000-8000-000000000011', null,                                   'PE other',         'be000000-0000-4000-8000-000000000003', 'member'),
  ('ce000000-0000-4000-8000-000000000012', 'ae000000-0000-4000-8000-000000000006', 'PE signed in',     'be000000-0000-4000-8000-000000000003', 'member'),
  ('ce000000-0000-4000-8000-000000000013', null,                                   'PE master',        null,                                   'hq'),
  ('ce000000-0000-4000-8000-000000000014', null,                                   'PE granted',       'be000000-0000-4000-8000-000000000003', 'member'),
  ('ce000000-0000-4000-8000-000000000016', null,                                   'PE later granted', 'be000000-0000-4000-8000-000000000003', 'member'),
  ('ce000000-0000-4000-8000-000000000020', null,                                   'PE linked',        'be000000-0000-4000-8000-000000000003', 'member'),
  ('ce000000-0000-4000-8000-000000000021', null,                                   'PE checked in',    'be000000-0000-4000-8000-000000000003', 'member'),
  ('ce000000-0000-4000-8000-000000000022', null,                                   'PE mistake',       'be000000-0000-4000-8000-000000000003', 'member'),
  ('ce000000-0000-4000-8000-000000000023', null,                                   'PE promoted',      'be000000-0000-4000-8000-000000000003', 'member'),
  ('ce000000-0000-4000-8000-000000000024', null,                                   'PE stays',         'be000000-0000-4000-8000-000000000003', 'member'),
  ('ce000000-0000-4000-8000-000000000025', null,                                   'PE deleted',       'be000000-0000-4000-8000-000000000003', 'member');
insert into members (id, name, removed_at) values ('ce000000-0000-4000-8000-000000000015', 'PE gone', now() - interval '7 days');
insert into member_grants (member_id, grant_name) values
  ('ce000000-0000-4000-8000-000000000001', 'admin'),
  ('ce000000-0000-4000-8000-000000000005', 'admin'),
  ('ce000000-0000-4000-8000-000000000014', 'recordings');
insert into checkins (id, member_id, week_start) values
  ('de000000-0000-4000-8000-000000000021', 'ce000000-0000-4000-8000-000000000021', '2026-10-05');

-- ---------- schema and privileges ----------
select has_table('public', 'pending_login_emails', 'pending_login_emails exists');
select columns_are('public', 'pending_login_emails', array['member_id', 'email', 'set_by', 'set_at'],
  'pending_login_emails has exactly these columns');
select col_is_pk('public', 'pending_login_emails', 'member_id', 'one noted address per person');
select is(
  (select array_agg(conname::text || ' ' || contype::text || coalesce(' on delete ' || nullif(confdeltype, ' ')::text, '')
     order by conname)
   from pg_constraint where conrelid = 'public.pending_login_emails'::regclass),
  array['pending_login_emails_email_format c', 'pending_login_emails_email_key u',
        'pending_login_emails_member_id_fkey f on delete c', 'pending_login_emails_pkey p',
        'pending_login_emails_set_by_fkey f on delete n'],
  'the constraints the app''s messages name; deleting a person deletes their address, deleting whoever noted it clears set_by'
);
select hasnt_column('public', 'members', 'email',
  'members has no email column: teammates and leaders read members, so the address lives elsewhere');
select is((select relrowsecurity from pg_class where oid = 'public.pending_login_emails'::regclass), true,
  'RLS is on for pending_login_emails');
select policies_are('public', 'pending_login_emails', array[
  'pending_login_emails_admin_select', 'pending_login_emails_admin_insert',
  'pending_login_emails_admin_update', 'pending_login_emails_admin_delete'],
  'pending_login_emails has one policy for each write and for reading, and no others');
select is(
  (select array_agg(format('%s to %s (%s) using %s check %s', cmd, roles, permissive, coalesce(qual, '-'),
     coalesce(with_check, '-')) order by cmd)
   from pg_policies where schemaname = 'public' and tablename = 'pending_login_emails'),
  array['DELETE to {authenticated} (PERMISSIVE) using app_has_grant(''admin''::text) check -',
        'INSERT to {authenticated} (PERMISSIVE) using - check app_has_grant(''admin''::text)',
        'SELECT to {authenticated} (PERMISSIVE) using app_has_grant(''admin''::text) check -',
        'UPDATE to {authenticated} (PERMISSIVE) using app_has_grant(''admin''::text) check app_has_grant(''admin''::text)'],
  'every policy is for signed-in users and asks for the admin grant, and nothing else'
);
select table_privs_are('public', 'pending_login_emails', 'anon', array[]::text[], 'anon has no privileges on pending_login_emails');
select is(
  array[has_any_column_privilege('anon', 'public.pending_login_emails', 'select'),
        has_any_column_privilege('anon', 'public.pending_login_emails', 'insert'),
        has_any_column_privilege('anon', 'public.pending_login_emails', 'update')],
  array[false, false, false], 'nor on any of its columns'
);
select table_privs_are('public', 'pending_login_emails', 'authenticated', array['DELETE', 'SELECT'],
  'signed-in users get table-wide SELECT and DELETE only (RLS limits them to admins)');
select is(
  pg_temp.column_privs('authenticated', 'public.pending_login_emails'),
  array['email:insert', 'email:update', 'member_id:insert'],
  'signed-in users write only the person and the address, and change only the address: never set_by or set_at'
);
select table_privs_are(
  'public', 'pending_login_emails', 'service_role', array['DELETE', 'INSERT', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'],
  'the server (service_role) has full access to pending_login_emails'
);

select function_privs_are('public', 'admin_add_members', array['uuid', 'jsonb'], 'authenticated', array['EXECUTE'],
  'signed-in users can call admin_add_members (it checks for the admin grant itself)');
select function_privs_are('public', 'admin_add_members', array['uuid', 'jsonb'], r, array[]::text[],
  format('%s cannot call admin_add_members', r))
  from unnest(array['anon', 'service_role']) r;
select is(
  (select bool_or(has_function_privilege('public', f, 'execute')) from unnest(array[
    'public.admin_add_members(uuid, jsonb)', 'public.pending_login_emails_check()',
    'public.members_forget_pending_email()', 'public.member_grants_forget_pending_email()']) f),
  false, 'PUBLIC cannot call any of the new functions'
);
select is(
  (select bool_or(has_function_privilege(r, f, 'execute'))
   from unnest(array['anon', 'authenticated', 'service_role']) r,
        unnest(array['public.pending_login_emails_check()', 'public.members_forget_pending_email()',
                     'public.member_grants_forget_pending_email()']) f),
  false, 'nobody calls the trigger functions directly: not anon, signed-in users or the server'
);
select is(
  (select proconfig from pg_proc where oid = f::regprocedure),
  array['search_path=""'], format('%s runs with an empty search_path', f)
) from unnest(array['public.admin_add_members(uuid, jsonb)', 'public.pending_login_emails_check()',
                    'public.members_forget_pending_email()', 'public.member_grants_forget_pending_email()']) f;
select is(
  (select array_agg(proname::text || '=' || prosecdef order by proname) from pg_proc
   where pronamespace = 'public'::regnamespace
     and proname in ('admin_add_members', 'pending_login_emails_check', 'members_forget_pending_email',
                     'member_grants_forget_pending_email')),
  array['admin_add_members=false', 'member_grants_forget_pending_email=true', 'members_forget_pending_email=true',
        'pending_login_emails_check=true'],
  'admin_add_members runs as the admin (RLS and the members triggers decide); the trigger functions as the owner'
);
select is(
  (select array_agg(pg_get_triggerdef(oid) order by tgname) from pg_trigger
   where tgname in ('pending_login_emails_check', 'members_forget_pending_email', 'member_grants_forget_pending_email')
     and not tgisinternal),
  array[
    'CREATE TRIGGER member_grants_forget_pending_email AFTER INSERT OR UPDATE OF member_id ON public.member_grants '
      || 'FOR EACH ROW EXECUTE FUNCTION member_grants_forget_pending_email()',
    'CREATE TRIGGER members_forget_pending_email AFTER UPDATE OF auth_user_id, removed_at, role ON public.members '
      || 'FOR EACH ROW WHEN (((new.auth_user_id IS NOT NULL) OR (new.removed_at IS NOT NULL) OR (new.role = ''hq''::text))) '
      || 'EXECUTE FUNCTION members_forget_pending_email()',
    'CREATE TRIGGER pending_login_emails_check BEFORE INSERT OR UPDATE ON public.pending_login_emails '
      || 'FOR EACH ROW EXECUTE FUNCTION pending_login_emails_check()'],
  'the check runs before every insert and update of an address; the forgetting after a login, a removal, hq or a grant'
);
-- Giving someone a login updates auth_user_id (a unique column), which locks the row FOR UPDATE;
-- noting a new address reads it FOR SHARE, so the two wait for each other (a second session can't
-- be driven from here, so this checks the lock is taken). Changing an address takes no lock on the
-- person's row: the pending row is locked first there, and taking the person's row second could
-- deadlock with a path that forgets addresses (it locks them the other way round).
select ok(
  pg_get_functiondef('public.pending_login_emails_check()'::regprocedure)
    ~* 'if tg_op = ''INSERT'' then\s+select[^;]*from public\.members m where m\.id = new\.member_id\s+for share;\s+else\s+select[^;]*from public\.members m where m\.id = new\.member_id;',
  'the check locks the person''s row while it decides on a new address, and not when an address changes'
);

-- ---------- signed out ----------
set local role anon;
set local request.jwt.claims to '{"role": "anon"}';
select is(pg_temp.error_of($$select 1 from public.pending_login_emails$$),
  '42501: permission denied for table pending_login_emails', 'a signed-out visitor can''t read noted addresses');
select is(
  pg_temp.error_of($$insert into public.pending_login_emails (member_id, email)
    values ('ce000000-0000-4000-8000-000000000011', 'anon@pending.test')$$),
  '42501: permission denied for table pending_login_emails', 'nor note one'
);
select is(
  pg_temp.error_of($$select public.admin_add_members('be000000-0000-4000-8000-000000000003', '[{"name": "PE anon"}]')$$),
  '42501: permission denied for function admin_add_members', 'nor add people'
);

-- ---------- an admin notes, changes and forgets an address ----------
set local role authenticated;
set local request.jwt.claims to '{"sub": "ae000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  pg_temp.error_of($$insert into public.pending_login_emails (member_id, email)
    values ('ce000000-0000-4000-8000-000000000010', 'newcomer@pending.test')$$),
  'no error', 'an admin notes the address for someone''s first invite'
);
select is(pg_temp.n($$select 1 from public.pending_login_emails where member_id = 'ce000000-0000-4000-8000-000000000010'$$), 1,
  'and reads it back');
reset role;
select results_eq(
  $$select p.email, s.name, p.set_at = now() from pending_login_emails p join members s on s.id = p.set_by
    where p.member_id = 'ce000000-0000-4000-8000-000000000010'$$,
  $$values ('newcomer@pending.test'::text, 'PE admin'::text, true)$$,
  'the trigger records which admin noted it, and when'
);
set local role authenticated;
select is(
  pg_temp.error_of($$insert into public.pending_login_emails (member_id, email, set_by)
    values ('ce000000-0000-4000-8000-000000000011', 'forged@pending.test', 'ce000000-0000-4000-8000-000000000002')$$),
  '42501: permission denied for table pending_login_emails', 'an admin can''t say someone else noted it'
);
select is(
  pg_temp.error_of($$insert into public.pending_login_emails (member_id, email, set_at)
    values ('ce000000-0000-4000-8000-000000000011', 'forged@pending.test', '2026-01-01')$$),
  '42501: permission denied for table pending_login_emails', 'nor when'
);
select is(
  pg_temp.error_of($$update public.pending_login_emails set set_by = 'ce000000-0000-4000-8000-000000000002'
    where member_id = 'ce000000-0000-4000-8000-000000000010'$$),
  '42501: permission denied for table pending_login_emails', 'nor rewrite who noted it afterwards'
);
select is(
  pg_temp.error_of($$update public.pending_login_emails set member_id = 'ce000000-0000-4000-8000-000000000011'
    where member_id = 'ce000000-0000-4000-8000-000000000010'$$),
  '42501: permission denied for table pending_login_emails', 'nor move an address to another person'
);

-- Another admin changes it: who noted it, and when, follow the change. (The trigger is off while
-- the old stamp is set, as the dashboard might have left one.)
reset role;
alter table pending_login_emails disable trigger pending_login_emails_check;
update pending_login_emails set set_by = 'ce000000-0000-4000-8000-000000000002', set_at = '2026-01-01'
  where member_id = 'ce000000-0000-4000-8000-000000000010';
alter table pending_login_emails enable trigger pending_login_emails_check;
set local role authenticated;
set local request.jwt.claims to '{"sub": "ae000000-0000-4000-8000-000000000005", "role": "authenticated"}';
select is(
  pg_temp.changed($$update public.pending_login_emails set email = 'newcomer.two@pending.test'
    where member_id = 'ce000000-0000-4000-8000-000000000010'$$),
  1, 'another admin changes the noted address'
);
reset role;
select results_eq(
  $$select p.email, s.name, p.set_at = now() from pending_login_emails p join members s on s.id = p.set_by
    where p.member_id = 'ce000000-0000-4000-8000-000000000010'$$,
  $$values ('newcomer.two@pending.test'::text, 'PE second admin'::text, true)$$,
  'and the change is theirs, made now'
);

-- ---------- the address: its format, and one person per address ----------
set local role authenticated;
set local request.jwt.claims to '{"sub": "ae000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  pg_temp.error_of(format($$insert into public.pending_login_emails (member_id, email)
    values ('ce000000-0000-4000-8000-000000000011', %L)$$, x.email)),
  '23514: new row for relation "pending_login_emails" violates check constraint "pending_login_emails_email_format"',
  format('an address %s is refused (pending_login_emails_email_format)', x.what)
) from (values
  ('Other@Pending.test',        'in upper case'),
  (' other@pending.test',       'with a space before it'),
  ('other@pending.test ',       'with a space after it'),
  ('other pending@pending.test', 'with a space inside it'),
  ('',                          'that is empty'),
  ('other.pending.test',        'with no @'),
  ('@pending.test',             'with nothing before the @'),
  ('other@@pending.test',       'with two @s'),
  ('other@pend@ing.test',       'with an @ in the domain'),
  ('other@localhost',           'whose domain has one part'),
  ('other@pending..test',       'with an empty part in the domain'),
  ('other@.pending.test',       'whose domain starts with a dot'),
  ('other@pending.test.',       'whose domain ends with a dot'),
  (repeat('a', 242) || '@pending.test', 'of 255 characters')
) x (email, what);
select is(
  pg_temp.error_of($$insert into public.pending_login_emails (member_id, email)
    values ('ce000000-0000-4000-8000-000000000011', null)$$),
  '23502: null value in column "email" of relation "pending_login_emails" violates not-null constraint',
  'a noted address can''t be empty (null): forgetting one deletes the row'
);
select is(
  pg_temp.error_of(format($$insert into public.pending_login_emails (member_id, email)
    values ('ce000000-0000-4000-8000-000000000011', %L)$$, repeat('a', 241) || '@pending.test')),
  'no error', 'an address of 254 characters is fine'
);
select is(
  pg_temp.changed($$update public.pending_login_emails set email = 'first.last+tag@sub.pending.test'
    where member_id = 'ce000000-0000-4000-8000-000000000011'$$),
  1, 'as is one with dots, a plus and a subdomain'
);
select is(
  pg_temp.error_of($$update public.pending_login_emails set email = 'Other@Pending.test'
    where member_id = 'ce000000-0000-4000-8000-000000000011'$$),
  '23514: new row for relation "pending_login_emails" violates check constraint "pending_login_emails_email_format"',
  'a change is held to the same format'
);
select is(
  pg_temp.error_of($$insert into public.pending_login_emails (member_id, email)
    values ('ce000000-0000-4000-8000-000000000011', 'other@pending.test')$$),
  '23505: duplicate key value violates unique constraint "pending_login_emails_pkey"',
  'a second address for the same person is refused (pending_login_emails_pkey: the page says the person changed)'
);
select is(
  pg_temp.changed($$update public.pending_login_emails set email = 'other@pending.test'
    where member_id = 'ce000000-0000-4000-8000-000000000011'$$),
  1, 'the person''s one address is changed instead'
);
select is(
  pg_temp.error_of($$update public.pending_login_emails set email = 'newcomer.two@pending.test'
    where member_id = 'ce000000-0000-4000-8000-000000000011'$$),
  '23505: duplicate key value violates unique constraint "pending_login_emails_email_key"',
  'an address noted for someone else can''t be noted for a second person (pending_login_emails_email_key)'
);
select is(
  pg_temp.changed($$delete from public.pending_login_emails where member_id = 'ce000000-0000-4000-8000-000000000011'$$),
  1, 'an admin forgets a noted address'
);
select is(
  pg_temp.changed($$update public.pending_login_emails set email = 'other@pending.test'
    where member_id = 'ce000000-0000-4000-8000-000000000010'$$),
  1, 'after which it can be noted for someone else'
);

-- ---------- who an address can't be noted for ----------
select is(
  pg_temp.error_of(format($$insert into public.pending_login_emails (member_id, email) values (%L, 'refused@pending.test')$$, x.id)),
  x.refusal, format('an admin can''t note an address for %s', x.who)
) from (values
  ('ce000000-0000-4000-8000-000000000099', 'P0002: This person doesn''t exist any more. Reload the page.',
   'someone who doesn''t exist'),
  ('ce000000-0000-4000-8000-000000000015', '23514: This person was removed from Module One. Reload the page.',
   'someone removed from Module One'),
  ('ce000000-0000-4000-8000-000000000013', '23514: Master Admins get their login from the project owner.',
   'a Master Admin'),
  ('ce000000-0000-4000-8000-000000000012',
   '23514: This person already has a login. To change the address they sign in with, use Change email.',
   'someone who already has a login'),
  ('ce000000-0000-4000-8000-000000000014',
   '23514: This person holds grants (such as admin), so only the project owner can give them a login.',
   'someone holding a grant'),
  ('ce000000-0000-4000-8000-000000000001',
   '23514: This person already has a login. To change the address they sign in with, use Change email.',
   'themselves'),
  ('ce000000-0000-4000-8000-000000000005',
   '23514: This person already has a login. To change the address they sign in with, use Change email.',
   'another admin')
) x (id, refusal, who);
reset role;
select is(
  (select count(*)::int from pending_login_emails where email = 'refused@pending.test'), 0,
  'a refused note leaves nothing behind'
);

-- Someone the project owner gives a grant after their address was noted: the owner gives grant
-- holders their login, so the address is forgotten (member_grants_forget_pending_email), and it's
-- free for someone else.
set local role authenticated;
select is(
  pg_temp.error_of($$insert into public.pending_login_emails (member_id, email)
    values ('ce000000-0000-4000-8000-000000000016', 'later@pending.test')$$),
  'no error', 'an admin notes an address for someone with no grants yet'
);
reset role;
insert into member_grants (member_id, grant_name) values ('ce000000-0000-4000-8000-000000000016', 'big_five');
set local role authenticated;
select is(
  pg_temp.n($$select 1 from public.pending_login_emails where member_id = 'ce000000-0000-4000-8000-000000000016'$$),
  0, 'once they hold a grant, their address is forgotten'
);
select is(
  pg_temp.changed($$update public.pending_login_emails set email = 'later.two@pending.test'
    where member_id = 'ce000000-0000-4000-8000-000000000016'$$),
  0, 'so there is nothing left to change'
);

-- ---------- nobody else reads or writes them ----------
-- newcomer (in PE Team) has 'other@pending.test' noted.
select is(pg_temp.n($$select 1 from public.pending_login_emails$$), 0, format('%s sees no noted address', s.who))
  from (values ('ae000000-0000-4000-8000-000000000002', 'a member of the same team'),
               ('ae000000-0000-4000-8000-000000000003', 'the leader of the team they sit in'),
               ('ae000000-0000-4000-8000-000000000004', 'a Master Admin without the admin grant'),
               ('ae000000-0000-4000-8000-000000000007', 'a login no member uses')) s(id, who)
  cross join lateral (select set_config('request.jwt.claims',
    json_build_object('sub', s.id, 'role', 'authenticated')::text, true)) signed_in;
select is(
  pg_temp.error_of($$insert into public.pending_login_emails (member_id, email)
    values ('ce000000-0000-4000-8000-000000000011', 'sneaky@pending.test')$$),
  '42501: new row violates row-level security policy for table "pending_login_emails"',
  format('%s can''t note one', s.who))
  from (values ('ae000000-0000-4000-8000-000000000002', 'a member'),
               ('ae000000-0000-4000-8000-000000000003', 'a leader'),
               ('ae000000-0000-4000-8000-000000000004', 'a Master Admin without the admin grant')) s(id, who)
  cross join lateral (select set_config('request.jwt.claims',
    json_build_object('sub', s.id, 'role', 'authenticated')::text, true)) signed_in;
select is(
  pg_temp.changed($$update public.pending_login_emails set email = 'sneaky@pending.test'
    where member_id::text like 'ce000000-%'$$),
  0, format('%s can''t change one', s.who))
  from (values ('ae000000-0000-4000-8000-000000000002', 'a member'),
               ('ae000000-0000-4000-8000-000000000003', 'a leader'),
               ('ae000000-0000-4000-8000-000000000004', 'a Master Admin without the admin grant')) s(id, who)
  cross join lateral (select set_config('request.jwt.claims',
    json_build_object('sub', s.id, 'role', 'authenticated')::text, true)) signed_in;
select is(
  pg_temp.changed($$delete from public.pending_login_emails where member_id::text like 'ce000000-%'$$),
  0, format('%s can''t forget one', s.who))
  from (values ('ae000000-0000-4000-8000-000000000002', 'a member'),
               ('ae000000-0000-4000-8000-000000000003', 'a leader'),
               ('ae000000-0000-4000-8000-000000000004', 'a Master Admin without the admin grant')) s(id, who)
  cross join lateral (select set_config('request.jwt.claims',
    json_build_object('sub', s.id, 'role', 'authenticated')::text, true)) signed_in;
-- The check runs before RLS refuses the row, so it mustn't answer someone who isn't an admin: its
-- sentences would tell them who exists, was removed, is a Master Admin or holds grants (which
-- member_grants hides from them), as 0003 keeps the tree's checks out of BEFORE triggers for.
set local request.jwt.claims to '{"sub": "ae000000-0000-4000-8000-000000000002", "role": "authenticated"}';
select is(
  pg_temp.error_of(format($$insert into public.pending_login_emails (member_id, email) values (%L, 'probe@pending.test')$$, x.id)),
  '42501: new row violates row-level security policy for table "pending_login_emails"',
  format('a member who names %s is refused like anyone else, and learns nothing about them', x.who)
) from (values
  ('ce000000-0000-4000-8000-000000000099', 'someone who doesn''t exist'),
  ('ce000000-0000-4000-8000-000000000015', 'someone removed'),
  ('ce000000-0000-4000-8000-000000000013', 'a Master Admin'),
  ('ce000000-0000-4000-8000-000000000014', 'someone holding a grant')
) x (id, who);
reset role;
select results_eq(
  $$select member_id, email from pending_login_emails where member_id::text like 'ce000000-%' order by member_id$$,
  $$values ('ce000000-0000-4000-8000-000000000010'::uuid, 'other@pending.test'::text)$$,
  'none of that changed anything: one address is noted, the admin''s'
);

-- ---------- the server ----------
set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
select is(
  pg_temp.error_of($$insert into public.pending_login_emails (member_id, email, set_by, set_at)
    values ('ce000000-0000-4000-8000-000000000025', 'deleted@pending.test', 'ce000000-0000-4000-8000-000000000002', '2026-01-01')$$),
  'no error', 'the server can note an address'
);
select results_eq(
  $$select email, set_by, set_at = now() from public.pending_login_emails where member_id = 'ce000000-0000-4000-8000-000000000025'$$,
  $$values ('deleted@pending.test'::text, null::uuid, true)$$,
  'but the trigger stamps it too: noted by nobody signed in, now, whatever the server sent'
);
select is(
  pg_temp.error_of($$insert into public.pending_login_emails (member_id, email)
    values ('ce000000-0000-4000-8000-000000000013', 'master@pending.test')$$),
  '23514: Master Admins get their login from the project owner.',
  'and the server is held to the same people: never a Master Admin'
);
reset role;

-- ---------- when a noted address goes ----------
set local role authenticated;
set local request.jwt.claims to '{"sub": "ae000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  pg_temp.error_of($$insert into public.pending_login_emails (member_id, email) values
    ('ce000000-0000-4000-8000-000000000020', 'linked@pending.test'),
    ('ce000000-0000-4000-8000-000000000021', 'checked.in@pending.test'),
    ('ce000000-0000-4000-8000-000000000022', 'mistake@pending.test'),
    ('ce000000-0000-4000-8000-000000000023', 'promoted@pending.test'),
    ('ce000000-0000-4000-8000-000000000024', 'stays@pending.test')$$),
  'no error', 'an admin notes several addresses in one insert'
);

-- giveLogin: the server links the invited login, recording who gave it.
set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
select is(
  pg_temp.changed($$update public.members set auth_user_id = 'ae000000-0000-4000-8000-000000000007',
      login_given_by = 'ce000000-0000-4000-8000-000000000001', login_given_at = now()
    where id = 'ce000000-0000-4000-8000-000000000020'$$),
  1, 'the server links someone''s new login'
);
reset role;
select is((select count(*)::int from pending_login_emails where member_id = 'ce000000-0000-4000-8000-000000000020'), 0,
  'which forgets their noted address: it lives in Supabase Auth from then on');

set local role authenticated;
set local request.jwt.claims to '{"sub": "ae000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(admin_remove_member('ce000000-0000-4000-8000-000000000021') ->> 'outcome', 'removed',
  'an admin removes someone with a check-in (kept, marked removed)');
reset role;
select is((select count(*)::int from pending_login_emails where member_id = 'ce000000-0000-4000-8000-000000000021'), 0,
  'which forgets their noted address');
select is((select count(*)::int from checkins where id = 'de000000-0000-4000-8000-000000000021'), 1,
  'while their check-in stays');

set local role authenticated;
select is(admin_remove_member('ce000000-0000-4000-8000-000000000022') ->> 'outcome', 'deleted',
  'an admin removes someone added by mistake (deleted outright: a noted address isn''t history)');
reset role;
select is((select count(*)::int from pending_login_emails where member_id = 'ce000000-0000-4000-8000-000000000022'), 0,
  'and their noted address goes with them');

-- The project owner makes someone a Master Admin in the dashboard.
update members set role = 'hq' where id = 'ce000000-0000-4000-8000-000000000023';
select is((select count(*)::int from pending_login_emails where member_id = 'ce000000-0000-4000-8000-000000000023'), 0,
  'making someone a Master Admin forgets their noted address');

set local role authenticated;
select is(
  pg_temp.changed(format($$update public.members set %s where id = 'ce000000-0000-4000-8000-000000000024'$$, x.change)),
  1, format('an admin %s someone with a noted address', x.what)
) from (values
  ('name = ''PE stays renamed''',                              'renames'),
  ('team_id = ''be000000-0000-4000-8000-000000000002''',        'moves'),
  ('role = ''leader''',                                         'makes a leader'),
  ('team_id = null',                                            'takes out of their team')
) x (change, what);
reset role;
select results_eq(
  $$select m.name, coalesce(m.team_id::text, 'no team'), m.role, p.email, s.name
    from members m join pending_login_emails p on p.member_id = m.id join members s on s.id = p.set_by
    where m.id = 'ce000000-0000-4000-8000-000000000024'$$,
  $$values ('PE stays renamed'::text, 'no team'::text, 'leader'::text, 'stays@pending.test'::text, 'PE admin'::text)$$,
  'none of which forgets it, or who noted it'
);

delete from members where id = 'ce000000-0000-4000-8000-000000000025';
select is((select count(*)::int from pending_login_emails where member_id = 'ce000000-0000-4000-8000-000000000025'), 0,
  'deleting a person (the project owner, in the dashboard) deletes their noted address');

-- ---------- admin_add_members: only admins ----------
set local role authenticated;
select is(
  pg_temp.error_of($$select public.admin_add_members('be000000-0000-4000-8000-000000000003', '[{"name": "PE intruder"}]')$$),
  '42501: Only admins can add people.', format('%s can''t add people', s.who))
  from (values ('ae000000-0000-4000-8000-000000000002', 'a member'),
               ('ae000000-0000-4000-8000-000000000003', 'the leader of the team'),
               ('ae000000-0000-4000-8000-000000000004', 'a Master Admin without the admin grant')) s(id, who)
  cross join lateral (select set_config('request.jwt.claims',
    json_build_object('sub', s.id, 'role', 'authenticated')::text, true)) signed_in;
set local role service_role;
set local request.jwt.claims to '{"role": "service_role"}';
select is(
  pg_temp.error_of($$select public.admin_add_members('be000000-0000-4000-8000-000000000003', '[{"name": "PE intruder"}]')$$),
  '42501: permission denied for function admin_add_members', 'nor can the server: it adds people only as the admin asking'
);
reset role;
select is((select count(*)::int from members where name = 'PE intruder'), 0, 'nobody was added');

-- ---------- admin_add_members: what it refuses ----------
set local role authenticated;
set local request.jwt.claims to '{"sub": "ae000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(pg_temp.error_of(format('select public.admin_add_members(%s, %s)', x.team, x.people)), x.refusal, x.why)
from (values
  ('null', $q$'[{"name": "PE list nowhere"}]'$q$,
   '22023: Pick where to add them.', 'a list needs somewhere to go'),
  ($q$'be000000-0000-4000-8000-000000000003'$q$, $q$'[]'$q$,
   '22023: Add from 1 to 200 people at a time.', 'an empty list is refused'),
  ($q$'be000000-0000-4000-8000-000000000003'$q$, 'null',
   '22023: Add from 1 to 200 people at a time.', 'so is no list'),
  ($q$'be000000-0000-4000-8000-000000000003'$q$, $q$'{"name": "PE list single"}'$q$,
   '22023: Add from 1 to 200 people at a time.', 'and one person on their own, not in a list'),
  ($q$'be000000-0000-4000-8000-000000000003'$q$, 'pg_temp.people(201, ''toomany'')',
   '22023: Add from 1 to 200 people at a time.', 'and a list of 201 people'),
  ($q$'be000000-0000-4000-8000-000000000003'$q$, $q$'[{"name": "PE list first"}, "PE list second"]'$q$,
   '22023: Each person needs a name.', 'a list with someone who isn''t an object is refused, after the people before them'),
  ($q$'be000000-0000-4000-8000-000000000003'$q$, $q$'[{"name": "PE list first"}, {"email": "noname@pending.test"}]'$q$,
   '23502: null value in column "name" of relation "members" violates not-null constraint',
   'so is one with someone who has no name'),
  ($q$'be000000-0000-4000-8000-000000000003'$q$, $q$'[{"name": "PE list first"}, {"name": "PE list boss", "role": "boss"}]'$q$,
   '23514: new row for relation "members" violates check constraint "members_role_chk"',
   'and one with a role nobody has'),
  ($q$'be000000-0000-4000-8000-000000000003'$q$, $q$'[{"name": "PE list first"}, {"name": "PE list master", "role": "hq"}]'$q$,
   '42501: new row violates row-level security policy for table "members"',
   'and one with a Master Admin (only the project owner makes one: RLS)'),
  ($q$'be000000-0000-4000-8000-0000000000ff'$q$, $q$'[{"name": "PE list lost"}]'$q$,
   '23503: insert or update on table "members" violates foreign key constraint "members_team_id_fkey"',
   'a node that doesn''t exist is refused'),
  ($q$'be000000-0000-4000-8000-000000000004'$q$, $q$'[{"name": "PE list archived"}]'$q$,
   '23514: That team is archived. Restore it first, or pick another.',
   'so is an archived node, in members_check_team''s words'),
  ('pg_temp.org()', $q$'[{"name": "PE list president"}]'$q$,
   '42501: Only the project owner can place people in the organisation itself.',
   'and the organisation, in 0006''s words'),
  ($q$'be000000-0000-4000-8000-000000000003'$q$,
   $q$'[{"name": "PE list first", "email": "dup@pending.test"}, {"name": "PE list second"}, {"name": "PE list third", "email": "dup@pending.test"}]'$q$,
   '23505: duplicate key value violates unique constraint "pending_login_emails_email_key"',
   'a list with an address twice is refused, at the last person'),
  ($q$'be000000-0000-4000-8000-000000000003'$q$,
   $q$'[{"name": "PE list first", "email": "first@pending.test"}, {"name": "PE list taken", "email": "other@pending.test"}]'$q$,
   '23505: duplicate key value violates unique constraint "pending_login_emails_email_key"',
   'so is one with an address already noted for someone else'),
  ($q$'be000000-0000-4000-8000-000000000003'$q$,
   $q$'[{"name": "PE list first", "email": "first@pending.test"}, {"name": "PE list shouty", "email": "Shouty@Pending.test"}]'$q$,
   '23514: new row for relation "pending_login_emails" violates check constraint "pending_login_emails_email_format"',
   'and one with an address in the wrong format')
) x (team, people, refusal, why);
reset role;
select is(
  (select count(*)::int from members where name like 'PE list %' or name like 'PE toomany %'),
  0, 'a refused list adds nobody, not even the people before the problem: all or nothing'
);
select is(
  (select count(*)::int from pending_login_emails where email in ('dup@pending.test', 'first@pending.test', 'noname@pending.test')),
  0, 'and notes nothing'
);
select results_eq(
  $$select member_id, email from pending_login_emails where email = 'other@pending.test'$$,
  $$values ('ce000000-0000-4000-8000-000000000010'::uuid, 'other@pending.test'::text)$$,
  'the address a list tried to take is still noted for the person who had it'
);

-- ---------- admin_add_members: adding a list ----------
set local role authenticated;
set local request.jwt.claims to '{"sub": "ae000000-0000-4000-8000-000000000001", "role": "authenticated"}';
select is(
  pg_temp.error_of($$select set_config('pe.added', public.admin_add_members('be000000-0000-4000-8000-000000000003',
    '[{"name": "PE Ada", "role": "member", "email": "ada@pending.test"},
      {"name": "PE Bea", "role": "leader", "email": null},
      {"name": "PE Cy", "email": ""},
      {"name": "PE Dee", "role": "member", "email": "dee@pending.test"}]')::text, true)$$),
  'no error', 'an admin adds a list of four people to a team'
);
reset role;
select is(cardinality(current_setting('pe.added')::uuid[]), 4, 'it returns one id for each person');
select results_eq(
  $$select m.name, t.name, m.role, m.auth_user_id is null,
           coalesce(p.email || ', noted by ' || s.name || case when p.set_at = now() then ' now' else ' earlier' end, 'none')
    from unnest(current_setting('pe.added')::uuid[]) with ordinality u (id, ord)
    join members m on m.id = u.id
    join teams t on t.id = m.team_id
    left join pending_login_emails p on p.member_id = m.id
    left join members s on s.id = p.set_by
    order by u.ord$$,
  $$values ('PE Ada'::text, 'PE Team'::text, 'member'::text, true, 'ada@pending.test, noted by PE admin now'::text),
           ('PE Bea', 'PE Team', 'leader', true, 'none'),
           ('PE Cy',  'PE Team', 'member', true, 'none'),
           ('PE Dee', 'PE Team', 'member', true, 'dee@pending.test, noted by PE admin now')$$,
  'in the list''s order: each in the team, with their role (member when none is given) and no login; an address noted, by the admin, for those who have one'
);
select is(
  (select count(*)::int from members where name in ('PE Ada', 'PE Bea', 'PE Cy', 'PE Dee')),
  4, 'each of them once'
);

set local role authenticated;
select is(
  pg_temp.error_of($$select set_config('pe.head', public.admin_add_members('be000000-0000-4000-8000-000000000001',
    '[{"name": "PE Head", "role": "member", "email": "head@pending.test"}]')::text, true)$$),
  'no error', 'an admin adds someone to a division'
);
reset role;
select results_eq(
  $$select m.name, m.team_id, m.role, p.email
    from members m left join pending_login_emails p on p.member_id = m.id
    where m.id = any (current_setting('pe.head')::uuid[])$$,
  $$values ('PE Head'::text, 'be000000-0000-4000-8000-000000000001'::uuid, 'leader'::text, 'head@pending.test'::text)$$,
  'who sits there, so leads it (members_lead_where_placed), with their address noted'
);

set local role authenticated;
select is(
  pg_temp.error_of($$select set_config('pe.bulk', public.admin_add_members('be000000-0000-4000-8000-000000000002',
    pg_temp.people(200, 'bulk'))::text, true)$$),
  'no error', 'an admin adds 200 people at once, the most a list holds'
);
reset role;
select results_eq(
  $$select count(distinct u.id)::int, count(m.id)::int, count(p.member_id)::int,
           bool_and(m.team_id = 'be000000-0000-4000-8000-000000000002' and m.name = 'PE bulk ' || u.ord
                    and p.email = 'bulk' || u.ord || '@pending.test')
    from unnest(current_setting('pe.bulk')::uuid[]) with ordinality u (id, ord)
    left join members m on m.id = u.id
    left join pending_login_emails p on p.member_id = m.id$$,
  $$values (200, 200, 200, true)$$,
  'all 200 are in the domain, in order, each with their address noted'
);

reset role;
select * from finish();
rollback;
