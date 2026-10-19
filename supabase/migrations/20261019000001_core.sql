-- Momentum: core schema (profiles + workouts)
-- Calorie/points constants mirror js/calc.js — keep them in sync.

create schema if not exists private;
grant usage on schema private to authenticated, anon;

-- ---------- constants ----------
create or replace function private.met(p_type text, p_intensity text)
returns numeric language sql immutable as $$
  select case p_type
    when 'running' then case p_intensity when 'light' then 8.3 when 'vigorous' then 11.8 else 9.8 end
    when 'workout' then case p_intensity when 'light' then 3.5 when 'vigorous' then 6.0 else 5.0 end
    when 'walking' then case p_intensity when 'light' then 3.0 when 'vigorous' then 5.0 else 3.5 end
    when 'cycling' then case p_intensity when 'light' then 6.8 when 'vigorous' then 10.0 else 8.0 end
  end
$$;

create or replace function private.pace_kmh(p_type text, p_intensity text)
returns numeric language sql immutable as $$
  select case p_type
    when 'running' then case p_intensity when 'light' then 8 when 'vigorous' then 12 else 10 end
    when 'walking' then case p_intensity when 'light' then 4 when 'vigorous' then 6.4 else 5 end
    when 'cycling' then case p_intensity when 'light' then 17 when 'vigorous' then 24 else 20 end
    else null
  end
$$;

-- max plausible average speed (anti-abuse) when both distance and time are given
create or replace function private.max_kmh(p_type text)
returns numeric language sql immutable as $$
  select case p_type when 'running' then 25 when 'walking' then 10 when 'cycling' then 70 else null end
$$;

-- ---------- profiles ----------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 40),
  avatar_emoji text not null default '🏃' check (char_length(avatar_emoji) between 1 and 8),
  avatar_color text not null default '#c6ff3d' check (avatar_color ~ '^#[0-9a-fA-F]{6}$'),
  weight_kg numeric(5,1) not null default 70 check (weight_kg between 25 and 300),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

create or replace function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_name text := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), '');
  v_colors text[] := array['#c6ff3d','#22d3ee','#ff6b3d','#a78bfa','#34d399','#38bdf8','#f472b6','#facc15'];
begin
  insert into public.profiles (id, display_name, avatar_emoji, avatar_color)
  values (
    new.id,
    left(coalesce(v_name, split_part(new.email, '@', 1), 'Athlete'), 40),
    coalesce(nullif(new.raw_user_meta_data ->> 'avatar_emoji', ''), '🏃'),
    v_colors[1 + floor(random() * array_length(v_colors, 1))::int]
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------- workouts ----------
create table public.workouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  type text not null check (type in ('running', 'workout', 'walking', 'cycling')),
  date date not null check (date between '2000-01-01' and '2100-01-01'),
  time time not null default '07:00',
  tz text not null default 'Asia/Jerusalem',
  starts_at timestamptz not null,
  measure text not null check (measure in ('distance', 'duration')),
  distance_km numeric(6,2) check (distance_km is null or (distance_km > 0 and distance_km <= 500)),
  duration_min numeric(6,1) check (duration_min is null or (duration_min > 0 and duration_min <= 1440)),
  intensity text not null default 'moderate' check (intensity in ('light', 'moderate', 'vigorous')),
  notes text check (notes is null or char_length(notes) <= 300),
  completed boolean not null default false,
  completed_at timestamptz,
  est_minutes numeric(7,1) not null default 0,
  kcal integer not null default 0,
  effort_points integer not null default 0,
  eligible boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index workouts_user_date_idx on public.workouts (user_id, date);
create index workouts_completed_idx on public.workouts (user_id, date) where completed;
alter table public.workouts enable row level security;

-- Computes derived fields and enforces the anti-abuse rules. Clients cannot set
-- starts_at, completed_at, kcal, effort_points or eligible themselves.
create or replace function private.workouts_before_write()
returns trigger language plpgsql security definer set search_path = public, private as $$
declare
  v_weight numeric;
  v_met numeric;
  v_pace numeric;
begin
  if tg_op = 'UPDATE' then
    new.user_id := old.user_id;
    new.created_at := old.created_at;
  end if;

  -- validate time zone (raises on unknown zone)
  perform now() at time zone new.tz;
  new.starts_at := (new.date + new.time) at time zone new.tz;

  if new.type = 'workout' then
    new.measure := 'duration';
    new.distance_km := null;
  end if;
  if new.measure = 'distance' and new.distance_km is null then
    raise exception 'Distance is required for a distance-based workout' using errcode = '22023';
  end if;
  if new.measure = 'duration' and new.duration_min is null then
    raise exception 'Duration is required for a time-based workout' using errcode = '22023';
  end if;
  if new.distance_km is not null and new.duration_min is not null
     and new.distance_km / (new.duration_min / 60.0) > private.max_kmh(new.type) then
    raise exception 'That speed is not realistic for %', new.type using errcode = '22023';
  end if;

  v_met := private.met(new.type, new.intensity);
  v_pace := private.pace_kmh(new.type, new.intensity);
  new.est_minutes := round(coalesce(new.duration_min, new.distance_km / v_pace * 60), 1);

  select weight_kg into v_weight from public.profiles where id = new.user_id;
  new.kcal := round(v_met * coalesce(v_weight, 70) * new.est_minutes / 60.0);
  new.effort_points := least(60, round(v_met * new.est_minutes / 20.0));

  if new.completed then
    if tg_op = 'INSERT' or not old.completed then
      new.completed_at := now();
    else
      new.completed_at := old.completed_at;
    end if;
    if new.starts_at > new.completed_at + interval '30 minutes' then
      raise exception 'You can''t complete a workout scheduled in the future' using errcode = '22023';
    end if;
    new.eligible := new.completed_at <= new.starts_at + interval '7 days';
  else
    new.completed_at := null;
    new.eligible := false;
  end if;

  new.updated_at := now();
  return new;
end $$;

create trigger workouts_before_write
  before insert or update on public.workouts
  for each row execute function private.workouts_before_write();

create policy "own workouts: select" on public.workouts for select to authenticated using (user_id = auth.uid());
create policy "own workouts: insert" on public.workouts for insert to authenticated with check (user_id = auth.uid());
create policy "own workouts: update" on public.workouts for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own workouts: delete" on public.workouts for delete to authenticated using (user_id = auth.uid());

revoke all on public.workouts from anon;
revoke all on public.profiles from anon;
