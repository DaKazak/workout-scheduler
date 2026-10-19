/* Calorie, duration, points and stats logic. Browser global `WorkoutCalc` + Node module (for tests).
   Numbers mirror supabase/migrations/*.sql — keep them in sync. */
(function (root) {
  'use strict';

  // MET values approximate the Compendium of Physical Activities (Ainsworth et al., 2011).
  // kmh = assumed pace used to convert a distance into time.
  var TYPES = {
    running: { label: 'Running', allowsDistance: true, maxKmh: 25, intensities: {
      light: { met: 8.3, kmh: 8 }, moderate: { met: 9.8, kmh: 10 }, vigorous: { met: 11.8, kmh: 12 } } },
    workout: { label: 'Workout', allowsDistance: false, intensities: {
      light: { met: 3.5 }, moderate: { met: 5.0 }, vigorous: { met: 6.0 } } },
    walking: { label: 'Walking', allowsDistance: true, maxKmh: 10, intensities: {
      light: { met: 3.0, kmh: 4 }, moderate: { met: 3.5, kmh: 5 }, vigorous: { met: 5.0, kmh: 6.4 } } },
    cycling: { label: 'Cycling', allowsDistance: true, maxKmh: 70, intensities: {
      light: { met: 6.8, kmh: 17 }, moderate: { met: 8.0, kmh: 20 }, vigorous: { met: 10.0, kmh: 24 } } }
  };
  var INTENSITIES = ['light', 'moderate', 'vigorous'];

  var POINTS = {
    perWorkout: 10,          // first 3 eligible workouts per day
    maxBasePerDay: 3,
    effortDivisor: 20,       // effort = MET x minutes / 20
    maxEffort: 60,           // per workout
    dailyCap: 100,           // workout + effort points per day
    perGoal: 5,
    allGoalsBonus: 10,
    streakDay: 5,            // each active day that is the 3rd+ in a row
    eligibleDays: 7,         // must be completed within 7 days of its date
    futureGraceMin: 30
  };

  var DEFAULT_GOALS = [
    { id: 'default-distance', label: 'Cover 5 km', metric: 'distance', activity_type: null, target: 5, position: 1 },
    { id: 'default-minutes', label: '30 active minutes', metric: 'minutes', activity_type: null, target: 30, position: 2 },
    { id: 'default-kcal', label: 'Burn 300 kcal', metric: 'kcal', activity_type: null, target: 300, position: 3 }
  ];

  function profile(type, intensity) {
    var t = TYPES[type] || TYPES.running;
    return t.intensities[intensity] || t.intensities.moderate;
  }
  function num(v) { var n = Number(v); return isFinite(n) && n > 0 ? n : 0; }

  /** Accepts v1 local records ({measure, value}) and v2 records ({distance_km, duration_min}). */
  function normalize(w) {
    var o = Object.assign({}, w);
    if (o.distance_km === undefined && o.duration_min === undefined && o.value !== undefined) {
      var v = num(o.value);
      if (effectiveMeasure(o) === 'distance') { o.distance_km = v || null; o.duration_min = null; }
      else { o.duration_min = v || null; o.distance_km = null; }
    }
    if (!TYPES[o.type] || !TYPES[o.type].allowsDistance) { o.measure = 'duration'; o.distance_km = null; }
    o.intensity = o.intensity || 'moderate';
    o.distance_km = num(o.distance_km) || null;
    o.duration_min = num(o.duration_min) || null;
    delete o.value;
    return o;
  }

  function effectiveMeasure(w) {
    var t = TYPES[w.type];
    if (!t || !t.allowsDistance) return 'duration';
    return w.measure === 'distance' ? 'distance' : 'duration';
  }

  function legacyValue(w, measure) {
    return (w.value !== undefined && effectiveMeasure(w) === measure) ? num(w.value) : 0;
  }

  /** Minutes: entered duration, else estimated from distance at the assumed pace. */
  function durationMinutes(w) {
    var d = num(w.duration_min) || legacyValue(w, 'duration');
    if (d) return d;
    var km = distanceKm(w);
    var p = profile(w.type, w.intensity);
    return km && p.kmh ? (km / p.kmh) * 60 : 0;
  }

  /** km only when entered (never invented for time-based entries). */
  function distanceKm(w) {
    if (!TYPES[w.type] || !TYPES[w.type].allowsDistance) return 0;
    return num(w.distance_km) || legacyValue(w, 'distance');
  }

  function hasActualTime(w) { return num(w.duration_min) > 0 || legacyValue(w, 'duration') > 0; }

  /** kcal = MET x weight_kg x hours */
  function calories(w, weightKg) {
    var kg = num(weightKg) || 70;
    return Math.round(profile(w.type, w.intensity).met * kg * (durationMinutes(w) / 60));
  }

  /** Stored server kcal when present, else live estimate. */
  function kcalOf(w, weightKg) { return typeof w.kcal === 'number' && w.kcal > 0 ? w.kcal : calories(w, weightKg); }

  function round1(x) { return Math.round(x * 10) / 10; }
  function effortPoints(w) {
    var mins = round1(durationMinutes(w));
    return Math.min(POINTS.maxEffort, Math.round(profile(w.type, w.intensity).met * mins / POINTS.effortDivisor));
  }
  function workoutPoints(w) { return POINTS.perWorkout + effortPoints(w); }

  function paceLabel(type, intensity) {
    var p = profile(type, intensity);
    if (!p.kmh) return '';
    if (type === 'cycling') return p.kmh + ' km/h';
    return fmtPace(60 / p.kmh);
  }
  function fmtPace(minPerKm) {
    var m = Math.floor(minPerKm), s = Math.round((minPerKm - m) * 60);
    if (s === 60) { m += 1; s = 0; }
    return m + ':' + (s < 10 ? '0' : '') + s + ' min/km';
  }

  /** Average speed check when both distance and time are given. */
  function speedError(w) {
    var km = num(w.distance_km), min = num(w.duration_min), t = TYPES[w.type];
    if (!km || !min || !t || !t.maxKmh) return null;
    return km / (min / 60) > t.maxKmh ? 'That speed is not realistic for ' + t.label.toLowerCase() + '.' : null;
  }

  // ---------- dates ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function isoDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseLocal(dateStr, timeStr) {
    var p = String(dateStr).split('-').map(Number), t = String(timeStr || '00:00').split(':').map(Number);
    return new Date(p[0], p[1] - 1, p[2], t[0] || 0, t[1] || 0);
  }
  function addDays(dateStr, n) { var d = parseLocal(dateStr); d.setDate(d.getDate() + n); return isoDate(d); }
  function dayDiff(a, b) { return Math.round((parseLocal(a) - parseLocal(b)) / 86400000); }
  function startOfWeek(dateStr) { var d = parseLocal(dateStr); d.setDate(d.getDate() - d.getDay()); return isoDate(d); } // Sunday
  function startOfMonth(dateStr) { return String(dateStr).slice(0, 8) + '01'; }
  function endOfMonth(dateStr) { var d = parseLocal(startOfMonth(dateStr)); d.setMonth(d.getMonth() + 1); d.setDate(0); return isoDate(d); }

  function startsAtMs(w) { return parseLocal(w.date, w.time).getTime(); }
  function completedAtMs(w) {
    if (!w.completed_at && !w.completedAt) return null;
    var v = w.completed_at || w.completedAt;
    return typeof v === 'number' ? v : Date.parse(v);
  }
  function isEligible(w) {
    if (!w.completed) return false;
    if (typeof w.eligible === 'boolean') return w.eligible;  // server-computed
    var c = completedAtMs(w);
    return c != null && c <= startsAtMs(w) + POINTS.eligibleDays * 86400000;
  }

  function metricValue(metric, w, weightKg) {
    if (metric === 'distance') return distanceKm(w);
    if (metric === 'minutes') return durationMinutes(w);
    if (metric === 'kcal') return kcalOf(w, weightKg);
    return 1;
  }

  /** Per-day scoring for one user's workouts (mirrors private.day_scores). */
  function scoreDays(workouts, goals, weightKg) {
    goals = goals && goals.length ? goals : DEFAULT_GOALS;
    var byDay = {};
    workouts.filter(function (w) { return w.completed; }).forEach(function (w) {
      (byDay[w.date] = byDay[w.date] || []).push(w);
    });
    var days = Object.keys(byDay).sort();
    var out = {}, activeDays = [];
    days.forEach(function (day) {
      var list = byDay[day].slice().sort(function (a, b) { return startsAtMs(a) - startsAtMs(b); });
      var elig = list.filter(isEligible);
      var wp = 0;
      elig.forEach(function (w, i) { wp += (i < POINTS.maxBasePerDay ? POINTS.perWorkout : 0) + effortPoints(w); });
      wp = Math.min(POINTS.dailyCap, wp);
      var hits = 0;
      goals.forEach(function (g) {
        var v = 0;
        elig.forEach(function (w) { if (!g.activity_type || g.activity_type === w.type) v += metricValue(g.metric, w, weightKg); });
        if (elig.length && v >= g.target) hits++;
      });
      var gp = hits * POINTS.perGoal + (hits === goals.length && goals.length ? POINTS.allGoalsBonus : 0);
      if (elig.length) activeDays.push(day);
      out[day] = { day: day, workoutPts: wp, goalPts: gp, streakPts: 0, active: elig.length > 0 };
    });
    for (var i = 2; i < activeDays.length; i++) {
      if (dayDiff(activeDays[i], activeDays[i - 2]) === 2) out[activeDays[i]].streakPts = POINTS.streakDay;
    }
    return out;
  }

  function sumPoints(scores, from, to) {
    var t = { workout: 0, goals: 0, streak: 0, total: 0 };
    Object.keys(scores).forEach(function (d) {
      if ((from && d < from) || (to && d > to)) return;
      var s = scores[d];
      t.workout += s.workoutPts; t.goals += s.goalPts; t.streak += s.streakPts;
    });
    t.total = t.workout + t.goals + t.streak;
    return t;
  }

  /** current & best streak of consecutive active (eligible completed) days */
  function streaks(workouts, today) {
    var set = {};
    workouts.forEach(function (w) { if (isEligible(w)) set[w.date] = true; });
    var days = Object.keys(set).sort();
    var best = 0, run = 0, prev = null;
    days.forEach(function (d) {
      run = prev && dayDiff(d, prev) === 1 ? run + 1 : 1;
      best = Math.max(best, run); prev = d;
    });
    var current = 0;
    var cursor = set[today] ? today : (set[addDays(today, -1)] ? addDays(today, -1) : null);
    while (cursor && set[cursor]) { current++; cursor = addDays(cursor, -1); }
    return { current: current, best: best, activeToday: !!set[today] };
  }

  var api = {
    TYPES: TYPES, INTENSITIES: INTENSITIES, POINTS: POINTS, DEFAULT_GOALS: DEFAULT_GOALS,
    profile: profile, normalize: normalize, effectiveMeasure: effectiveMeasure,
    durationMinutes: durationMinutes, distanceKm: distanceKm, hasActualTime: hasActualTime,
    calories: calories, kcalOf: kcalOf, effortPoints: effortPoints, workoutPoints: workoutPoints,
    paceLabel: paceLabel, fmtPace: fmtPace, speedError: speedError,
    pad: pad, isoDate: isoDate, parseLocal: parseLocal, addDays: addDays, dayDiff: dayDiff,
    startOfWeek: startOfWeek, startOfMonth: startOfMonth, endOfMonth: endOfMonth,
    startsAtMs: startsAtMs, completedAtMs: completedAtMs, isEligible: isEligible,
    metricValue: metricValue, scoreDays: scoreDays, sumPoints: sumPoints, streaks: streaks
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WorkoutCalc = api;
})(this);
