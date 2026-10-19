-- Momentum: Explore — group visibility, descriptions, public discovery, join requests.
-- Non-members never read group tables directly; they only get safe aggregates through
-- the security-definer RPCs below (no invite codes, no workout notes, private groups excluded).

-- Existing groups become private (safest); new groups default to public.
alter table public.groups add column visibility text not null default 'private'
  check (visibility in ('public', 'request', 'private'));
alter table public.groups alter column visibility set default 'public';
alter table public.groups add column description text check (description is null or char_length(description) <= 160);
grant update (visibility, description) on public.groups to authenticated;

create table public.group_join_requests (
  group_id uuid not null references public.groups (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
alter table public.group_join_requests enable row level security;
create policy "join requests: own or admin read" on public.group_join_requests for select to authenticated
  using (user_id = auth.uid() or private.is_admin(group_id));
grant select on public.group_join_requests to authenticated;

create or replace function private.discoverable(p_group uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.groups where id = p_group and visibility in ('public', 'request'))
$$;

-- Leaderboard core without the membership check (used by Explore for discoverable groups only).
create or replace function private.lb(p_group uuid, p_from date default null, p_to date default null, p_today date default null)
returns table (user_id uuid, display_name text, avatar_emoji text, avatar_color text, role text, rank int,
               points int, workouts int, km numeric, minutes int, kcal int,
               workout_points int, goal_points int, streak_points int, challenge_points int, current_streak int)
language sql stable security definer set search_path = public, private as $$
  with d as (
    select * from private.day_scores(p_group) ds
    where (p_from is null or ds.day >= p_from) and (p_to is null or ds.day <= p_to)
  ),
  a as (
    select d.user_id, sum(d.workouts)::int as workouts, sum(d.km) as km, sum(d.minutes) as minutes, sum(d.kcal)::int as kcal,
      sum(d.workout_pts)::int as wp, sum(d.goal_pts)::int as gp, sum(d.streak_pts)::int as sp
    from d group by d.user_id
  ),
  c as (
    select cp.user_id, sum(cp.reward)::int as cp
    from private.challenge_progress(p_group) cp
    where cp.finished_on is not null
      and (p_from is null or cp.finished_on >= p_from) and (p_to is null or cp.finished_on <= p_to)
    group by cp.user_id
  ),
  s as (select * from private.current_streaks(p_group, coalesce(p_today, private.today_il()))),
  t as (
    select m.user_id, p.display_name, p.avatar_emoji, p.avatar_color, m.role,
      (coalesce(a.wp, 0) + coalesce(a.gp, 0) + coalesce(a.sp, 0) + coalesce(c.cp, 0))::int as points,
      coalesce(a.workouts, 0) as workouts, round(coalesce(a.km, 0), 1) as km,
      round(coalesce(a.minutes, 0))::int as minutes, coalesce(a.kcal, 0) as kcal,
      coalesce(a.wp, 0) as wp, coalesce(a.gp, 0) as gp, coalesce(a.sp, 0) as sp, coalesce(c.cp, 0) as cp,
      coalesce(s.streak, 0) as streak
    from public.group_members m
    join public.profiles p on p.id = m.user_id
    left join a on a.user_id = m.user_id
    left join c on c.user_id = m.user_id
    left join s on s.user_id = m.user_id
    where m.group_id = p_group
  )
  select t.user_id, t.display_name, t.avatar_emoji, t.avatar_color, t.role,
    (rank() over (order by t.points desc, t.workouts desc))::int,
    t.points, t.workouts, t.km, t.minutes, t.kcal, t.wp, t.gp, t.sp, t.cp, t.streak
  from t order by 6, t.display_name
$$;
revoke execute on function private.lb(uuid, date, date, date) from public, anon, authenticated;

create or replace function public.leaderboard(p_group uuid, p_from date default null, p_to date default null, p_today date default null)
returns table (user_id uuid, display_name text, avatar_emoji text, avatar_color text, role text, rank int,
               points int, workouts int, km numeric, minutes int, kcal int,
               workout_points int, goal_points int, streak_points int, challenge_points int, current_streak int)
language sql stable security definer set search_path = public, private as $$
  select private.assert_member(p_group);
  select * from private.lb(p_group, p_from, p_to, p_today)
$$;

-- create_group with visibility + description
drop function public.create_group(text, text, text);
create or replace function public.create_group(p_name text, p_emoji text default '🔥', p_color text default '#c6ff3d',
                                               p_visibility text default 'public', p_description text default null)
returns public.groups language plpgsql security definer set search_path = public, private as $$
declare v_group public.groups;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if (select count(*) from public.group_members where user_id = auth.uid()) >= 20 then
    raise exception 'You can be in at most 20 groups' using errcode = '22023';
  end if;
  insert into public.groups (name, emoji, color, invite_code, created_by, visibility, description)
  values (btrim(p_name), coalesce(nullif(p_emoji, ''), '🔥'), coalesce(p_color, '#c6ff3d'), private.new_invite_code(), auth.uid(),
          coalesce(p_visibility, 'public'), nullif(btrim(coalesce(p_description, '')), ''))
  returning * into v_group;
  insert into public.group_members (group_id, user_id, role) values (v_group.id, auth.uid(), 'admin');
  return v_group;
end $$;

-- Leaving: a sole admin must promote someone first (unless they're the last member, then the group is deleted).
create or replace function public.leave_group(p_group uuid)
returns void language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_member(p_group) then return; end if;
  if private.is_admin(p_group)
     and exists (select 1 from public.group_members where group_id = p_group and user_id <> auth.uid())
     and not exists (select 1 from public.group_members where group_id = p_group and role = 'admin' and user_id <> auth.uid()) then
    raise exception 'You''re the only admin — make someone else an admin before leaving' using errcode = '22023';
  end if;
  delete from public.group_members where group_id = p_group and user_id = auth.uid();
  if not exists (select 1 from public.group_members where group_id = p_group) then
    delete from public.groups where id = p_group;
  end if;
end $$;

-- Explore list: discoverable groups the caller is not in.
create or replace function public.explore_groups(p_today date default null)
returns table (id uuid, name text, emoji text, color text, description text, visibility text, created_at timestamptz,
               member_count int, avatars jsonb, month_km numeric, month_workouts int, month_points int,
               top3 jsonb, active_challenges int, sports text[], requested boolean)
language sql stable security definer set search_path = public, private as $$
  with g as (
    select g.* from public.groups g
    where auth.uid() is not null and g.visibility in ('public', 'request') and not private.is_member(g.id)
  ), td as (select coalesce(p_today, private.today_il()) as d)
  select g.id, g.name, g.emoji, g.color, g.description, g.visibility, g.created_at,
    (select count(*)::int from public.group_members m where m.group_id = g.id),
    (select coalesce(jsonb_agg(jsonb_build_object('emoji', x.avatar_emoji, 'color', x.avatar_color, 'name', x.display_name)), '[]')
       from (select p.* from public.group_members m join public.profiles p on p.id = m.user_id
             where m.group_id = g.id order by m.joined_at limit 6) x),
    coalesce(l.km, 0), coalesce(l.workouts, 0), coalesce(l.points, 0),
    coalesce(l.top3, '[]'),
    (select count(*)::int from public.challenges c, td where c.group_id = g.id and td.d between c.start_date and c.end_date),
    (select coalesce(array_agg(s.type order by s.n desc), '{}') from (
       select w.type, count(*) n from public.workouts w join public.group_members m on m.user_id = w.user_id and m.group_id = g.id, td
       where w.completed and w.date > td.d - 60 group by w.type order by 2 desc limit 2) s),
    exists (select 1 from public.group_join_requests r where r.group_id = g.id and r.user_id = auth.uid())
  from g cross join td
  left join lateral (
    select sum(b.km) km, sum(b.workouts)::int workouts, sum(b.points)::int points,
      (jsonb_agg(jsonb_build_object('name', b.display_name, 'emoji', b.avatar_emoji, 'color', b.avatar_color, 'points', b.points)
         order by b.rank, b.display_name) filter (where b.rank <= 3 and b.points > 0)) top3
    from private.lb(g.id, date_trunc('month', td.d)::date, td.d, td.d) b
  ) l on true
$$;

-- Read-only preview of one discoverable (or own) group.
create or replace function public.explore_group_detail(p_group uuid, p_today date default null)
returns jsonb language plpgsql stable security definer set search_path = public, private as $$
declare v_td date := coalesce(p_today, private.today_il()); v jsonb;
begin
  if auth.uid() is null or not (private.discoverable(p_group) or private.is_member(p_group)) then
    raise exception 'Group not found' using errcode = 'P0002';
  end if;
  select jsonb_build_object(
    'id', g.id, 'name', g.name, 'emoji', g.emoji, 'color', g.color, 'description', g.description,
    'visibility', g.visibility, 'created_at', g.created_at,
    'member_count', (select count(*) from public.group_members m where m.group_id = g.id),
    'is_member', private.is_member(g.id),
    'requested', exists (select 1 from public.group_join_requests r where r.group_id = g.id and r.user_id = auth.uid()),
    'top10', (select coalesce(jsonb_agg(jsonb_build_object('rank', b.rank, 'name', b.display_name, 'emoji', b.avatar_emoji,
                'color', b.avatar_color, 'points', b.points, 'workouts', b.workouts, 'km', b.km) order by b.rank, b.display_name), '[]')
              from private.lb(g.id, date_trunc('month', v_td)::date, v_td, v_td) b where b.rank <= 10),
    'challenges', (select coalesce(jsonb_agg(jsonb_build_object('title', c.title, 'description', c.description, 'metric', c.metric,
                'activity_type', c.activity_type, 'target', c.target, 'start_date', c.start_date, 'end_date', c.end_date,
                'reward', c.reward_points,
                'participants', (select count(*) from public.challenge_participants cp where cp.challenge_id = c.id)) order by c.end_date), '[]')
              from public.challenges c where c.group_id = g.id and v_td between c.start_date and c.end_date),
    'goals', (select coalesce(jsonb_agg(jsonb_build_object('title', gg.title, 'metric', gg.metric, 'activity_type', gg.activity_type,
                'target', gg.target, 'start_date', gg.start_date, 'end_date', gg.end_date,
                'progress', (select coalesce(sum(private.metric_value(gg.metric, w.distance_km, w.est_minutes, w.kcal)), 0)
                             from public.workouts w join public.group_members m on m.user_id = w.user_id and m.group_id = g.id
                             where w.completed and w.eligible and w.date between gg.start_date and gg.end_date
                               and (gg.activity_type is null or w.type = gg.activity_type))) order by gg.end_date), '[]')
              from public.group_goals gg where gg.group_id = g.id and v_td between gg.start_date and gg.end_date),
    'week', (select jsonb_build_object('workouts', count(*), 'km', round(coalesce(sum(w.distance_km), 0), 1),
                'minutes', round(coalesce(sum(w.est_minutes), 0)), 'active_members', count(distinct w.user_id))
             from public.workouts w join public.group_members m on m.user_id = w.user_id and m.group_id = g.id
             where w.completed and w.date between v_td - 6 and v_td),
    'recent', (select coalesce(jsonb_agg(r order by r.at desc), '[]') from (
                select p.display_name as name, p.avatar_emoji as emoji, p.avatar_color as color, w.type, w.date,
                  w.distance_km as km, round(w.est_minutes) as minutes, w.completed_at as at
                from public.workouts w join public.group_members m on m.user_id = w.user_id and m.group_id = g.id
                join public.profiles p on p.id = w.user_id
                where w.completed order by w.completed_at desc limit 8) r)
  ) into v from public.groups g where g.id = p_group;
  return v;
end $$;

-- Join from Explore: public → member now; request → pending request; private → not allowed.
create or replace function public.join_public_group(p_group uuid)
returns text language plpgsql security definer set search_path = public, private as $$
declare v_vis text;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select visibility into v_vis from public.groups where id = p_group;
  if v_vis is null or v_vis = 'private' then raise exception 'Group not found' using errcode = 'P0002'; end if;
  if private.is_member(p_group) then return 'member'; end if;
  if (select count(*) from public.group_members where user_id = auth.uid()) >= 20 then
    raise exception 'You can be in at most 20 groups' using errcode = '22023';
  end if;
  if (select count(*) from public.group_members where group_id = p_group) >= 100 then
    raise exception 'This group is full' using errcode = '22023';
  end if;
  if v_vis = 'request' then
    insert into public.group_join_requests (group_id, user_id) values (p_group, auth.uid()) on conflict do nothing;
    return 'requested';
  end if;
  insert into public.group_members (group_id, user_id) values (p_group, auth.uid()) on conflict do nothing;
  return 'joined';
end $$;

create or replace function public.cancel_join_request(p_group uuid)
returns void language sql security definer set search_path = public as $$
  delete from public.group_join_requests where group_id = p_group and user_id = auth.uid()
$$;

create or replace function public.list_join_requests(p_group uuid)
returns table (user_id uuid, display_name text, avatar_emoji text, avatar_color text, created_at timestamptz)
language plpgsql stable security definer set search_path = public, private as $$
begin
  if not private.is_admin(p_group) then raise exception 'Only group admins can see requests' using errcode = '42501'; end if;
  return query select r.user_id, p.display_name, p.avatar_emoji, p.avatar_color, r.created_at
    from public.group_join_requests r join public.profiles p on p.id = r.user_id
    where r.group_id = p_group order by r.created_at;
end $$;

create or replace function public.respond_join_request(p_group uuid, p_user uuid, p_approve boolean)
returns void language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_admin(p_group) then raise exception 'Only group admins can respond to requests' using errcode = '42501'; end if;
  delete from public.group_join_requests where group_id = p_group and user_id = p_user;
  if not found then raise exception 'Request not found' using errcode = 'P0002'; end if;
  if p_approve then
    insert into public.group_members (group_id, user_id) values (p_group, p_user) on conflict do nothing;
  end if;
end $$;

-- a request is moot once you're a member (e.g. joined via invite code)
create or replace function private.clear_request_on_join()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.group_join_requests where group_id = new.group_id and user_id = new.user_id;
  return new;
end $$;
create trigger group_members_clear_request after insert on public.group_members
  for each row execute function private.clear_request_on_join();

revoke execute on function public.explore_groups(date), public.explore_group_detail(uuid, date), public.join_public_group(uuid),
  public.cancel_join_request(uuid), public.list_join_requests(uuid), public.respond_join_request(uuid, uuid, boolean),
  public.create_group(text, text, text, text, text) from public, anon;
grant execute on function public.explore_groups(date), public.explore_group_detail(uuid, date), public.join_public_group(uuid),
  public.cancel_join_request(uuid), public.list_join_requests(uuid), public.respond_join_request(uuid, uuid, boolean),
  public.create_group(text, text, text, text, text) to authenticated;
