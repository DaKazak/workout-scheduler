-- Momentum: groups, goals, challenges, cheers + RLS

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 50),
  emoji text not null default '🔥' check (char_length(emoji) between 1 and 8),
  color text not null default '#c6ff3d' check (color ~ '^#[0-9a-fA-F]{6}$'),
  invite_code text not null unique,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.group_members (
  group_id uuid not null references public.groups (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null default 'member' check (role in ('admin', 'member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index group_members_user_idx on public.group_members (user_id);

create table public.group_daily_goals (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  label text not null check (char_length(btrim(label)) between 1 and 60),
  metric text not null check (metric in ('distance', 'minutes', 'kcal', 'workouts')),
  activity_type text check (activity_type in ('running', 'workout', 'walking', 'cycling')),
  target numeric(8,1) not null check (target > 0 and target <= 100000),
  position int not null default 0,
  created_at timestamptz not null default now()
);

create table public.group_goals (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 80),
  metric text not null check (metric in ('distance', 'minutes', 'kcal', 'workouts')),
  activity_type text check (activity_type in ('running', 'workout', 'walking', 'cycling')),
  target numeric(10,1) not null check (target > 0 and target <= 10000000),
  start_date date not null,
  end_date date not null,
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  check (end_date >= start_date and end_date - start_date <= 366)
);

create table public.challenges (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 80),
  description text check (description is null or char_length(description) <= 300),
  metric text not null check (metric in ('distance', 'minutes', 'kcal', 'workouts')),
  activity_type text check (activity_type in ('running', 'workout', 'walking', 'cycling')),
  target numeric(10,1) not null check (target > 0 and target <= 1000000),
  start_date date not null,
  end_date date not null,
  reward_points int not null default 50 check (reward_points between 0 and 200),
  created_by uuid default auth.uid() references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  check (end_date >= start_date and end_date - start_date <= 120)
);

create table public.challenge_participants (
  challenge_id uuid not null references public.challenges (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (challenge_id, user_id)
);

create table public.cheers (
  workout_id uuid not null references public.workouts (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  emoji text not null default '👏' check (emoji in ('👏', '🔥', '💪', '🙌', '⚡')),
  created_at timestamptz not null default now(),
  primary key (workout_id, user_id)
);

-- ---------- helpers (security definer to avoid RLS recursion) ----------
create or replace function private.is_member(p_group uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.group_members where group_id = p_group and user_id = auth.uid())
$$;

create or replace function private.is_admin(p_group uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.group_members where group_id = p_group and user_id = auth.uid() and role = 'admin')
$$;

create or replace function private.shares_group(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select p_user = auth.uid() or exists (
    select 1 from public.group_members a join public.group_members b on a.group_id = b.group_id
    where a.user_id = auth.uid() and b.user_id = p_user)
$$;

create or replace function private.workout_owner(p_workout uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select user_id from public.workouts where id = p_workout
$$;

create or replace function private.challenge_group(p_challenge uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select group_id from public.challenges where id = p_challenge
$$;

create or replace function private.assert_member(p_group uuid)
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not private.is_member(p_group) then
    raise exception 'Not a member of this group' using errcode = '42501';
  end if;
end $$;

create or replace function private.new_invite_code()
returns text language plpgsql volatile as $$
declare
  v_alpha text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text;
begin
  loop
    v_code := '';
    for i in 1..8 loop
      v_code := v_code || substr(v_alpha, 1 + floor(random() * length(v_alpha))::int, 1);
    end loop;
    exit when not exists (select 1 from public.groups where invite_code = v_code);
  end loop;
  return v_code;
end $$;

grant execute on all functions in schema private to authenticated;

-- ---------- RLS ----------
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.group_daily_goals enable row level security;
alter table public.group_goals enable row level security;
alter table public.challenges enable row level security;
alter table public.challenge_participants enable row level security;
alter table public.cheers enable row level security;

revoke all on public.groups, public.group_members, public.group_daily_goals, public.group_goals,
  public.challenges, public.challenge_participants, public.cheers from anon;

-- profiles: see yourself and people you share a group with; edit only yourself (selected columns)
create policy "profiles: select self or groupmates" on public.profiles for select to authenticated
  using (private.shares_group(id));
create policy "profiles: update self" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
revoke insert, update, delete on public.profiles from authenticated;
grant update (display_name, avatar_emoji, avatar_color, weight_kg) on public.profiles to authenticated;

-- groups: members read; admins rename / restyle / delete; creation + invites via RPC
create policy "groups: members read" on public.groups for select to authenticated using (private.is_member(id));
create policy "groups: admins update" on public.groups for update to authenticated
  using (private.is_admin(id)) with check (private.is_admin(id));
create policy "groups: admins delete" on public.groups for delete to authenticated using (private.is_admin(id));
revoke insert, update on public.groups from authenticated;
grant update (name, emoji, color) on public.groups to authenticated;

-- memberships: members see the roster; all changes go through RPCs
create policy "members: read roster" on public.group_members for select to authenticated using (private.is_member(group_id));
revoke insert, update, delete on public.group_members from authenticated;

-- daily goals / group goals / challenges: members read, admins write
create policy "daily goals: read" on public.group_daily_goals for select to authenticated using (private.is_member(group_id));
create policy "daily goals: admin insert" on public.group_daily_goals for insert to authenticated with check (private.is_admin(group_id));
create policy "daily goals: admin update" on public.group_daily_goals for update to authenticated using (private.is_admin(group_id)) with check (private.is_admin(group_id));
create policy "daily goals: admin delete" on public.group_daily_goals for delete to authenticated using (private.is_admin(group_id));

create policy "group goals: read" on public.group_goals for select to authenticated using (private.is_member(group_id));
create policy "group goals: admin insert" on public.group_goals for insert to authenticated with check (private.is_admin(group_id));
create policy "group goals: admin update" on public.group_goals for update to authenticated using (private.is_admin(group_id)) with check (private.is_admin(group_id));
create policy "group goals: admin delete" on public.group_goals for delete to authenticated using (private.is_admin(group_id));

create policy "challenges: read" on public.challenges for select to authenticated using (private.is_member(group_id));
create policy "challenges: admin insert" on public.challenges for insert to authenticated with check (private.is_admin(group_id));
create policy "challenges: admin update" on public.challenges for update to authenticated using (private.is_admin(group_id)) with check (private.is_admin(group_id));
create policy "challenges: admin delete" on public.challenges for delete to authenticated using (private.is_admin(group_id));

create policy "participants: read" on public.challenge_participants for select to authenticated
  using (private.is_member(private.challenge_group(challenge_id)));
create policy "participants: join self" on public.challenge_participants for insert to authenticated
  with check (user_id = auth.uid() and private.is_member(private.challenge_group(challenge_id))
    and exists (select 1 from public.challenges c where c.id = challenge_id
                and c.end_date >= (now() at time zone 'Asia/Jerusalem')::date - 1));
create policy "participants: leave self" on public.challenge_participants for delete to authenticated
  using (user_id = auth.uid());
revoke update on public.challenge_participants from authenticated;

-- cheers: give to groupmates' completed workouts (not your own); see cheers you gave or received
create policy "cheers: read" on public.cheers for select to authenticated
  using (user_id = auth.uid() or private.workout_owner(workout_id) = auth.uid());
create policy "cheers: give" on public.cheers for insert to authenticated
  with check (user_id = auth.uid()
    and private.workout_owner(workout_id) <> auth.uid()
    and private.shares_group(private.workout_owner(workout_id)));
create policy "cheers: take back" on public.cheers for delete to authenticated using (user_id = auth.uid());
revoke update on public.cheers from authenticated;

-- limit daily goals per group
create or replace function private.daily_goals_limit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.group_daily_goals where group_id = new.group_id) >= 6 then
    raise exception 'A group can have at most 6 daily goals' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger daily_goals_limit before insert on public.group_daily_goals
  for each row execute function private.daily_goals_limit();

-- ---------- group RPCs ----------
create or replace function public.create_group(p_name text, p_emoji text default '🔥', p_color text default '#c6ff3d')
returns public.groups language plpgsql security definer set search_path = public, private as $$
declare v_group public.groups;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  if (select count(*) from public.group_members where user_id = auth.uid()) >= 20 then
    raise exception 'You can be in at most 20 groups' using errcode = '22023';
  end if;
  insert into public.groups (name, emoji, color, invite_code, created_by)
  values (btrim(p_name), coalesce(nullif(p_emoji, ''), '🔥'), coalesce(p_color, '#c6ff3d'), private.new_invite_code(), auth.uid())
  returning * into v_group;
  insert into public.group_members (group_id, user_id, role) values (v_group.id, auth.uid(), 'admin');
  return v_group;
end $$;

create or replace function public.group_preview(p_code text)
returns table (id uuid, name text, emoji text, color text, member_count int, already_member boolean)
language sql stable security definer set search_path = public, private as $$
  select g.id, g.name, g.emoji, g.color,
    (select count(*)::int from public.group_members m where m.group_id = g.id),
    private.is_member(g.id)
  from public.groups g
  where auth.uid() is not null and g.invite_code = upper(btrim(p_code))
$$;

create or replace function public.join_group(p_code text)
returns uuid language plpgsql security definer set search_path = public, private as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  select id into v_id from public.groups where invite_code = upper(btrim(p_code));
  if v_id is null then raise exception 'Invite code not found' using errcode = 'P0002'; end if;
  if (select count(*) from public.group_members where group_id = v_id) >= 100 then
    raise exception 'This group is full' using errcode = '22023';
  end if;
  insert into public.group_members (group_id, user_id) values (v_id, auth.uid()) on conflict do nothing;
  return v_id;
end $$;

create or replace function public.leave_group(p_group uuid)
returns void language plpgsql security definer set search_path = public, private as $$
begin
  delete from public.group_members where group_id = p_group and user_id = auth.uid();
  if not exists (select 1 from public.group_members where group_id = p_group) then
    delete from public.groups where id = p_group;
  elsif not exists (select 1 from public.group_members where group_id = p_group and role = 'admin') then
    update public.group_members set role = 'admin'
    where group_id = p_group and user_id = (
      select user_id from public.group_members where group_id = p_group order by joined_at limit 1);
  end if;
end $$;

create or replace function public.remove_member(p_group uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_admin(p_group) then raise exception 'Only group admins can remove members' using errcode = '42501'; end if;
  if p_user = auth.uid() then raise exception 'Use "leave group" to remove yourself' using errcode = '22023'; end if;
  delete from public.group_members where group_id = p_group and user_id = p_user;
end $$;

create or replace function public.set_member_role(p_group uuid, p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public, private as $$
begin
  if not private.is_admin(p_group) then raise exception 'Only group admins can change roles' using errcode = '42501'; end if;
  if p_role not in ('admin', 'member') then raise exception 'Bad role' using errcode = '22023'; end if;
  if p_role = 'member' and (select count(*) from public.group_members where group_id = p_group and role = 'admin' and user_id <> p_user) = 0 then
    raise exception 'A group needs at least one admin' using errcode = '22023';
  end if;
  update public.group_members set role = p_role where group_id = p_group and user_id = p_user;
end $$;

create or replace function public.regenerate_invite(p_group uuid)
returns text language plpgsql security definer set search_path = public, private as $$
declare v_code text;
begin
  if not private.is_admin(p_group) then raise exception 'Only group admins can reset the invite' using errcode = '42501'; end if;
  v_code := private.new_invite_code();
  update public.groups set invite_code = v_code where id = p_group;
  return v_code;
end $$;

revoke execute on function public.create_group(text, text, text), public.group_preview(text), public.join_group(text),
  public.leave_group(uuid), public.remove_member(uuid, uuid), public.set_member_role(uuid, uuid, text),
  public.regenerate_invite(uuid) from anon, public;
grant execute on function public.create_group(text, text, text), public.group_preview(text), public.join_group(text),
  public.leave_group(uuid), public.remove_member(uuid, uuid), public.set_member_role(uuid, uuid, text),
  public.regenerate_invite(uuid) to authenticated;
