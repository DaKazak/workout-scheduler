/* Momentum — main app (ES module). Works in two modes:
   - remote: Supabase auth + Postgres (multi-user, groups, leaderboards)
   - local:  this-device-only (localStorage), same planner as v1 + personal badges/records */
'use strict';

const Calc = window.WorkoutCalc;
const Ach = window.Achievements;
const QUOTES = window.WORKOUT_QUOTES || [];
const CFG = window.MOMENTUM_CONFIG || {};
const { t } = window.I18N;
const SUPABASE_CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/+esm';

const KEY_LOCAL = 'momentum.v1.workouts';
const KEY_SETTINGS = 'momentum.v1.settings';
const KEY_MODE = 'momentum.mode';
const KEY_GROUP = 'momentum.group';
const TYPE_LABEL = { running: 'Running', workout: 'Workout', walking: 'Walking', cycling: 'Cycling' };
const TYPE_VERB = { running: 'ran', workout: 'trained', walking: 'walked', cycling: 'rode' };
const EMOJIS = ['🏃', '🏃‍♀️', '🚴', '🚶', '🏋️', '💪', '🔥', '⚡', '🦁', '🐺', '🦅', '🐆', '🌟', '🚀', '🏆', '🎯'];
const GROUP_EMOJIS = ['🔥', '🏆', '⚡', '🏃', '🚴', '💪', '🌊', '⛰️', '🦁', '🐺', '🚀', '🎯'];
const COLORS = ['#c6ff3d', '#22d3ee', '#ff6b3d', '#a78bfa', '#34d399', '#38bdf8', '#f472b6', '#facc15'];
const CHEERS = ['👏', '🔥', '💪'];
const METRIC_UNIT = { distance: 'km', minutes: 'min', kcal: 'kcal', workouts: 'workouts' };

// ---------- state ----------
const state = {
  mode: null,            // 'remote' | 'local'
  sb: null,              // supabase client
  user: null,
  profile: null,
  settings: Object.assign({ weightKg: 70 }, loadJSON(KEY_SETTINGS, {})),
  workouts: [],
  cheersOnMine: {},      // workout_id -> [{emoji, name}]
  groups: [],            // [{...group, role}]
  groupId: null,
  groupData: null,       // loaded group view data
  dailyGoals: null,      // current group's daily goals (null = defaults)
  view: 'home',
  feedAll: false,
  tab: 'upcoming',
  lbPeriod: 'month',
  editingId: null,
  quoteIndex: -1,
  authTab: 'login',
  pendingJoin: null,
  explore: { list: null, q: '', sport: '', sort: 'active', previewId: null, seq: 0 }
};

// ---------- tiny utils ----------
function loadJSON(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { toast(t('err.storage')); }
}
const $ = (id) => document.getElementById(id);
function el(tag, attrs, children) {
  const n = document.createElement(tag);
  if (attrs) for (const k of Object.keys(attrs)) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v; // static, trusted markup only
    else if (k === 'style') n.setAttribute('style', v);
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  (children || []).forEach((c) => { if (c != null && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
  return n;
}
function clear(node) { node.textContent = ''; return node; }
function today() { return Calc.isoDate(new Date()); }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function weight() {
  const w = Number(state.profile ? state.profile.weight_kg : state.settings.weightKg);
  return isFinite(w) && w >= 25 && w <= 300 ? w : 70;
}
function fmtNum(n, d) {
  d = d == null ? 1 : d;
  const r = Math.round(n * Math.pow(10, d)) / Math.pow(10, d);
  return r.toLocaleString('en-US', { maximumFractionDigits: d });
}
function fmtInt(n) { return Math.round(n || 0).toLocaleString('en-US'); }
function fmtMinutes(min) {
  min = Math.round(min);
  if (min < 60) return min + ' min';
  const h = Math.floor(min / 60), m = min % 60;
  return h + ' h' + (m ? ' ' + m + ' min' : '');
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
const dayFmt = new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });
const shortFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });
function dayLabel(dateStr) {
  const td = today();
  if (dateStr === td) return t('day.today');
  if (dateStr === Calc.addDays(td, 1)) return t('day.tomorrow');
  if (dateStr === Calc.addDays(td, -1)) return t('day.yesterday');
  return dayFmt.format(Calc.parseLocal(dateStr));
}
function shortDate(d) { return shortFmt.format(Calc.parseLocal(d)); }
function monthName(d) { return monthFmt.format(Calc.parseLocal(d)); }
function timeAgo(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return t('ago.now');
  if (s < 3600) return t('ago.min', { n: Math.floor(s / 60) });
  if (s < 86400) return t('ago.hour', { n: Math.floor(s / 3600) });
  return t('ago.day', { n: Math.floor(s / 86400) });
}
function avatar(p, size) {
  const a = el('span', { class: 'avatar' + (size ? ' ' + size : ''), text: (p && p.avatar_emoji) || '🏃' });
  a.style.setProperty('--ac', (p && p.avatar_color) || '#c6ff3d');
  return a;
}
function errMsg(e) {
  if (!e) return t('err.generic');
  const m = e.message || String(e);
  if (/Failed to fetch|NetworkError/i.test(m)) return t('err.network');
  return m;
}
function showErr(id, msg) { const n = $(id); n.textContent = msg; n.hidden = !msg; }
function isAdmin() { const g = currentGroup(); return !!g && g.role === 'admin'; }
function currentGroup() { return state.groups.find((g) => g.id === state.groupId) || null; }
function openDialog(d) { if (d.showModal) { if (!d.open) d.showModal(); } else d.setAttribute('open', ''); }

const ICON = {
  check: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M9 16.2l-3.5-3.5L4 14.2l5 5 11-11-1.5-1.5z"/></svg>',
  undo: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12.5 8c-2.6 0-5 1-6.9 2.6L2 7v9h9l-3.6-3.6A8 8 0 0 1 20.1 16l2.4-.8A10.5 10.5 0 0 0 12.5 8z"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M3 17.2V21h3.8l11-11-3.8-3.8-11 11zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.8 3.8L20.7 7z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>'
};

// ======================================================================
// Data layer
// ======================================================================
const WORKOUT_FIELDS = 'id,type,date,time,tz,measure,distance_km,duration_min,intensity,notes,completed,completed_at,est_minutes,kcal,effort_points,eligible,created_at';
const TZ = (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'Asia/Jerusalem';

function rowToWorkout(r) {
  return Object.assign({}, r, {
    time: String(r.time || '07:00').slice(0, 5),
    distance_km: r.distance_km == null ? null : Number(r.distance_km),
    duration_min: r.duration_min == null ? null : Number(r.duration_min)
  });
}
function workoutToRow(w) {
  return {
    type: w.type, date: w.date, time: w.time, tz: TZ, measure: Calc.effectiveMeasure(w),
    distance_km: w.distance_km || null, duration_min: w.duration_min || null,
    intensity: w.intensity || 'moderate', notes: w.notes || null, completed: !!w.completed
  };
}

const local = {
  load() {
    const list = loadJSON(KEY_LOCAL, []);
    if (!Array.isArray(list)) return [];
    return list.filter((w) => w && typeof w.id === 'string' && TYPE_LABEL[w.type] && /^\d{4}-\d{2}-\d{2}$/.test(w.date))
      .map((w) => {
        const n = Calc.normalize(w);
        if (n.completed && !n.completed_at && n.completedAt) n.completed_at = new Date(n.completedAt).toISOString();
        delete n.completedAt;
        return n;
      });
  },
  save(list) { saveJSON(KEY_LOCAL, list); }
};

const store = {
  async loadAll() {
    if (state.mode === 'remote') {
      const { data, error } = await state.sb.from('workouts').select(WORKOUT_FIELDS).order('date').order('time');
      if (error) throw error;
      state.workouts = data.map(rowToWorkout);
      await store.loadCheersOnMine();
    } else {
      state.workouts = local.load();
    }
  },
  async loadCheersOnMine() {
    const mine = new Set(state.workouts.filter((w) => w.completed).map((w) => w.id));
    state.cheersOnMine = {};
    if (!mine.size) return;
    const { data, error } = await state.sb.from('cheers').select('workout_id,emoji,user_id,profiles(display_name)').neq('user_id', state.user.id);
    if (error) return;
    data.forEach((c) => {
      if (!mine.has(c.workout_id)) return;
      (state.cheersOnMine[c.workout_id] = state.cheersOnMine[c.workout_id] || []).push({ emoji: c.emoji, name: c.profiles ? c.profiles.display_name : '' });
    });
  },
  async add(w) {
    if (state.mode === 'remote') {
      const { data, error } = await state.sb.from('workouts').insert(workoutToRow(w)).select(WORKOUT_FIELDS).single();
      if (error) throw error;
      state.workouts.push(rowToWorkout(data));
      return rowToWorkout(data);
    }
    checkFutureComplete(w);
    const nw = Object.assign({ id: uid(), created_at: new Date().toISOString() }, w, { completed_at: w.completed ? new Date().toISOString() : null });
    state.workouts.push(nw); local.save(state.workouts);
    return nw;
  },
  async update(id, patch) {
    const cur = state.workouts.find((w) => w.id === id);
    if (!cur) return null;
    const next = Object.assign({}, cur, patch);
    if (state.mode === 'remote') {
      const { data, error } = await state.sb.from('workouts').update(workoutToRow(next)).eq('id', id).select(WORKOUT_FIELDS).single();
      if (error) throw error;
      Object.assign(cur, rowToWorkout(data));
      return cur;
    }
    if (next.completed && !cur.completed) { checkFutureComplete(next); next.completed_at = new Date().toISOString(); }
    if (next.completed && cur.completed) checkFutureComplete(Object.assign({}, next, { _at: Date.parse(cur.completed_at) }));
    if (!next.completed) next.completed_at = null;
    Object.assign(cur, next); local.save(state.workouts);
    return cur;
  },
  async remove(id) {
    if (state.mode === 'remote') {
      const { error } = await state.sb.from('workouts').delete().eq('id', id);
      if (error) throw error;
    }
    state.workouts = state.workouts.filter((w) => w.id !== id);
    if (state.mode !== 'remote') local.save(state.workouts);
  },
  async removeAll() {
    if (state.mode === 'remote') {
      const { error } = await state.sb.from('workouts').delete().eq('user_id', state.user.id);
      if (error) throw error;
    }
    state.workouts = [];
    if (state.mode !== 'remote') local.save(state.workouts);
  },
  async addMany(list) {
    if (state.mode === 'remote') {
      const { data, error } = await state.sb.from('workouts').insert(list.map(workoutToRow)).select(WORKOUT_FIELDS);
      if (error) throw error;
      data.forEach((r) => state.workouts.push(rowToWorkout(r)));
      return data.length;
    }
    list.forEach((w) => state.workouts.push(Object.assign({ id: uid(), created_at: new Date().toISOString(), completed_at: w.completed ? new Date().toISOString() : null }, w)));
    local.save(state.workouts);
    return list.length;
  }
};

function checkFutureComplete(w) {
  if (!w.completed) return;
  const ref = w._at || Date.now();
  if (Calc.startsAtMs(w) > ref + Calc.POINTS.futureGraceMin * 60000) throw new Error(t('err.future'));
}

// ======================================================================
// Planner: form
// ======================================================================
const form = $('workoutForm');

function formValues() {
  const fd = new FormData(form);
  const type = fd.get('type');
  const allowsDist = Calc.TYPES[type].allowsDistance;
  const measure = allowsDist ? fd.get('measure') : 'duration';
  const primary = parseFloat(String(fd.get('value') || '').replace(',', '.'));
  const secondary = parseFloat(String(fd.get('secondary') || '').replace(',', '.'));
  const w = {
    type, date: fd.get('date'), time: fd.get('time'), measure,
    intensity: fd.get('intensity') || 'moderate', notes: String(fd.get('notes') || '').trim(),
    distance_km: null, duration_min: null, completed: $('doneInput').checked
  };
  if (measure === 'distance') { w.distance_km = primary > 0 ? primary : null; w.duration_min = secondary > 0 ? secondary : null; }
  else { w.duration_min = primary > 0 ? primary : null; w.distance_km = allowsDist && secondary > 0 ? secondary : null; }
  w._primary = primary;
  return w;
}

function syncFormUI() {
  const type = form.elements.type.value;
  const allowsDistance = Calc.TYPES[type].allowsDistance;
  const distRadio = form.querySelector('input[name=measure][value=distance]');
  const durRadio = form.querySelector('input[name=measure][value=duration]');
  distRadio.disabled = !allowsDistance;
  if (!allowsDistance) durRadio.checked = true;
  distRadio.parentElement.classList.toggle('disabled', !allowsDistance);
  $('measureHint').hidden = allowsDistance;
  const isDist = form.elements.measure.value === 'distance';
  $('valueLabel').textContent = isDist ? t('form.distance') : t('form.duration');
  const input = $('valueInput');
  input.step = isDist ? '0.1' : '1';
  input.min = isDist ? '0.1' : '1';
  input.max = isDist ? '500' : '1440';
  input.placeholder = isDist ? (type === 'cycling' ? 'e.g. 25' : 'e.g. 5') : 'e.g. 45';
  $('secondaryField').hidden = !allowsDistance;
  $('secondaryLabel').innerHTML = '';
  $('secondaryLabel').append(isDist ? t('form.timeTaken') : t('form.distanceCovered'), ' ', el('em', { text: t('form.optionalPR') }));
  $('secondaryInput').step = isDist ? '1' : '0.1';
  $('secondaryInput').placeholder = isDist ? 'e.g. 28' : 'e.g. 4.5';
  updateDoneAvailability();
  updateEstimate();
}

function updateDoneAvailability() {
  const d = $('dateInput').value, tm = $('timeInput').value;
  const future = d && tm && Calc.startsAtMs({ date: d, time: tm }) > Date.now() + Calc.POINTS.futureGraceMin * 60000;
  const editingDone = state.editingId && (state.workouts.find((w) => w.id === state.editingId) || {}).completed;
  $('doneField').hidden = !!editingDone;
  $('doneInput').disabled = future;
  if (future) $('doneInput').checked = false;
  $('doneField').classList.toggle('disabled', future);
  $('submitBtn').textContent = state.editingId ? t('form.save') : ($('doneInput').checked ? t('form.log') : t('form.add'));
}

function updateEstimate() {
  const v = formValues();
  let kcal = 0, detail = t('form.enterValue'), pts = '';
  if (v._primary > 0) {
    kcal = Calc.calories(v, weight());
    const p = Calc.profile(v.type, v.intensity);
    const mins = Calc.durationMinutes(v);
    detail = 'MET ' + p.met + ' × ' + fmtNum(weight()) + ' kg × ' + fmtNum(mins / 60, 2) + ' h';
    if (v.distance_km && !v.duration_min) detail += ' (≈ ' + fmtMinutes(mins) + ' at ' + Calc.paceLabel(v.type, v.intensity) + ')';
    if (v.distance_km && v.duration_min && v.type !== 'cycling') detail += ' · ' + Calc.fmtPace(v.duration_min / v.distance_km);
    pts = t('form.pts', { n: Calc.workoutPoints(v) });
  }
  $('estKcal').textContent = fmtInt(kcal);
  $('estDetail').textContent = detail;
  $('estPts').textContent = pts;
}

function validate(v) {
  if (!v.date) return t('val.date');
  if (!v.time) return t('val.time');
  if (!(v._primary > 0)) return v.measure === 'distance' ? t('val.distance') : t('val.duration');
  if (v.distance_km && v.distance_km > 500) return t('val.tooFar');
  if (v.duration_min && v.duration_min > 1440) return t('val.tooLong');
  const sp = Calc.speedError(v);
  if (sp) return sp;
  if (v.completed && Calc.startsAtMs(v) > Date.now() + Calc.POINTS.futureGraceMin * 60000) return t('err.future');
  return null;
}

function defaultDateTime() {
  const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1);
  return { date: Calc.isoDate(d), time: Calc.pad(d.getHours()) + ':00' };
}

function resetForm() {
  const keepType = form.elements.type.value || 'running';
  form.reset();
  form.querySelector('input[name=type][value=' + keepType + ']').checked = true;
  const dt = defaultDateTime();
  $('dateInput').value = dt.date; $('timeInput').value = dt.time;
  state.editingId = null;
  $('formTitle').textContent = t('form.title');
  $('cancelEditBtn').hidden = true;
  $('formPanel').classList.remove('editing');
  showErr('formError', '');
  syncFormUI();
}

function startEdit(id) {
  const w = state.workouts.find((x) => x.id === id);
  if (!w) return;
  state.editingId = id;
  const m = Calc.effectiveMeasure(w);
  form.querySelector('input[name=type][value=' + w.type + ']').checked = true;
  form.querySelector('input[name=measure][value=' + m + ']').checked = true;
  $('dateInput').value = w.date; $('timeInput').value = w.time;
  $('valueInput').value = m === 'distance' ? (w.distance_km || '') : (w.duration_min || '');
  $('secondaryInput').value = m === 'distance' ? (w.duration_min || '') : (w.distance_km || '');
  $('intensityInput').value = w.intensity || 'moderate';
  $('notesInput').value = w.notes || '';
  $('doneInput').checked = false;
  $('formTitle').textContent = t('form.editTitle');
  $('cancelEditBtn').hidden = false;
  $('formPanel').classList.add('editing');
  showErr('formError', '');
  syncFormUI();
  setView('home');
  $('formPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => $('valueInput').focus({ preventScroll: true }), 300);
}

form.addEventListener('input', (e) => {
  if (e.target.name === 'type' || e.target.name === 'measure') syncFormUI();
  else if (e.target.id === 'dateInput' || e.target.id === 'timeInput' || e.target.id === 'doneInput') { updateDoneAvailability(); updateEstimate(); }
  else updateEstimate();
});
form.addEventListener('change', (e) => {
  if (e.target.name === 'type' || e.target.name === 'measure') syncFormUI();
  if (e.target.id === 'doneInput') updateDoneAvailability();
});
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const v = formValues();
  const err = validate(v);
  if (err) { showErr('formError', err); return; }
  showErr('formError', '');
  delete v._primary;
  const btn = $('submitBtn'); btn.disabled = true;
  try {
    if (state.editingId) {
      const cur = state.workouts.find((w) => w.id === state.editingId);
      v.completed = cur ? cur.completed : false;
      await store.update(state.editingId, v);
      toast(t('toast.updated'));
    } else {
      const w = await store.add(v);
      if (w.completed) toast(t('toast.logged', { type: TYPE_LABEL[w.type], kcal: fmtInt(Calc.kcalOf(w, weight())), pts: Calc.isEligible(w) ? Calc.workoutPoints(w) : 0 }));
      else toast(t('toast.scheduled', { type: TYPE_LABEL[v.type], day: dayLabel(v.date).toLowerCase(), time: v.time }));
      setTab(w.completed ? 'history' : 'upcoming');
    }
    resetForm();
    renderAll();
    afterWorkoutChange();
  } catch (ex) {
    showErr('formError', errMsg(ex));
  } finally { btn.disabled = false; }
});
$('cancelEditBtn').addEventListener('click', resetForm);

// ======================================================================
// Planner: list
// ======================================================================
function describe(w) {
  const mins = Calc.durationMinutes(w);
  const sub = [cap(w.intensity || 'moderate')];
  let main;
  if (Calc.effectiveMeasure(w) === 'distance') {
    main = fmtNum(Calc.distanceKm(w), 2) + ' km';
    if (Calc.hasActualTime(w)) {
      sub.push(fmtMinutes(mins));
      if (w.type === 'cycling') sub.push(fmtNum(Calc.distanceKm(w) / (mins / 60)) + ' km/h');
      else sub.push(Calc.fmtPace(mins / Calc.distanceKm(w)));
    } else { sub.push('≈ ' + fmtMinutes(mins)); sub.push(Calc.paceLabel(w.type, w.intensity)); }
  } else {
    main = fmtMinutes(mins);
    if (Calc.distanceKm(w)) sub.push(fmtNum(Calc.distanceKm(w), 2) + ' km');
  }
  return { main, sub: sub.join(' · ') };
}
function isPast(w) { return Calc.startsAtMs(w) < Date.now(); }
function sortKey(w) { return w.date + 'T' + (w.time || '00:00'); }

function card(w) {
  const d = describe(w);
  const kcal = w.completed ? Calc.kcalOf(w, weight()) : Calc.calories(w, weight());
  const overdue = !w.completed && isPast(w);
  const c = el('article', { class: 'card type-' + w.type + (w.completed ? ' done' : '') + (overdue ? ' overdue' : ''), 'data-id': w.id });
  c.appendChild(el('img', { class: 'thumb', src: 'img/' + w.type + '-thumb.jpg', alt: TYPE_LABEL[w.type], loading: 'lazy', width: '480', height: '360' }));
  const eligible = Calc.isEligible(w);
  const cheers = state.cheersOnMine[w.id] || [];
  c.appendChild(el('div', { class: 'card-body' }, [
    el('div', { class: 'card-meta' }, [
      el('span', { class: 'badge', text: TYPE_LABEL[w.type] }),
      el('span', { class: 'time', text: w.time }),
      overdue ? el('span', { class: 'flag', text: t('card.missed') }) : null,
      w.completed ? el('span', { class: 'flag ok', text: t('card.done') }) : null,
      w.completed ? el('span', { class: 'flag pts' + (eligible ? '' : ' none'), title: eligible ? '' : t('card.latePts'), text: eligible ? '+' + Calc.workoutPoints(w) + ' pts' : t('card.noPts') }) : null
    ]),
    el('h3', { text: d.main }),
    el('p', { class: 'sub', text: d.sub }),
    w.notes ? el('p', { class: 'notes', text: w.notes }) : null,
    cheers.length ? el('p', { class: 'cheers-got', title: cheers.map((x) => x.name + ' ' + x.emoji).join(', '),
      text: cheers.map((x) => x.emoji).join('') + ' ' + t('card.cheers', { names: cheers.map((x) => x.name).slice(0, 3).join(', ') }) }) : null
  ]));
  c.appendChild(el('div', { class: 'kcal', title: t('card.kcalTitle') }, [el('strong', { text: fmtInt(kcal) }), el('span', { text: 'kcal' })]));
  const future = !w.completed && Calc.startsAtMs(w) > Date.now() + Calc.POINTS.futureGraceMin * 60000;
  c.appendChild(el('div', { class: 'actions' }, [
    el('button', { type: 'button', class: 'act complete' + (future ? ' locked' : ''), 'data-act': 'complete',
      'aria-label': w.completed ? t('card.undoComplete') : t('card.complete'),
      title: w.completed ? t('card.undoComplete') : (future ? t('card.futureLocked') : t('card.complete')), html: w.completed ? ICON.undo : ICON.check }),
    el('button', { type: 'button', class: 'act', 'data-act': 'edit', 'aria-label': t('card.edit'), title: t('card.edit'), html: ICON.edit }),
    el('button', { type: 'button', class: 'act del', 'data-act': 'delete', 'aria-label': t('card.delete'), title: t('card.delete'), html: ICON.trash })
  ]));
  return c;
}

function groupByDay(list) {
  const groups = [], map = {};
  list.forEach((w) => { if (!map[w.date]) { map[w.date] = { date: w.date, items: [] }; groups.push(map[w.date]); } map[w.date].items.push(w); });
  return groups;
}
function dayTotals(items) {
  let kcal = 0, min = 0;
  items.forEach((w) => { kcal += w.completed ? Calc.kcalOf(w, weight()) : Calc.calories(w, weight()); min += Calc.durationMinutes(w); });
  return fmtMinutes(min) + ' · ' + fmtInt(kcal) + ' kcal';
}
function renderList(container, list, emptyHtml) {
  clear(container);
  if (!list.length) { container.appendChild(el('div', { class: 'empty', html: emptyHtml })); return; }
  groupByDay(list).forEach((g) => {
    const section = el('section', { class: 'day' }, [
      el('header', { class: 'day-head' }, [
        el('h4', { text: dayLabel(g.date) }),
        el('span', { text: (g.items.length > 1 ? g.items.length + ' workouts · ' : '') + dayTotals(g.items) })
      ])
    ]);
    g.items.forEach((w) => section.appendChild(card(w)));
    container.appendChild(section);
  });
}

function renderPlanner() {
  const upcoming = state.workouts.filter((w) => !w.completed).sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
  const history = state.workouts.filter((w) => w.completed).sort((a, b) => (sortKey(a) > sortKey(b) ? -1 : sortKey(a) < sortKey(b) ? 1 : 0));
  renderList($('upcomingList'), upcoming, '<div class="empty-icon">🗓️</div><p><b>' + t('empty.upcoming') + '</b></p><p>' + t('empty.upcomingSub') + '</p>');
  const histBox = $('historyList');
  renderList(histBox, history, '<div class="empty-icon">🏁</div><p><b>' + t('empty.history') + '</b></p><p>' + t('empty.historySub') + '</p>');
  if (history.length) {
    let km = 0, min = 0, kcal = 0;
    history.forEach((w) => { km += Calc.distanceKm(w); min += Calc.durationMinutes(w); kcal += Calc.kcalOf(w, weight()); });
    histBox.insertBefore(el('div', { class: 'history-total' }, [
      el('span', { text: t('hist.allTime') }), el('b', { text: history.length + ' workouts' }), el('b', { text: fmtNum(km) + ' km' }),
      el('b', { text: fmtMinutes(min) }), el('b', { class: 'k', text: fmtInt(kcal) + ' kcal' })
    ]), histBox.firstChild);
  }
  $('upcomingCount').textContent = upcoming.length;
  $('historyCount').textContent = history.length;
  renderHero(upcoming);
}

async function onListClick(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.closest('.card').getAttribute('data-id');
  const act = btn.getAttribute('data-act');
  if (act === 'edit') return startEdit(id);
  if (act === 'complete') return toggleComplete(id);
  if (act === 'delete') return removeWorkout(id);
}
$('upcomingList').addEventListener('click', onListClick);
$('historyList').addEventListener('click', onListClick);

async function toggleComplete(id) {
  const w = state.workouts.find((x) => x.id === id);
  if (!w) return;
  try {
    const res = await store.update(id, { completed: !w.completed });
    renderAll();
    if (res.completed) {
      toast(Calc.isEligible(res) ? t('toast.done', { kcal: fmtInt(Calc.kcalOf(res, weight())), pts: Calc.workoutPoints(res) }) : t('toast.doneLate', { kcal: fmtInt(Calc.kcalOf(res, weight())) }));
    } else toast(t('toast.back'));
    afterWorkoutChange();
  } catch (ex) { toast(errMsg(ex)); }
}

async function removeWorkout(id) {
  const removed = state.workouts.find((w) => w.id === id);
  if (!removed) return;
  try {
    await store.remove(id);
    if (state.editingId === id) resetForm();
    renderAll(); afterWorkoutChange();
    toast(t('toast.deleted'), async () => {
      try {
        if (state.mode === 'remote') { await store.add(Object.assign({}, removed)); }
        else { state.workouts.push(removed); local.save(state.workouts); }
        renderAll(); afterWorkoutChange();
      } catch (ex) { toast(errMsg(ex)); }
    });
  } catch (ex) { toast(errMsg(ex)); }
}

function setTab(tab) {
  state.tab = tab;
  const up = tab === 'upcoming';
  $('tabUpcoming').classList.toggle('active', up); $('tabHistory').classList.toggle('active', !up);
  $('tabUpcoming').setAttribute('aria-selected', String(up)); $('tabHistory').setAttribute('aria-selected', String(!up));
  $('upcomingList').hidden = !up; $('historyList').hidden = up;
}
$('tabUpcoming').addEventListener('click', () => setTab('upcoming'));
$('tabHistory').addEventListener('click', () => setTab('history'));

// ======================================================================
// Stats, goals rings, hero
// ======================================================================
function goalsForMe() { return state.dailyGoals && state.dailyGoals.length ? state.dailyGoals : Calc.DEFAULT_GOALS; }

function renderStats() {
  const td = today(), ws = Calc.startOfWeek(td), we = Calc.addDays(ws, 6);
  const done = { n: 0, km: 0, min: 0, kcal: 0 }, planned = { n: 0, km: 0, min: 0, kcal: 0 };
  state.workouts.forEach((w) => {
    if (w.date < ws || w.date > we) return;
    const tt = w.completed ? done : planned;
    tt.n++; tt.km += Calc.distanceKm(w); tt.min += Calc.durationMinutes(w);
    tt.kcal += w.completed ? Calc.kcalOf(w, weight()) : Calc.calories(w, weight());
  });
  $('statCount').textContent = done.n;
  $('statCountSub').textContent = t('stat.donePlanned', { n: planned.n });
  $('statKm').textContent = fmtNum(done.km);
  $('statKmSub').textContent = t('stat.kmDone') + (planned.km ? ' · +' + fmtNum(planned.km) + ' ' + t('stat.planned') : '');
  $('statMin').textContent = fmtInt(done.min);
  $('statMinSub').textContent = t('stat.minDone') + (planned.min ? ' · +' + fmtInt(planned.min) + ' ' + t('stat.planned') : '');
  $('statKcal').textContent = fmtInt(done.kcal);
  $('statKcalSub').textContent = t('stat.kcalDone') + (planned.kcal ? ' · +' + fmtInt(planned.kcal) + ' ' + t('stat.planned') : '');
  const scores = Calc.scoreDays(state.workouts, goalsForMe(), weight());
  const pw = Calc.sumPoints(scores, ws, we);
  $('statPts').textContent = fmtInt(pw.total);
  $('statPtsSub').textContent = t('stat.ptsSub', { today: fmtInt((scores[td] ? scores[td].workoutPts + scores[td].goalPts + scores[td].streakPts : 0)) });
  const st = Calc.streaks(state.workouts, td);
  $('statStreak').textContent = st.current;
  $('statStreakSub').textContent = st.current ? (st.activeToday ? t('stat.streakOn') : t('stat.streakKeep')) : t('stat.streakBest', { n: st.best });
}

function goalValue(g, list) {
  let v = 0;
  list.forEach((w) => { if (!g.activity_type || g.activity_type === w.type) v += Calc.metricValue(g.metric, w, weight()); });
  return v;
}
function fmtMetric(metric, v) {
  if (metric === 'distance') return fmtNum(v) + ' km';
  if (metric === 'minutes') return fmtInt(v) + ' min';
  if (metric === 'kcal') return fmtInt(v) + ' kcal';
  return fmtInt(v) + (Math.round(v) === 1 ? ' workout' : ' workouts');
}
const GOAL_ICON = { distance: '📍', minutes: '⏱️', kcal: '🔥', workouts: '✅' };
const RING_COLORS = ['#c6ff3d', '#22d3ee', '#ff7a45', '#a78bfa', '#34d399', '#f472b6'];

function ring(pct, color, inner) {
  const r = 34, c = 2 * Math.PI * r, p = Math.max(0, Math.min(1, pct));
  const wrap = el('div', { class: 'ring' + (p >= 1 ? ' full' : '') });
  wrap.innerHTML = '<svg viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="' + r + '" class="ring-bg"/>' +
    '<circle cx="40" cy="40" r="' + r + '" class="ring-fg" style="opacity:' + (p > 0 ? 1 : 0) + ';stroke:' + color + ';stroke-dasharray:' + (c * p).toFixed(1) + ' ' + c.toFixed(1) + '"/></svg>';
  wrap.appendChild(el('span', { class: 'ring-inner', text: inner }));
  return wrap;
}

function renderGoals() {
  const goals = goalsForMe();
  const mine = state.workouts.filter((w) => w.completed && w.date === today() && Calc.isEligible(w));
  const box = clear($('myRings'));
  let hits = 0;
  goals.forEach((g, i) => {
    const v = goalValue(g, mine), pct = v / g.target;
    if (pct >= 1) hits++;
    box.appendChild(el('div', { class: 'goal' }, [
      ring(pct, RING_COLORS[i % RING_COLORS.length], pct >= 1 ? '✓' : Math.round(Math.min(pct, 1) * 100) + '%'),
      el('div', { class: 'goal-text' }, [
        el('b', { text: (GOAL_ICON[g.metric] || '') + ' ' + g.label }),
        el('span', { text: fmtMetric(g.metric, v) + ' / ' + fmtMetric(g.metric, g.target) })
      ])
    ]));
  });
  const bonus = hits * Calc.POINTS.perGoal + (hits === goals.length && goals.length ? Calc.POINTS.allGoalsBonus : 0);
  box.appendChild(el('div', { class: 'goal-bonus' }, [el('strong', { text: '+' + bonus }), el('span', { text: t('goals.bonus', { hits, n: goals.length }) })]));
  const g = currentGroup();
  $('goalsSource').textContent = g && state.dailyGoals && state.dailyGoals.length ? t('goals.setBy', { name: g.name }) : t('goals.default');
}

function renderHero(upcoming) {
  const h = new Date().getHours();
  const name = state.profile ? ', ' + state.profile.display_name : '';
  $('greeting').textContent = (h < 5 ? t('hello.night') : h < 12 ? t('hello.morning') : h < 18 ? t('hello.afternoon') : t('hello.evening')) + name;
  const next = upcoming.filter((w) => !isPast(w))[0];
  const types = ['running', 'workout', 'walking', 'cycling'];
  document.querySelectorAll('.hero-tiles .tile').forEach((tile, i) => tile.classList.toggle('focus', !!next && types[i] === next.type));
  if (next) $('nextUp').textContent = t('hero.next', { type: TYPE_LABEL[next.type], what: describe(next).main, day: dayLabel(next.date), time: next.time });
  else $('nextUp').textContent = upcoming.length ? t('hero.missed') : t('hero.none');
}

// ---------- quotes ----------
function showQuote(step) {
  if (!QUOTES.length) return;
  const i = state.quoteIndex < 0 ? Math.floor(Math.random() * QUOTES.length) : (state.quoteIndex + (step || 1)) % QUOTES.length;
  state.quoteIndex = i;
  const q = QUOTES[i], box = $('quoteBox');
  box.classList.remove('swap'); void box.offsetWidth; box.classList.add('swap');
  $('quoteText').textContent = '\u201C' + q.text + '\u201D';
  $('quoteAuthor').textContent = '— ' + (q.author || t('quote.unknown'));
}
$('nextQuoteBtn').addEventListener('click', () => showQuote(1 + Math.floor(Math.random() * 3)));

// ---------- toast ----------
let toastTimer = null, toastUndoFn = null;
function toast(msg, undoFn) {
  const tt = $('toast');
  $('toastText').textContent = msg;
  toastUndoFn = undoFn || null;
  $('toastUndo').hidden = !undoFn;
  tt.hidden = false;
  tt.classList.remove('show'); void tt.offsetWidth; tt.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { tt.classList.remove('show'); setTimeout(() => { tt.hidden = true; }, 250); }, undoFn ? 6000 : 3200);
}
$('toastUndo').addEventListener('click', () => {
  const fn = toastUndoFn; toastUndoFn = null;
  $('toast').classList.remove('show'); $('toast').hidden = true;
  if (fn) fn();
});

// ======================================================================
// Groups
// ======================================================================
async function loadGroups() {
  const { data, error } = await state.sb.from('group_members').select('role, groups(id,name,emoji,color,invite_code,created_by,created_at,visibility,description)').eq('user_id', state.user.id);
  if (error) throw error;
  state.groups = data.filter((r) => r.groups).map((r) => Object.assign({}, r.groups, { role: r.role }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const saved = localStorage.getItem(KEY_GROUP);
  if (!state.groups.find((g) => g.id === state.groupId)) {
    state.groupId = (state.groups.find((g) => g.id === saved) || state.groups[0] || {}).id || null;
  }
  renderGroupSwitcher();
  await loadDailyGoals();
}

async function loadDailyGoals() {
  state.dailyGoals = null;
  if (!state.groupId) return;
  const { data } = await state.sb.from('group_daily_goals').select('*').eq('group_id', state.groupId).order('position').order('created_at');
  state.dailyGoals = (data || []).map((g) => Object.assign({}, g, { target: Number(g.target) }));
}

function renderGroupSwitcher() {
  const sel = clear($('groupSelect'));
  $('groupSwitchWrap').hidden = state.mode !== 'remote';
  state.groups.forEach((g) => sel.appendChild(el('option', { value: g.id, text: g.emoji + ' ' + g.name })));
  sel.appendChild(el('option', { value: '__new', text: t('group.newOption') }));
  if (state.groupId) sel.value = state.groupId; else sel.value = '__new';
  if (!state.groups.length) sel.insertBefore(el('option', { value: '', text: t('group.none'), selected: true }), sel.firstChild);
}
$('groupSelect').addEventListener('change', async (e) => {
  const v = e.target.value;
  if (v === '__new') { renderGroupSwitcher(); openGroupDialog(); return; }
  if (!v) return;
  await switchGroup(v);
});

async function switchGroup(id) {
  state.groupId = id;
  localStorage.setItem(KEY_GROUP, id);
  state.groupData = null;
  renderGroupSwitcher();
  await loadDailyGoals();
  renderAll();
  await refreshGroup();
}

function periodRange(p) {
  const td = today();
  if (p === 'week') { const s = Calc.startOfWeek(td); return { from: s, to: Calc.addDays(s, 6) }; }
  if (p === 'month') return { from: Calc.startOfMonth(td), to: Calc.endOfMonth(td) };
  return { from: null, to: null };
}

let groupLoadSeq = 0;
async function refreshGroup() {
  if (state.mode !== 'remote' || !state.groupId) { renderGroupView(); return; }
  const gid = state.groupId, seq = ++groupLoadSeq, sb = state.sb, td = today();
  const r = periodRange(state.lbPeriod);
  try {
    const [lb, members, goals, goalProg, chs, parts, standings, feed, hof, todayProg] = await Promise.all([
      sb.rpc('leaderboard', { p_group: gid, p_from: r.from, p_to: r.to, p_today: td }),
      sb.from('group_members').select('user_id, role, joined_at, profiles(display_name, avatar_emoji, avatar_color)').eq('group_id', gid).order('joined_at'),
      sb.from('group_goals').select('*').eq('group_id', gid).order('end_date'),
      sb.rpc('group_goal_progress', { p_group: gid }),
      sb.from('challenges').select('*').eq('group_id', gid).order('end_date'),
      sb.from('challenge_participants').select('challenge_id, user_id'),
      sb.rpc('challenge_standings', { p_group: gid }),
      sb.rpc('group_feed', { p_group: gid, p_limit: 30 }),
      sb.rpc('monthly_winners', { p_group: gid, p_today: td }),
      sb.rpc('daily_progress', { p_group: gid, p_day: td })
    ]);
    if (seq !== groupLoadSeq) return;
    const firstErr = [lb, members, goals, goalProg, chs, parts, standings, feed, hof, todayProg].find((x) => x.error);
    if (firstErr) throw firstErr.error;
    state.groupData = {
      gid, leaderboard: lb.data, members: members.data, goals: goals.data, goalProgress: goalProg.data,
      challenges: chs.data, participants: parts.data, standings: standings.data, feed: feed.data, hof: hof.data, today: todayProg.data
    };
  } catch (ex) {
    if (seq !== groupLoadSeq) return;
    if (/Not a member/i.test(errMsg(ex))) { await loadGroups(); }
    toast(errMsg(ex));
  }
  renderGroupView();
  renderGroupToday();
  renderWinnerBanners();
}

async function refreshLeaderboardOnly() {
  if (!state.groupData) return refreshGroup();
  const r = periodRange(state.lbPeriod);
  const { data, error } = await state.sb.rpc('leaderboard', { p_group: state.groupId, p_from: r.from, p_to: r.to, p_today: today() });
  if (error) return toast(errMsg(error));
  state.groupData.leaderboard = data;
  renderLeaderboard();
}

let afterTimer = null;
function afterWorkoutChange() {
  if (state.mode !== 'remote') return;
  clearTimeout(afterTimer);
  afterTimer = setTimeout(() => { if (state.groupId) refreshGroup(); }, 400);
}

// ---------- group view rendering ----------
function renderGroupView() {
  const remote = state.mode === 'remote';
  const g = currentGroup();
  $('noGroup').hidden = remote && !!g;
  $('groupContent').hidden = !(remote && g);
  if (!remote) {
    renderNoGroupLocal();
    return;
  }
  $('noGroup').classList.remove('local');
  $('exploreCtaBtn').closest('.panel').hidden = false;
  if (!g) return;
  $('groupEmoji').textContent = g.emoji;
  $('groupEmoji').style.setProperty('--gc', g.color);
  $('groupName').textContent = g.name;
  $('groupDesc').textContent = g.description || '';
  $('groupDesc').hidden = !g.description;
  const d = state.groupData && state.groupData.gid === g.id ? state.groupData : null;
  $('groupMeta').textContent = d ? t('group.meta', { n: d.members.length, role: g.role === 'admin' ? t('group.youAdmin') : t('group.youMember') }) : t('loading');
  document.querySelectorAll('#groupView .admin-only').forEach((n) => { n.hidden = !isAdmin(); });
  if (!d) return;
  renderLeaderboard();
  renderGroupGoals();
  renderChallenges();
  renderFeed();
  renderHall();
}

function renderNoGroupLocal() {
  $('exploreCtaBtn').closest('.panel').hidden = true;
  const box = $('noGroup');
  box.hidden = false;
  box.classList.add('local');
  if (box.dataset.local === '1') return;
  box.dataset.local = '1';
  box.dataset.orig = box.innerHTML;
  clear(box).appendChild(el('div', { class: 'panel cta-card wide' }, [
    el('div', { class: 'cta-emoji', text: '🏆' }),
    el('h2', { text: t('local.groupsTitle') }),
    el('p', { class: 'muted', text: state.sb ? t('local.groupsText') : t('local.noBackend') }),
    state.sb ? el('button', { type: 'button', class: 'primary-btn', text: t('auth.cta'), onclick: () => showAuth() }) : null
  ]));
}
function restoreNoGroup() {
  const box = $('noGroup');
  if (box.dataset.local === '1') { box.innerHTML = box.dataset.orig; box.dataset.local = ''; bindNoGroup(); }
}

function renderLeaderboard() {
  const d = state.groupData; if (!d) return;
  const r = periodRange(state.lbPeriod);
  $('lbRange').textContent = state.lbPeriod === 'all' ? t('lb.all') : t('lb.range', { from: shortDate(r.from), to: shortDate(r.to) });
  const tb = clear($('lbTable').querySelector('tbody'));
  d.leaderboard.forEach((row) => {
    const me = row.user_id === state.user.id;
    const medal = row.points > 0 ? (row.rank === 1 ? '🥇' : row.rank === 2 ? '🥈' : row.rank === 3 ? '🥉' : row.rank) : row.rank;
    const breakdown = t('lb.breakdown', { w: row.workout_points, g: row.goal_points, s: row.streak_points, c: row.challenge_points });
    tb.appendChild(el('tr', { class: me ? 'me' : '', title: breakdown }, [
      el('td', { class: 'rank', text: String(medal) }),
      el('td', { class: 'name-col' }, [el('div', { class: 'who' }, [avatar(row, 'sm'), el('div', { class: 'who-text' }, [
        el('span', null, [row.display_name + (me ? ' ' + t('lb.you') : ''), row.role === 'admin' ? el('em', { class: 'role', text: 'admin' }) : null]),
        el('small', { text: breakdown })])])]),
      el('td', { class: 'pts' }, [el('b', { text: fmtInt(row.points) })]),
      el('td', { text: fmtInt(row.workouts) }),
      el('td', { text: fmtNum(Number(row.km)) }),
      el('td', { text: fmtInt(row.minutes) }),
      el('td', { text: fmtInt(row.kcal) }),
      el('td', { class: 'streak', text: row.current_streak ? '🔥' + row.current_streak : '–' })
    ]));
  });
}
$('lbPeriod').addEventListener('change', (e) => { state.lbPeriod = e.target.value; refreshLeaderboardOnly(); });

function progressBar(segments, total, target, label) {
  const bar = el('div', { class: 'pbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(target), 'aria-valuenow': String(Math.round(total)), 'aria-label': label || '' });
  const denom = Math.max(target, total) || 1;
  segments.forEach((s) => {
    if (s.value <= 0) return;
    const seg = el('span', { class: 'seg', title: s.title || '' });
    seg.style.width = (s.value / denom * 100).toFixed(2) + '%';
    seg.style.background = s.color;
    bar.appendChild(seg);
  });
  return bar;
}

function renderGroupGoals() {
  const d = state.groupData, box = clear($('groupGoals'));
  if (!d.goals.length) {
    box.appendChild(el('p', { class: 'muted empty-small', text: isAdmin() ? t('gg.emptyAdmin') : t('gg.empty') }));
    return;
  }
  d.goals.forEach((g) => {
    const contrib = d.goalProgress.filter((p) => p.goal_id === g.id).map((p) => Object.assign({}, p, { value: Number(p.value) })).sort((a, b) => b.value - a.value);
    const total = contrib.reduce((a, p) => a + p.value, 0);
    const target = Number(g.target);
    const pct = Math.min(100, Math.round(total / target * 100));
    const ended = g.end_date < today(), upcoming = g.start_date > today();
    box.appendChild(el('div', { class: 'gg' + (pct >= 100 ? ' complete' : '') }, [
      el('div', { class: 'gg-head' }, [
        el('b', { text: (pct >= 100 ? '🎉 ' : '') + g.title }),
        el('span', { class: 'muted', text: shortDate(g.start_date) + ' – ' + shortDate(g.end_date) + (ended ? ' · ' + t('gg.ended') : upcoming ? ' · ' + t('gg.upcoming') : '') }),
        isAdmin() ? el('button', { type: 'button', class: 'mini-del', title: t('gg.delete'), 'aria-label': t('gg.delete'), text: '×', onclick: () => deleteRow('group_goals', g.id) }) : null
      ]),
      progressBar(contrib.map((p) => ({ value: p.value, color: p.avatar_color, title: p.display_name + ': ' + fmtMetric(g.metric, p.value) })), total, target, g.title),
      el('div', { class: 'gg-foot' }, [
        el('span', { text: fmtMetric(g.metric, total) + ' / ' + fmtMetric(g.metric, target) + ' · ' + pct + '%' + (g.activity_type ? ' · ' + TYPE_LABEL[g.activity_type] : '') }),
        el('span', { class: 'contrib' }, contrib.filter((p) => p.value > 0).slice(0, 6).map((p) => el('span', { class: 'chip', title: p.display_name }, [avatar(p, 'xs'), fmtMetric(g.metric, p.value).replace(' workouts', '').replace(' workout', '')])))
      ])
    ]));
  });
}

function renderChallenges() {
  const d = state.groupData, box = clear($('challenges'));
  if (!d.challenges.length) {
    box.appendChild(el('p', { class: 'muted empty-small', text: isAdmin() ? t('ch.emptyAdmin') : t('ch.empty') }));
    return;
  }
  const td = today();
  d.challenges.slice().sort((a, b) => (a.end_date < td) - (b.end_date < td) || a.end_date.localeCompare(b.end_date)).forEach((c) => {
    const parts = d.participants.filter((p) => p.challenge_id === c.id);
    const joined = parts.some((p) => p.user_id === state.user.id);
    const st = d.standings.filter((s) => s.challenge_id === c.id);
    const mine = st.find((s) => s.user_id === state.user.id);
    const target = Number(c.target);
    const finishers = st.filter((s) => s.finished_on);
    const ended = c.end_date < td, notStarted = c.start_date > td;
    const daysLeft = Calc.dayDiff(c.end_date, td);
    const status = ended ? t('ch.ended') : notStarted ? t('ch.starts', { d: shortDate(c.start_date) }) : t('ch.left', { n: daysLeft + 1 });
    const myProg = mine ? Number(mine.progress) : 0;
    box.appendChild(el('div', { class: 'challenge' + (ended ? ' ended' : '') + (mine && mine.finished_on ? ' finished' : '') }, [
      el('div', { class: 'ch-head' }, [
        el('span', { class: 'ch-icon', text: c.activity_type ? ({ running: '🏃', workout: '🏋️', walking: '🚶', cycling: '🚴' })[c.activity_type] : '⚡' }),
        el('div', { class: 'ch-title' }, [
          el('b', { text: c.title }),
          el('span', { class: 'muted', text: t('ch.target', { what: fmtMetric(c.metric, target), type: c.activity_type ? TYPE_LABEL[c.activity_type].toLowerCase() : t('ch.any') }) + ' · ' + shortDate(c.start_date) + ' – ' + shortDate(c.end_date) })
        ]),
        el('span', { class: 'reward', text: '+' + c.reward_points + ' pts' })
      ]),
      c.description ? el('p', { class: 'ch-desc', text: c.description }) : null,
      joined ? el('div', { class: 'ch-mine' }, [
        progressBar([{ value: myProg, color: (state.profile && state.profile.avatar_color) || '#c6ff3d' }], myProg, target, c.title),
        el('span', { text: mine && mine.finished_on ? t('ch.youFinished', { d: shortDate(mine.finished_on) }) : t('ch.yourProgress', { v: fmtMetric(c.metric, myProg), tgt: fmtMetric(c.metric, target) }) })
      ]) : null,
      el('div', { class: 'ch-foot' }, [
        el('span', { class: 'muted', text: status + ' · ' + t('ch.joined', { n: parts.length }) + (finishers.length ? ' · 🏁 ' + finishers.map((f) => f.display_name).join(', ') : '') }),
        el('span', { class: 'ch-actions' }, [
          !ended ? el('button', { type: 'button', class: joined ? 'ghost-btn slim' : 'primary-btn slim', text: joined ? t('ch.leave') : t('ch.join'), onclick: () => toggleChallenge(c.id, joined) }) : null,
          isAdmin() ? el('button', { type: 'button', class: 'mini-del', title: t('ch.delete'), 'aria-label': t('ch.delete'), text: '×', onclick: () => deleteRow('challenges', c.id) }) : null
        ])
      ]),
      st.length > 1 ? el('ol', { class: 'ch-standings' }, st.slice(0, 5).map((s) => el('li', null, [avatar(s, 'xs'), el('span', { text: s.display_name }), el('b', { text: s.finished_on ? '🏁' : Math.round(Number(s.progress) / target * 100) + '%' })]))) : null
    ]));
  });
}

async function toggleChallenge(id, joined) {
  const q = joined
    ? state.sb.from('challenge_participants').delete().eq('challenge_id', id).eq('user_id', state.user.id)
    : state.sb.from('challenge_participants').insert({ challenge_id: id, user_id: state.user.id });
  const { error } = await q;
  if (error) return toast(errMsg(error));
  toast(joined ? t('ch.leftToast') : t('ch.joinedToast'));
  refreshGroup();
}

async function deleteRow(table, id) {
  if (!window.confirm(t('confirm.delete'))) return;
  const { error } = await state.sb.from(table).delete().eq('id', id);
  if (error) return toast(errMsg(error));
  refreshGroup();
}

function renderFeed() {
  const d = state.groupData, box = clear($('feed'));
  if (!d.feed.length) { box.appendChild(el('div', { class: 'empty', html: '<div class="empty-icon">📣</div><p><b>' + t('feed.empty') + '</b></p><p>' + t('feed.emptySub') + '</p>' })); return; }
  const limit = state.feedAll ? d.feed.length : 10;
  d.feed.slice(0, limit).forEach((f) => {
    const me = f.user_id === state.user.id;
    const w = rowToWorkout(f);
    const what = Calc.effectiveMeasure(w) === 'distance' ? fmtNum(Calc.distanceKm(w), 2) + ' km' : fmtMinutes(Calc.durationMinutes(w));
    const cheerers = f.cheerers || [];
    box.appendChild(el('div', { class: 'feed-item type-' + f.type }, [
      avatar(f),
      el('div', { class: 'feed-body' }, [
        el('p', { class: 'feed-line' }, [el('b', { text: me ? t('feed.you') : f.display_name }), ' ' + TYPE_VERB[f.type] + ' ', el('b', { text: what }),
          f.type === 'workout' ? '' : ' · ' + fmtMinutes(Number(f.est_minutes))]),
        el('p', { class: 'feed-meta' }, [
          el('span', { class: 'badge', text: TYPE_LABEL[f.type] }), ' ',
          dayLabel(f.date) + ' ' + String(f.time).slice(0, 5) + ' · ' + fmtInt(f.kcal) + ' kcal · ',
          el('span', { class: 'pts-text', text: f.points ? '+' + f.points + ' pts' : t('card.noPts') }),
          ' · ' + timeAgo(f.completed_at)
        ]),
        cheerers.length ? el('p', { class: 'feed-cheerers', text: cheerers.map((c) => c.emoji + ' ' + c.name).join('  ') }) : null
      ]),
      me ? el('span', { class: 'cheer-count', text: f.cheer_count ? f.cheer_count + ' 👏' : '' })
        : el('div', { class: 'cheer-btns' }, CHEERS.map((e) => el('button', {
          type: 'button', class: 'cheer' + (f.my_cheer === e ? ' on' : ''), 'aria-pressed': String(f.my_cheer === e),
          'aria-label': t('feed.cheer', { e, name: f.display_name }), text: e, onclick: () => cheer(f, e)
        })))
    ]));
  });
  feedMore();
}

function feedMore() {
  const d = state.groupData;
  if (!d || d.feed.length <= 10) return;
  $('feed').appendChild(el('button', { type: 'button', class: 'ghost-btn more-btn', text: state.feedAll ? t('feed.less') : t('feed.more', { n: d.feed.length - 10 }),
    onclick: () => { state.feedAll = !state.feedAll; renderFeed(); } }));
}

async function cheer(f, emoji) {
  const sb = state.sb;
  const prev = f.my_cheer;
  let res = await sb.from('cheers').delete().eq('workout_id', f.workout_id).eq('user_id', state.user.id);
  if (!res.error && prev !== emoji) res = await sb.from('cheers').insert({ workout_id: f.workout_id, user_id: state.user.id, emoji });
  if (res.error) return toast(errMsg(res.error));
  if (prev !== emoji) toast(t('feed.cheered', { e: emoji, name: f.display_name }));
  const { data } = await sb.rpc('group_feed', { p_group: state.groupId, p_limit: 30 });
  if (data && state.groupData) { state.groupData.feed = data; renderFeed(); }
}

function renderGroupToday() {
  const box = $('groupToday');
  const d = state.groupData;
  if (state.mode !== 'remote' || !d || !currentGroup()) { box.hidden = true; return; }
  box.hidden = false;
  clear(box).appendChild(el('h3', { text: t('goals.groupToday', { name: currentGroup().name }) }));
  const byGoal = {};
  d.today.forEach((r) => { (byGoal[r.goal_id] = byGoal[r.goal_id] || []).push(r); });
  Object.keys(byGoal).forEach((gid, i) => {
    const rows = byGoal[gid], g = rows[0];
    const target = Number(g.target);
    const hit = rows.filter((r) => Number(r.value) >= target);
    const avg = rows.reduce((a, r) => a + Math.min(1, Number(r.value) / target), 0) / rows.length;
    const bar = el('div', { class: 'pbar thin' }); const seg = el('span', { class: 'seg' });
    seg.style.width = (avg * 100).toFixed(1) + '%'; seg.style.background = RING_COLORS[i % RING_COLORS.length]; bar.appendChild(seg);
    box.appendChild(el('div', { class: 'gt-row' }, [
      el('div', { class: 'gt-label' }, [el('b', { text: g.label }), el('span', { class: 'muted', text: t('goals.membersHit', { n: hit.length, total: rows.length }) })]),
      bar,
      el('div', { class: 'gt-who' }, rows.slice().sort((a, b) => Number(b.value) - Number(a.value)).map((r) => {
        const a = avatar(r, 'xs'); a.classList.toggle('dim', Number(r.value) < target);
        a.title = r.display_name + ': ' + fmtMetric(r.metric, Number(r.value)); return a;
      }))
    ]));
  });
}

// ---------- hall of fame / winner banner / confetti ----------
function lastMonthStart() { const d = Calc.parseLocal(Calc.startOfMonth(today())); d.setMonth(d.getMonth() - 1); return Calc.isoDate(d); }

function renderHall() {
  const d = state.groupData, box = clear($('hallOfFame'));
  const months = {};
  d.hof.forEach((r) => { (months[r.month] = months[r.month] || []).push(r); });
  const keys = Object.keys(months).sort().reverse();
  if (!keys.length) { box.appendChild(el('p', { class: 'muted empty-small', text: t('hof.empty') })); return; }
  keys.forEach((m) => {
    box.appendChild(el('div', { class: 'hof-row' }, [
      el('b', { class: 'hof-month', text: monthName(m) }),
      el('div', { class: 'hof-podium' }, months[m].map((r) => el('span', { class: 'hof-entry r' + r.rank }, [
        el('span', { text: r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : '🥉' }), avatar(r, 'xs'), el('span', { text: r.display_name }), el('small', { text: fmtInt(r.points) + ' pts' })
      ])))
    ]));
  });
}

function winnerBanner(compact) {
  const d = state.groupData;
  if (!d || !currentGroup()) return null;
  const lm = lastMonthStart();
  const top = d.hof.filter((r) => r.month === lm).sort((a, b) => a.rank - b.rank);
  if (!top.length) return null;
  const champ = top[0];
  const dismissKey = 'momentum.hofDismiss.' + d.gid + '.' + lm;
  if (compact && localStorage.getItem(dismissKey)) return null;
  const isMe = champ.user_id === state.user.id;
  const b = el('section', { class: 'winner-banner' + (compact ? ' compact' : '') }, [
    el('div', { class: 'trophy', text: '🏆' }),
    el('div', { class: 'winner-text' }, [
      el('p', { class: 'eyebrow', text: t('hof.eyebrow', { month: monthName(lm), group: currentGroup().name }) }),
      el('h2', null, [isMe ? t('hof.youWon') : t('hof.won', { name: champ.display_name }), ' ', el('span', { class: 'grad', text: fmtInt(champ.points) + ' pts' })]),
      el('div', { class: 'podium' }, top.map((r) => el('div', { class: 'step s' + r.rank }, [
        avatar(r), el('b', { text: r.display_name }), el('span', { text: (r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : '🥉') + ' ' + fmtInt(r.points) + ' pts · ' + fmtInt(r.workouts) + ' workouts' })
      ])))
    ]),
    compact ? el('button', { type: 'button', class: 'mini-del', 'aria-label': t('hof.dismiss'), title: t('hof.dismiss'), text: '×', onclick: () => { localStorage.setItem(dismissKey, '1'); renderWinnerBanners(); } }) : null
  ]);
  const confettiKey = 'momentum.confetti.' + d.gid + '.' + lm;
  if (!localStorage.getItem(confettiKey)) { localStorage.setItem(confettiKey, '1'); setTimeout(confetti, 300); }
  return b;
}
function renderWinnerBanners() {
  const home = clear($('winnerSlotHome')), grp = clear($('winnerSlotGroup'));
  if (state.mode !== 'remote') return;
  const a = winnerBanner(true); if (a) home.appendChild(a);
  const b = winnerBanner(false); if (b) grp.appendChild(b);
}

function confetti() {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cv = $('confetti'), ctx = cv.getContext('2d');
  const W = cv.width = window.innerWidth, H = cv.height = window.innerHeight;
  cv.classList.add('on');
  const colors = ['#c6ff3d', '#22d3ee', '#ff7a45', '#a78bfa', '#facc15', '#f472b6'];
  const parts = Array.from({ length: 160 }, () => ({
    x: Math.random() * W, y: -20 - Math.random() * H * 0.5, vx: (Math.random() - 0.5) * 3, vy: 2 + Math.random() * 4,
    r: 4 + Math.random() * 5, a: Math.random() * Math.PI, va: (Math.random() - 0.5) * 0.3, c: colors[Math.floor(Math.random() * colors.length)]
  }));
  const start = performance.now();
  (function frame(now) {
    ctx.clearRect(0, 0, W, H);
    parts.forEach((p) => {
      p.x += p.vx; p.y += p.vy; p.a += p.va; p.vy += 0.03;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.a); ctx.fillStyle = p.c; ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); ctx.restore();
    });
    if (now - start < 3800) requestAnimationFrame(frame); else { ctx.clearRect(0, 0, W, H); cv.classList.remove('on'); }
  })(start);
}

// ---------- pickers ----------
function picker(container, options, selected, kind) {
  clear(container);
  options.forEach((o) => {
    const b = el('button', { type: 'button', class: 'pick' + (o === selected ? ' on' : ''), 'data-v': o, 'aria-pressed': String(o === selected), 'aria-label': kind === 'color' ? 'Colour ' + o : o });
    if (kind === 'color') b.style.background = o; else b.textContent = o;
    b.addEventListener('click', () => {
      container.querySelectorAll('.pick').forEach((x) => { x.classList.remove('on'); x.setAttribute('aria-pressed', 'false'); });
      b.classList.add('on'); b.setAttribute('aria-pressed', 'true'); container.dataset.value = o;
    });
    container.appendChild(b);
  });
  container.dataset.value = selected;
}

// ---------- create / join ----------
function openGroupDialog() {
  $('gName').value = '';
  picker($('gEmoji'), GROUP_EMOJIS, GROUP_EMOJIS[0], 'emoji');
  picker($('gColor'), COLORS, COLORS[0], 'color');
  $('gJoinCode').value = '';
  $('gDesc').value = ''; $('gVis').value = 'public';
  showErr('groupError', '');
  openDialog($('groupDialog'));
}
$('groupForm').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const name = $('gName').value.trim();
  if (!name) return showErr('groupError', t('val.groupName'));
  const { data, error } = await state.sb.rpc('create_group', { p_name: name, p_emoji: $('gEmoji').dataset.value, p_color: $('gColor').dataset.value, p_visibility: $('gVis').value, p_description: $('gDesc').value.trim() || null });
  if (error) return showErr('groupError', errMsg(error));
  $('groupDialog').close();
  await loadGroups();
  await switchGroup(data.id);
  setView('group');
  toast(t('group.created', { name }));
  openInvite();
});
$('gJoinBtn').addEventListener('click', async () => {
  const code = $('gJoinCode').value.trim();
  if (!code) return showErr('groupError', t('val.code'));
  $('groupDialog').close();
  await previewJoin(code);
});

function bindNoGroup() {
  const cb = $('createGroupBtn'); if (cb) cb.addEventListener('click', openGroupDialog);
  const jf = $('joinForm');
  if (jf) jf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const code = $('joinCode').value.trim();
    if (!code) return showErr('joinError', t('val.code'));
    showErr('joinError', '');
    await previewJoin(code);
  });
}
bindNoGroup();
$('newGroupBtn').addEventListener('click', openGroupDialog);

async function previewJoin(code) {
  const { data, error } = await state.sb.rpc('group_preview', { p_code: code });
  if (error) return toast(errMsg(error));
  const g = data && data[0];
  if (!g) { toast(t('join.notFound')); if ($('joinError')) showErr('joinError', t('join.notFound')); return; }
  if (g.already_member) { toast(t('join.already', { name: g.name })); await switchGroup(g.id); setView('group'); return; }
  const prev = clear($('joinPreview'));
  const em = el('span', { class: 'group-emoji', text: g.emoji }); em.style.setProperty('--gc', g.color);
  prev.append(em, el('div', null, [el('h3', { text: g.name }), el('p', { class: 'muted', text: t('join.members', { n: g.member_count }) })]));
  showErr('joinDialogError', '');
  $('confirmJoinBtn').onclick = async () => {
    const res = await state.sb.rpc('join_group', { p_code: code });
    if (res.error) return showErr('joinDialogError', errMsg(res.error));
    $('joinDialog').close();
    await loadGroups();
    await switchGroup(res.data);
    setView('group');
    toast(t('join.joined', { name: g.name }));
  };
  openDialog($('joinDialog'));
}

// ---------- invite ----------
function inviteUrl(code) {
  const base = (location.protocol === 'http:' || location.protocol === 'https:') ? location.origin + location.pathname : (CFG.SITE_URL || '');
  return base + '?join=' + encodeURIComponent(code);
}
function openInvite() {
  const g = currentGroup(); if (!g) return;
  $('inviteCode').textContent = g.invite_code;
  $('inviteLink').value = inviteUrl(g.invite_code);
  $('shareInviteBtn').hidden = !navigator.share;
  openDialog($('inviteDialog'));
}
$('inviteBtn').addEventListener('click', openInvite);
$('copyInviteBtn').addEventListener('click', async () => {
  const v = $('inviteLink').value;
  try { await navigator.clipboard.writeText(v); toast(t('invite.copied')); }
  catch (e) { $('inviteLink').select(); document.execCommand && document.execCommand('copy'); toast(t('invite.copied')); }
});
$('shareInviteBtn').addEventListener('click', () => {
  const g = currentGroup();
  navigator.share({ title: 'Momentum', text: t('invite.shareText', { name: g.name }), url: $('inviteLink').value }).catch(() => {});
});

// ---------- manage ----------
function openManage() {
  const g = currentGroup(); if (!g) return;
  $('mName').value = g.name;
  picker($('mEmoji'), GROUP_EMOJIS.includes(g.emoji) ? GROUP_EMOJIS : [g.emoji].concat(GROUP_EMOJIS), g.emoji, 'emoji');
  picker($('mColor'), COLORS.includes(g.color) ? COLORS : [g.color].concat(COLORS), g.color, 'color');
  document.querySelectorAll('#manageDialog .admin-only').forEach((n) => { n.hidden = !isAdmin(); });
  $('mDesc').value = g.description || ''; $('mVis').value = g.visibility || 'private';
  showErr('manageError', '');
  renderManageGoals(); renderMembers(); renderRequests();
  openDialog($('manageDialog'));
}
$('manageBtn').addEventListener('click', openManage);

function renderManageGoals() {
  const box = clear($('mGoals'));
  const list = state.dailyGoals || [];
  if (!list.length) box.appendChild(el('p', { class: 'muted', text: t('manage.defaults', { list: Calc.DEFAULT_GOALS.map((g) => g.label).join(', ') }) }));
  list.forEach((g) => box.appendChild(el('div', { class: 'mg-row' }, [
    el('span', { text: (GOAL_ICON[g.metric] || '') + ' ' + g.label }),
    el('span', { class: 'muted', text: fmtMetric(g.metric, g.target) + (g.activity_type ? ' · ' + TYPE_LABEL[g.activity_type] : '') }),
    el('button', { type: 'button', class: 'mini-del', text: '×', 'aria-label': t('gg.delete'), onclick: async () => {
      const { error } = await state.sb.from('group_daily_goals').delete().eq('id', g.id);
      if (error) return showErr('manageError', errMsg(error));
      await loadDailyGoals(); renderManageGoals(); renderAll(); refreshGroup();
    } })
  ])));
}
$('dgAdd').addEventListener('click', async () => {
  const label = $('dgLabel').value.trim(), target = parseFloat($('dgTarget').value);
  if (!label || !(target > 0)) return showErr('manageError', t('val.goal'));
  const { error } = await state.sb.from('group_daily_goals').insert({
    group_id: state.groupId, label, metric: $('dgMetric').value, activity_type: $('dgType').value || null, target,
    position: (state.dailyGoals || []).length + 1
  });
  if (error) return showErr('manageError', errMsg(error));
  showErr('manageError', '');
  $('dgLabel').value = ''; $('dgTarget').value = '';
  await loadDailyGoals(); renderManageGoals(); renderAll(); refreshGroup();
});

function renderMembers() {
  const box = clear($('mMembers'));
  const d = state.groupData;
  const members = d && d.gid === state.groupId ? d.members : [];
  members.forEach((m) => {
    const p = m.profiles || {};
    const me = m.user_id === state.user.id;
    box.appendChild(el('div', { class: 'member' }, [
      avatar(p, 'sm'),
      el('span', { class: 'm-name', text: (p.display_name || '?') + (me ? ' ' + t('lb.you') : '') }),
      el('em', { class: 'role', text: m.role }),
      isAdmin() && !me ? el('span', { class: 'm-actions' }, [
        el('button', { type: 'button', class: 'ghost-btn slim', text: m.role === 'admin' ? t('manage.demote') : t('manage.promote'),
          onclick: () => memberAction('set_member_role', { p_group: state.groupId, p_user: m.user_id, p_role: m.role === 'admin' ? 'member' : 'admin' }) }),
        el('button', { type: 'button', class: 'ghost-btn slim danger', text: t('manage.remove'),
          onclick: () => { if (window.confirm(t('manage.confirmRemove', { name: p.display_name }))) memberAction('remove_member', { p_group: state.groupId, p_user: m.user_id }); } })
      ]) : null
    ]));
  });
}
async function renderRequests() {
  const box = clear($('mRequests'));
  if (!isAdmin()) return;
  const gid = state.groupId;
  const { data, error } = await state.sb.rpc('list_join_requests', { p_group: gid });
  if (error || gid !== state.groupId) return;
  if (!data.length) { box.appendChild(el('p', { class: 'muted', text: t('req.none') })); return; }
  data.forEach((r) => box.appendChild(el('div', { class: 'member' }, [
    avatar(r, 'sm'),
    el('span', { class: 'm-name', text: r.display_name }),
    el('em', { class: 'role', text: timeAgo(r.created_at) }),
    el('span', { class: 'm-actions' }, [
      el('button', { type: 'button', class: 'primary-btn slim', text: t('req.approve'), onclick: () => respondRequest(r, true) }),
      el('button', { type: 'button', class: 'ghost-btn slim danger', text: t('req.decline'), onclick: () => respondRequest(r, false) })
    ])
  ])));
}
async function respondRequest(r, approve) {
  const { error } = await state.sb.rpc('respond_join_request', { p_group: state.groupId, p_user: r.user_id, p_approve: approve });
  if (error) return showErr('manageError', errMsg(error));
  toast(approve ? t('req.approved', { name: r.display_name }) : t('req.declined'));
  await refreshGroup(); renderMembers(); renderRequests();
}
async function memberAction(fn, args) {
  const { error } = await state.sb.rpc(fn, args);
  if (error) return showErr('manageError', errMsg(error));
  await loadGroups(); await refreshGroup(); renderMembers(); renderRequests();
  document.querySelectorAll('#manageDialog .admin-only').forEach((n) => { n.hidden = !isAdmin(); });
}
$('mSave').addEventListener('click', async () => {
  const name = $('mName').value.trim();
  if (!name) return showErr('manageError', t('val.groupName'));
  const { error } = await state.sb.from('groups').update({ name, emoji: $('mEmoji').dataset.value, color: $('mColor').dataset.value, description: $('mDesc').value.trim() || null, visibility: $('mVis').value }).eq('id', state.groupId);
  if (error) return showErr('manageError', errMsg(error));
  await loadGroups(); renderAll(); renderGroupView(); toast(t('manage.saved'));
});
$('mRegen').addEventListener('click', async () => {
  if (!window.confirm(t('manage.confirmRegen'))) return;
  const { error } = await state.sb.rpc('regenerate_invite', { p_group: state.groupId });
  if (error) return showErr('manageError', errMsg(error));
  await loadGroups(); toast(t('manage.regenerated')); openInvite();
});
$('leaveGroupBtn').addEventListener('click', async () => {
  const g = currentGroup();
  if (!window.confirm(t('manage.confirmLeave', { name: g.name }))) return;
  const { error } = await state.sb.rpc('leave_group', { p_group: g.id });
  if (error) return showErr('manageError', errMsg(error));
  $('manageDialog').close();
  state.groupId = null; state.groupData = null;
  state.explore.list = null;
  await loadGroups(); renderAll(); refreshGroup(); toast(t('manage.left', { name: g.name }));
});
$('deleteGroupBtn').addEventListener('click', async () => {
  const g = currentGroup();
  if (window.prompt(t('manage.confirmDelete', { name: g.name })) !== g.name) return;
  const { error } = await state.sb.from('groups').delete().eq('id', g.id);
  if (error) return showErr('manageError', errMsg(error));
  $('manageDialog').close();
  state.groupId = null; state.groupData = null;
  await loadGroups(); renderAll(); refreshGroup(); toast(t('manage.deleted', { name: g.name }));
});

// ---------- group goal & challenge dialogs ----------
$('addGoalBtn').addEventListener('click', () => {
  $('ggTitleIn').value = ''; $('ggTarget').value = '';
  $('ggStart').value = Calc.startOfMonth(today()); $('ggEnd').value = Calc.endOfMonth(today());
  showErr('goalError', ''); openDialog($('goalDialog'));
});
$('goalForm').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const row = { group_id: state.groupId, title: $('ggTitleIn').value.trim(), metric: $('ggMetric').value, activity_type: $('ggType').value || null,
    target: parseFloat($('ggTarget').value), start_date: $('ggStart').value, end_date: $('ggEnd').value };
  if (!row.title || !(row.target > 0) || !row.start_date || !row.end_date) return showErr('goalError', t('val.fields'));
  if (row.end_date < row.start_date) return showErr('goalError', t('val.dates'));
  const { error } = await state.sb.from('group_goals').insert(row);
  if (error) return showErr('goalError', errMsg(error));
  $('goalDialog').close(); toast(t('gg.created')); refreshGroup();
});
$('addChallengeBtn').addEventListener('click', () => {
  $('chTitleIn').value = ''; $('chDesc').value = ''; $('chTarget').value = ''; $('chReward').value = 50;
  $('chStart').value = today(); $('chEnd').value = Calc.addDays(today(), 6);
  showErr('challengeError', ''); openDialog($('challengeDialog'));
});
$('challengeForm').addEventListener('submit', async (e) => {
  if (e.submitter && e.submitter.value === 'cancel') return;
  e.preventDefault();
  const row = { group_id: state.groupId, title: $('chTitleIn').value.trim(), description: $('chDesc').value.trim() || null,
    metric: $('chMetric').value, activity_type: $('chType').value || null, target: parseFloat($('chTarget').value),
    reward_points: parseInt($('chReward').value, 10), start_date: $('chStart').value, end_date: $('chEnd').value };
  if (!row.title || !(row.target > 0) || !row.start_date || !row.end_date || !(row.reward_points >= 0 && row.reward_points <= 200)) return showErr('challengeError', t('val.fields'));
  if (row.end_date < row.start_date) return showErr('challengeError', t('val.dates'));
  const { data, error } = await state.sb.from('challenges').insert(row).select('id').single();
  if (error) return showErr('challengeError', errMsg(error));
  await state.sb.from('challenge_participants').insert({ challenge_id: data.id, user_id: state.user.id });
  $('challengeDialog').close(); toast(t('ch.created')); refreshGroup();
});
$('refreshFeedBtn').addEventListener('click', () => refreshGroup());

// ======================================================================
// Explore
// ======================================================================
const SPORT_EMOJI = { running: '🏃', cycling: '🚴', walking: '🚶', workout: '💪' };
$('exSearch').placeholder = t('ex.search');
$('exploreCtaBtn').addEventListener('click', () => setView('explore'));
$('exSearch').addEventListener('input', (e) => { state.explore.q = e.target.value.trim().toLowerCase(); renderExploreList(); });
$('exSport').addEventListener('change', (e) => { state.explore.sport = e.target.value; renderExploreList(); });
$('exSort').addEventListener('change', (e) => { state.explore.sort = e.target.value; renderExploreList(); });

async function openExplore(force) {
  const remote = state.mode === 'remote';
  $('exploreLocal').hidden = remote;
  $('exploreBrowse').hidden = !remote || !!state.explore.previewId;
  $('explorePreview').hidden = !remote || !state.explore.previewId;
  if (!remote) return;
  if (state.explore.previewId) return;
  if (state.explore.list && !force) { renderExploreList(); return; }
  const seq = ++state.explore.seq;
  clear($('exploreGrid')).appendChild(el('p', { class: 'muted', text: t('loading') }));
  const { data, error } = await state.sb.rpc('explore_groups', { p_today: today() });
  if (seq !== state.explore.seq) return;
  if (error) { clear($('exploreGrid')).appendChild(el('p', { class: 'form-error', text: errMsg(error) })); return; }
  state.explore.list = data || [];
  renderExploreList();
}

function visBadge(v) { return el('span', { class: 'vis-badge vis-' + v, text: t('vis.badge.' + v) }); }
function avatarStack(list, total) {
  const wrap = el('div', { class: 'avatar-stack' });
  (list || []).forEach((a) => wrap.appendChild(avatar({ avatar_emoji: a.emoji, avatar_color: a.color, display_name: a.name }, 'sm')));
  if (total > (list || []).length) wrap.appendChild(el('span', { class: 'avatar sm more-av', text: '+' + (total - list.length) }));
  return wrap;
}
function chCountText(n) { return n === 0 ? t('ex.noChallenges') : n === 1 ? t('ex.challenge1') : t('ex.challenges', { n }); }

function renderExploreList() {
  const grid = clear($('exploreGrid'));
  const all = state.explore.list || [];
  const { q, sport, sort } = state.explore;
  let list = all.filter((g) => (!q || g.name.toLowerCase().includes(q) || (g.description || '').toLowerCase().includes(q))
    && (!sport || (g.sports || []).includes(sport)));
  const cmp = {
    active: (a, b) => b.month_workouts - a.month_workouts || b.month_points - a.month_points,
    members: (a, b) => b.member_count - a.member_count || b.month_workouts - a.month_workouts,
    newest: (a, b) => String(b.created_at).localeCompare(String(a.created_at))
  }[sort];
  list = list.slice().sort(cmp);
  if (!list.length) { grid.appendChild(el('div', { class: 'panel empty-small explore-empty', text: all.length ? t('ex.empty') : t('ex.none') })); return; }
  list.forEach((g) => grid.appendChild(exploreCard(g)));
}

function exploreCard(g) {
  const em = el('span', { class: 'group-emoji', text: g.emoji }); em.style.setProperty('--gc', g.color);
  const top = (g.top3 || []);
  const card = el('article', { class: 'panel ex-card', tabindex: '0', role: 'button', 'aria-label': g.name, 'data-id': g.id }, [
    el('div', { class: 'ex-top' }, [em, el('div', { class: 'ex-title' }, [
      el('h3', { text: g.name }),
      el('p', { class: 'muted', text: t('ex.members', { n: g.member_count }) + ' · ' }, [visBadge(g.visibility)])
    ])]),
    g.description ? el('p', { class: 'ex-desc', text: g.description }) : null,
    el('div', { class: 'ex-row' }, [avatarStack(g.avatars, g.member_count),
      el('span', { class: 'ex-sports' }, (g.sports || []).map((s) => el('span', { class: 'chip', text: SPORT_EMOJI[s] + ' ' + TYPE_LABEL[s] })))]),
    el('div', { class: 'ex-stats' }, [
      el('div', null, [el('b', { text: fmtNum(Number(g.month_km)) }), el('span', { text: t('ex.km') })]),
      el('div', null, [el('b', { text: fmtInt(g.month_workouts) }), el('span', { text: t('ex.workouts') })]),
      el('div', null, [el('b', { text: fmtInt(g.month_points) }), el('span', { text: t('ex.points') })])
    ]),
    el('div', { class: 'ex-top3' }, [el('span', { class: 'ex-label', text: t('ex.top3') })].concat(top.length
      ? top.map((p, i) => el('span', { class: 'ex-podium' }, [el('span', { text: ['🥇', '🥈', '🥉'][i] }),
          avatar({ avatar_emoji: p.emoji, avatar_color: p.color, display_name: p.name }, 'sm'), el('span', { class: 'ex-pname', text: p.name })]))
      : [el('span', { class: 'muted', text: t('ex.noTop') })])),
    el('div', { class: 'ex-foot' }, [
      el('span', { class: 'muted', text: '⚡ ' + chCountText(g.active_challenges) }),
      joinButton(g, true)
    ])
  ]);
  const open = (e) => { if (e.target.closest('button')) return; openPreview(g.id); };
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(e); });
  return card;
}

function joinButton(g, slim) {
  const cls = slim ? ' slim' : '';
  if (g.is_member) return el('button', { type: 'button', class: 'primary-btn' + cls, text: t('ex.open'), onclick: async () => { state.explore.previewId = null; await switchGroup(g.id); setView('group'); } });
  if (g.requested) return el('button', { type: 'button', class: 'ghost-btn' + cls, text: t('ex.cancelRequest'), onclick: () => cancelRequest(g) });
  return el('button', { type: 'button', class: 'primary-btn ex-join' + cls, text: g.visibility === 'request' ? t('ex.request') : t('ex.join'), onclick: () => joinFromExplore(g) });
}

async function joinFromExplore(g) {
  const { data, error } = await state.sb.rpc('join_public_group', { p_group: g.id });
  if (error) return toast(errMsg(error));
  state.explore.list = null;
  if (data === 'requested') {
    toast(t('ex.requestSent', { name: g.name }));
    if (state.explore.previewId) openPreview(g.id); else openExplore(true);
    return;
  }
  state.explore.previewId = null;
  await loadGroups();
  await switchGroup(g.id);
  setView('group');
  window.scrollTo({ top: $('mainNav').offsetTop - 4 });
  toast(t('ex.joined', { name: g.name }));
}
async function cancelRequest(g) {
  const { error } = await state.sb.rpc('cancel_join_request', { p_group: g.id });
  if (error) return toast(errMsg(error));
  toast(t('ex.requestCancelled'));
  state.explore.list = null;
  if (state.explore.previewId) openPreview(g.id); else openExplore(true);
}

function closePreview() { state.explore.previewId = null; openExplore(); }

async function openPreview(id) {
  state.explore.previewId = id;
  $('exploreBrowse').hidden = true;
  const box = clear($('explorePreview')); box.hidden = false;
  box.appendChild(el('p', { class: 'muted', text: t('loading') }));
  window.scrollTo({ top: $('mainNav').offsetTop - 4 });
  const { data, error } = await state.sb.rpc('explore_group_detail', { p_group: id, p_today: today() });
  if (state.explore.previewId !== id) return;
  clear(box);
  if (error) { box.append(el('button', { type: 'button', class: 'link-btn', text: t('ex.back'), onclick: closePreview }), el('p', { class: 'form-error', text: errMsg(error) })); return; }
  renderPreview(box, data);
}

function renderPreview(box, d) {
  const em = el('span', { class: 'group-emoji', text: d.emoji }); em.style.setProperty('--gc', d.color);
  box.appendChild(el('button', { type: 'button', class: 'link-btn ex-back', text: t('ex.back'), onclick: closePreview }));
  box.appendChild(el('section', { class: 'panel group-head ex-phead' }, [
    el('div', { class: 'group-id' }, [em, el('div', null, [
      el('h2', { text: d.name }),
      el('p', { class: 'muted', text: t('ex.members', { n: d.member_count }) + ' · ' }, [visBadge(d.visibility)]),
      d.description ? el('p', { class: 'group-desc', text: d.description }) : null
    ])]),
    el('div', { class: 'group-actions' }, [joinButton(d, false)])
  ]));
  const w = d.week || {};
  box.appendChild(el('p', { class: 'notice ex-ro', text: '👀 ' + t('ex.readOnly') }));
  // leaderboard
  const rows = (d.top10 || []).map((r) => el('tr', null, [
    el('td', { class: 'rank', text: r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : String(r.rank) }),
    el('td', null, [el('span', { class: 'who' }, [avatar({ avatar_emoji: r.emoji, avatar_color: r.color, display_name: r.name }, 'sm'), el('span', { text: r.name })])]),
    el('td', { class: 'num', text: fmtInt(r.points) }), el('td', { class: 'num', text: fmtInt(r.workouts) }), el('td', { class: 'num', text: fmtNum(Number(r.km)) })
  ]));
  box.appendChild(el('section', { class: 'panel leaderboard-panel' }, [
    el('div', { class: 'panel-head' }, [el('h2', { text: t('ex.lbTitle') })]),
    rows.length ? el('div', { class: 'table-wrap' }, [el('table', { class: 'lb ex-lb' }, [
      el('thead', null, [el('tr', null, [el('th', { text: '#' }), el('th', { text: t('ex.colName') }), el('th', { class: 'num', text: t('ex.colPoints') }), el('th', { class: 'num', text: t('ex.colWorkouts') }), el('th', { class: 'num', text: 'km' })])]),
      el('tbody', null, rows)])]) : el('p', { class: 'muted', text: t('ex.nothing') })
  ]));
  const chs = (d.challenges || []).map((c) => el('div', { class: 'gg' }, [
    el('div', { class: 'gg-head' }, [el('b', { text: '⚡ ' + c.title }), el('span', { class: 'reward', text: t('ex.reward', { n: c.reward }) })]),
    el('p', { class: 'muted', text: fmtMetric(c.metric, Number(c.target)) + (c.activity_type ? ' · ' + TYPE_LABEL[c.activity_type] : '') + ' · ' + t('ex.endsOn', { d: shortDate(c.end_date) }) + ' · ' + t('ex.joinedCh', { n: c.participants }) })
  ]));
  const goals = (d.goals || []).map((g) => {
    const pct = Math.min(100, Number(g.progress) / Number(g.target) * 100);
    const bar = el('div', { class: 'pbar' }, [el('span', { class: 'seg' })]); bar.firstChild.style.width = pct + '%'; bar.firstChild.style.background = 'linear-gradient(90deg, var(--accent), var(--accent2))';
    return el('div', { class: 'gg' }, [
      el('div', { class: 'gg-head' }, [el('b', { text: g.title }), el('span', { class: 'muted', text: shortDate(g.start_date) + ' – ' + shortDate(g.end_date) })]),
      bar, el('p', { class: 'muted', text: fmtMetric(g.metric, Number(g.progress)) + ' / ' + fmtMetric(g.metric, Number(g.target)) + ' · ' + Math.round(pct) + '%' })]);
  });
  const recent = (d.recent || []).map((r) => el('div', { class: 'feed-item' }, [
    avatar({ avatar_emoji: r.emoji, avatar_color: r.color, display_name: r.name }, 'sm'),
    el('div', { class: 'feed-body' }, [el('p', { class: 'feed-line' }, [el('b', { text: r.name }), document.createTextNode(' ' + TYPE_VERB[r.type] + ' ' + (r.km ? fmtNum(Number(r.km)) + ' km' : fmtMinutes(Number(r.minutes))))]),
      el('p', { class: 'feed-meta muted', text: SPORT_EMOJI[r.type] + ' ' + TYPE_LABEL[r.type] + ' · ' + timeAgo(r.at) })])
  ]));
  box.appendChild(el('div', { class: 'social-layout ex-layout' }, [
    el('div', null, [
      el('section', { class: 'panel' }, [el('div', { class: 'panel-head' }, [el('h2', { text: t('ex.activeCh') })])].concat(chs.length ? chs : [el('p', { class: 'muted', text: t('ex.noChallenges') })])),
      el('section', { class: 'panel' }, [el('div', { class: 'panel-head' }, [el('h2', { text: t('ex.goals') })])].concat(goals.length ? goals : [el('p', { class: 'muted', text: t('ex.nothing') })]))
    ]),
    el('section', { class: 'panel feed-panel' }, [
      el('div', { class: 'panel-head' }, [el('h2', { text: t('ex.recent') })]),
      el('p', { class: 'ex-week' }, [el('b', { text: t('ex.week') + ': ' }), document.createTextNode(t('ex.weekLine', { w: w.workouts || 0, km: fmtNum(Number(w.km || 0)), min: fmtInt(w.minutes), m: w.active_members || 0 }))])
    ].concat(recent.length ? recent : [el('p', { class: 'muted', text: t('ex.nothing') })]))
  ]));
  const foot = el('div', { class: 'ex-pfoot' }, [joinButton(d, false)]);
  box.appendChild(foot);
}

// ======================================================================
// Me view
// ======================================================================
function renderMe() {
  const p = state.profile;
  const meAv = $('meAvatar');
  meAv.textContent = p ? p.avatar_emoji : '🏃';
  meAv.style.setProperty('--ac', p ? p.avatar_color : '#c6ff3d');
  $('meName').textContent = p ? p.display_name : t('me.localName');
  const st = Calc.streaks(state.workouts, today());
  $('meMeta').textContent = (state.user ? state.user.email + ' · ' : '') + fmtNum(weight()) + ' kg · ' + t('me.streaks', { cur: st.current, best: st.best });
  $('editProfileBtn').textContent = state.mode === 'remote' ? t('me.edit') : t('me.settings');

  // weekly summary
  const ws = Ach.weekSummary(state.workouts, weight(), today());
  const c = ws.current, pv = ws.previous;
  function delta(a, b, f) {
    if (!b && !a) return el('small', { class: 'delta', text: '—' });
    const diff = a - b;
    return el('small', { class: 'delta ' + (diff > 0 ? 'up' : diff < 0 ? 'down' : ''), text: (diff > 0 ? '▲ ' : diff < 0 ? '▼ ' : '') + (f ? f(Math.abs(diff)) : fmtInt(Math.abs(diff))) + ' ' + t('me.vsLast') });
  }
  const wk = clear($('weekCard'));
  wk.append(
    el('div', { class: 'panel-head' }, [el('h2', { text: t('me.weekTitle') }), el('span', { class: 'muted', text: shortDate(ws.start) + ' – ' + shortDate(Calc.addDays(ws.start, 6)) })]),
    el('div', { class: 'week-grid' }, [
      el('div', null, [el('span', { text: t('me.workouts') }), el('strong', { text: c.count }), delta(c.count, pv.count)]),
      el('div', null, [el('span', { text: 'km' }), el('strong', { text: fmtNum(c.km) }), delta(c.km, pv.km, (x) => fmtNum(x))]),
      el('div', null, [el('span', { text: t('me.minutes') }), el('strong', { text: fmtInt(c.minutes) }), delta(c.minutes, pv.minutes)]),
      el('div', null, [el('span', { text: 'kcal' }), el('strong', { class: 'k', text: fmtInt(c.kcal) }), delta(c.kcal, pv.kcal)]),
      el('div', null, [el('span', { text: t('me.points') }), el('strong', { class: 'p', text: fmtInt(c.points) }), delta(c.points, pv.points)]),
      el('div', null, [el('span', { text: t('me.activeDays') }), el('strong', { text: c.activeDays + '/7' }), delta(c.activeDays, pv.activeDays)])
    ]),
    el('p', { class: 'week-line', text: c.count ? t('me.weekLine', { type: TYPE_LABEL[c.topType] || '', days: c.activeDays }) : t('me.weekEmpty') })
  );

  // records
  const r = Ach.records(state.workouts, weight());
  const rec = clear($('records'));
  const items = [
    ['🏃', t('pr.longestRun'), r.longestRun && fmtNum(r.longestRun.v, 2) + ' km', r.longestRun && r.longestRun.w.date],
    ['⚡', t('pr.fastestRun'), r.fastestRun && Calc.fmtPace(r.fastestRun.v), r.fastestRun && r.fastestRun.w.date],
    ['🚴', t('pr.longestRide'), r.longestRide && fmtNum(r.longestRide.v, 2) + ' km', r.longestRide && r.longestRide.w.date],
    ['🚶', t('pr.longestWalk'), r.longestWalk && fmtNum(r.longestWalk.v, 2) + ' km', r.longestWalk && r.longestWalk.w.date],
    ['⏱️', t('pr.longestSession'), r.longestSession && fmtMinutes(r.longestSession.v), r.longestSession && r.longestSession.w.date],
    ['📅', t('pr.bigWeekKm'), r.biggestWeekKm && fmtNum(r.biggestWeekKm.km) + ' km', r.biggestWeekKm && t('pr.weekOf', { d: shortDate(r.biggestWeekKm.week) })],
    ['📈', t('pr.bigWeekMin'), r.biggestWeekMin && fmtMinutes(r.biggestWeekMin.minutes), r.biggestWeekMin && t('pr.weekOf', { d: shortDate(r.biggestWeekMin.week) })],
    ['🔥', t('pr.kcalDay'), r.bestKcalDay && fmtInt(r.bestKcalDay.v) + ' kcal', r.bestKcalDay && r.bestKcalDay.day],
    ['📆', t('pr.bestStreak'), st.best ? st.best + ' ' + t('pr.days') : null, null]
  ];
  items.forEach(([icon, label, value, when]) => rec.appendChild(el('div', { class: 'record' + (value ? '' : ' none') }, [
    el('span', { class: 'r-icon', text: icon }),
    el('div', null, [el('span', { class: 'r-label', text: label }), el('b', { text: value || '—' }),
      when ? el('small', { text: /^\d{4}-/.test(when) ? shortDate(when) : when }) : null])
  ])));
  if (!r.fastestRun) rec.appendChild(el('p', { class: 'hint', text: t('pr.paceHint') }));

  // badges
  const bs = Ach.badges(state.workouts, weight(), today());
  $('badgeCount').textContent = t('badges.count', { n: bs.filter((b) => b.earned).length, total: bs.length });
  const bb = clear($('badges'));
  bs.sort((a, b) => (b.earned - a.earned) || (b.progress - a.progress)).forEach((b) => bb.appendChild(el('div', { class: 'badge-tile' + (b.earned ? ' earned' : ''), title: b.desc }, [
    el('span', { class: 'b-icon', text: b.icon }),
    el('b', { text: b.name }),
    el('small', { text: b.earned ? b.desc : fmtNum(Math.min(b.value, b.goal)) + ' / ' + fmtNum(b.goal) + (b.unit ? ' ' + b.unit : '') }),
    b.earned ? null : el('span', { class: 'b-bar' }, [el('span', { style: 'width:' + (b.progress * 100).toFixed(0) + '%' })])
  ])));

  // points
  const scores = Calc.scoreDays(state.workouts, goalsForMe(), weight());
  const wkR = periodRange('week'), moR = periodRange('month');
  const pts = clear($('myPoints'));
  [[t('lb.week'), Calc.sumPoints(scores, wkR.from, wkR.to)], [t('lb.month'), Calc.sumPoints(scores, moR.from, moR.to)], [t('lb.allTime'), Calc.sumPoints(scores)]].forEach(([label, s]) => {
    pts.appendChild(el('div', { class: 'pt-box' }, [el('span', { text: label }), el('strong', { text: fmtInt(s.total) }),
      el('small', { text: t('me.ptsBreak', { w: s.workout, g: s.goals, s: s.streak }) })]));
  });
  pts.appendChild(el('p', { class: 'hint', text: state.mode === 'remote' ? t('me.ptsNoteRemote') : t('me.ptsNoteLocal') }));
}
$('editProfileBtn').addEventListener('click', () => openSettings());

function renderPointsHow() {
  const P = Calc.POINTS;
  const html = '<ul class="how-list">' +
    '<li><b>+' + P.perWorkout + '</b> for each completed workout (first ' + P.maxBasePerDay + ' per day).</li>' +
    '<li><b>Effort points</b> = MET × minutes ÷ ' + P.effortDivisor + ' (max ' + P.maxEffort + ' per workout). ≈ 15 for a 30-min run, 10 for a 1-hour walk, 15 for a 1-hour gym session, 24 for a 1-hour ride. Distance-only entries use the default pace.</li>' +
    '<li>Workout + effort points are <b>capped at ' + P.dailyCap + ' per day</b>.</li>' +
    '<li><b>Daily goals:</b> +' + P.perGoal + ' per goal hit, +' + P.allGoalsBonus + ' bonus for hitting all of them (group admins set the goals).</li>' +
    '<li><b>Streak:</b> +' + P.streakDay + ' for every active day that is your 3rd (or more) day in a row.</li>' +
    '<li><b>Challenges:</b> the challenge reward (0–200, set by the admin) on the day you reach the target.</li>' +
    '<li><b>Fair play:</b> you can\'t complete a workout before its scheduled time (' + P.futureGraceMin + '-min grace), and workouts marked done more than ' + P.eligibleDays + ' days after their date still count for stats but earn no points. Speeds that aren\'t humanly realistic are rejected.</li>' +
    '<li>Ties are broken by number of workouts. Monthly winners are computed automatically on the 1st.</li></ul>';
  $('pointsHow').innerHTML = html; $('pointsHow2').innerHTML = html;
}

// ======================================================================
// Settings / profile
// ======================================================================
const settingsDialog = $('settingsDialog');
function openSettings() {
  const remote = state.mode === 'remote';
  $('profileFields').hidden = !remote;
  $('signOutBtn').hidden = !remote;
  $('signInBtn').hidden = remote || !state.sb;
  $('sampleBtn').hidden = remote;
  $('clearBtn').textContent = remote ? t('settings.deleteMine') : t('settings.deleteAll');
  $('weightInput').value = weight();
  if (remote) {
    $('profName').value = state.profile.display_name;
    picker($('profEmoji'), EMOJIS.includes(state.profile.avatar_emoji) ? EMOJIS : [state.profile.avatar_emoji].concat(EMOJIS), state.profile.avatar_emoji, 'emoji');
    picker($('profColor'), COLORS.includes(state.profile.avatar_color) ? COLORS : [state.profile.avatar_color].concat(COLORS), state.profile.avatar_color, 'color');
  }
  showErr('settingsError', '');
  openDialog(settingsDialog);
}
$('settingsBtn').addEventListener('click', openSettings);
$('settingsForm').addEventListener('submit', async (e) => {
  if (!e.submitter || e.submitter.value !== 'save') return;
  e.preventDefault();
  const w = parseFloat(String($('weightInput').value).replace(',', '.'));
  if (!(w >= 25 && w <= 300)) return showErr('settingsError', t('val.weight'));
  if (state.mode === 'remote') {
    const name = $('profName').value.trim();
    if (!name) return showErr('settingsError', t('val.name'));
    const patch = { display_name: name, avatar_emoji: $('profEmoji').dataset.value, avatar_color: $('profColor').dataset.value, weight_kg: Math.round(w * 10) / 10 };
    const { data, error } = await state.sb.from('profiles').update(patch).eq('id', state.user.id).select().single();
    if (error) return showErr('settingsError', errMsg(error));
    state.profile = data;
  } else {
    state.settings.weightKg = Math.round(w * 10) / 10;
    saveJSON(KEY_SETTINGS, state.settings);
  }
  settingsDialog.close('save');
  toast(t('settings.saved', { w: fmtNum(weight()) }));
  renderAll(); updateEstimate();
  if (state.mode === 'remote' && state.groupId) refreshGroup();
});
$('sampleBtn').addEventListener('click', async () => { await addSamples(); settingsDialog.close('cancel'); toast(t('toast.samples')); });
$('clearBtn').addEventListener('click', async () => {
  if (!state.workouts.length) return toast(t('toast.nothing'));
  if (!window.confirm(t('confirm.deleteAll', { n: state.workouts.length }))) return;
  try { await store.removeAll(); } catch (ex) { return showErr('settingsError', errMsg(ex)); }
  resetForm(); renderAll(); afterWorkoutChange();
  settingsDialog.close('cancel'); toast(t('toast.allDeleted'));
});
$('signOutBtn').addEventListener('click', async () => {
  settingsDialog.close('cancel');
  await state.sb.auth.signOut();
});
$('signInBtn').addEventListener('click', () => { settingsDialog.close('cancel'); showAuth(); });

async function addSamples() {
  const td = today();
  const d = (n) => Calc.addDays(td, n);
  const now = new Date();
  const samples = [
    { type: 'running', date: d(-3), time: '06:30', measure: 'distance', distance_km: 6, duration_min: 34, intensity: 'moderate', notes: 'Tel Aviv promenade, easy pace', completed: true },
    { type: 'workout', date: d(-2), time: '19:00', measure: 'duration', duration_min: 50, intensity: 'vigorous', notes: 'Push day: bench, OHP, dips', completed: true },
    { type: 'walking', date: d(-1), time: '18:15', measure: 'distance', distance_km: 4, intensity: 'moderate', notes: '', completed: true },
    now.getHours() >= 8 ? { type: 'workout', date: d(0), time: '07:00', measure: 'duration', duration_min: 30, intensity: 'moderate', notes: 'Morning mobility + core', completed: true } : null,
    { type: 'cycling', date: d(0), time: '17:30', measure: 'distance', distance_km: 25, intensity: 'moderate', notes: 'Yarkon Park loop', completed: false },
    { type: 'running', date: d(1), time: '06:30', measure: 'duration', duration_min: 40, intensity: 'light', notes: 'Recovery run', completed: false },
    { type: 'workout', date: d(1), time: '19:00', measure: 'duration', duration_min: 45, intensity: 'moderate', notes: 'Pull day + core', completed: false },
    { type: 'walking', date: d(3), time: '08:00', measure: 'duration', duration_min: 60, intensity: 'light', notes: 'Weekend walk', completed: false },
    { type: 'cycling', date: d(4), time: '07:00', measure: 'distance', distance_km: 40, intensity: 'vigorous', notes: '', completed: false }
  ].filter(Boolean).map((s) => Object.assign({ distance_km: null, duration_min: null }, s));
  await store.addMany(samples);
  renderAll(); afterWorkoutChange();
}

// ======================================================================
// Import v1 local workouts after login
// ======================================================================
function importKey() { return 'momentum.imported.' + state.user.id; }
function renderImportBanner() {
  const box = $('importBanner');
  if (state.mode !== 'remote' || localStorage.getItem(importKey())) { box.hidden = true; return; }
  const list = local.load();
  if (!list.length) { box.hidden = true; return; }
  box.hidden = false;
  clear(box).append(
    el('span', { text: '📥 ' + t('import.text', { n: list.length }) }),
    el('span', { class: 'notice-actions' }, [
      el('button', { type: 'button', class: 'primary-btn slim', text: t('import.btn'), onclick: doImport }),
      el('button', { type: 'button', class: 'ghost-btn slim', text: t('import.skip'), onclick: () => { localStorage.setItem(importKey(), 'skipped'); renderImportBanner(); } })
    ])
  );
}
async function doImport() {
  const list = local.load().map((w) => {
    const c = Object.assign({}, w);
    // can't complete future-dated workouts on the server: import those as planned
    if (c.completed && Calc.startsAtMs(c) > Date.now() + Calc.POINTS.futureGraceMin * 60000) c.completed = false;
    return c;
  });
  try {
    const n = await store.addMany(list);
    localStorage.setItem(importKey(), new Date().toISOString());
    renderAll(); afterWorkoutChange();
    toast(t('import.done', { n }));
  } catch (ex) { toast(errMsg(ex)); }
}

// ======================================================================
// Auth
// ======================================================================
function setAuthTab(tab) {
  state.authTab = tab;
  const signup = tab === 'signup';
  $('tabLogin').classList.toggle('active', !signup); $('tabSignup').classList.toggle('active', signup);
  $('nameField').hidden = !signup;
  $('authSubmit').textContent = signup ? t('auth.signup') : t('auth.login');
  $('authPassword').autocomplete = signup ? 'new-password' : 'current-password';
  $('forgotBtn').hidden = signup;
  showErr('authError', ''); $('authInfo').hidden = true;
}
$('tabLogin').addEventListener('click', () => setAuthTab('login'));
$('tabSignup').addEventListener('click', () => setAuthTab('signup'));
$('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('authEmail').value.trim(), password = $('authPassword').value;
  showErr('authError', ''); $('authInfo').hidden = true;
  if (!/^\S+@\S+\.\S+$/.test(email)) return showErr('authError', t('val.email'));
  if (password.length < 8) return showErr('authError', t('val.password'));
  const btn = $('authSubmit'); btn.disabled = true;
  try {
    if (state.authTab === 'signup') {
      const name = $('authName').value.trim();
      if (!name) { showErr('authError', t('val.name')); return; }
      const { data, error } = await state.sb.auth.signUp({ email, password, options: { data: { display_name: name }, emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
      if (!data.session) { const n = $('authInfo'); n.textContent = t('auth.checkEmail'); n.hidden = false; }
    } else {
      const { error } = await state.sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (ex) { showErr('authError', errMsg(ex)); }
  finally { btn.disabled = false; }
});
$('forgotBtn').addEventListener('click', async () => {
  const email = $('authEmail').value.trim();
  if (!/^\S+@\S+\.\S+$/.test(email)) return showErr('authError', t('auth.forgotNeedEmail'));
  const { error } = await state.sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if (error) return showErr('authError', errMsg(error));
  const n = $('authInfo'); n.textContent = t('auth.resetSent'); n.hidden = false;
});
$('localModeBtn').addEventListener('click', () => { localStorage.setItem(KEY_MODE, 'local'); enterLocal(); });
$('recoverySave').addEventListener('click', async () => {
  const pw = $('newPassword').value;
  if (pw.length < 8) return showErr('recoveryError', t('val.password'));
  const { error } = await state.sb.auth.updateUser({ password: pw });
  if (error) return showErr('recoveryError', errMsg(error));
  $('recoveryDialog').close(); toast(t('auth.pwSaved'));
});

function showAuth() {
  state.mode = null;
  document.body.classList.add('auth-mode');
  $('authView').hidden = false;
  ['homeView', 'groupView', 'exploreView', 'meView'].forEach((v) => { $(v).hidden = true; });
  $('mainNav').hidden = true;
  $('groupSwitchWrap').hidden = true;
  renderInviteBanner();
  setAuthTab(state.pendingJoin ? 'signup' : state.authTab);
}
function renderInviteBanner() {
  const b = $('inviteBanner');
  b.hidden = !state.pendingJoin;
  if (state.pendingJoin) b.textContent = t('auth.invited', { code: state.pendingJoin });
}

// ======================================================================
// Views & mode switching
// ======================================================================
function setView(v) {
  if (!state.mode) return;
  state.view = v;
  ['home', 'group', 'explore', 'me'].forEach((k) => { $(k + 'View').hidden = k !== v; });
  document.querySelectorAll('.nav-btn').forEach((b) => { const on = b.dataset.view === v; b.classList.toggle('active', on); b.setAttribute('aria-current', on ? 'page' : 'false'); });
  if (v === 'group') { renderGroupView(); if (state.mode === 'remote' && state.groupId && !state.groupData) refreshGroup(); }
  if (v === 'me') renderMe();
  if (v === 'explore') openExplore();
}
document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => { setView(b.dataset.view); window.scrollTo({ top: $('mainNav').offsetTop - 4, behavior: 'smooth' }); }));

function renderChrome() {
  const remote = state.mode === 'remote';
  document.body.classList.toggle('remote', remote);
  document.body.classList.remove('auth-mode');
  $('authView').hidden = true;
  $('mainNav').hidden = false;
  $('topAvatar').hidden = !remote;
  $('gearIcon').style.display = remote ? 'none' : '';
  if (remote) { $('topAvatar').textContent = state.profile.avatar_emoji; $('topAvatar').style.setProperty('--ac', state.profile.avatar_color); }
  $('weightChip').textContent = remote ? state.profile.display_name : fmtNum(weight()) + ' kg';
  $('dataNote').textContent = remote ? t('footer.remote') : t('footer.local');
  const lb = $('localModeBanner');
  lb.hidden = remote || !state.sb;
  if (!lb.hidden) clear(lb).append(el('span', { text: '💡 ' + t('local.banner') }), el('button', { type: 'button', class: 'primary-btn slim', text: t('auth.cta'), onclick: () => showAuth() }));
}

function renderAll() {
  if (!state.mode) return;
  renderChrome();
  renderPlanner();
  renderStats();
  renderGoals();
  renderImportBanner();
  if (state.view === 'me') renderMe();
  if (state.view === 'group') renderGroupView();
  renderGroupToday();
}

async function enterLocal() {
  state.mode = 'local'; state.user = null; state.profile = null; state.groups = []; state.groupId = null; state.groupData = null; state.dailyGoals = null;
  await store.loadAll();
  resetForm();
  ['homeView'].forEach((v) => { $(v).hidden = false; });
  renderGroupSwitcher();
  renderAll();
  setView('home');
}

async function enterRemote(session) {
  state.user = session.user;
  restoreNoGroup();
  let { data: prof, error } = await state.sb.from('profiles').select('*').eq('id', state.user.id).maybeSingle();
  if (error) throw error;
  if (!prof) throw new Error(t('err.noProfile'));
  state.profile = prof;
  state.mode = 'remote';
  localStorage.removeItem(KEY_MODE);
  await Promise.all([store.loadAll(), loadGroups()]);
  resetForm();
  renderAll();
  setView(state.view || 'home');
  if (state.groupId) refreshGroup();
  if (state.pendingJoin) {
    const code = state.pendingJoin; state.pendingJoin = null; sessionStorage.removeItem('momentum.pendingJoin');
    await previewJoin(code);
  }
}

// ======================================================================
// Boot
// ======================================================================
async function boot() {
  window.I18N.applyStatic();
  renderPointsHow();
  showQuote();
  const params = new URLSearchParams(location.search);
  const join = params.get('join');
  if (join) {
    state.pendingJoin = join.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    sessionStorage.setItem('momentum.pendingJoin', state.pendingJoin);
    params.delete('join');
    history.replaceState(null, '', location.pathname + (params.toString() ? '?' + params : '') + location.hash);
  } else state.pendingJoin = sessionStorage.getItem('momentum.pendingJoin');

  const configured = CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY && !/YOUR_|PLACEHOLDER/i.test(CFG.SUPABASE_URL + CFG.SUPABASE_ANON_KEY);
  if (configured) {
    try {
      const mod = await import(SUPABASE_CDN);
      state.sb = mod.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    } catch (e) { console.warn('Supabase unavailable, using local mode', e); state.sb = null; }
  }
  if (!state.sb) { await enterLocal(); return; }

  let lastUserId = null;
  state.sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') { setTimeout(() => openDialog($('recoveryDialog')), 0); }
    const uidNow = session ? session.user.id : null;
    if (uidNow === lastUserId && event !== 'SIGNED_IN') return;
    if (uidNow === lastUserId) return;
    lastUserId = uidNow;
    // defer: never await supabase calls inside the auth callback
    setTimeout(async () => {
      try {
        if (session) await enterRemote(session);
        else if (localStorage.getItem(KEY_MODE) === 'local' && !state.pendingJoin) await enterLocal();
        else showAuth();
      } catch (ex) { console.error(ex); toast(errMsg(ex)); showAuth(); }
    }, 0);
  });
  const { data } = await state.sb.auth.getSession();
  if (!data.session && lastUserId === null) {
    if (localStorage.getItem(KEY_MODE) === 'local' && !state.pendingJoin) await enterLocal(); else showAuth();
  }
}

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || state.mode !== 'remote') return;
  try { await store.loadAll(); renderAll(); if (state.groupId) refreshGroup(); } catch (e) { /* offline */ }
});
setInterval(() => { if (state.mode) { renderPlanner(); renderStats(); renderGoals(); } }, 60 * 1000);

boot();
window.__momentum = { state, renderAll, addSamples, refreshGroup };
