-- Module One — initial schema + RLS
-- Review carefully before applying to any shared/production DB.

create extension if not exists "pgcrypto";

-- ---------- tables ----------
create table teams (
  id        uuid primary key default gen_random_uuid(),
  name      text not null,
  division  text
);

create table members (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique references auth.users(id) on delete set null,
  name          text not null,
  team_id       uuid references teams(id) on delete set null,
  role          text not null default 'member',   -- member | leader | hq
  big_five      jsonb,
  constraint members_role_chk check (role in ('member','leader','hq'))
);

create table checkins (
  id                uuid primary key default gen_random_uuid(),
  member_id         uuid not null references members(id) on delete cascade,
  week_start        date not null,
  transcript        text,
  activity_score    int check (activity_score between 1 and 5),
  excellence_score  int check (excellence_score between 1 and 5),
  morale_score      int check (morale_score between 1 and 5),
  category          text,
  rubric_review     text,
  created_at        timestamptz not null default now(),
  unique (member_id, week_start)
);

create table checkin_mentions (                    -- 360 edges for the perf-matrix
  checkin_id        uuid not null references checkins(id) on delete cascade,
  about_member_id   uuid not null references members(id) on delete cascade,
  sentiment         int check (sentiment between -2 and 2)
);

-- ---------- helpers (security definer so policies can read members) ----------
create or replace function app_current_team() returns uuid
  language sql stable security definer set search_path = public as $$
    select team_id from members where auth_user_id = auth.uid() limit 1;
$$;

create or replace function app_current_role() returns text
  language sql stable security definer set search_path = public as $$
    select role from members where auth_user_id = auth.uid() limit 1;
$$;

create or replace function app_current_member_id() returns uuid
  language sql stable security definer set search_path = public as $$
    select id from members where auth_user_id = auth.uid() limit 1;
$$;

-- ---------- RLS ----------
alter table teams            enable row level security;
alter table members          enable row level security;
alter table checkins         enable row level security;
alter table checkin_mentions enable row level security;

-- teams: your own team, or hq sees all
create policy teams_select on teams for select
  using (id = app_current_team() or app_current_role() = 'hq');

-- members: yourself, same team, or hq
create policy members_select on members for select
  using (
    auth_user_id = auth.uid()
    or team_id = app_current_team()
    or app_current_role() = 'hq'
  );

-- checkins: your own; leaders & hq see their team; hq sees all
create policy checkins_select on checkins for select
  using (
    member_id = app_current_member_id()
    or app_current_role() = 'hq'
    or (
      app_current_role() = 'leader'
      and exists (
        select 1 from members m
        where m.id = checkins.member_id and m.team_id = app_current_team()
      )
    )
  );

-- you can only write your own check-ins
create policy checkins_insert on checkins for insert
  with check (member_id = app_current_member_id());
create policy checkins_update on checkins for update
  using (member_id = app_current_member_id());

-- mentions: hq, or same-team visibility of the parent check-in
create policy mentions_select on checkin_mentions for select
  using (
    app_current_role() = 'hq'
    or exists (
      select 1 from checkins c join members m on m.id = c.member_id
      where c.id = checkin_mentions.checkin_id and m.team_id = app_current_team()
    )
  );
