-- Momentum: points, leaderboards, hall of fame, feed, goal & challenge progress.
-- All scoring is computed on the fly from workouts (no cron needed).
--
-- POINTS (documented in the app's "How points work" panel):
--   * Completed workout: +10 (first 3 eligible workouts per day)
--   * Effort: MET x minutes / 20, max 60 per workout (≈ 15 for a 30-min run, 10 for a 1-h walk)
--   * Daily cap on workout + effort points: 100
--   * Daily goals: +5 per goal hit, +10 more if all of the group's daily goals are hit
--   * Streak: +5 for each active day that is the 3rd+ consecutive active day
--   * Challenges: reward points (0-200, set by admins) on the day you reach the target
--   * Eligible = completed no later than 7 days after its scheduled time; future workouts can't be completed.

create or replace function private.metric_value(p_metric text, p_distance numeric, p_minutes numeric, p_kcal int)
returns numeric language sql immutable as $$
  select case p_metric
    when 'distance' then coalesce(p_distance, 0)
    when 'minutes' then coalesce(p_minutes, 0)
    when 'kcal' then coalesce(p_kcal, 0)
    else 1 end::numeric
$$;

create or replace function private.effective_goals(p_group uuid)
returns table (id text, label text, metric text, activity_type text, target numeric, "position" int)
language sql stable security definer set search_path = public as $$
  select g.id::text, g.label, g.metric, g.activity_type, g.target::numeric, g.position
  from public.group_daily_goals g where g.group_id = p_group
  union all
  select v.* from (values
    ('default-distance', 'Cover 5 km', 'distance', null::text, 5::numeric, 1),
    ('default-minutes', '30 active minutes', 'minutes', null::text, 30::numeric, 2),
    ('default-kcal', 'Burn 300 kcal', 'kcal', null::text, 300::numeric, 3)
  ) v(id, label, metric, activity_type, target, "position")
  where p_group is null or not exists (select 1 from public.group_daily_goals g2 where g2.group_id = p_group)
$$;

create or replace function private.day_scores(p_group uuid)
returns table (user_id uuid, day date, workouts int, km numeric, minutes numeric, kcal int,
               workout_pts int, streak_pts int, goal_pts int)
language sql stable security definer set search_path = public, private as $$
  with w as (
    select w.*, row_number() over (partition by w.user_id, w.date, w.eligible order by w.starts_at, w.id) as rn
    from public.workouts w
    join public.group_members m on m.user_id = w.user_id and m.group_id = p_group
    where w.completed
  ),
  goals as (select * from private.effective_goals(p_group)),
  goal_count as (select count(*)::int as c from goals),
  days as (
    select w.user_id, w.date as day, count(*)::int as workouts, coalesce(sum(w.distance_km), 0)::numeric as km,
      sum(w.est_minutes)::numeric as minutes, sum(w.kcal)::int as kcal,
      least(100, coalesce(sum(case when w.eligible then (case when w.rn <= 3 then 10 else 0 end) + w.effort_points end), 0))::int as workout_pts,
      bool_or(w.eligible) as active
    from w group by w.user_id, w.date
  ),
  streaks as (
    select d.user_id, d.day,
      case when lag(d.day, 2) over (partition by d.user_id order by d.day) = d.day - 2 then 5 else 0 end as pts
    from days d where d.active
  ),
  gv as (
    select w.user_id, w.date as day, g.id as goal_id, g.target,
      sum(private.metric_value(g.metric, w.distance_km, w.est_minutes, w.kcal)) as val
    from w join goals g on g.activity_type is null or g.activity_type = w.type
    where w.eligible
    group by w.user_id, w.date, g.id, g.target
  ),
  gh as (select gv.user_id, gv.day, (count(*) filter (where gv.val >= gv.target))::int as hits from gv group by gv.user_id, gv.day)
  select d.user_id, d.day, d.workouts, d.km, d.minutes, d.kcal, d.workout_pts,
    coalesce(s.pts, 0)::int,
    coalesce(gh.hits * 5 + case when gh.hits = gc.c and gc.c > 0 then 10 else 0 end, 0)::int
  from days d
  cross join goal_count gc
  left join streaks s on s.user_id = d.user_id and s.day = d.day
  left join gh on gh.user_id = d.user_id and gh.day = d.day
$$;

create or replace function private.challenge_progress(p_group uuid)
returns table (challenge_id uuid, user_id uuid, progress numeric, finished_on date, reward int)
language sql stable security definer set search_path = public, private as $$
  with p as (
    select c.id as cid, c.target, c.reward_points, c.metric, c.activity_type, c.start_date, c.end_date, cp.user_id
    from public.challenges c
    join public.challenge_participants cp on cp.challenge_id = c.id
    join public.group_members gm on gm.group_id = c.group_id and gm.user_id = cp.user_id
    where c.group_id = p_group
  ),
  w as (
    select p.cid, p.user_id, w.date, w.starts_at, w.id as wid,
      private.metric_value(p.metric, w.distance_km, w.est_minutes, w.kcal) as val
    from p join public.workouts w on w.user_id = p.user_id and w.completed and w.eligible
      and w.date between p.start_date and p.end_date
      and (p.activity_type is null or w.type = p.activity_type)
  ),
  cum as (select w.*, sum(w.val) over (partition by w.cid, w.user_id order by w.date, w.starts_at, w.wid) as total from w)
  select p.cid, p.user_id,
    coalesce((select sum(w.val) from w where w.cid = p.cid and w.user_id = p.user_id), 0)::numeric,
    (select min(cum.date) from cum where cum.cid = p.cid and cum.user_id = p.user_id and cum.total >= p.target),
    p.reward_points
  from p
$$;

create or replace function private.current_streaks(p_group uuid, p_today date)
returns table (user_id uuid, streak int)
language sql stable security definer set search_path = public, private as $$
  with d as (
    select distinct w.user_id, w.date
    from public.workouts w join public.group_members m on m.user_id = w.user_id and m.group_id = p_group
    where w.completed and w.eligible and w.date <= p_today
  ),
  isl as (select d.user_id, d.date, d.date - (row_number() over (partition by d.user_id order by d.date))::int as grp from d),
  agg as (select isl.user_id, isl.grp, max(isl.date) as last_day, count(*)::int as len from isl group by isl.user_id, isl.grp)
  select a.user_id, a.len from agg a
  where a.last_day >= p_today - 1
    and a.last_day = (select max(b.last_day) from agg b where b.user_id = a.user_id)
$$;

create or replace function private.today_il()
returns date language sql stable as $$ select (now() at time zone 'Asia/Jerusalem')::date $$;

-- ---------- public RPCs ----------
create or replace function public.leaderboard(p_group uuid, p_from date default null, p_to date default null, p_today date default null)
returns table (user_id uuid, display_name text, avatar_emoji text, avatar_color text, role text, rank int,
               points int, workouts int, km numeric, minutes int, kcal int,
               workout_points int, goal_points int, streak_points int, challenge_points int, current_streak int)
language sql stable security definer set search_path = public, private as $$
  select private.assert_member(p_group);
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

create or replace function public.monthly_winners(p_group uuid, p_today date default null)
returns table (month date, rank int, user_id uuid, display_name text, avatar_emoji text, avatar_color text,
               points int, workouts int, km numeric)
language sql stable security definer set search_path = public, private as $$
  select private.assert_member(p_group);
  select mo.m::date, l.rank, l.user_id, l.display_name, l.avatar_emoji, l.avatar_color, l.points, l.workouts, l.km
  from generate_series(
         date_trunc('month', coalesce(p_today, private.today_il()) - interval '12 months'),
         date_trunc('month', coalesce(p_today, private.today_il())) - interval '1 month',
         interval '1 month') as mo(m)
  cross join lateral public.leaderboard(p_group, mo.m::date, (mo.m + interval '1 month' - interval '1 day')::date,
                                        (mo.m + interval '1 month' - interval '1 day')::date) l
  where l.rank <= 3 and l.points > 0
  order by 1 desc, 2
$$;

create or replace function public.group_feed(p_group uuid, p_limit int default 30)
returns table (workout_id uuid, user_id uuid, display_name text, avatar_emoji text, avatar_color text,
               type text, date date, "time" time, measure text, distance_km numeric, duration_min numeric,
               est_minutes numeric, intensity text, kcal int, points int, completed_at timestamptz,
               cheer_count int, my_cheer text, cheerers jsonb)
language sql stable security definer set search_path = public, private as $$
  select private.assert_member(p_group);
  select w.id, w.user_id, p.display_name, p.avatar_emoji, p.avatar_color,
    w.type, w.date, w.time, w.measure, w.distance_km, w.duration_min, w.est_minutes, w.intensity, w.kcal,
    case when w.eligible then 10 + w.effort_points else 0 end,
    w.completed_at,
    (select count(*)::int from public.cheers c where c.workout_id = w.id),
    (select c.emoji from public.cheers c where c.workout_id = w.id and c.user_id = auth.uid()),
    coalesce((select jsonb_agg(jsonb_build_object('name', pp.display_name, 'emoji', c.emoji) order by c.created_at)
              from public.cheers c join public.profiles pp on pp.id = c.user_id where c.workout_id = w.id), '[]'::jsonb)
  from public.workouts w
  join public.group_members m on m.user_id = w.user_id and m.group_id = p_group
  join public.profiles p on p.id = w.user_id
  where w.completed
  order by w.completed_at desc
  limit least(greatest(coalesce(p_limit, 30), 1), 100)
$$;

create or replace function public.daily_progress(p_group uuid, p_day date)
returns table (user_id uuid, display_name text, avatar_emoji text, avatar_color text,
               goal_id text, label text, metric text, activity_type text, target numeric, value numeric)
language sql stable security definer set search_path = public, private as $$
  select private.assert_member(p_group);
  select m.user_id, p.display_name, p.avatar_emoji, p.avatar_color, g.id, g.label, g.metric, g.activity_type, g.target,
    coalesce((select sum(private.metric_value(g.metric, w.distance_km, w.est_minutes, w.kcal))
              from public.workouts w
              where w.user_id = m.user_id and w.completed and w.eligible and w.date = p_day
                and (g.activity_type is null or w.type = g.activity_type)), 0)::numeric
  from public.group_members m
  join public.profiles p on p.id = m.user_id
  cross join private.effective_goals(p_group) g
  where m.group_id = p_group
  order by g.position, p.display_name
$$;

create or replace function public.group_goal_progress(p_group uuid)
returns table (goal_id uuid, user_id uuid, display_name text, avatar_emoji text, avatar_color text, value numeric)
language sql stable security definer set search_path = public, private as $$
  select private.assert_member(p_group);
  select g.id, m.user_id, p.display_name, p.avatar_emoji, p.avatar_color,
    coalesce((select sum(private.metric_value(g.metric, w.distance_km, w.est_minutes, w.kcal))
              from public.workouts w
              where w.user_id = m.user_id and w.completed and w.eligible
                and w.date between g.start_date and g.end_date
                and (g.activity_type is null or w.type = g.activity_type)), 0)::numeric
  from public.group_goals g
  join public.group_members m on m.group_id = g.group_id
  join public.profiles p on p.id = m.user_id
  where g.group_id = p_group
$$;

create or replace function public.challenge_standings(p_group uuid)
returns table (challenge_id uuid, user_id uuid, display_name text, avatar_emoji text, avatar_color text,
               progress numeric, finished_on date)
language sql stable security definer set search_path = public, private as $$
  select private.assert_member(p_group);
  select cp.challenge_id, cp.user_id, p.display_name, p.avatar_emoji, p.avatar_color, cp.progress, cp.finished_on
  from private.challenge_progress(p_group) cp join public.profiles p on p.id = cp.user_id
  order by cp.finished_on nulls last, cp.progress desc
$$;

-- default daily goals for users without a group (read-only)
create or replace function public.default_daily_goals()
returns table (id text, label text, metric text, activity_type text, target numeric, "position" int)
language sql stable security definer set search_path = public, private as $$
  select * from private.effective_goals(null)
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.leaderboard(uuid, date, date, date)', 'public.monthly_winners(uuid, date)',
    'public.group_feed(uuid, int)', 'public.daily_progress(uuid, date)',
    'public.group_goal_progress(uuid)', 'public.challenge_standings(uuid)', 'public.default_daily_goals()']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;

-- private helpers must never be reachable by API roles except those used in RLS policies
revoke execute on function private.day_scores(uuid), private.challenge_progress(uuid),
  private.current_streaks(uuid, date) from public, anon, authenticated;
