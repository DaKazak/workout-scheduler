/* Badges, personal records and weekly summary — computed from the signed-in user's own workouts. */
(function (root) {
  'use strict';
  var C = root.WorkoutCalc || (typeof require !== 'undefined' ? require('./calc.js') : null);

  function done(ws) { return ws.filter(function (w) { return w.completed; }); }
  function sum(ws, f) { return ws.reduce(function (a, w) { return a + f(w); }, 0); }
  function maxBy(ws, f) { var best = null, bv = 0; ws.forEach(function (w) { var v = f(w); if (v > bv) { bv = v; best = w; } }); return best ? { w: best, v: bv } : null; }
  function hour(w) { return Number(String(w.time || '00:00').split(':')[0]); }

  var BADGES = [
    { id: 'first', icon: '🎯', name: 'First step', desc: 'Complete your first workout', goal: 1, value: function (s) { return s.count; } },
    { id: 'five', icon: '🏃', name: 'First 5K', desc: 'Run 5 km in one go', goal: 5, value: function (s) { return s.longestRun; }, unit: 'km' },
    { id: 'tenk', icon: '🔟', name: 'First 10K', desc: 'Run 10 km in one go', goal: 10, value: function (s) { return s.longestRun; }, unit: 'km' },
    { id: 'half', icon: '🥈', name: 'Half marathon', desc: 'Run 21.1 km in one go', goal: 21.1, value: function (s) { return s.longestRun; }, unit: 'km' },
    { id: 'century', icon: '🚴', name: 'Century ride', desc: 'Ride 100 km in one go', goal: 100, value: function (s) { return s.longestRide; }, unit: 'km' },
    { id: 'club100', icon: '💯', name: '100 km club', desc: 'Cover 100 km in total', goal: 100, value: function (s) { return s.km; }, unit: 'km' },
    { id: 'club500', icon: '🌍', name: '500 km club', desc: 'Cover 500 km in total', goal: 500, value: function (s) { return s.km; }, unit: 'km' },
    { id: 'streak7', icon: '🔥', name: '7-day streak', desc: 'Be active 7 days in a row', goal: 7, value: function (s) { return s.bestStreak; }, unit: 'days' },
    { id: 'streak30', icon: '☄️', name: '30-day streak', desc: 'Be active 30 days in a row', goal: 30, value: function (s) { return s.bestStreak; }, unit: 'days' },
    { id: 'early', icon: '🌅', name: 'Early bird', desc: '5 workouts starting before 7:00', goal: 5, value: function (s) { return s.early; } },
    { id: 'owl', icon: '🌙', name: 'Night owl', desc: '5 workouts starting 21:00 or later', goal: 5, value: function (s) { return s.late; } },
    { id: 'iron', icon: '🏋️', name: 'Iron regular', desc: '10 gym workouts', goal: 10, value: function (s) { return s.gym; } },
    { id: 'allround', icon: '🧭', name: 'All-rounder', desc: 'Complete all 4 workout types', goal: 4, value: function (s) { return s.typesDone; } },
    { id: 'minutes', icon: '⏱️', name: '1,000 minutes', desc: '1,000 active minutes in total', goal: 1000, value: function (s) { return s.minutes; }, unit: 'min' },
    { id: 'kcal', icon: '⚡', name: 'Furnace', desc: 'Burn 10,000 kcal in total', goal: 10000, value: function (s) { return s.kcal; }, unit: 'kcal' },
    { id: 'weekend', icon: '🎉', name: 'Weekend warrior', desc: 'Work out on both Friday and Saturday of one weekend', goal: 1, value: function (s) { return s.weekends; } }
  ];

  function stats(workouts, weightKg, today) {
    var ws = done(workouts);
    var runs = ws.filter(function (w) { return w.type === 'running'; });
    var rides = ws.filter(function (w) { return w.type === 'cycling'; });
    var types = {};
    ws.forEach(function (w) { types[w.type] = true; });
    var days = {};
    ws.forEach(function (w) { days[w.date] = true; });
    var weekends = 0;
    Object.keys(days).forEach(function (d) {
      if (C.parseLocal(d).getDay() === 5 && days[C.addDays(d, 1)]) weekends++;
    });
    var st = C.streaks(workouts, today);
    return {
      count: ws.length,
      km: sum(ws, C.distanceKm),
      minutes: sum(ws, C.durationMinutes),
      kcal: sum(ws, function (w) { return C.kcalOf(w, weightKg); }),
      longestRun: Math.max(0, Math.max.apply(null, [0].concat(runs.map(C.distanceKm)))),
      longestRide: Math.max(0, Math.max.apply(null, [0].concat(rides.map(C.distanceKm)))),
      early: ws.filter(function (w) { return hour(w) < 7; }).length,
      late: ws.filter(function (w) { return hour(w) >= 21; }).length,
      gym: ws.filter(function (w) { return w.type === 'workout'; }).length,
      typesDone: Object.keys(types).length,
      bestStreak: st.best,
      currentStreak: st.current,
      weekends: weekends
    };
  }

  function badges(workouts, weightKg, today) {
    var s = stats(workouts, weightKg, today);
    return BADGES.map(function (b) {
      var v = b.value(s);
      return { id: b.id, icon: b.icon, name: b.name, desc: b.desc, unit: b.unit || '', goal: b.goal,
        value: v, earned: v >= b.goal, progress: Math.min(1, v / b.goal) };
    });
  }

  function records(workouts, weightKg) {
    var ws = done(workouts);
    function longest(type) { return maxBy(ws.filter(function (w) { return w.type === type; }), C.distanceKm); }
    var fastest = null;
    ws.filter(function (w) { return w.type === 'running' && C.distanceKm(w) >= 1 && C.hasActualTime(w); }).forEach(function (w) {
      var pace = C.durationMinutes(w) / C.distanceKm(w);
      if (!fastest || pace < fastest.v) fastest = { w: w, v: pace };
    });
    var weeks = {};
    ws.forEach(function (w) {
      var k = C.startOfWeek(w.date);
      var o = weeks[k] = weeks[k] || { week: k, km: 0, minutes: 0, kcal: 0, count: 0 };
      o.km += C.distanceKm(w); o.minutes += C.durationMinutes(w); o.kcal += C.kcalOf(w, weightKg); o.count++;
    });
    var wk = Object.keys(weeks).map(function (k) { return weeks[k]; });
    var bigKm = wk.reduce(function (a, b) { return !a || b.km > a.km ? b : a; }, null);
    var bigMin = wk.reduce(function (a, b) { return !a || b.minutes > a.minutes ? b : a; }, null);
    var dayKcal = {};
    ws.forEach(function (w) { dayKcal[w.date] = (dayKcal[w.date] || 0) + C.kcalOf(w, weightKg); });
    var bestDay = Object.keys(dayKcal).reduce(function (a, d) { return !a || dayKcal[d] > dayKcal[a] ? d : a; }, null);
    return {
      longestRun: longest('running'),
      longestRide: longest('cycling'),
      longestWalk: longest('walking'),
      longestSession: maxBy(ws, C.durationMinutes),
      fastestRun: fastest,
      biggestWeekKm: bigKm && bigKm.km > 0 ? bigKm : null,
      biggestWeekMin: bigMin && bigMin.minutes > 0 ? bigMin : null,
      bestKcalDay: bestDay ? { day: bestDay, v: dayKcal[bestDay] } : null
    };
  }

  function weekSummary(workouts, weightKg, today) {
    var thisStart = C.startOfWeek(today), lastStart = C.addDays(thisStart, -7);
    var scores = C.scoreDays(workouts, null, weightKg);
    function range(from, to) {
      var ws = done(workouts).filter(function (w) { return w.date >= from && w.date <= to; });
      var byType = {};
      ws.forEach(function (w) { byType[w.type] = (byType[w.type] || 0) + C.durationMinutes(w); });
      var top = Object.keys(byType).sort(function (a, b) { return byType[b] - byType[a]; })[0] || null;
      var activeDays = {};
      ws.forEach(function (w) { activeDays[w.date] = true; });
      return { count: ws.length, km: sum(ws, C.distanceKm), minutes: sum(ws, C.durationMinutes),
        kcal: sum(ws, function (w) { return C.kcalOf(w, weightKg); }), points: C.sumPoints(scores, from, to).total,
        topType: top, activeDays: Object.keys(activeDays).length };
    }
    return { start: thisStart, current: range(thisStart, C.addDays(thisStart, 6)), previous: range(lastStart, C.addDays(lastStart, 6)) };
  }

  var api = { BADGES: BADGES, stats: stats, badges: badges, records: records, weekSummary: weekSummary };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Achievements = api;
})(this);
