/* Calorie + duration estimation (MET-based). Works in the browser and in Node (for tests). */
(function (root) {
  'use strict';

  // MET values are approximations from the Compendium of Physical Activities (Ainsworth et al., 2011).
  // kmh = assumed pace used to convert a distance into time.
  var TYPES = {
    running: {
      label: 'Running', allowsDistance: true,
      intensities: {
        light:    { met: 8.3,  kmh: 8 },   // 7:30 min/km
        moderate: { met: 9.8,  kmh: 10 },  // 6:00 min/km
        vigorous: { met: 11.8, kmh: 12 }   // 5:00 min/km
      }
    },
    workout: {
      label: 'Workout', allowsDistance: false,
      intensities: {
        light:    { met: 3.5 },  // light/moderate resistance training
        moderate: { met: 5.0 },  // general gym / strength
        vigorous: { met: 6.0 }   // vigorous weight lifting
      }
    },
    walking: {
      label: 'Walking', allowsDistance: true,
      intensities: {
        light:    { met: 3.0, kmh: 4 },    // 15:00 min/km
        moderate: { met: 3.5, kmh: 5 },    // 12:00 min/km
        vigorous: { met: 5.0, kmh: 6.4 }   // brisk, ~9:23 min/km
      }
    },
    cycling: {
      label: 'Cycling', allowsDistance: true,
      intensities: {
        light:    { met: 6.8,  kmh: 17 },
        moderate: { met: 8.0,  kmh: 20 },
        vigorous: { met: 10.0, kmh: 24 }
      }
    }
  };

  var INTENSITIES = ['light', 'moderate', 'vigorous'];

  function profile(type, intensity) {
    var t = TYPES[type] || TYPES.running;
    return t.intensities[intensity] || t.intensities.moderate;
  }

  /** Effective measure: Workout type is always time-based. */
  function effectiveMeasure(w) {
    var t = TYPES[w.type];
    if (!t || !t.allowsDistance) return 'duration';
    return w.measure === 'distance' ? 'distance' : 'duration';
  }

  /** Duration in minutes (entered, or estimated from distance + assumed pace). */
  function durationMinutes(w) {
    var v = Number(w.value);
    if (!isFinite(v) || v <= 0) return 0;
    if (effectiveMeasure(w) === 'duration') return v;
    var p = profile(w.type, w.intensity);
    return (v / p.kmh) * 60;
  }

  /** Distance in km only when the user entered one (we don't invent km for time-based entries). */
  function distanceKm(w) {
    var v = Number(w.value);
    if (!isFinite(v) || v <= 0) return 0;
    return effectiveMeasure(w) === 'distance' ? v : 0;
  }

  /** kcal = MET x weight_kg x hours */
  function calories(w, weightKg) {
    var kg = Number(weightKg);
    if (!isFinite(kg) || kg <= 0) kg = 70;
    var p = profile(w.type, w.intensity);
    return Math.round(p.met * kg * (durationMinutes(w) / 60));
  }

  function paceLabel(type, intensity) {
    var p = profile(type, intensity);
    if (!p.kmh) return '';
    if (type === 'cycling') return p.kmh + ' km/h';
    var minPerKm = 60 / p.kmh;
    var m = Math.floor(minPerKm);
    var s = Math.round((minPerKm - m) * 60);
    if (s === 60) { m += 1; s = 0; }
    return m + ':' + (s < 10 ? '0' : '') + s + ' min/km';
  }

  var api = {
    TYPES: TYPES, INTENSITIES: INTENSITIES, profile: profile,
    effectiveMeasure: effectiveMeasure, durationMinutes: durationMinutes,
    distanceKm: distanceKm, calories: calories, paceLabel: paceLabel
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WorkoutCalc = api;
})(this);
