-- Run by scripts/check-organisation-upgrade.sh (see there) on a database at migration 0005, with
-- the psql variable migration (0006's file). Stops at the first broken expectation, and rolls
-- everything back.
begin;

-- What production may hold before 0006, besides 0003's founding structure: people sitting in a
-- division (a leader and a member), a division lead row, an archived division, an unplaced domain
-- with someone in it, and check-ins made in a division and elsewhere.
insert into teams (id, name, kind, sort_order) values
  ('0f000000-0000-4000-8000-000000000001', 'Old division', 'division', 4),
  ('0f000000-0000-4000-8000-000000000002', 'Loose domain', 'domain',   5);
update teams set archived_at = '2026-10-01' where id = '0f000000-0000-4000-8000-000000000001';
insert into members (id, name, team_id, role)
select v.id::uuid, v.name, t.id, v.role
from (values
  ('0f000000-0000-4000-8000-000000000011', 'Head',      'Gather', 'leader'),
  ('0f000000-0000-4000-8000-000000000012', 'Sitter',    'Gather', 'member'),
  ('0f000000-0000-4000-8000-000000000013', 'Chief',     'HQ',     'hq')
) as v (id, name, division, role)
join teams t on t.kind = 'division' and t.name = v.division;
insert into members (id, name, team_id, role) values
  ('0f000000-0000-4000-8000-000000000014', 'Loose one',  '0f000000-0000-4000-8000-000000000002', 'member'),
  ('0f000000-0000-4000-8000-000000000015', 'IP member',  (select id from teams where code = 'IP.1'), 'member');
insert into team_leads (team_id, member_id)
select id, '0f000000-0000-4000-8000-000000000011' from teams where kind = 'division' and name = 'Culture';
insert into checkins (id, member_id, week_start) values
  ('0f000000-0000-4000-8000-000000000021', '0f000000-0000-4000-8000-000000000012', '2026-09-28'),
  ('0f000000-0000-4000-8000-000000000022', '0f000000-0000-4000-8000-000000000014', '2026-09-28'),
  ('0f000000-0000-4000-8000-000000000023', '0f000000-0000-4000-8000-000000000015', '2026-09-28');

-- Everything 0006 should leave alone: teams apart from the divisions' parent, members apart from the
-- role of the member sitting in a division, every lead row and every check-in.
create temp table old_rows as
  select id, concat_ws('|', name, kind, sort_order, code, domain_type, division_type, note, archived_at,
                       case when kind = 'division' then '-' else parent_id::text end) as v from teams
  union all
  select id, concat_ws('|', name, team_id, case when id = '0f000000-0000-4000-8000-000000000012' then '-' else role end,
                       auth_user_id) from members
  union all
  select member_id, concat_ws('|', 'lead', team_id) from team_leads
  union all
  select id, concat_ws('|', member_id, team_id, week_start) from checkins;

\i :migration

do $$
declare
  got text;
begin
  select string_agg(name || '|' || coalesce(parent_id::text, '-') || '|' || sort_order, ', ') into got
  from teams where kind = 'organisation';
  if got is distinct from 'The New Normal|-|0' then
    raise exception 'there should be one organisation, The New Normal, at the top; got %', got;
  end if;

  select string_agg(d.name || ':' || d.sort_order, ', ' order by d.sort_order, d.name) into got
  from teams d join teams o on o.id = d.parent_id and o.kind = 'organisation'
  where d.kind = 'division';
  if got is distinct from 'Gather:0, Culture:1, HQ:2, Special Projects:3, Old division:4' then
    raise exception 'every division, archived ones too, should sit under the organisation in its old order; got %', got;
  end if;

  select string_agg(name, ', ' order by name) into got from teams where parent_id is null;
  if got is distinct from 'Loose domain, The New Normal' then
    raise exception 'only the organisation and the unplaced domain should stay at the top level; got %', got;
  end if;

  select role into got from members where id = '0f000000-0000-4000-8000-000000000012';
  if got is distinct from 'leader' then
    raise exception 'the member sitting in Gather should now lead it; got %', got;
  end if;

  select string_agg(id::text, ', ' order by id) into got
  from (
    select id, concat_ws('|', name, kind, sort_order, code, domain_type, division_type, note, archived_at,
                         case when kind = 'division' then '-' else parent_id::text end) as v
    from teams where kind <> 'organisation'
    union all
    select id, concat_ws('|', name, team_id, case when id = '0f000000-0000-4000-8000-000000000012' then '-' else role end,
                         auth_user_id) from members
    union all
    select member_id, concat_ws('|', 'lead', team_id) from team_leads
    union all
    select id, concat_ws('|', member_id, team_id, week_start) from checkins
    except
    select id, v from old_rows
  ) changed;
  if got is not null then
    raise exception 'these rows changed (or appeared) beyond what 0006 should do: %', got;
  end if;
  select string_agg(id::text, ', ' order by id) into got
  from (select id, v from old_rows except all (
    select id, concat_ws('|', name, kind, sort_order, code, domain_type, division_type, note, archived_at,
                         case when kind = 'division' then '-' else parent_id::text end) from teams
    union all
    select id, concat_ws('|', name, team_id, case when id = '0f000000-0000-4000-8000-000000000012' then '-' else role end,
                         auth_user_id) from members
    union all
    select member_id, concat_ws('|', 'lead', team_id) from team_leads
    union all
    select id, concat_ws('|', member_id, team_id, week_start) from checkins)) gone;
  if got is not null then
    raise exception 'these rows went missing: %', got;
  end if;
end $$;

rollback;
