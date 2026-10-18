# Momentum — Workout Scheduler

A small static web app for planning and tracking workouts (Running, Workout/gym, Walking, Cycling).
No build step, no backend: plain HTML/CSS/JS, data stored in the browser's `localStorage`.

## Features
- Schedule workouts with date & time, measured by distance (km) or duration (min); Workout (gym) is time-only
- Intensity (light / moderate / vigorous) and optional notes
- Live calorie estimate while typing (MET × weight kg × hours), shown on every card
- Upcoming schedule grouped by day (with "Missed?" flags), completed history with all-time totals
- Weekly stats: workouts, km, minutes, kcal (week starts Sunday)
- Edit, delete (with undo), mark complete / undo
- Body-weight setting (default 70 kg), sample data, delete-all
- Rotating motivational quotes

## Run locally
```
python3 -m http.server 8000   # then open http://localhost:8000
```

## Calorie assumptions
MET values approximate the Compendium of Physical Activities. Distance is converted to time with these paces:
running 7:30 / 6:00 / 5:00 min/km (MET 8.3 / 9.8 / 11.8), walking 15:00 / 12:00 / ~9:20 min/km (MET 3.0 / 3.5 / 5.0),
cycling 17 / 20 / 24 km/h (MET 6.8 / 8.0 / 10.0); gym workout MET 3.5 / 5.0 / 6.0.

## Photo credits (Wikimedia Commons, cropped & compressed)
- Running: [Julien Chorier, ultra traileur](https://commons.wikimedia.org/wiki/File:Julien_Chorier,_ultra_traileur.jpg) — Peignée Verticale / Damien Rosso, CC BY 4.0
- Workout: [Man lifting dumbbell weight in fitness gym](https://commons.wikimedia.org/wiki/File:Attractive_man_lifting_dumbbell_weight_for_exercise_in_fitness_gym.jpg) — Nenad Stojkovic, CC BY 2.0
- Walking: [Mountaineering Man Trail Path Mountains](https://commons.wikimedia.org/wiki/File:Mountaineering_Man_Trail_Path_Mountains.jpg) — Hermann, CC0
- Cycling: [Marianne Vos, La Flèche Wallonne Femmes 2013](https://commons.wikimedia.org/wiki/File:Marianne_Vos_La_Fl%C3%A8che_Wallonne_Femmes_2013.jpg) — "...some guy", CC BY 2.0
