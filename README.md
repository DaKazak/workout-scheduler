# Momentum — Workout Scheduler

Plan runs, gym sessions, walks and rides — alone or with friends. Static frontend (plain HTML/CSS/JS, no build step) on GitHub Pages, with a Supabase backend (Auth + Postgres + Row Level Security). supabase-js is loaded from a CDN.

Live: https://dakazak.github.io/workout-scheduler/

## Features
- **Accounts:** email + password sign-up/sign-in, password reset, profile (display name, avatar emoji and colour, body weight).
- **Planner:** Running / Workout / Walking / Cycling. Measure by km or minutes, with an optional second value (time or distance) for pace records. Schedule, edit, complete, delete with undo, or log a past workout as already done. Live calorie and points estimate.
- **Groups:** create a group (name, emoji, colour), invite with a code or `?join=CODE` link, belong to several groups, switch between them. Admins can rename the group, reset the invite, promote/demote/remove members, set daily goals, create group goals and challenges, and delete the group.
- **Points and leaderboard:** per group for the week, month or all time (rank, points, workouts, km, minutes, kcal, streak), with a points breakdown per member.
- **Monthly winner:** a hall of fame and trophy banner with last month's top 3 and confetti the first time you see it. Computed from the data, so no cron job is needed.
- **Daily goals:** set by the group (defaults: 5 km, 30 minutes, 300 kcal). Progress rings for you and a summary for the group.
- **Group goals:** shared targets with a stacked progress bar showing each member's contribution.
- **Challenges:** created by admins (title, activity, target, dates, reward 0–200 pts). Members join, see their progress, and the standings list who finished.
- **Activity feed:** friends' completed workouts, which you can cheer 👏🔥💪 (notes stay private).
- **Me:** weekly summary compared with last week, streaks, 16 badges, personal records (longest run/ride/walk/session, fastest pace, biggest week, most kcal in a day, best streak).
- **Import:** one click brings v1 local (this-device) workouts into your account after you sign in.
- **No account needed:** "use without an account" keeps the original local-only planner.

## Points (also shown in-app under "How points work")
| Rule | Points |
|---|---|
| Completed workout (first 3 per day) | +10 |
| Effort = MET × minutes ÷ 20, max 60 per workout | ≈15 for a 30-min run |
| Daily cap on workout + effort points | 100 |
| Each daily goal hit / all goals hit | +5 / +10 bonus |
| Active day that is the 3rd or later day in a row | +5 |
| Finishing a challenge | its reward (0–200) |

Anti-abuse rules are enforced in Postgres triggers:
- You can't complete a workout before its scheduled time (30-minute grace).
- A workout marked done more than 7 days after its date earns no points.
- Unrealistic speeds are rejected.
- Clients can't set calories, points, or completion time themselves.

## Project layout
```
index.html, css/            UI (style.css = v1 theme, social.css = v2 components)
js/config.js                Supabase URL + publishable (anon) key — public by design
js/calc.js                  MET/kcal/points/streak logic (mirrors the SQL)
js/achievements.js          badges, records, weekly summary
js/i18n.js                  all UI strings (ready for a Hebrew/RTL table)
js/main.js                  app (ES module)
supabase/migrations/*.sql   schema, RLS, RPCs (leaderboard, feed, hall of fame…)
```

## Backend setup (already done for the live site)
1. Create a Supabase project.
2. Run the files in `supabase/migrations/` in order, using `supabase db push` or the SQL editor.
3. Under Auth settings, set the Site URL to the Pages URL and add it to the redirect allow-list. Optionally turn off "Confirm email".
4. Put the project URL and publishable key into `js/config.js`.

## Calorie assumptions
MET values approximate the Compendium of Physical Activities. When only a distance is entered, it is converted to time using the default pace for the chosen intensity:

| Activity | Light | Moderate | Vigorous |
|---|---|---|---|
| Running | 7:30 /km (MET 8.3) | 6:00 /km (MET 9.8) | 5:00 /km (MET 11.8) |
| Walking | 15:00 /km (MET 3.0) | 12:00 /km (MET 3.5) | ~9:20 /km (MET 5.0) |
| Cycling | 17 km/h (MET 6.8) | 20 km/h (MET 8.0) | 24 km/h (MET 10.0) |
| Gym workout (time only) | MET 3.5 | MET 5.0 | MET 6.0 |

## Photo credits (Wikimedia Commons, cropped & compressed)
- Running: [Julien Chorier, ultra traileur](https://commons.wikimedia.org/wiki/File:Julien_Chorier,_ultra_traileur.jpg) — Peignée Verticale / Damien Rosso, CC BY 4.0
- Workout: [Man lifting dumbbell weight in fitness gym](https://commons.wikimedia.org/wiki/File:Attractive_man_lifting_dumbbell_weight_for_exercise_in_fitness_gym.jpg) — Nenad Stojkovic, CC BY 2.0
- Walking: [Mountaineering Man Trail Path Mountains](https://commons.wikimedia.org/wiki/File:Mountaineering_Man_Trail_Path_Mountains.jpg) — Hermann, CC0
- Cycling: [Marianne Vos, La Flèche Wallonne Femmes 2013](https://commons.wikimedia.org/wiki/File:Marianne_Vos_La_Fl%C3%A8che_Wallonne_Femmes_2013.jpg) — "...some guy", CC BY 2.0
