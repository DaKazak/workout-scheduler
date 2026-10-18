(function () {
  'use strict';

  var Calc = window.WorkoutCalc;
  var QUOTES = window.WORKOUT_QUOTES || [];
  var KEY_WORKOUTS = 'momentum.v1.workouts';
  var KEY_SETTINGS = 'momentum.v1.settings';
  var TYPE_LABEL = { running: 'Running', workout: 'Workout', walking: 'Walking', cycling: 'Cycling' };

  // ---------- storage ----------
  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { toast('Could not save (storage unavailable)'); }
  }

  var state = {
    workouts: sanitizeList(load(KEY_WORKOUTS, [])),
    settings: Object.assign({ weightKg: 70 }, load(KEY_SETTINGS, {})),
    editingId: null,
    tab: 'upcoming',
    quoteIndex: -1
  };

  function sanitizeList(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(function (w) {
      return w && typeof w.id === 'string' && TYPE_LABEL[w.type] && /^\d{4}-\d{2}-\d{2}$/.test(w.date);
    });
  }
  function persist() { save(KEY_WORKOUTS, state.workouts); }
  function weight() {
    var w = Number(state.settings.weightKg);
    return isFinite(w) && w >= 25 && w <= 300 ? w : 70;
  }

  // ---------- dates ----------
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function isoDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseLocal(dateStr, timeStr) {
    var p = dateStr.split('-').map(Number);
    var t = (timeStr || '00:00').split(':').map(Number);
    return new Date(p[0], p[1] - 1, p[2], t[0] || 0, t[1] || 0);
  }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function startOfWeek(d) { // week starts Sunday (Israel)
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() - x.getDay());
    return x;
  }
  var dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
  var shortDayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  function dayLabel(dateStr) {
    var today = isoDate(new Date());
    if (dateStr === today) return 'Today';
    if (dateStr === isoDate(addDays(new Date(), 1))) return 'Tomorrow';
    if (dateStr === isoDate(addDays(new Date(), -1))) return 'Yesterday';
    return dayFmt.format(parseLocal(dateStr));
  }

  // ---------- formatting ----------
  function fmtNum(n, digits) {
    var d = digits == null ? 1 : digits;
    var r = Math.round(n * Math.pow(10, d)) / Math.pow(10, d);
    return r.toLocaleString('en-US', { maximumFractionDigits: d });
  }
  function fmtMinutes(min) {
    min = Math.round(min);
    if (min < 60) return min + ' min';
    var h = Math.floor(min / 60), m = min % 60;
    return h + ' h' + (m ? ' ' + m + ' min' : '');
  }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function describe(w) {
    var measure = Calc.effectiveMeasure(w);
    var mins = Calc.durationMinutes(w);
    var main, sub = [];
    if (measure === 'distance') {
      main = fmtNum(Number(w.value), 2) + ' km';
      sub.push('≈ ' + fmtMinutes(mins));
      sub.push(Calc.paceLabel(w.type, w.intensity));
    } else {
      main = fmtMinutes(Number(w.value));
    }
    sub.unshift(cap(w.intensity || 'moderate'));
    return { main: main, sub: sub.join(' · ') };
  }

  // ---------- DOM helpers ----------
  function $(id) { return document.getElementById(id); }
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k]; // only used with static, trusted markup
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  var ICON = {
    check: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M9 16.2l-3.5-3.5L4 14.2l5 5 11-11-1.5-1.5z"/></svg>',
    undo: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12.5 8c-2.6 0-5 1-6.9 2.6L2 7v9h9l-3.6-3.6A8 8 0 0 1 20.1 16l2.4-.8A10.5 10.5 0 0 0 12.5 8z"/></svg>',
    edit: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 17.2V21h3.8l11-11-3.8-3.8-11 11zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.8 3.8L20.7 7z"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>'
  };

  // ---------- form ----------
  var form = $('workoutForm');

  function formValues() {
    var fd = new FormData(form);
    var type = fd.get('type');
    var measure = Calc.TYPES[type].allowsDistance ? fd.get('measure') : 'duration';
    return {
      type: type,
      date: fd.get('date'),
      time: fd.get('time'),
      measure: measure,
      value: parseFloat(String(fd.get('value')).replace(',', '.')),
      intensity: fd.get('intensity') || 'moderate',
      notes: String(fd.get('notes') || '').trim()
    };
  }

  function syncFormUI() {
    var type = form.elements.type.value;
    var allowsDistance = Calc.TYPES[type].allowsDistance;
    var distRadio = form.querySelector('input[name=measure][value=distance]');
    var durRadio = form.querySelector('input[name=measure][value=duration]');
    distRadio.disabled = !allowsDistance;
    if (!allowsDistance) durRadio.checked = true;
    distRadio.parentElement.classList.toggle('disabled', !allowsDistance);
    $('measureHint').hidden = allowsDistance;
    var isDist = form.elements.measure.value === 'distance';
    $('valueLabel').textContent = isDist ? 'Distance (km)' : 'Duration (min)';
    var input = $('valueInput');
    input.step = isDist ? '0.1' : '1';
    input.min = isDist ? '0.1' : '1';
    input.max = isDist ? '500' : '1440';
    input.placeholder = isDist ? (type === 'cycling' ? 'e.g. 25' : 'e.g. 5') : 'e.g. 45';
    updateEstimate();
  }

  function updateEstimate() {
    var v = formValues();
    var kcal = 0, detail = 'Enter a distance or duration';
    if (isFinite(v.value) && v.value > 0) {
      kcal = Calc.calories(v, weight());
      var p = Calc.profile(v.type, v.intensity);
      var mins = Calc.durationMinutes(v);
      detail = 'MET ' + p.met + ' × ' + fmtNum(weight()) + ' kg × ' + fmtNum(mins / 60, 2) + ' h';
      if (Calc.effectiveMeasure(v) === 'distance') detail += ' (≈ ' + fmtMinutes(mins) + ' at ' + Calc.paceLabel(v.type, v.intensity) + ')';
    }
    $('estKcal').textContent = kcal.toLocaleString('en-US');
    $('estDetail').textContent = detail;
  }

  function validate(v) {
    if (!v.date) return 'Pick a date.';
    if (!v.time) return 'Pick a time.';
    if (!isFinite(v.value) || v.value <= 0) return v.measure === 'distance' ? 'Enter a distance in km.' : 'Enter a duration in minutes.';
    if (v.measure === 'distance' && v.value > 500) return 'That distance looks too long (max 500 km).';
    if (v.measure === 'duration' && v.value > 1440) return 'Duration must be under 24 hours.';
    return null;
  }

  function defaultDateTime() {
    var d = new Date();
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    return { date: isoDate(d), time: pad(d.getHours()) + ':00' };
  }

  function resetForm() {
    var keepType = form.elements.type.value;
    form.reset();
    form.querySelector('input[name=type][value=' + keepType + ']').checked = true;
    var dt = defaultDateTime();
    $('dateInput').value = dt.date;
    $('timeInput').value = dt.time;
    state.editingId = null;
    $('formTitle').textContent = 'Plan a workout';
    $('submitBtn').textContent = 'Add to schedule';
    $('cancelEditBtn').hidden = true;
    $('formPanel').classList.remove('editing');
    $('formError').hidden = true;
    syncFormUI();
  }

  function startEdit(id) {
    var w = find(id);
    if (!w) return;
    state.editingId = id;
    form.querySelector('input[name=type][value=' + w.type + ']').checked = true;
    form.querySelector('input[name=measure][value=' + Calc.effectiveMeasure(w) + ']').checked = true;
    $('dateInput').value = w.date;
    $('timeInput').value = w.time;
    $('valueInput').value = w.value;
    $('intensityInput').value = w.intensity || 'moderate';
    $('notesInput').value = w.notes || '';
    $('formTitle').textContent = 'Edit workout';
    $('submitBtn').textContent = 'Save changes';
    $('cancelEditBtn').hidden = false;
    $('formPanel').classList.add('editing');
    $('formError').hidden = true;
    syncFormUI();
    $('formPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(function () { $('valueInput').focus({ preventScroll: true }); }, 300);
  }

  form.addEventListener('input', function (e) {
    if (e.target.name === 'type' || e.target.name === 'measure') syncFormUI();
    else updateEstimate();
  });
  form.addEventListener('change', function (e) {
    if (e.target.name === 'type' || e.target.name === 'measure') syncFormUI();
  });
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var v = formValues();
    var err = validate(v);
    if (err) { $('formError').textContent = err; $('formError').hidden = false; return; }
    $('formError').hidden = true;
    if (state.editingId) {
      var w = find(state.editingId);
      if (w) Object.assign(w, v, { updatedAt: Date.now() });
      toast('Workout updated');
    } else {
      state.workouts.push(Object.assign({ id: uid(), completed: false, createdAt: Date.now() }, v));
      toast(TYPE_LABEL[v.type] + ' scheduled for ' + dayLabel(v.date).replace(/^(Today|Tomorrow)$/, function (m) { return m.toLowerCase(); }) + ' at ' + v.time);
      if (state.tab !== 'upcoming' && !isPast(v)) setTab('upcoming');
    }
    persist();
    resetForm();
    render();
  });
  $('cancelEditBtn').addEventListener('click', resetForm);

  // ---------- data ops ----------
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function find(id) { for (var i = 0; i < state.workouts.length; i++) if (state.workouts[i].id === id) return state.workouts[i]; return null; }
  function isPast(w) { return parseLocal(w.date, w.time).getTime() < Date.now(); }
  function sortKey(w) { return w.date + 'T' + (w.time || '00:00'); }

  function toggleComplete(id) {
    var w = find(id);
    if (!w) return;
    w.completed = !w.completed;
    w.completedAt = w.completed ? Date.now() : null;
    persist();
    render();
    toast(w.completed ? 'Nice work! ' + Calc.calories(w, weight()) + ' kcal logged 💪' : 'Moved back to upcoming');
  }

  function remove(id) {
    var idx = -1;
    for (var i = 0; i < state.workouts.length; i++) if (state.workouts[i].id === id) idx = i;
    if (idx < 0) return;
    var removed = state.workouts.splice(idx, 1)[0];
    if (state.editingId === id) resetForm();
    persist();
    render();
    toast('Workout deleted', function () {
      state.workouts.splice(idx, 0, removed);
      persist();
      render();
    });
  }

  // ---------- rendering ----------
  function card(w) {
    var d = describe(w);
    var kcal = Calc.calories(w, weight());
    var overdue = !w.completed && isPast(w);
    var c = el('article', { class: 'card type-' + w.type + (w.completed ? ' done' : '') + (overdue ? ' overdue' : ''), 'data-id': w.id });
    c.appendChild(el('img', { class: 'thumb', src: 'img/' + w.type + '-thumb.jpg', alt: TYPE_LABEL[w.type], loading: 'lazy', width: '480', height: '360' }));
    var body = el('div', { class: 'card-body' }, [
      el('div', { class: 'card-meta' }, [
        el('span', { class: 'badge', text: TYPE_LABEL[w.type] }),
        el('span', { class: 'time', text: w.time }),
        overdue ? el('span', { class: 'flag', text: 'Missed?' }) : null,
        w.completed ? el('span', { class: 'flag ok', text: 'Done' }) : null
      ]),
      el('h3', { text: d.main }),
      el('p', { class: 'sub', text: d.sub }),
      w.notes ? el('p', { class: 'notes', text: w.notes }) : null
    ]);
    c.appendChild(body);
    c.appendChild(el('div', { class: 'kcal', title: 'Estimated calories' }, [
      el('strong', { text: kcal.toLocaleString('en-US') }), el('span', { text: 'kcal' })
    ]));
    var actions = el('div', { class: 'actions' }, [
      el('button', { type: 'button', class: 'act complete', 'data-act': 'complete', 'aria-label': w.completed ? 'Mark as not completed' : 'Mark completed', title: w.completed ? 'Undo complete' : 'Mark completed', html: w.completed ? ICON.undo : ICON.check }),
      el('button', { type: 'button', class: 'act', 'data-act': 'edit', 'aria-label': 'Edit', title: 'Edit', html: ICON.edit }),
      el('button', { type: 'button', class: 'act del', 'data-act': 'delete', 'aria-label': 'Delete', title: 'Delete', html: ICON.trash })
    ]);
    c.appendChild(actions);
    return c;
  }

  function groupByDay(list) {
    var groups = [], map = {};
    list.forEach(function (w) {
      if (!map[w.date]) { map[w.date] = { date: w.date, items: [] }; groups.push(map[w.date]); }
      map[w.date].items.push(w);
    });
    return groups;
  }

  function dayTotals(items) {
    var kcal = 0, min = 0;
    items.forEach(function (w) { kcal += Calc.calories(w, weight()); min += Calc.durationMinutes(w); });
    return fmtMinutes(min) + ' · ' + kcal.toLocaleString('en-US') + ' kcal';
  }

  function renderList(container, list, emptyHtml) {
    container.textContent = '';
    if (!list.length) {
      container.appendChild(el('div', { class: 'empty', html: emptyHtml }));
      return;
    }
    groupByDay(list).forEach(function (g) {
      var section = el('section', { class: 'day' }, [
        el('header', { class: 'day-head' }, [
          el('h4', { text: dayLabel(g.date) }),
          el('span', { text: (g.items.length > 1 ? g.items.length + ' workouts · ' : '') + dayTotals(g.items) })
        ])
      ]);
      g.items.forEach(function (w) { section.appendChild(card(w)); });
      container.appendChild(section);
    });
  }

  function renderStats() {
    var ws = startOfWeek(new Date()), we = addDays(ws, 7);
    var wsKey = isoDate(ws), weKey = isoDate(we);
    var done = { n: 0, km: 0, min: 0, kcal: 0 }, planned = { n: 0, km: 0, min: 0, kcal: 0 };
    state.workouts.forEach(function (w) {
      if (w.date < wsKey || w.date >= weKey) return;
      var t = w.completed ? done : planned;
      t.n++; t.km += Calc.distanceKm(w); t.min += Calc.durationMinutes(w); t.kcal += Calc.calories(w, weight());
    });
    $('statCount').textContent = done.n;
    $('statCountSub').textContent = 'done · ' + planned.n + ' more planned';
    $('statKm').textContent = fmtNum(done.km);
    $('statKmSub').textContent = 'km done' + (planned.km ? ' · +' + fmtNum(planned.km) + ' planned' : '');
    $('statMin').textContent = Math.round(done.min).toLocaleString('en-US');
    $('statMinSub').textContent = 'min done' + (planned.min ? ' · +' + Math.round(planned.min) + ' planned' : '');
    $('statKcal').textContent = done.kcal.toLocaleString('en-US');
    $('statKcalSub').textContent = 'kcal burned' + (planned.kcal ? ' · +' + planned.kcal.toLocaleString('en-US') + ' planned' : '');
  }

  function renderHero(upcoming) {
    var h = new Date().getHours();
    $('greeting').textContent = (h < 5 ? 'Late night, Daniel' : h < 12 ? 'Good morning, Daniel' : h < 18 ? 'Good afternoon, Daniel' : 'Good evening, Daniel');
    var next = upcoming.filter(function (w) { return !isPast(w); })[0];
    var tiles = document.querySelectorAll('.hero-tiles .tile');
    var types = ['running', 'workout', 'walking', 'cycling'];
    tiles.forEach(function (t, i) { t.classList.toggle('focus', !!next && types[i] === next.type); });
    if (next) {
      $('nextUp').textContent = 'Next up: ' + TYPE_LABEL[next.type] + ' · ' + describe(next).main + ' — ' + dayLabel(next.date) + ' at ' + next.time;
    } else {
      $('nextUp').textContent = upcoming.length ? 'You have missed sessions to review — or plan something new below.' : 'Nothing scheduled yet — plan your next workout below.';
    }
  }

  function render() {
    var upcoming = state.workouts.filter(function (w) { return !w.completed; })
      .sort(function (a, b) { return sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0; });
    var history = state.workouts.filter(function (w) { return w.completed; })
      .sort(function (a, b) { return sortKey(a) > sortKey(b) ? -1 : sortKey(a) < sortKey(b) ? 1 : 0; });

    renderList($('upcomingList'), upcoming,
      '<div class="empty-icon">🗓️</div><p><b>Your schedule is clear.</b></p><p>Add a run, gym session, walk or ride with the form.</p>');
    var histBox = $('historyList');
    renderList(histBox, history,
      '<div class="empty-icon">🏁</div><p><b>No completed workouts yet.</b></p><p>Tick ✓ on a workout when you finish it.</p>');
    if (history.length) {
      var t = { km: 0, min: 0, kcal: 0 };
      history.forEach(function (w) { t.km += Calc.distanceKm(w); t.min += Calc.durationMinutes(w); t.kcal += Calc.calories(w, weight()); });
      histBox.insertBefore(el('div', { class: 'history-total' }, [
        el('span', { text: 'All time' }),
        el('b', { text: history.length + ' workouts' }),
        el('b', { text: fmtNum(t.km) + ' km' }),
        el('b', { text: fmtMinutes(t.min) }),
        el('b', { class: 'k', text: t.kcal.toLocaleString('en-US') + ' kcal' })
      ]), histBox.firstChild);
    }
    $('upcomingCount').textContent = upcoming.length;
    $('historyCount').textContent = history.length;
    renderStats();
    renderHero(upcoming);
    $('weightChip').textContent = fmtNum(weight()) + ' kg';
  }

  function onListClick(e) {
    var btn = e.target.closest('button[data-act]');
    if (!btn) return;
    var id = btn.closest('.card').getAttribute('data-id');
    var act = btn.getAttribute('data-act');
    if (act === 'complete') toggleComplete(id);
    else if (act === 'edit') startEdit(id);
    else if (act === 'delete') remove(id);
  }
  $('upcomingList').addEventListener('click', onListClick);
  $('historyList').addEventListener('click', onListClick);

  // ---------- tabs ----------
  function setTab(tab) {
    state.tab = tab;
    var up = tab === 'upcoming';
    $('tabUpcoming').classList.toggle('active', up);
    $('tabHistory').classList.toggle('active', !up);
    $('tabUpcoming').setAttribute('aria-selected', String(up));
    $('tabHistory').setAttribute('aria-selected', String(!up));
    $('upcomingList').hidden = !up;
    $('historyList').hidden = up;
  }
  $('tabUpcoming').addEventListener('click', function () { setTab('upcoming'); });
  $('tabHistory').addEventListener('click', function () { setTab('history'); });

  // ---------- quotes ----------
  function showQuote(step) {
    if (!QUOTES.length) return;
    var i;
    if (state.quoteIndex < 0) i = Math.floor(Math.random() * QUOTES.length);
    else {
      i = (state.quoteIndex + (step || 1)) % QUOTES.length;
    }
    state.quoteIndex = i;
    var q = QUOTES[i];
    var box = $('quoteBox');
    box.classList.remove('swap');
    void box.offsetWidth; // restart animation
    box.classList.add('swap');
    $('quoteText').textContent = '\u201C' + q.text + '\u201D';
    $('quoteAuthor').textContent = q.author ? '— ' + q.author : '— Unknown';
  }
  $('nextQuoteBtn').addEventListener('click', function () { showQuote(1 + Math.floor(Math.random() * 3)); });

  // ---------- settings ----------
  var dialog = $('settingsDialog');
  $('settingsBtn').addEventListener('click', function () {
    $('weightInput').value = weight();
    if (dialog.showModal) dialog.showModal(); else dialog.setAttribute('open', '');
  });
  dialog.addEventListener('close', function () {
    if (dialog.returnValue === 'save') {
      var w = parseFloat(String($('weightInput').value).replace(',', '.'));
      if (isFinite(w) && w >= 25 && w <= 300) {
        state.settings.weightKg = Math.round(w * 10) / 10;
        save(KEY_SETTINGS, state.settings);
        toast('Weight set to ' + fmtNum(state.settings.weightKg) + ' kg — estimates updated');
        render();
        updateEstimate();
      } else {
        toast('Weight must be between 25 and 300 kg');
      }
    }
  });
  $('sampleBtn').addEventListener('click', function () {
    addSamples();
    dialog.close('cancel');
    toast('Sample workouts added');
  });
  $('clearBtn').addEventListener('click', function () {
    if (!state.workouts.length) { toast('Nothing to delete'); return; }
    if (!window.confirm('Delete all ' + state.workouts.length + ' workouts? This cannot be undone.')) return;
    state.workouts = [];
    persist();
    resetForm();
    render();
    dialog.close('cancel');
    toast('All workouts deleted');
  });

  function addSamples() {
    var t = new Date();
    function d(n) { return isoDate(addDays(t, n)); }
    var samples = [
      { type: 'running', date: d(-3), time: '06:30', measure: 'distance', value: 6, intensity: 'moderate', notes: 'Tel Aviv promenade, easy pace', completed: true },
      { type: 'workout', date: d(-2), time: '19:00', measure: 'duration', value: 50, intensity: 'vigorous', notes: 'Push day: bench, OHP, dips', completed: true },
      { type: 'walking', date: d(-1), time: '18:15', measure: 'distance', value: 4, intensity: 'moderate', notes: '', completed: true },
      t.getHours() >= 8 ? { type: 'workout', date: d(0), time: '07:00', measure: 'duration', value: 30, intensity: 'moderate', notes: 'Morning mobility + core', completed: true } : null,
      { type: 'cycling', date: d(0), time: '17:30', measure: 'distance', value: 25, intensity: 'moderate', notes: 'Yarkon Park loop', completed: false },
      { type: 'running', date: d(1), time: '06:30', measure: 'duration', value: 40, intensity: 'light', notes: 'Recovery run', completed: false },
      { type: 'workout', date: d(1), time: '19:00', measure: 'duration', value: 45, intensity: 'moderate', notes: 'Pull day + core', completed: false },
      { type: 'walking', date: d(3), time: '08:00', measure: 'duration', value: 60, intensity: 'light', notes: 'Weekend walk', completed: false },
      { type: 'cycling', date: d(4), time: '07:00', measure: 'distance', value: 40, intensity: 'vigorous', notes: '', completed: false }
    ];
    samples.filter(Boolean).forEach(function (s) {
      state.workouts.push(Object.assign({ id: uid(), createdAt: Date.now(), completedAt: s.completed ? Date.now() : null }, s));
    });
    persist();
    render();
  }

  // ---------- toast ----------
  var toastTimer = null, toastUndoFn = null;
  function toast(msg, undoFn) {
    var t = $('toast');
    $('toastText').textContent = msg;
    toastUndoFn = undoFn || null;
    $('toastUndo').hidden = !undoFn;
    t.hidden = false;
    t.classList.remove('show'); void t.offsetWidth; t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.hidden = true; }, 250); }, undoFn ? 6000 : 3000);
  }
  $('toastUndo').addEventListener('click', function () {
    if (toastUndoFn) toastUndoFn();
    toastUndoFn = null;
    $('toast').classList.remove('show');
    $('toast').hidden = true;
  });

  // ---------- init ----------
  resetForm();
  render();
  showQuote();
  // keep "Today"/"overdue" labels fresh if the tab stays open
  setInterval(render, 60 * 1000);

  // test hook
  window.__momentum = { state: state, render: render, addSamples: addSamples };
})();
