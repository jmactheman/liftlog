'use strict';

/* ── LiftLog · app logic ──────────────────────────────────────────────────────
   Vanilla JS, no build step. IndexedDB via db.js. Cloud sync via sync.js/auth.js
   (dormant until Supabase is configured). UI modelled on Strong. */

// ── Constants ────────────────────────────────────────────────────────────────
var BODY_PARTS = ['Chest','Back','Shoulders','Arms','Legs','Core','Full Body','Cardio','Other'];
var CATEGORIES = ['Barbell','Dumbbell','Machine','Smith Machine','Cable','Bodyweight','Kettlebell','Other'];
var DEFAULT_REST = 120;
var REST_CHOICES = [0,30,45,60,90,120,150,180,210,240,300];

// ── Exercise types ─────────────────────────────────────────────────────────────
// Each type declares which metric fields a set records. Cardio ('distance_time')
// logs miles + duration, like Strong. Sets carry whichever subset of
// weight/reps/distance/duration their exercise's type uses; the rest stay null.
var EX_TYPES = {
  weight_reps:   { label: 'Weight & Reps',   fields: ['weight', 'reps'] },
  bodyweight:    { label: 'Bodyweight Reps',  fields: ['reps'] },
  distance_time: { label: 'Distance & Time',  fields: ['distance', 'duration'] },
  time:          { label: 'Duration',         fields: ['duration'] }
};
var EX_TYPE_ORDER = ['weight_reps', 'bodyweight', 'distance_time', 'time'];
// Per-field display: column width, header, and input kind. 'duration' is entered
// via the MM:SS modal (openSetTimeEditor), not the numeric keypad.
var FIELD = {
  weight:   { header: 'lbs',   col: '78px', keypad: true,  int: false },
  reps:     { header: 'Reps',  col: '64px', keypad: true,  int: true  },
  distance: { header: 'Miles', col: '78px', keypad: true,  int: false },
  duration: { header: 'Time',  col: '86px', keypad: false, int: false }
};
function exType(ex) { return (ex && EX_TYPES[ex.type]) ? ex.type : 'weight_reps'; }
function exFields(ex) { return EX_TYPES[exType(ex)].fields; }

// ── State ────────────────────────────────────────────────────────────────────
var DATA = { exercises: [], workouts: [], sets: [], templates: [] };
var settings = { id: 'app', userName: '', locations: ['Home'], activeWorkoutId: null };
var active = null;        // in-progress workout object (or null)
var sessRest = null;      // { setId, exerciseId, total, remaining, paused, interval }
var _seq = Date.now();
var exFilterBody = 'All';

// ── Tiny helpers ───────────────────────────────────────────────────────────-─
function genId() { return 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function nextSeq() { _seq += 1; return _seq; }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) {
    return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
  });
}
function $(id) { return document.getElementById(id); }
function todayStr() { var d = new Date(); return d.toISOString().slice(0, 10); }
function num(v) { var n = parseFloat(v); return isNaN(n) ? null : n; }
function fmtW(w) { if (w == null) return ''; return (Math.round(w * 100) / 100).toString(); }
function epley(w, r) { if (!w || !r) return 0; return Math.round(w * (1 + r / 30)); }

function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec));
  var m = Math.floor(sec / 60), s = sec % 60;
  return m + ':' + (s < 10 ? '0' : '') + s;
}
function fmtDuration(ms) {
  var min = Math.round(ms / 60000);
  if (min < 60) return min + 'm';
  var h = Math.floor(min / 60); return h + 'h ' + (min % 60) + 'm';
}
// A set's elapsed duration in seconds → "M:SS", or "H:MM:SS" past an hour.
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  var p = function(n) { return (n < 10 ? '0' : '') + n; };
  return h ? (h + ':' + p(m) + ':' + p(s)) : (m + ':' + p(s));
}
function fmtDateLong(iso) {
  var d = new Date(iso);
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}
function monthKey(iso) {
  var d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }).toUpperCase();
}

function toast(msg) {
  var t = $('toast'); if (!t) return;
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(function() { t.classList.remove('show'); }, 1900);
}
function openModal(id) { var m = $(id); if (m) m.classList.add('active'); }
function closeModal(id) { var m = $(id); if (m) m.classList.remove('active'); }

// Custom confirm (native confirm() blocks the headless preview).
function showConfirm(title, msg, confirmLabel, onConfirm, danger) {
  $('confirm-body').innerHTML =
    '<h2>' + escapeHtml(title) + '</h2>' +
    (msg ? '<p class="sub">' + escapeHtml(msg) + '</p>' : '') +
    '<div class="sheet-actions">' +
      '<button class="btn ' + (danger ? 'btn-danger' : '') + '" id="confirm-yes">' + escapeHtml(confirmLabel || 'Confirm') + '</button>' +
      '<button class="btn btn-dark" onclick="closeModal(\'confirm-modal\')">Cancel</button>' +
    '</div>';
  openModal('confirm-modal');
  $('confirm-yes').onclick = function() { closeModal('confirm-modal'); if (onConfirm) onConfirm(); };
}

// Close any open modal by tapping its backdrop.
document.addEventListener('click', function(e) {
  if (e.target.classList && e.target.classList.contains('modal-overlay')) {
    e.target.classList.remove('active');
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────────
async function loadAllData() {
  DATA.exercises = await dbGetAll('exercises');
  DATA.workouts  = await dbGetAll('workouts');
  DATA.sets      = await dbGetAll('sets');
  DATA.templates = await dbGetAll('templates');
  var s = await dbGet('settings', 'app');
  if (s) settings = Object.assign(settings, s);
  if (!settings.locations || !settings.locations.length) settings.locations = ['Home'];
  // restore in-progress workout
  active = null;
  if (settings.activeWorkoutId) {
    var w = DATA.workouts.filter(function(x) { return x.id === settings.activeWorkoutId; })[0];
    if (w && !w.finishedAt) active = w; else { settings.activeWorkoutId = null; }
  }
  // keep seq ahead of any stored set
  DATA.sets.forEach(function(st) { if (st.seq && st.seq > _seq) _seq = st.seq; });
}

function renderAll() {
  renderExercises(); renderHistory(); renderTemplates(); renderResume();
  renderLocations(); renderProfile(); renderBodyChips();
}

async function boot() {
  await loadAllData();
  renderAll();
  switchTab('start');
  if (active) openSession();
  if ('serviceWorker' in navigator) {
    try { navigator.serviceWorker.register('sw.js?v=2'); } catch (e) {}
  }
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
function switchTab(id) {
  ['profile','history','start','exercises'].forEach(function(t) {
    var v = $('tab-' + t); if (v) v.classList.toggle('active', t === id);
  });
  document.querySelectorAll('#bottom-nav .nav-btn').forEach(function(b) {
    b.classList.toggle('active', b.getAttribute('data-tab') === id);
  });
  if (id === 'history') renderHistory();
  if (id === 'exercises') renderExercises();
  if (id === 'start') { renderTemplates(); renderResume(); }
  if (id === 'profile') renderProfile();
  window.scrollTo(0, 0);
}

// ── Settings: name + locations ────────────────────────────────────────────────
async function persistSettings() { settings.id = 'app'; await dbPut('settings', settings); }

function renderProfile() {
  var nm = $('setting-name'); if (nm && document.activeElement !== nm) nm.value = settings.userName || '';
  $('profile-name').textContent = settings.userName || 'Athlete';
  var n = DATA.workouts.filter(function(w) { return w.finishedAt; }).length;
  $('profile-count').textContent = n + (n === 1 ? ' workout' : ' workouts');
}
var _nameT = null;
function saveName(v) {
  settings.userName = v;
  $('profile-name').textContent = v || 'Athlete';
  clearTimeout(_nameT); _nameT = setTimeout(persistSettings, 500);
}

function renderLocations() {
  var el = $('locations-list'); if (!el) return;
  // Locations are user text — never interpolate them into onclick JS (an
  // apostrophe would break out of the string). Reference by index instead.
  el.innerHTML = settings.locations.map(function(loc, i) {
    return '<div class="loc-item"><span>' + escapeHtml(loc) + '</span>' +
      '<button onclick="removeLocation(' + i + ')">Remove</button></div>';
  }).join('') || '<p class="muted tiny">No locations yet.</p>';
}
// fromPicker: opened from the "Where are you training?" sheet — return to it
// after adding (or cancelling) instead of abandoning the start-workout flow.
function addLocationPrompt(fromPicker) {
  var backToPicker = fromPicker && _locPickCb;
  $('confirm-body').innerHTML =
    '<h2>Add location</h2><p class="sub">e.g. "PF Highland Village", "Home", "Work".</p>' +
    '<input type="text" id="new-loc" placeholder="Location name" autocomplete="off">' +
    '<div class="sheet-actions"><button class="btn" id="loc-save">Add</button>' +
    '<button class="btn btn-dark" onclick="' + (backToPicker ? 'renderLocPicker()' : 'closeModal(\'confirm-modal\')') + '">Cancel</button></div>';
  openModal('confirm-modal');
  setTimeout(function() { $('new-loc').focus(); }, 60);
  $('loc-save').onclick = async function() {
    var v = ($('new-loc').value || '').trim();
    if (!v) return;
    if (settings.locations.indexOf(v) < 0) settings.locations.push(v);
    await persistSettings(); renderLocations();
    if (backToPicker) renderLocPicker(); else closeModal('confirm-modal');
  };
}
async function removeLocation(i) {
  settings.locations.splice(i, 1);
  await persistSettings(); renderLocations();
}

// ── Exercises library ─────────────────────────────────────────────────────────
function exerciseById(id) { return DATA.exercises.filter(function(e) { return e.id === id; })[0] || null; }

function renderBodyChips() {
  var el = $('ex-bodypart-chips'); if (!el) return;
  var parts = ['All'].concat(BODY_PARTS);
  el.innerHTML = parts.map(function(p) {
    return '<button class="chip ' + (exFilterBody === p ? 'on' : '') + '" onclick="setBodyFilter(\'' + p + '\')">' + p + '</button>';
  }).join('');
}
function setBodyFilter(p) { exFilterBody = p; renderBodyChips(); renderExercises(); }

// The metric that ranks "best" for a type: heaviest weight, most reps, longest
// distance, or longest time. Used for PRs, the library stat, and history bests.
function bestMetric(s, t) {
  if (t === 'bodyweight') return s.reps || 0;
  if (t === 'distance_time') return s.distance || 0;
  if (t === 'time') return s.duration || 0;
  return s.weight || 0;
}
// A compact one-line summary of a set, formatted for its exercise type.
function setSummary(s, ex) {
  var t = exType(ex);
  if (t === 'bodyweight') return (s.reps != null ? s.reps : '—') + ' reps';
  if (t === 'distance_time') {
    var d = s.distance != null ? fmtW(s.distance) + ' mi' : '';
    var tm = s.duration != null ? fmtDur(s.duration) : '';
    return [d, tm].filter(Boolean).join(' · ') || '—';
  }
  if (t === 'time') return s.duration != null ? fmtDur(s.duration) : '—';
  return fmtW(s.weight) + ' lb × ' + s.reps;
}
// Best done set for an exercise's library stat line (ranked by its type metric).
function bestSetFor(exId) {
  var ex = exerciseById(exId), t = exType(ex), best = null;
  DATA.sets.forEach(function(s) {
    if (s.exerciseId !== exId || !s.done) return;
    if (!best || bestMetric(s, t) > bestMetric(best, t)) best = s;
  });
  return best;
}

function renderExercises() {
  var el = $('exercises-list'); if (!el) return;
  var q = (($('ex-search') && $('ex-search').value) || '').trim().toLowerCase();
  var list = DATA.exercises.filter(function(e) {
    if (exFilterBody !== 'All' && e.bodyPart !== exFilterBody) return false;
    if (q && e.name.toLowerCase().indexOf(q) < 0) return false;
    return true;
  }).sort(function(a, b) { return a.name.localeCompare(b.name); });

  if (!list.length) {
    el.innerHTML = '<div class="empty">No exercises yet.<br>Tap <strong>New</strong> to create one — e.g. "Smith Bench".</div>';
    return;
  }
  var html = '<div class="az-list">'; var letter = '';
  list.forEach(function(e) {
    var L = (e.name[0] || '#').toUpperCase();
    if (L !== letter) { letter = L; html += '<div class="az-head">' + escapeHtml(L) + '</div>'; }
    var b = bestSetFor(e.id);
    var stat = b ? setSummary(b, e) : '';
    html += '<div class="ex-row" onclick="openExerciseEditor(\'' + e.id + '\')">' +
      '<div class="ex-ic">' + escapeHtml((e.name[0] || '?').toUpperCase()) + '</div>' +
      '<div class="ex-main"><div class="ex-name">' + escapeHtml(e.name) + '</div>' +
      '<div class="ex-sub">' + escapeHtml([e.bodyPart, e.category].filter(Boolean).join(' · ')) + '</div></div>' +
      '<div class="ex-stat">' + stat + '</div></div>';
  });
  html += '</div>';
  el.innerHTML = html;
}

function openExerciseEditor(id) {
  // Clear any picker follow-up from a previous "+ New" that was cancelled, so a
  // later normal save can't fire a stale pickExercise(). (createExerciseFromPicker
  // re-sets it after opening.)
  saveExercise._then = null;
  var e = id ? exerciseById(id) : null;
  var body = $('exercise-modal-body');
  body.innerHTML =
    '<div class="sheet-grab"></div>' +
    '<h2>' + (e ? 'Edit exercise' : 'New exercise') + '</h2>' +
    '<label class="field"><span>Name</span><input type="text" id="ex-name" placeholder="e.g. Smith Bench" value="' + escapeHtml(e ? e.name : '') + '"></label>' +
    '<label class="field"><span>Type</span><select id="ex-type">' +
      EX_TYPE_ORDER.map(function(t) { return '<option value="' + t + '" ' + (exType(e) === t ? 'selected' : '') + '>' + EX_TYPES[t].label + '</option>'; }).join('') +
    '</select></label>' +
    '<label class="field"><span>Body part</span><select id="ex-body">' +
      BODY_PARTS.map(function(p) { return '<option ' + (e && e.bodyPart === p ? 'selected' : '') + '>' + p + '</option>'; }).join('') +
    '</select></label>' +
    '<label class="field"><span>Category</span><select id="ex-cat">' +
      CATEGORIES.map(function(c) { return '<option ' + (e && e.category === c ? 'selected' : '') + '>' + c + '</option>'; }).join('') +
    '</select></label>' +
    '<label class="field"><span>Default rest timer</span><select id="ex-rest">' +
      REST_CHOICES.map(function(r) { return '<option value="' + r + '" ' + ((e ? e.defaultRestSec : DEFAULT_REST) === r ? 'selected' : '') + '>' + (r ? fmtClock(r) : 'Off') + '</option>'; }).join('') +
    '</select></label>' +
    '<div class="sheet-actions">' +
      '<button class="btn" onclick="saveExercise(' + (e ? "'" + e.id + "'" : 'null') + ')">Save</button>' +
      (e ? '<button class="btn btn-danger" onclick="deleteExercise(\'' + e.id + '\')">Delete exercise</button>' : '') +
      '<button class="btn btn-dark" onclick="closeModal(\'exercise-modal\')">Cancel</button>' +
    '</div>';
  openModal('exercise-modal');
}

async function saveExercise(id) {
  var name = ($('ex-name').value || '').trim();
  if (!name) { toast('Name required'); return; }
  var e = id ? exerciseById(id) : null;
  var rec = e || { id: genId(), createdAt: new Date().toISOString() };
  rec.name = name;
  rec.type = $('ex-type').value;
  rec.bodyPart = $('ex-body').value;
  rec.category = $('ex-cat').value;
  rec.defaultRestSec = parseInt($('ex-rest').value, 10);
  await dbPut('exercises', rec);
  if (!e) DATA.exercises.push(rec);
  closeModal('exercise-modal');
  renderExercises();
  if (saveExercise._then) { var cb = saveExercise._then; saveExercise._then = null; cb(rec); }
}

function deleteExercise(id) {
  showConfirm('Delete exercise?', 'History that used it is kept. This only removes it from your library.', 'Delete', async function() {
    await dbDelete('exercises', id);
    DATA.exercises = DATA.exercises.filter(function(e) { return e.id !== id; });
    closeModal('exercise-modal'); renderExercises();
  }, true);
}

// ── Exercise picker (used by session "Add exercise" + template builder) ─────────
var _pickCtx = null;  // 'session' | 'template'
function openExPicker(ctx) {
  _pickCtx = ctx;
  // Render the picker chrome (header + search input) once, so the input element
  // is NOT recreated on each keystroke — recreating it tears the focused input
  // out of the DOM and dismisses the mobile keyboard. oninput updates only the
  // list container below.
  $('expicker-body').innerHTML =
    '<div class="sheet-grab"></div>' +
    '<div class="row-between"><h2>Add exercise</h2>' +
      '<button class="btn-ghost btn-small" onclick="createExerciseFromPicker()">+ New</button></div>' +
    '<div class="search-bar"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>' +
      '<input type="search" id="pick-search" placeholder="Search" oninput="renderExPicker(this.value)"></div>' +
    '<div id="expicker-list"></div>';
  renderExPicker('');
  openModal('expicker-sheet');
}
function renderExPicker(q) {
  q = (q || '').toLowerCase();
  var list = DATA.exercises.filter(function(e) { return !q || e.name.toLowerCase().indexOf(q) >= 0; })
    .sort(function(a, b) { return a.name.localeCompare(b.name); });
  var el = $('expicker-list'); if (!el) return;
  el.innerHTML =
    (list.length ? list.map(function(e) {
      return '<div class="ex-row" onclick="pickExercise(\'' + e.id + '\')">' +
        '<div class="ex-ic">' + escapeHtml((e.name[0] || '?').toUpperCase()) + '</div>' +
        '<div class="ex-main"><div class="ex-name">' + escapeHtml(e.name) + '</div>' +
        '<div class="ex-sub">' + escapeHtml([e.bodyPart, e.category].filter(Boolean).join(' · ')) + '</div></div></div>';
    }).join('') : '<div class="empty">No exercises. Tap <strong>+ New</strong> to create one.</div>');
}
function createExerciseFromPicker() {
  // Close the picker first: the editor and picker share a z-index and the picker
  // sits later in the DOM, so leaving it open would paint it ON TOP of the editor
  // (the editor opens behind it and "+ New" looks like it does nothing).
  closeModal('expicker-sheet');
  openExerciseEditor();
  saveExercise._then = function(rec) { pickExercise(rec.id); };
}
function pickExercise(exId) {
  closeModal('expicker-sheet');
  if (_pickCtx === 'session') addExerciseToSession(exId);
  else if (_pickCtx === 'template') tplAddExercise(exId);
}

// ── Session: lifecycle ─────────────────────────────────────────────────────────
function workoutSets(wid) {
  return DATA.sets.filter(function(s) { return s.workoutId === wid; })
    .sort(function(a, b) { return (a.seq || 0) - (b.seq || 0); });
}

async function startEmptyWorkout(presetLabel) {
  if (active) { openSession(); return; }
  pickLocationThen(function(loc) {
    createWorkout(loc, presetLabel || '');
  });
}

var _locPickCb = null;
function pickLocationThen(cb) {
  _locPickCb = cb;
  renderLocPicker();
  openModal('confirm-modal');
}
function renderLocPicker() {
  // Buttons reference locations by index — names are user text and must never
  // be interpolated into onclick JS (apostrophes would break the handler).
  $('confirm-body').innerHTML =
    '<h2>Where are you training?</h2>' +
    '<div class="loc-list" style="margin-top:6px;">' +
      settings.locations.map(function(l, i) { return '<button class="btn btn-dark" style="justify-content:flex-start;" onclick="pickLocByIndex(' + i + ')">' + escapeHtml(l) + '</button>'; }).join('') +
    '</div>' +
    '<div class="sheet-actions"><button class="btn-ghost" onclick="addLocationPrompt(true)">+ Add location</button>' +
    '<button class="btn btn-dark" onclick="closeModal(\'confirm-modal\')">Cancel</button></div>';
}
function pickLocByIndex(i) {
  var l = settings.locations[i]; if (l == null) return;
  closeModal('confirm-modal');
  var cb = _locPickCb; _locPickCb = null;
  if (cb) cb(l);
}

async function createWorkout(loc, label) {
  active = {
    id: genId(), date: todayStr(), startedAt: new Date().toISOString(), finishedAt: null,
    label: label || 'Workout', location: loc || '', notes: '', exerciseOrder: [],
    createdAt: new Date().toISOString()
  };
  await dbPut('workouts', active);
  DATA.workouts.push(active);
  settings.activeWorkoutId = active.id; await persistSettings();
  openSession();
}

function openSession() {
  if (!active) return;
  renderSession();
  $('session-overlay').classList.add('active');
  startSessClock();
  acquireWakeLock();
}
function closeSessionOverlay() { closeKeypad(); releaseWakeLock(); $('session-overlay').classList.remove('active'); stopSessClock(); renderAll(); }

// Screen Wake Lock — keep the display awake during an active workout so the rest
// bell isn't suspended by iOS auto-lock. iOS releases the lock on tab switch, so
// we re-acquire when the app becomes visible again while a workout is live.
var wakeLock = null;
async function acquireWakeLock() {
  try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
}
function releaseWakeLock() { try { if (wakeLock) { wakeLock.release(); wakeLock = null; } } catch (e) {} }
document.addEventListener('visibilitychange', function() {
  if (document.visibilityState === 'visible' && active) {
    acquireWakeLock();
    // catch the countdown up immediately after background throttling
    if (sessRest && !sessRest.paused) restTick();
  }
});

// live elapsed clock in the title meta
var _clockInt = null;
function startSessClock() { stopSessClock(); _clockInt = setInterval(updateSessClock, 1000); updateSessClock(); }
function stopSessClock() { if (_clockInt) clearInterval(_clockInt); _clockInt = null; }
function updateSessClock() {
  if (!active) return;
  var el = $('sess-elapsed'); if (!el) return;
  el.textContent = fmtDuration(Date.now() - new Date(active.startedAt).getTime());
}

// ── Session: rendering ──────────────────────────────────────────────────────────
function previousPerf(exId, loc) {
  var cands = DATA.workouts.filter(function(w) {
    return w.finishedAt && w.id !== (active && active.id) && w.location === loc;
  }).sort(function(a, b) { return new Date(b.finishedAt) - new Date(a.finishedAt); });
  for (var i = 0; i < cands.length; i++) {
    var ss = workoutSets(cands[i].id).filter(function(s) { return s.exerciseId === exId && s.done; });
    if (ss.length) return ss;
  }
  return [];
}

// "Previous" column text for a set row — a prior done set summarised by type.
function prevText(p, ex) { return p ? setSummary(p, ex) : '—'; }

// One metric cell for a set. Numeric fields drive the keypad; 'duration' opens
// the MM:SS time editor on tap and shows the previous value as a faded default.
function cellHTML(s, field, p) {
  if (field === 'duration') {
    var has = s.duration != null;
    var disp = has ? fmtDur(s.duration) : (p && p.duration != null ? fmtDur(p.duration) : '0:00');
    return '<div class="cell timecell' + (has ? '' : ' ph') + '" data-set="' + s.id + '" data-field="duration" onclick="openSetTimeEditor(\'' + s.id + '\')">' + disp + '</div>';
  }
  var val = s[field] != null ? (field === 'reps' ? s[field] : fmtW(s[field])) : '';
  var ph  = (p && p[field] != null) ? (field === 'reps' ? p[field] : fmtW(p[field])) : '0';
  return '<input class="cell" inputmode="none" data-set="' + s.id + '" data-field="' + field + '" placeholder="' + ph + '" value="' + val + '" onfocus="openKeypad(this)" onchange="setField(\'' + s.id + '\',\'' + field + '\',this.value)">';
}

function renderSession() {
  if (!active) return;
  var sc = $('sess-scroll');
  var html =
    '<input class="sess-title" id="sess-title" value="' + escapeHtml(active.label) + '" onchange="setWorkoutField(\'label\', this.value)">' +
    '<div class="sess-meta">' +
      '<span><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/></svg>' + fmtDateLong(active.startedAt) + '</span>' +
      '<span><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/></svg><b id="sess-elapsed">0m</b></span>' +
      (active.location ? '<span class="loc-tag" onclick="changeWorkoutLocation()">📍 ' + escapeHtml(active.location) + '</span>' : '<span class="loc-tag" onclick="changeWorkoutLocation()">📍 Set location</span>') +
    '</div>';

  active.exerciseOrder.forEach(function(exId) {
    var ex = exerciseById(exId);
    var name = ex ? ex.name : 'Exercise';
    var fields = exFields(ex);
    var grid = '42px 1fr ' + fields.map(function(f) { return FIELD[f].col; }).join(' ') + ' 44px';
    var sets = workoutSets(active.id).filter(function(s) { return s.exerciseId === exId; });
    var prev = previousPerf(exId, active.location);
    html += '<div class="ex-block" data-ex="' + exId + '">' +
      '<div class="ex-block-head"><button class="ex-block-name" onclick="openExMenu(\'' + exId + '\')">' + escapeHtml(name) + '</button>' +
      '<button class="ex-menu" onclick="openExMenu(\'' + exId + '\')">•••</button></div>' +
      '<div class="set-table"><div class="sth" style="grid-template-columns:' + grid + '"><div class="c-num">Set</div><div>Previous</div>' +
      fields.map(function(f) { return '<div class="center">' + FIELD[f].header + '</div>'; }).join('') +
      '<div class="c-chk">✓</div></div>';
    sets.forEach(function(s, i) {
      var p = prev[i] || prev[prev.length - 1];
      html += '<div class="set-swipe" data-set="' + s.id + '">' +
        '<div class="set-swipe-bg"><svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg></div>' +
        '<div class="set-row ' + (s.done ? 'done' : '') + '" data-set="' + s.id + '" style="grid-template-columns:' + grid + '">' +
        '<div class="c-num"><span class="set-badge" onclick="askDeleteSet(\'' + s.id + '\')">' + (i + 1) + '</span></div>' +
        '<div class="c-prev ' + (p ? 'use' : '') + '">' + prevText(p, ex) + '</div>' +
        fields.map(function(f) { return cellHTML(s, f, p); }).join('') +
        '<button class="chk ' + (s.done ? 'on' : '') + '" onclick="toggleDone(\'' + s.id + '\')"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg></button>' +
        '</div></div>' +
        '<div class="rest-slot" id="restslot-' + s.id + '">' + (s.done ? '' : restLineHTML(s)) + '</div>';
    });
    var restSec = ex ? ex.defaultRestSec : DEFAULT_REST;
    html += '<button class="add-set" onclick="addSetTo(\'' + exId + '\')">+ Add Set' + (restSec ? ' (' + fmtClock(restSec) + ')' : '') + '</button></div></div>';
  });

  html += '<button class="add-ex" onclick="openExPicker(\'session\')">+ Add Exercise</button>' +
    '<button class="btn btn-danger" style="margin-top:14px;" onclick="cancelWorkout()">Cancel Workout</button>';
  sc.innerHTML = html;
  updateRestUI();
  bindSetSwipe();
  reattachKeypad();
}

// ── Session: swipe-a-set-left-to-delete (Strong-style) ────────────────────────
// Delegated on the persistent #sess-scroll container, so it survives re-renders.
// Horizontal drag past a threshold deletes the set; otherwise the row snaps back.
var _swipe = null;
function bindSetSwipe() {
  var sc = $('sess-scroll'); if (!sc || sc._swipeBound) return;
  sc._swipeBound = true;
  var THRESH = 90, LOCK = 12;
  sc.addEventListener('touchstart', function(e) {
    var row = e.target.closest && e.target.closest('.set-row'); if (!row) return;
    var t = e.touches[0];
    _swipe = { row: row, x0: t.clientX, y0: t.clientY, dx: 0, locked: false, abort: false };
    row.style.transition = 'none';
  }, { passive: true });
  sc.addEventListener('touchmove', function(e) {
    if (!_swipe || _swipe.abort) return;
    var t = e.touches[0];
    var dx = t.clientX - _swipe.x0, dy = t.clientY - _swipe.y0;
    if (!_swipe.locked) {
      if (Math.abs(dy) > LOCK && Math.abs(dy) > Math.abs(dx)) { _swipe.abort = true; return; }
      if (Math.abs(dx) > LOCK) _swipe.locked = true; else return;
    }
    dx = Math.min(0, dx);                 // only allow left-swipe
    _swipe.dx = dx;
    _swipe.row.style.transform = 'translateX(' + dx + 'px)';
    _swipe.row.parentNode.classList.toggle('swiping', dx < -8);
    if (e.cancelable) e.preventDefault();  // we own this gesture; block scroll
  }, { passive: false });
  function end() {
    if (!_swipe) return;
    var sw = _swipe; _swipe = null;
    var row = sw.row, wrap = row.parentNode;
    row.style.transition = 'transform .2s ease';
    if (sw.locked && sw.dx < -THRESH) {
      row.style.transform = 'translateX(-100%)';
      var setId = wrap.getAttribute('data-set');
      setTimeout(function() { deleteSetNow(setId); }, 180);
    } else {
      row.style.transform = '';
      wrap.classList.remove('swiping');
    }
  }
  sc.addEventListener('touchend', end);
  sc.addEventListener('touchcancel', end);
}
async function deleteSetNow(id) {
  await dbDelete('sets', id);
  DATA.sets = DATA.sets.filter(function(s) { return s.id !== id; });
  if (sessRest && sessRest.setId === id) stopRest(true);
  renderSession();
}

async function setWorkoutField(field, val) { active[field] = val; await dbPut('workouts', active); }
function changeWorkoutLocation() {
  pickLocationThen(async function(loc) { active.location = loc; await dbPut('workouts', active); renderSession(); });
}

async function addExerciseToSession(exId) {
  if (active.exerciseOrder.indexOf(exId) < 0) active.exerciseOrder.push(exId);
  await dbPut('workouts', active);
  await addSetTo(exId, true);
  renderSession();
}

async function addSetTo(exId, skipRender) {
  var ex = exerciseById(exId);
  var existing = workoutSets(active.id).filter(function(s) { return s.exerciseId === exId; });
  var last = existing[existing.length - 1];
  var s = {
    id: genId(), workoutId: active.id, exerciseId: exId, exerciseName: ex ? ex.name : '',
    weight: last ? last.weight : null, reps: last ? last.reps : null,
    distance: last ? last.distance : null, duration: last ? last.duration : null, done: false,
    restSec: ex ? ex.defaultRestSec : DEFAULT_REST, seq: nextSeq(), isPR: false, prTypes: []
  };
  await dbPut('sets', s);
  DATA.sets.push(s);
  if (!skipRender) renderSession();
}

function setLocal(id) { return DATA.sets.filter(function(s) { return s.id === id; })[0]; }

async function setField(id, field, val) {
  var s = setLocal(id); if (!s) return;
  if (FIELD[field] && FIELD[field].int) { var r = parseInt(val, 10); s[field] = isNaN(r) ? null : r; }
  else s[field] = num(val);
  await dbPut('sets', s);
}

// Fill any blank metric fields of a set from the matching "Previous" set, so
// checking it off (or finishing the workout) adopts the shown placeholders.
function fillFromPrev(s) {
  var ex = exerciseById(s.exerciseId);
  var prev = previousPerf(s.exerciseId, active.location);
  var peers = workoutSets(active.id).filter(function(x) { return x.exerciseId === s.exerciseId; });
  var p = prev[peers.indexOf(s)] || prev[prev.length - 1];
  if (!p) return;
  exFields(ex).forEach(function(f) { if (s[f] == null && p[f] != null) s[f] = p[f]; });
}

async function toggleDone(id) {
  var s = setLocal(id); if (!s) return;
  s.done = !s.done;
  if (s.done) fillFromPrev(s);   // adopt the "Previous" placeholders for blanks
  await dbPut('sets', s);
  renderSession();
  if (s.done && s.restSec) startRest(s); else if (!s.done && sessRest && sessRest.setId === id) stopRest();
}

function askDeleteSet(id) {
  showConfirm('Delete this set?', '', 'Delete', async function() {
    await dbDelete('sets', id);
    DATA.sets = DATA.sets.filter(function(s) { return s.id !== id; });
    if (sessRest && sessRest.setId === id) stopRest();
    renderSession();
  }, true);
}

// ── Session: exercise menu ──────────────────────────────────────────────────────
function openExMenu(exId) {
  var ex = exerciseById(exId);
  $('ex-menu-body').innerHTML =
    '<div class="sheet-grab"></div><h2>' + escapeHtml(ex ? ex.name : 'Exercise') + '</h2>' +
    '<div class="menu-list">' +
      '<button onclick="editRestTimer(\'' + exId + '\')"><svg viewBox="0 0 24 24"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M9 2h6"/></svg>Edit rest timer</button>' +
      '<button class="danger" onclick="removeExerciseFromSession(\'' + exId + '\')"><svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>Remove exercise</button>' +
    '</div>' +
    '<div class="sheet-actions"><button class="btn btn-dark" onclick="closeModal(\'ex-menu-sheet\')">Close</button></div>';
  openModal('ex-menu-sheet');
}
function editRestTimer(exId) {
  var ex = exerciseById(exId); if (!ex) return;
  $('ex-menu-body').innerHTML =
    '<div class="sheet-grab"></div><h2>Rest timer · ' + escapeHtml(ex.name) + '</h2>' +
    '<label class="field"><span>Rest between sets</span><select id="rt-sel">' +
      REST_CHOICES.map(function(r) { return '<option value="' + r + '" ' + (ex.defaultRestSec === r ? 'selected' : '') + '>' + (r ? fmtClock(r) : 'Off') + '</option>'; }).join('') +
    '</select></label>' +
    '<div class="sheet-actions"><button class="btn" onclick="saveRestTimer(\'' + exId + '\')">Save</button>' +
    '<button class="btn btn-dark" onclick="closeModal(\'ex-menu-sheet\')">Cancel</button></div>';
}
async function saveRestTimer(exId) {
  var ex = exerciseById(exId); if (!ex) return;
  ex.defaultRestSec = parseInt($('rt-sel').value, 10);
  await dbPut('exercises', ex);
  // apply to not-yet-done sets of this exercise in the active workout
  var ss = workoutSets(active.id).filter(function(s) { return s.exerciseId === exId && !s.done; });
  for (var i = 0; i < ss.length; i++) { ss[i].restSec = ex.defaultRestSec; await dbPut('sets', ss[i]); }
  closeModal('ex-menu-sheet'); renderSession();
}
function removeExerciseFromSession(exId) {
  closeModal('ex-menu-sheet');
  showConfirm('Remove exercise?', 'Removes it and its sets from this workout.', 'Remove', async function() {
    var ss = workoutSets(active.id).filter(function(s) { return s.exerciseId === exId; });
    for (var i = 0; i < ss.length; i++) await dbDelete('sets', ss[i].id);
    DATA.sets = DATA.sets.filter(function(s) { return !(s.workoutId === active.id && s.exerciseId === exId); });
    active.exerciseOrder = active.exerciseOrder.filter(function(x) { return x !== exId; });
    await dbPut('workouts', active); renderSession();
  }, true);
}

// ── Session: custom numeric keypad ────────────────────────────────────────────
// inputmode="none" suppresses the OS keyboard; we drive values from our own pad
// so a single "Next" button walks weight → reps → next set, like Strong.
var activeCell = null;
function openKeypad(input) {
  activeCell = input;
  document.querySelectorAll('.cell.kp-active').forEach(function(c) { c.classList.remove('kp-active'); });
  input.classList.add('kp-active');
  var kp = $('keypad'); if (kp) kp.classList.add('show');
  var sc = $('sess-scroll'); if (sc) sc.style.paddingBottom = '320px';
  setTimeout(function() { try { input.scrollIntoView({ block: 'center' }); } catch (e) {} }, 60);
}
function closeKeypad() {
  activeCell = null;
  document.querySelectorAll('.cell.kp-active').forEach(function(c) { c.classList.remove('kp-active'); });
  var kp = $('keypad'); if (kp) kp.classList.remove('show');
  var sc = $('sess-scroll'); if (sc) sc.style.paddingBottom = '';
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}
// renderSession() replaces the whole #sess-scroll DOM; if the keypad was open,
// activeCell would point at a detached input (e.g. when the rest timer hits 0
// mid-typing and re-renders). Re-find the same cell in the fresh DOM, or close
// the keypad if its set is gone.
function reattachKeypad() {
  if (!activeCell) return;
  var el = document.querySelector('#sess-scroll .cell[data-set="' + activeCell.getAttribute('data-set') +
    '"][data-field="' + activeCell.getAttribute('data-field') + '"]');
  if (el) { activeCell = el; el.classList.add('kp-active'); }
  else closeKeypad();
}
function kpCommit() {
  if (!activeCell) return;
  setField(activeCell.getAttribute('data-set'), activeCell.getAttribute('data-field'), activeCell.value);
}
function kpPress(ch) {
  if (!activeCell) return;
  var field = activeCell.getAttribute('data-field');
  var v = activeCell.value || '';
  if (ch === '.') { if (FIELD[field] && FIELD[field].int) return; if (v.indexOf('.') >= 0) return; if (v === '') v = '0'; }
  if (v.length >= 6) return;
  activeCell.value = v + ch;
  kpCommit();
}
function kpBackspace() {
  if (!activeCell) return;
  activeCell.value = (activeCell.value || '').slice(0, -1);
  kpCommit();
}
function kpNext() {
  if (!activeCell) return;
  var field = activeCell.getAttribute('data-field');
  var setId = activeCell.getAttribute('data-set');
  // Only walk real inputs — the 'duration' time-cell is a div (also class .cell)
  // that opens its own editor, so it must never receive the numeric keypad.
  var cells = Array.prototype.slice.call(document.querySelectorAll('#sess-scroll input.cell'));
  var i = cells.indexOf(activeCell);
  var s0 = setLocal(setId), exF = s0 ? exFields(exerciseById(s0.exerciseId)) : [];
  if (exF[exF.length - 1] === field) {
    // Next on the type's last field = check the set (fills blanks + marks done)
    // and start its rest timer, then jump to the next set. No green-check tap.
    var s = setDoneStartRest(setId);
    renderSession();
    if (s && s.restSec) startRest(s);
    var nc = Array.prototype.slice.call(document.querySelectorAll('#sess-scroll input.cell'));
    if (i + 1 < nc.length) openKeypad(nc[i + 1]); else closeKeypad();
    return;
  }
  if (i >= 0 && i < cells.length - 1) openKeypad(cells[i + 1]);
  else closeKeypad();
}

// Mark a set done (idempotent), filling blanks from the Previous hint. Returns
// the set so the caller can start its rest timer.
function setDoneStartRest(setId) {
  var s = setLocal(setId); if (!s) return null;
  if (!s.done) {
    s.done = true;
    fillFromPrev(s);
    dbPut('sets', s);
  }
  return s;
}

// ── Session: rest timer ──────────────────────────────────────────────────────────
// Web Audio bell — generated, no asset. Unlocked on a user gesture (startRest is
// always triggered by a tap) so it can still fire when the timer hits 0 later.
var audioCtx = null;
function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch (e) {}
}
function playChime() {
  try {
    ensureAudio(); if (!audioCtx) return;
    var now = audioCtx.currentTime;
    [[0, 880], [0.2, 1175], [0.4, 1568]].forEach(function(pair) {
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = pair[1];
      o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.0001, now + pair[0]);
      g.gain.exponentialRampToValueAtTime(0.35, now + pair[0] + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, now + pair[0] + 0.32);
      o.start(now + pair[0]); o.stop(now + pair[0] + 0.36);
    });
  } catch (e) {}
}

function startRest(s) {
  stopRest(true);
  ensureAudio();   // unlock audio on this tap so the bell can ring at 0
  // `endAt` is the source of truth while running; `remaining` is derived from it
  // each tick, so the countdown stays accurate even when the browser throttles
  // background timers (paused timers hold `remaining` and recompute endAt on resume).
  sessRest = { setId: s.id, exerciseId: s.exerciseId, total: s.restSec, remaining: s.restSec,
    endAt: Date.now() + s.restSec * 1000, paused: false, interval: null };
  sessRest.interval = setInterval(restTick, 1000);
  updateRestUI();
}
function restTick() {
  if (!sessRest || sessRest.paused) return;
  sessRest.remaining = Math.max(0, Math.round((sessRest.endAt - Date.now()) / 1000));
  if (sessRest.remaining <= 0) {
    playChime();
    if (navigator.vibrate) { try { navigator.vibrate([300, 120, 300, 120, 300]); } catch (e) {} }
    toast('⏱ Rest over — next set');
    stopRest();
    return;
  }
  updateRestUI();
}
// The editable rest interval shown under an upcoming (not-done) set. Tapping it
// opens the duration editor for THAT set — changing its rest without starting it.
function restLineHTML(s) {
  var txt = s.restSec ? fmtClock(s.restSec) : 'Off';
  return '<div class="rest-line" onclick="openDurationEditor(\'' + s.id + '\')">' +
    '<span class="rest-track"></span><span class="rest-val">⏲ ' + txt + '</span><span class="rest-track"></span></div>';
}

function stopRest(silent) {
  if (sessRest) {
    if (sessRest.interval) clearInterval(sessRest.interval);
    // Clear the live bar from the slot this timer was occupying so it can't be
    // left frozen on screen when a new set's rest starts (renderSession redraws
    // the old bar via updateRestUI just before startRest switches the timer).
    var slot = $('restslot-' + sessRest.setId);
    if (slot) {
      var s = setLocal(sessRest.setId);
      slot.innerHTML = (s && !s.done) ? restLineHTML(s) : '';
    }
  }
  sessRest = null;
  if (!silent) { if (active) renderSession(); updateRestUI(); }
}
// Only touches the header chip + the ACTIVE set's slot (fills it with the live
// bar). Other slots keep their editable rest-line from renderSession().
function updateRestUI() {
  var chip = $('sess-timer-chip'), lbl = $('sess-timer-label');
  if (!sessRest) {
    if (chip) chip.classList.remove('running');
    if (lbl) lbl.textContent = 'Rest';
    if ($('rest-control-sheet').classList.contains('active')) renderRestControl();
    return;
  }
  if (chip) chip.classList.add('running');
  if (lbl) lbl.textContent = fmtClock(sessRest.remaining);
  var slot = $('restslot-' + sessRest.setId);
  if (slot) {
    // start full, drain to empty as the rest counts down
    var pct = Math.min(100, Math.max(0, (sessRest.remaining / sessRest.total) * 100));
    slot.innerHTML = '<div class="rest-bar" onclick="openRestControl()"><div class="fill" style="width:' + pct + '%"></div><div class="lbl">' + fmtClock(sessRest.remaining) + '</div></div>';
  }
  if ($('rest-control-sheet').classList.contains('active')) renderRestControl();
}
function openRestControl() {
  if (!sessRest) { toast('Check a set to start the rest timer'); return; }
  renderRestControl(); openModal('rest-control-sheet');
}
function renderRestControl() {
  if (!sessRest) { closeModal('rest-control-sheet'); return; }
  $('rest-control-body').innerHTML =
    '<div class="sheet-grab"></div><div class="rest-control">' +
      '<div class="rest-dial"><div class="rd-time">' + fmtClock(sessRest.remaining) + '</div><div class="rd-lbl">' + (sessRest.paused ? 'Paused' : 'Rest') + '</div></div>' +
      '<div class="rc-btns"><button class="adj" onclick="adjustRest(-10)">−10</button>' +
        '<button class="btn" style="flex:0 0 auto;width:auto;padding:0 26px;" onclick="togglePauseRest()">' + (sessRest.paused ? 'Resume' : 'Pause') + '</button>' +
        '<button class="adj" onclick="adjustRest(10)">+10</button></div>' +
      '<div class="rc-btns" style="margin-top:12px;">' +
        '<button class="btn btn-dark" onclick="resetRest()">Reset</button>' +
        '<button class="btn btn-dark" onclick="openActiveRestEditor()">⌨ Edit</button>' +
        '<button class="btn btn-dark" onclick="stopRest();closeModal(\'rest-control-sheet\')">Skip</button></div>' +
    '</div>';
}
function adjustRest(d) {
  if (!sessRest) return;
  sessRest.remaining = Math.max(1, sessRest.remaining + d);
  if (!sessRest.paused) sessRest.endAt = Date.now() + sessRest.remaining * 1000;
  sessRest.total = Math.max(sessRest.total, sessRest.remaining);
  updateRestUI();
}
function resetRest() {
  if (!sessRest) return;
  sessRest.remaining = sessRest.total;
  sessRest.endAt = Date.now() + sessRest.total * 1000;
  sessRest.paused = false;
  updateRestUI();
}
function togglePauseRest() {
  if (!sessRest) return;
  if (sessRest.paused) { sessRest.endAt = Date.now() + sessRest.remaining * 1000; sessRest.paused = false; }
  else { sessRest.remaining = Math.max(0, Math.round((sessRest.endAt - Date.now()) / 1000)); sessRest.paused = true; }
  updateRestUI();
}

// ── Session: duration editor (type any length) ────────────────────────────────
// raw = the digits typed; interpreted right-to-left as [HH]MM SS (e.g. "200" →
// 2:00, "2830" → 28:30, "10500" → 1:05:00). kind 'set' edits a set's restSec;
// 'active' retargets the running rest timer; 'setfield' sets a cardio/time set's
// own logged duration (s.duration).
var durTarget = null;
function durTotal() {
  if (!durTarget) return 0;
  if (durTarget.raw === '') return durTarget.initial || 0;
  var r = durTarget.raw;
  var s = parseInt(r.slice(-2), 10) || 0;
  var m = parseInt(r.slice(-4, -2) || '0', 10) || 0;
  var h = parseInt(r.slice(0, -4) || '0', 10) || 0;
  return h * 3600 + m * 60 + s;
}
function openDurationEditor(setId) {
  var s = setLocal(setId); if (!s) return;
  durTarget = { kind: 'set', setId: setId, initial: s.restSec || 0, raw: '' };
  renderDurEditor(); openModal('dur-modal');
}
function openActiveRestEditor() {
  if (!sessRest) return;
  durTarget = { kind: 'active', initial: sessRest.remaining, raw: '' };
  renderDurEditor(); openModal('dur-modal');
}
// The logged time for a Distance & Time / Duration set.
function openSetTimeEditor(setId) {
  var s = setLocal(setId); if (!s) return;
  durTarget = { kind: 'setfield', setId: setId, initial: s.duration || 0, raw: '' };
  renderDurEditor(); openModal('dur-modal');
}
function renderDurEditor() {
  var dig = function(d) { return '<button type="button" onclick="durPress(\'' + d + '\')">' + d + '</button>'; };
  var isTime = durTarget.kind === 'setfield';
  var sub = isTime ? 'Time for this set' :
    (durTarget.kind === 'active' ? 'Adjust the running timer' : 'Rest after this set — won\'t start it');
  $('dur-body').innerHTML =
    '<div class="sheet-grab"></div><h2>' + (isTime ? 'Duration' : 'Rest timer') + '</h2>' +
    '<div class="dur-display">' + fmtDur(durTotal()) + '</div>' +
    '<p class="dur-sub">' + sub + '</p>' +
    '<div class="kp-grid">' +
      dig('1') + dig('2') + dig('3') + dig('4') + dig('5') + dig('6') + dig('7') + dig('8') + dig('9') +
      '<button type="button" onclick="durClear()">C</button>' + dig('0') +
      '<button type="button" onclick="durBackspace()">⌫</button>' +
    '</div>' +
    '<div class="kp-actions" style="margin-top:10px;">' +
      '<button type="button" class="kp-done" onclick="closeModal(\'dur-modal\')">Cancel</button>' +
      '<button type="button" class="kp-next" onclick="durApply()">Set</button>' +
    '</div>';
}
function durPress(d) { durTarget.raw = (durTarget.raw + d).replace(/^0+/, '').slice(-6); renderDurEditor(); }
function durBackspace() { durTarget.raw = durTarget.raw.slice(0, -1); renderDurEditor(); }
function durClear() { durTarget.raw = '0'; renderDurEditor(); }
async function durApply() {
  var total = durTotal();
  if (durTarget.kind === 'active') {
    if (sessRest) {
      sessRest.total = Math.max(1, total);
      sessRest.remaining = Math.max(1, total);
      sessRest.endAt = Date.now() + sessRest.remaining * 1000;
      updateRestUI();
    }
  } else if (durTarget.kind === 'setfield') {
    var st = setLocal(durTarget.setId);
    if (st) { st.duration = total; await dbPut('sets', st); renderSession(); }
  } else {
    var s = setLocal(durTarget.setId);
    if (s) { s.restSec = total; await dbPut('sets', s); renderSession(); }
  }
  closeModal('dur-modal');
}

// ── Session: cancel / finish ──────────────────────────────────────────────────
function cancelWorkout() {
  showConfirm('Cancel workout?', 'This discards the entire in-progress workout.', 'Discard', async function() {
    var ss = workoutSets(active.id);
    for (var i = 0; i < ss.length; i++) await dbDelete('sets', ss[i].id);
    DATA.sets = DATA.sets.filter(function(s) { return s.workoutId !== active.id; });
    await dbDelete('workouts', active.id);
    DATA.workouts = DATA.workouts.filter(function(w) { return w.id !== active.id; });
    settings.activeWorkoutId = null; await persistSettings();
    active = null; stopRest(true); closeSessionOverlay();
  }, true);
}

// The effective metric values for an unfinished set: what the user typed, else
// the grey "Previous" placeholder shown in its row (mirrors renderSession). Lets
// "Finish all unfinished sets" complete a set left on the placeholder, like
// Strong. Returns an object keyed by the exercise type's fields.
function setEffective(s) {
  var ex = exerciseById(s.exerciseId);
  var peers = workoutSets(active.id).filter(function(x) { return x.exerciseId === s.exerciseId; });
  var prev = previousPerf(s.exerciseId, active.location);
  var p = prev[peers.indexOf(s)] || prev[prev.length - 1];
  var out = {};
  exFields(ex).forEach(function(f) { out[f] = s[f] != null ? s[f] : (p ? p[f] : null); });
  return out;
}
// True when every metric field the exercise needs has a value (typed or default).
function effComplete(s) {
  var e = setEffective(s);
  return exFields(exerciseById(s.exerciseId)).every(function(f) { return e[f] != null; });
}

function confirmFinish() {
  closeKeypad();
  var ss = workoutSets(active.id);
  var doneCt = ss.filter(function(s) { return s.done; }).length;
  var unchecked = ss.filter(function(s) { return !s.done; });
  var completable = unchecked.filter(effComplete);
  // Nothing completed and nothing completable → offer to discard the empty workout.
  if (!doneCt && !completable.length) {
    showConfirm('Finish empty workout?', 'No sets were completed — this will be discarded.', 'Discard', function() { cancelWorkout(); });
    return;
  }
  // No unfinished sets (or none with values) → just finish; empty sets are pruned.
  if (!unchecked.length || !completable.length) { finishWorkout(); return; }
  var n = completable.length;
  $('finish-sheet-body').innerHTML =
    '<div class="sheet-grab"></div><h2>Finish Workout?</h2>' +
    '<p class="sub">' + n + ' set' + (n === 1 ? '' : 's') + ' ' + (n === 1 ? 'isn\'t' : 'aren\'t') +
      ' checked off. Finish them with their shown values, or discard them. Empty sets are removed either way.</p>' +
    '<div class="sheet-actions">' +
      '<button class="btn btn-green" onclick="finishWorkout(true)">Finish all unfinished sets</button>' +
      '<button class="btn btn-danger" onclick="finishWorkout(false)">Discard unfinished sets</button>' +
      '<button class="btn btn-dark" onclick="closeModal(\'finish-sheet\')">Cancel</button>' +
    '</div>';
  openModal('finish-sheet');
}

async function finishWorkout(completeUnfinished) {
  closeKeypad();
  closeModal('finish-sheet');
  var ss = workoutSets(active.id);
  // Resolve placeholder-backed values up front, before any deletions shift indices.
  var eff = {};
  if (completeUnfinished) ss.forEach(function(s) { if (!s.done) eff[s.id] = setEffective(s); });
  for (var i = 0; i < ss.length; i++) {
    var s = ss[i];
    if (s.done) continue;
    var e = completeUnfinished ? eff[s.id] : null;
    var ok = e && exFields(exerciseById(s.exerciseId)).every(function(f) { return e[f] != null; });
    if (ok) {
      exFields(exerciseById(s.exerciseId)).forEach(function(f) { s[f] = e[f]; });
      s.done = true;
      await dbPut('sets', s);
    } else {
      await dbDelete('sets', s.id);
      DATA.sets = DATA.sets.filter(function(x) { return x.id !== s.id; });
    }
  }
  // prune exercises with no remaining sets
  active.exerciseOrder = active.exerciseOrder.filter(function(exId) {
    return DATA.sets.some(function(s) { return s.workoutId === active.id && s.exerciseId === exId; });
  });
  var remaining = workoutSets(active.id).filter(function(s) { return s.done; });
  if (!remaining.length) { await cancelWorkoutSilent(); toast('Empty workout discarded'); return; }

  active.finishedAt = new Date().toISOString();
  await dbPut('workouts', active);
  await computePRs(active);
  settings.activeWorkoutId = null; await persistSettings();
  stopRest(true); stopSessClock(); releaseWakeLock();
  var finished = active; active = null;
  $('session-overlay').classList.remove('active');
  renderAll();
  showCongrats(finished);
}

async function cancelWorkoutSilent() {
  var ss = workoutSets(active.id);
  for (var i = 0; i < ss.length; i++) await dbDelete('sets', ss[i].id);
  DATA.sets = DATA.sets.filter(function(s) { return s.workoutId !== active.id; });
  await dbDelete('workouts', active.id);
  DATA.workouts = DATA.workouts.filter(function(w) { return w.id !== active.id; });
  settings.activeWorkoutId = null; await persistSettings();
  active = null; stopRest(true); closeSessionOverlay();
}

// PR detection vs all prior finished sets for the same exercise + location.
async function computePRs(workout) {
  var byEx = {};
  workout.exerciseOrder.forEach(function(exId) { byEx[exId] = true; });
  for (var exId in byEx) {
    if (!byEx.hasOwnProperty(exId)) continue;
    var prior = DATA.sets.filter(function(s) {
      if (s.exerciseId !== exId || !s.done) return false;
      var w = DATA.workouts.filter(function(x) { return x.id === s.workoutId; })[0];
      return w && w.finishedAt && w.id !== workout.id && w.location === workout.location &&
             new Date(w.finishedAt) < new Date(workout.finishedAt);
    });
    var t = exType(exerciseById(exId));
    // Prior bests across every metric; each type reads the ones it cares about.
    var bestW = 0, bestV = 0, best1 = 0, bestR = 0, bestD = 0, bestT = 0;
    prior.forEach(function(s) {
      bestW = Math.max(bestW, s.weight || 0);
      bestV = Math.max(bestV, (s.weight || 0) * (s.reps || 0));
      best1 = Math.max(best1, epley(s.weight, s.reps));
      bestR = Math.max(bestR, s.reps || 0);
      bestD = Math.max(bestD, s.distance || 0);
      bestT = Math.max(bestT, s.duration || 0);
    });
    var cur = workoutSets(workout.id).filter(function(s) { return s.exerciseId === exId && s.done; });
    for (var i = 0; i < cur.length; i++) {
      var s = cur[i], types = [];
      if (t === 'weight_reps') {
        var w = s.weight || 0, v = w * (s.reps || 0), e = epley(s.weight, s.reps);
        if (w > bestW) { types.push('WEIGHT'); bestW = w; }
        if (v > bestV) { types.push('VOL'); bestV = v; }
        if (e > best1) { types.push('1RM'); best1 = e; }
      } else if (t === 'bodyweight') {
        var r = s.reps || 0;
        if (r > bestR) { types.push('REPS'); bestR = r; }
      } else if (t === 'distance_time') {
        var d = s.distance || 0, tt = s.duration || 0;
        if (d > bestD) { types.push('DIST'); bestD = d; }
        if (tt > bestT) { types.push('TIME'); bestT = tt; }
      } else if (t === 'time') {
        var tm = s.duration || 0;
        if (tm > bestT) { types.push('TIME'); bestT = tm; }
      }
      s.prTypes = types; s.isPR = types.length > 0;
      await dbPut('sets', s);
    }
  }
}

function showCongrats(w) {
  var n = DATA.workouts.filter(function(x) { return x.finishedAt; }).length;
  $('congrats-body').innerHTML =
    '<div class="congrats"><div class="stars">⭐️</div><h2>Nice work!</h2>' +
    '<p class="sub">You completed your ' + ordinal(n) + ' workout.</p></div>' +
    '<div class="sheet-actions">' +
      '<button class="btn" onclick="saveWorkoutAsTemplate(\'' + w.id + '\');closeModal(\'congrats-modal\')">Save as Template</button>' +
      '<button class="btn btn-dark" onclick="closeModal(\'congrats-modal\');switchTab(\'history\')">Done</button>' +
    '</div>';
  openModal('congrats-modal');
}
function ordinal(n) {
  var s = ['th','st','nd','rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// ── History ──────────────────────────────────────────────────────────────────
function renderHistory() {
  var el = $('history-list'); if (!el) return;
  var ws = DATA.workouts.filter(function(w) { return w.finishedAt; })
    .sort(function(a, b) { return new Date(b.finishedAt) - new Date(a.finishedAt); });
  if (!ws.length) { el.innerHTML = '<div class="empty">No workouts yet.<br>Tap <strong>Start</strong> to log your first.</div>'; return; }
  var html = '', curMonth = '';
  ws.forEach(function(w) {
    var mk = monthKey(w.finishedAt);
    if (mk !== curMonth) { curMonth = mk; html += '<div class="hist-month">' + mk + '</div>'; }
    var sets = workoutSets(w.id).filter(function(s) { return s.done; });
    var vol = sets.reduce(function(a, s) { return a + (s.weight || 0) * (s.reps || 0); }, 0);
    var dist = sets.reduce(function(a, s) { return a + (s.distance || 0); }, 0);
    var prs = sets.reduce(function(a, s) { return a + (s.prTypes ? s.prTypes.length : 0); }, 0);
    var dur = w.finishedAt ? fmtDuration(new Date(w.finishedAt) - new Date(w.startedAt)) : '—';
    // best set per exercise, ranked by that exercise's type metric
    var byEx = {};
    sets.forEach(function(s) {
      var t = exType(exerciseById(s.exerciseId));
      if (!byEx[s.exerciseId] || bestMetric(s, t) > bestMetric(byEx[s.exerciseId], t)) byEx[s.exerciseId] = s;
    });
    var rows = w.exerciseOrder.filter(function(e) { return byEx[e]; }).map(function(exId) {
      var s = byEx[exId], cnt = sets.filter(function(x) { return x.exerciseId === exId; }).length;
      return '<div class="hcs-row"><span class="l">' + cnt + ' × ' + escapeHtml(s.exerciseName || (exerciseById(exId) || {}).name || 'Exercise') + '</span>' +
        '<span class="r">' + escapeHtml(setSummary(s, exerciseById(exId))) + '</span></div>';
    }).join('');
    html += '<div class="card hist-card">' +
      '<div class="row-between"><div><div class="hc-title">' + escapeHtml(w.label || 'Workout') + '</div>' +
      '<div class="hc-date">' + fmtDateLong(w.finishedAt) + (w.location ? ' · ' + escapeHtml(w.location) : '') + '</div></div>' +
      '<button class="ex-menu" style="background:var(--card-2);color:var(--accent);border-radius:8px;width:36px;height:30px;border:0;" onclick="openHistMenu(\'' + w.id + '\')">•••</button></div>' +
      '<div class="hc-stats">' +
        '<span><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/></svg>' + dur + '</span>' +
        (vol ? '<span><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg>' + Math.round(vol).toLocaleString() + ' lb</span>' : '') +
        (dist ? '<span><svg viewBox="0 0 24 24"><path d="M3 12h18M12 3v18"/></svg>' + fmtW(Math.round(dist * 100) / 100) + ' mi</span>' : '') +
        (prs ? '<span class="pr-ct">🏆 ' + prs + ' PR' + (prs > 1 ? 's' : '') + '</span>' : '') +
      '</div>' +
      '<div class="hc-sets"><div class="hcs-head"><span>Exercise</span><span>Best Set</span></div>' + rows + '</div>' +
      '<div onclick="openWorkoutDetail(\'' + w.id + '\')" style="margin-top:8px;color:var(--accent);font-size:14px;font-weight:600;">View details ›</div>' +
      '</div>';
  });
  el.innerHTML = html;
}

function openWorkoutDetail(wid) {
  var w = DATA.workouts.filter(function(x) { return x.id === wid; })[0]; if (!w) return;
  var sets = workoutSets(wid).filter(function(s) { return s.done; });
  var vol = sets.reduce(function(a, s) { return a + (s.weight || 0) * (s.reps || 0); }, 0);
  var dist = sets.reduce(function(a, s) { return a + (s.distance || 0); }, 0);
  var prs = sets.reduce(function(a, s) { return a + (s.prTypes ? s.prTypes.length : 0); }, 0);
  var dur = fmtDuration(new Date(w.finishedAt) - new Date(w.startedAt));
  var body = '<div class="sheet-grab"></div><h2>' + escapeHtml(w.label || 'Workout') + '</h2>' +
    '<p class="sub">' + fmtDateLong(w.finishedAt) + (w.location ? ' · ' + escapeHtml(w.location) : '') + '</p>' +
    '<div class="hc-stats" style="margin-top:0;"><span>⏱ ' + dur + '</span>' +
      (vol ? '<span>🏋 ' + Math.round(vol).toLocaleString() + ' lb</span>' : '') +
      (dist ? '<span>📏 ' + fmtW(Math.round(dist * 100) / 100) + ' mi</span>' : '') +
      (prs ? '<span class="pr-ct">🏆 ' + prs + '</span>' : '') + '</div>';
  w.exerciseOrder.forEach(function(exId) {
    var ss = sets.filter(function(s) { return s.exerciseId === exId; });
    if (!ss.length) return;
    var ex = exerciseById(exId), isWR = exType(ex) === 'weight_reps';
    var best1 = isWR ? Math.max.apply(null, ss.map(function(s) { return epley(s.weight, s.reps); })) : 0;
    body += '<div class="detail-ex"><div class="de-head"><span>' + escapeHtml(ss[0].exerciseName || (ex || {}).name || 'Exercise') + '</span>' +
      (isWR ? '<span class="de-1rm">1RM ' + best1 + '</span>' : '') + '</div>';
    ss.forEach(function(s, i) {
      body += '<div class="detail-set"><span class="ds-n">' + (i + 1) + '</span>' +
        '<span>' + escapeHtml(setSummary(s, ex)) +
        (s.prTypes && s.prTypes.length ? ' <span class="pr-badges">' + s.prTypes.map(function(t) { return '<span class="pr-badge">🏆 ' + t + '</span>'; }).join('') + '</span>' : '') +
        '</span><span class="ds-1rm">' + (isWR ? epley(s.weight, s.reps) : '') + '</span></div>';
    });
    body += '</div>';
  });
  body += '<div class="sheet-actions"><button class="btn" onclick="performAgain(\'' + wid + '\')">Perform Again</button>' +
    '<button class="btn btn-dark" onclick="closeModal(\'detail-modal\')">Close</button></div>';
  $('detail-modal-body').innerHTML = body;
  openModal('detail-modal');
}

function openHistMenu(wid) {
  $('hist-menu-body').innerHTML =
    '<div class="sheet-grab"></div>' +
    '<div class="menu-list">' +
      '<button onclick="closeModal(\'hist-menu-sheet\');performAgain(\'' + wid + '\')"><svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 109-9M3 4v5h5"/></svg>Perform Again</button>' +
      '<button onclick="closeModal(\'hist-menu-sheet\');saveWorkoutAsTemplate(\'' + wid + '\')"><svg viewBox="0 0 24 24"><path d="M5 3h11l3 3v15H5z"/></svg>Save as Template</button>' +
      '<button onclick="closeModal(\'hist-menu-sheet\');openWorkoutDetail(\'' + wid + '\')"><svg viewBox="0 0 24 24"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>View details</button>' +
      '<button class="danger" onclick="deleteWorkout(\'' + wid + '\')"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"/></svg>Delete</button>' +
    '</div>' +
    '<div class="sheet-actions"><button class="btn btn-dark" onclick="closeModal(\'hist-menu-sheet\')">Close</button></div>';
  openModal('hist-menu-sheet');
}

function deleteWorkout(wid) {
  closeModal('hist-menu-sheet');
  showConfirm('Delete workout?', 'This permanently removes the workout and its sets.', 'Delete', async function() {
    var ss = workoutSets(wid);
    for (var i = 0; i < ss.length; i++) await dbDelete('sets', ss[i].id);
    DATA.sets = DATA.sets.filter(function(s) { return s.workoutId !== wid; });
    await dbDelete('workouts', wid);
    DATA.workouts = DATA.workouts.filter(function(w) { return w.id !== wid; });
    renderHistory(); renderProfile();
  }, true);
}

// Clone a finished workout into a fresh in-progress session.
async function performAgain(wid) {
  if (active) { toast('Finish your current workout first'); return; }
  closeModal('detail-modal');
  var w = DATA.workouts.filter(function(x) { return x.id === wid; })[0]; if (!w) return;
  await createWorkout(w.location, w.label);
  active.exerciseOrder = w.exerciseOrder.slice();
  await dbPut('workouts', active);
  var src = workoutSets(wid).filter(function(s) { return s.done; });
  for (var i = 0; i < src.length; i++) {
    var o = src[i];
    var ns = { id: genId(), workoutId: active.id, exerciseId: o.exerciseId, exerciseName: o.exerciseName,
      weight: o.weight, reps: o.reps, distance: o.distance, duration: o.duration, done: false,
      restSec: o.restSec || DEFAULT_REST, seq: nextSeq(), isPR: false, prTypes: [] };
    await dbPut('sets', ns); DATA.sets.push(ns);
  }
  renderSession();
}

// ── Templates ──────────────────────────────────────────────────────────────────
var tplDraft = null;  // { id?, name, location, items:[{exerciseId, exerciseName, sets}] }

function renderTemplates() {
  var el = $('templates-grid'); if (!el) return;
  if (!DATA.templates.length) { el.innerHTML = '<div class="empty">No templates yet.<br>Build one, or finish a workout and "Save as Template".</div>'; return; }
  el.innerHTML = '<div class="tpl-grid">' + DATA.templates.map(function(t) {
    var preview = (t.items || []).map(function(it) { return it.exerciseName; }).join(', ');
    return '<div class="tpl-card" onclick="startFromTemplate(\'' + t.id + '\')">' +
      '<div class="row-between"><div class="tc-title">' + escapeHtml(t.name) + '</div>' +
      '<button class="ex-menu" style="background:none;color:var(--text-mut);width:24px;border:0;" onclick="event.stopPropagation();openTemplateMenu(\'' + t.id + '\')">•••</button></div>' +
      '<div class="tc-body">' + escapeHtml(preview || 'No exercises') + '</div></div>';
  }).join('') + '</div>';
}

function openTemplateMenu(id) {
  $('hist-menu-body').innerHTML =
    '<div class="sheet-grab"></div>' +
    '<div class="menu-list">' +
      '<button onclick="closeModal(\'hist-menu-sheet\');startFromTemplate(\'' + id + '\')"><svg viewBox="0 0 24 24"><path d="M5 3l14 9-14 9z"/></svg>Start workout</button>' +
      '<button onclick="closeModal(\'hist-menu-sheet\');openTemplateBuilder(\'' + id + '\')"><svg viewBox="0 0 24 24"><path d="M12 20h9M16 4l4 4L8 20H4v-4z"/></svg>Edit</button>' +
      '<button class="danger" onclick="deleteTemplate(\'' + id + '\')"><svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"/></svg>Delete</button>' +
    '</div><div class="sheet-actions"><button class="btn btn-dark" onclick="closeModal(\'hist-menu-sheet\')">Close</button></div>';
  openModal('hist-menu-sheet');
}
function deleteTemplate(id) {
  closeModal('hist-menu-sheet');
  showConfirm('Delete template?', '', 'Delete', async function() {
    await dbDelete('templates', id);
    DATA.templates = DATA.templates.filter(function(t) { return t.id !== id; });
    renderTemplates();
  }, true);
}

function openTemplateBuilder(id) {
  var t = id ? DATA.templates.filter(function(x) { return x.id === id; })[0] : null;
  tplDraft = t ? { id: t.id, name: t.name, location: t.location || '', items: (t.items || []).map(function(i) { return Object.assign({}, i); }) }
              : { name: '', location: '', items: [] };
  renderTemplateBuilder();
  openModal('template-modal');
}
function renderTemplateBuilder() {
  var items = tplDraft.items.map(function(it, i) {
    return '<div class="loc-item"><span>' + escapeHtml(it.exerciseName) + '</span>' +
      '<span style="display:flex;align-items:center;gap:8px;">' +
      '<button class="adj" style="width:30px;height:30px;font-size:18px;" onclick="tplSetCount(' + i + ',-1)">−</button>' +
      '<b>' + it.sets + '</b>' +
      '<button class="adj" style="width:30px;height:30px;font-size:18px;" onclick="tplSetCount(' + i + ',1)">+</button>' +
      '<button onclick="tplRemove(' + i + ')">✕</button></span></div>';
  }).join('');
  $('template-modal-body').innerHTML =
    '<div class="sheet-grab"></div><h2>' + (tplDraft.id ? 'Edit template' : 'New template') + '</h2>' +
    '<label class="field"><span>Name</span><input type="text" id="tpl-name" placeholder="e.g. Push A" value="' + escapeHtml(tplDraft.name) + '" oninput="tplDraft.name=this.value"></label>' +
    '<div class="section-title" style="font-size:16px;margin:18px 0 8px;">Exercises</div>' +
    '<div class="loc-list">' + (items || '<p class="muted tiny">None yet.</p>') + '</div>' +
    '<button class="add-ex" style="margin-top:12px;" onclick="openExPicker(\'template\')">+ Add Exercise</button>' +
    '<div class="sheet-actions"><button class="btn" onclick="saveTemplate()">Save template</button>' +
    '<button class="btn btn-dark" onclick="closeModal(\'template-modal\')">Cancel</button></div>';
}
function tplAddExercise(exId) {
  var ex = exerciseById(exId); if (!ex) return;
  tplDraft.items.push({ exerciseId: exId, exerciseName: ex.name, sets: 3 });
  renderTemplateBuilder(); openModal('template-modal');
}
function tplSetCount(i, d) { tplDraft.items[i].sets = Math.max(1, tplDraft.items[i].sets + d); renderTemplateBuilder(); }
function tplRemove(i) { tplDraft.items.splice(i, 1); renderTemplateBuilder(); }
async function saveTemplate() {
  if (!tplDraft.name.trim()) { toast('Name required'); return; }
  if (!tplDraft.items.length) { toast('Add at least one exercise'); return; }
  var rec = { id: tplDraft.id || genId(), name: tplDraft.name.trim(), location: tplDraft.location || '',
    items: tplDraft.items, createdAt: new Date().toISOString() };
  await dbPut('templates', rec);
  if (tplDraft.id) DATA.templates = DATA.templates.map(function(t) { return t.id === rec.id ? rec : t; });
  else DATA.templates.push(rec);
  closeModal('template-modal'); renderTemplates(); toast('Template saved');
}

function saveWorkoutAsTemplate(wid) {
  var w = DATA.workouts.filter(function(x) { return x.id === wid; })[0]; if (!w) return;
  var items = w.exerciseOrder.map(function(exId) {
    var cnt = workoutSets(wid).filter(function(s) { return s.exerciseId === exId && s.done; }).length || 1;
    var ex = exerciseById(exId);
    return { exerciseId: exId, exerciseName: (ex ? ex.name : 'Exercise'), sets: cnt };
  }).filter(function(it) { return it.exerciseId; });
  tplDraft = { name: w.label || 'Workout', location: w.location || '', items: items };
  renderTemplateBuilder(); openModal('template-modal');
}

async function startFromTemplate(id) {
  if (active) { toast('Finish your current workout first'); return; }
  var t = DATA.templates.filter(function(x) { return x.id === id; })[0]; if (!t) return;
  pickLocationThen(async function(loc) {
    await createWorkout(loc, t.name);
    active.exerciseOrder = t.items.map(function(i) { return i.exerciseId; }).filter(function(e) { return exerciseById(e); });
    await dbPut('workouts', active);
    for (var i = 0; i < t.items.length; i++) {
      var it = t.items[i]; if (!exerciseById(it.exerciseId)) continue;
      for (var k = 0; k < it.sets; k++) await addSetTo(it.exerciseId, true);
    }
    renderSession();
  });
}

// ── Resume banner ──────────────────────────────────────────────────────────────
function renderResume() {
  var el = $('resume-banner'); if (!el) return;
  if (!active) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="card tap" onclick="openSession()" style="border-color:var(--accent);">' +
    '<div class="row-between"><div><div style="font-weight:800;">Workout in progress</div>' +
    '<div class="muted tiny">' + escapeHtml(active.label) + (active.location ? ' · ' + escapeHtml(active.location) : '') + '</div></div>' +
    '<span class="pill accent">Resume ›</span></div></div>';
}

// ── Export ───────────────────────────────────────────────────────────────────
function exportJSON() {
  var payload = { app: 'liftlog', exportedAt: new Date().toISOString(),
    exercises: DATA.exercises, workouts: DATA.workouts, sets: DATA.sets, templates: DATA.templates,
    settings: settings };
  var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'liftlog-export-' + todayStr() + '.json';
  a.click();
  setTimeout(function() { URL.revokeObjectURL(a.href); }, 1000);
}

// ── go ───────────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
