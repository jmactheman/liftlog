'use strict';

/* ── LiftLog · app logic ──────────────────────────────────────────────────────
   Vanilla JS, no build step. IndexedDB via db.js. Cloud sync via sync.js/auth.js
   (dormant until Supabase is configured). UI modelled on Strong. */

// ── Constants ────────────────────────────────────────────────────────────────
var BODY_PARTS = ['Chest','Back','Shoulders','Arms','Legs','Core','Full Body','Cardio','Other'];
var CATEGORIES = ['Barbell','Dumbbell','Machine','Smith Machine','Cable','Bodyweight','Kettlebell','Other'];
var DEFAULT_REST = 120;
var REST_CHOICES = [0,30,45,60,90,120,150,180,210,240,300];

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
  switchTab(active ? 'start' : 'start');
  if (active) openSession();
  if ('serviceWorker' in navigator) {
    try { navigator.serviceWorker.register('sw.js?v=1'); } catch (e) {}
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
  el.innerHTML = settings.locations.map(function(loc) {
    return '<div class="loc-item"><span>' + escapeHtml(loc) + '</span>' +
      '<button onclick="removeLocation(\'' + escapeHtml(loc).replace(/'/g, "\\'") + '\')">Remove</button></div>';
  }).join('') || '<p class="muted tiny">No locations yet.</p>';
}
function addLocationPrompt() {
  $('confirm-body').innerHTML =
    '<h2>Add location</h2><p class="sub">e.g. "PF Highland Village", "Home", "Work".</p>' +
    '<input type="text" id="new-loc" placeholder="Location name" autocomplete="off">' +
    '<div class="sheet-actions"><button class="btn" id="loc-save">Add</button>' +
    '<button class="btn btn-dark" onclick="closeModal(\'confirm-modal\')">Cancel</button></div>';
  openModal('confirm-modal');
  setTimeout(function() { $('new-loc').focus(); }, 60);
  $('loc-save').onclick = async function() {
    var v = ($('new-loc').value || '').trim();
    if (!v) return;
    if (settings.locations.indexOf(v) < 0) settings.locations.push(v);
    await persistSettings(); renderLocations(); closeModal('confirm-modal');
  };
}
async function removeLocation(loc) {
  settings.locations = settings.locations.filter(function(l) { return l !== loc; });
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

// Best (heaviest) done set per exercise, for the library stat line.
function bestSetFor(exId) {
  var best = null;
  DATA.sets.forEach(function(s) {
    if (s.exerciseId !== exId || !s.done || s.weight == null) return;
    if (!best || s.weight > best.weight) best = s;
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
    var stat = b ? (fmtW(b.weight) + ' lb × ' + b.reps) : '';
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
  var e = id ? exerciseById(id) : null;
  var body = $('exercise-modal-body');
  body.innerHTML =
    '<div class="sheet-grab"></div>' +
    '<h2>' + (e ? 'Edit exercise' : 'New exercise') + '</h2>' +
    '<label class="field"><span>Name</span><input type="text" id="ex-name" placeholder="e.g. Smith Bench" value="' + escapeHtml(e ? e.name : '') + '"></label>' +
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
  renderExPicker('');
  openModal('expicker-sheet');
}
function renderExPicker(q) {
  q = (q || '').toLowerCase();
  var list = DATA.exercises.filter(function(e) { return !q || e.name.toLowerCase().indexOf(q) >= 0; })
    .sort(function(a, b) { return a.name.localeCompare(b.name); });
  $('expicker-body').innerHTML =
    '<div class="sheet-grab"></div>' +
    '<div class="row-between"><h2>Add exercise</h2>' +
      '<button class="btn-ghost btn-small" onclick="createExerciseFromPicker()">+ New</button></div>' +
    '<div class="search-bar"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>' +
      '<input type="search" id="pick-search" placeholder="Search" oninput="renderExPicker(this.value)"></div>' +
    (list.length ? list.map(function(e) {
      return '<div class="ex-row" onclick="pickExercise(\'' + e.id + '\')">' +
        '<div class="ex-ic">' + escapeHtml((e.name[0] || '?').toUpperCase()) + '</div>' +
        '<div class="ex-main"><div class="ex-name">' + escapeHtml(e.name) + '</div>' +
        '<div class="ex-sub">' + escapeHtml([e.bodyPart, e.category].filter(Boolean).join(' · ')) + '</div></div></div>';
    }).join('') : '<div class="empty">No exercises. Tap <strong>+ New</strong> to create one.</div>');
}
function createExerciseFromPicker() {
  saveExercise._then = function(rec) { pickExercise(rec.id); };
  openExerciseEditor();
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

function pickLocationThen(cb) {
  var locs = settings.locations.slice();
  $('confirm-body').innerHTML =
    '<h2>Where are you training?</h2>' +
    '<div class="loc-list" style="margin-top:6px;">' +
      locs.map(function(l) { return '<button class="btn btn-dark" style="justify-content:flex-start;" onclick="__pickLoc(\'' + escapeHtml(l).replace(/'/g, "\\'") + '\')">' + escapeHtml(l) + '</button>'; }).join('') +
    '</div>' +
    '<div class="sheet-actions"><button class="btn-ghost" onclick="addLocationPrompt()">+ Add location</button>' +
    '<button class="btn btn-dark" onclick="closeModal(\'confirm-modal\')">Cancel</button></div>';
  openModal('confirm-modal');
  window.__pickLoc = function(l) { closeModal('confirm-modal'); cb(l); };
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
}
function closeSessionOverlay() { closeKeypad(); $('session-overlay').classList.remove('active'); stopSessClock(); renderAll(); }

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
    var sets = workoutSets(active.id).filter(function(s) { return s.exerciseId === exId; });
    var prev = previousPerf(exId, active.location);
    html += '<div class="ex-block" data-ex="' + exId + '">' +
      '<div class="ex-block-head"><button class="ex-block-name" onclick="openExMenu(\'' + exId + '\')">' + escapeHtml(name) + '</button>' +
      '<button class="ex-menu" onclick="openExMenu(\'' + exId + '\')">•••</button></div>' +
      '<div class="set-table"><div class="sth"><div class="c-num">Set</div><div>Previous</div><div class="center">lbs</div><div class="center">Reps</div><div class="c-chk">✓</div></div>';
    sets.forEach(function(s, i) {
      var p = prev[i] || prev[prev.length - 1];
      var pTxt = p ? (fmtW(p.weight) + ' lb × ' + p.reps) : '—';
      html += '<div class="set-row ' + (s.done ? 'done' : '') + '" data-set="' + s.id + '">' +
        '<div class="c-num"><span class="set-badge" onclick="askDeleteSet(\'' + s.id + '\')">' + (i + 1) + '</span></div>' +
        '<div class="c-prev ' + (p ? 'use' : '') + '">' + pTxt + '</div>' +
        '<input class="cell" inputmode="none" data-set="' + s.id + '" data-field="weight" placeholder="' + (p ? fmtW(p.weight) : '0') + '" value="' + (s.weight != null ? fmtW(s.weight) : '') + '" onfocus="openKeypad(this)" onchange="setField(\'' + s.id + '\',\'weight\',this.value)">' +
        '<input class="cell" inputmode="none" data-set="' + s.id + '" data-field="reps" placeholder="' + (p ? p.reps : '0') + '" value="' + (s.reps != null ? s.reps : '') + '" onfocus="openKeypad(this)" onchange="setField(\'' + s.id + '\',\'reps\',this.value)">' +
        '<button class="chk ' + (s.done ? 'on' : '') + '" onclick="toggleDone(\'' + s.id + '\')"><svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg></button>' +
        '</div>' +
        '<div class="rest-slot" id="restslot-' + s.id + '"></div>';
    });
    var restSec = ex ? ex.defaultRestSec : DEFAULT_REST;
    html += '<button class="add-set" onclick="addSetTo(\'' + exId + '\')">+ Add Set' + (restSec ? ' (' + fmtClock(restSec) + ')' : '') + '</button></div></div>';
  });

  html += '<button class="add-ex" onclick="openExPicker(\'session\')">+ Add Exercise</button>' +
    '<button class="btn btn-danger" style="margin-top:14px;" onclick="cancelWorkout()">Cancel Workout</button>';
  sc.innerHTML = html;
  updateRestUI();
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
    weight: last ? last.weight : null, reps: last ? last.reps : null, done: false,
    restSec: ex ? ex.defaultRestSec : DEFAULT_REST, seq: nextSeq(), isPR: false, prTypes: []
  };
  await dbPut('sets', s);
  DATA.sets.push(s);
  if (!skipRender) renderSession();
}

function setLocal(id) { return DATA.sets.filter(function(s) { return s.id === id; })[0]; }

async function setField(id, field, val) {
  var s = setLocal(id); if (!s) return;
  s[field] = field === 'reps' ? (val === '' ? null : parseInt(val, 10)) : num(val);
  await dbPut('sets', s);
}

async function toggleDone(id) {
  var s = setLocal(id); if (!s) return;
  s.done = !s.done;
  if (s.done) {
    // fill blanks from the "Previous" hint if available
    var prev = previousPerf(s.exerciseId, active.location);
    var idx = workoutSets(active.id).filter(function(x) { return x.exerciseId === s.exerciseId; }).indexOf(s);
    var p = prev[idx] || prev[prev.length - 1];
    if (s.weight == null && p) s.weight = p.weight;
    if (s.reps == null && p) s.reps = p.reps;
  }
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
function kpCommit() {
  if (!activeCell) return;
  setField(activeCell.getAttribute('data-set'), activeCell.getAttribute('data-field'), activeCell.value);
}
function kpPress(ch) {
  if (!activeCell) return;
  var field = activeCell.getAttribute('data-field');
  var v = activeCell.value || '';
  if (ch === '.') { if (field === 'reps') return; if (v.indexOf('.') >= 0) return; if (v === '') v = '0'; }
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
  var cells = Array.prototype.slice.call(document.querySelectorAll('#sess-scroll .cell'));
  var i = cells.indexOf(activeCell);
  if (field === 'reps') {
    // Next on reps = check the set (fills blanks + marks done) and start its
    // rest timer, then jump to the next set's weight. No tapping the green check.
    var s = setDoneStartRest(setId);
    renderSession();
    if (s && s.restSec) startRest(s);
    var nc = Array.prototype.slice.call(document.querySelectorAll('#sess-scroll .cell'));
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
    var prev = previousPerf(s.exerciseId, active.location);
    var idx = workoutSets(active.id).filter(function(x) { return x.exerciseId === s.exerciseId; }).indexOf(s);
    var p = prev[idx] || prev[prev.length - 1];
    if (s.weight == null && p) s.weight = p.weight;
    if (s.reps == null && p) s.reps = p.reps;
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
  sessRest = { setId: s.id, exerciseId: s.exerciseId, total: s.restSec, remaining: s.restSec, paused: false, interval: null };
  sessRest.interval = setInterval(restTick, 1000);
  updateRestUI();
}
function restTick() {
  if (!sessRest || sessRest.paused) return;
  sessRest.remaining -= 1;
  if (sessRest.remaining <= 0) {
    playChime();
    if (navigator.vibrate) { try { navigator.vibrate([300, 120, 300, 120, 300]); } catch (e) {} }
    toast('⏱ Rest over — next set');
    stopRest();
    return;
  }
  updateRestUI();
}
function stopRest(silent) {
  if (sessRest && sessRest.interval) clearInterval(sessRest.interval);
  sessRest = null;
  if (!silent) updateRestUI();
}
function updateRestUI() {
  var chip = $('sess-timer-chip'), lbl = $('sess-timer-label');
  document.querySelectorAll('.rest-slot').forEach(function(el) { el.innerHTML = ''; });
  if (!sessRest) {
    if (chip) chip.classList.remove('running');
    if (lbl) lbl.textContent = 'Rest';
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
        '<button class="btn btn-dark" onclick="stopRest();closeModal(\'rest-control-sheet\')">Skip</button></div>' +
    '</div>';
}
function adjustRest(d) { if (!sessRest) return; sessRest.remaining = Math.max(1, sessRest.remaining + d); sessRest.total = Math.max(sessRest.total, sessRest.remaining); updateRestUI(); }
function resetRest() { if (!sessRest) return; sessRest.remaining = sessRest.total; sessRest.paused = false; updateRestUI(); }
function togglePauseRest() { if (!sessRest) return; sessRest.paused = !sessRest.paused; updateRestUI(); }

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

function confirmFinish() {
  closeKeypad();
  var ss = workoutSets(active.id);
  var unfinished = ss.filter(function(s) { return !s.done && (s.weight != null || s.reps != null); });
  var doneCt = ss.filter(function(s) { return s.done; }).length;
  if (!doneCt && !unfinished.length) {
    showConfirm('Finish empty workout?', 'No sets were completed — this will be discarded.', 'Discard', function() { cancelWorkout(); });
    return;
  }
  if (!unfinished.length) { finishWorkout(); return; }
  $('finish-sheet-body').innerHTML =
    '<div class="sheet-grab"></div><h2>Finish Workout?</h2>' +
    '<p class="sub">Some sets have data but aren\'t checked off. Empty sets will be removed either way.</p>' +
    '<div class="sheet-actions">' +
      '<button class="btn btn-green" onclick="finishWorkout(true)">Complete unfinished sets</button>' +
      '<button class="btn btn-danger" onclick="finishWorkout(false)">Discard unfinished sets</button>' +
      '<button class="btn btn-dark" onclick="closeModal(\'finish-sheet\')">Cancel</button>' +
    '</div>';
  openModal('finish-sheet');
}

async function finishWorkout(completeUnfinished) {
  closeKeypad();
  closeModal('finish-sheet');
  var ss = workoutSets(active.id);
  for (var i = 0; i < ss.length; i++) {
    var s = ss[i];
    var hasData = s.weight != null && s.reps != null;
    if (!s.done) {
      if (completeUnfinished && hasData) { s.done = true; await dbPut('sets', s); }
      else { await dbDelete('sets', s.id); DATA.sets = DATA.sets.filter(function(x) { return x.id !== s.id; }); }
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
  stopRest(true); stopSessClock();
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
    var bestW = 0, bestV = 0, best1 = 0;
    prior.forEach(function(s) {
      bestW = Math.max(bestW, s.weight || 0);
      bestV = Math.max(bestV, (s.weight || 0) * (s.reps || 0));
      best1 = Math.max(best1, epley(s.weight, s.reps));
    });
    var cur = workoutSets(workout.id).filter(function(s) { return s.exerciseId === exId && s.done; });
    for (var i = 0; i < cur.length; i++) {
      var s = cur[i], types = [];
      var w = s.weight || 0, v = w * (s.reps || 0), e = epley(s.weight, s.reps);
      if (w > bestW) { types.push('WEIGHT'); bestW = w; }
      if (v > bestV) { types.push('VOL'); bestV = v; }
      if (e > best1) { types.push('1RM'); best1 = e; }
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
    var prs = sets.reduce(function(a, s) { return a + (s.prTypes ? s.prTypes.length : 0); }, 0);
    var dur = w.finishedAt ? fmtDuration(new Date(w.finishedAt) - new Date(w.startedAt)) : '—';
    // best set per exercise
    var byEx = {};
    sets.forEach(function(s) { if (!byEx[s.exerciseId] || s.weight > byEx[s.exerciseId].weight) byEx[s.exerciseId] = s; });
    var rows = w.exerciseOrder.filter(function(e) { return byEx[e]; }).map(function(exId) {
      var s = byEx[exId], cnt = sets.filter(function(x) { return x.exerciseId === exId; }).length;
      return '<div class="hcs-row"><span class="l">' + cnt + ' × ' + escapeHtml(s.exerciseName || (exerciseById(exId) || {}).name || 'Exercise') + '</span>' +
        '<span class="r">' + fmtW(s.weight) + ' lb × ' + s.reps + '</span></div>';
    }).join('');
    html += '<div class="card hist-card">' +
      '<div class="row-between"><div><div class="hc-title">' + escapeHtml(w.label || 'Workout') + '</div>' +
      '<div class="hc-date">' + fmtDateLong(w.finishedAt) + (w.location ? ' · ' + escapeHtml(w.location) : '') + '</div></div>' +
      '<button class="ex-menu" style="background:var(--card-2);color:var(--accent);border-radius:8px;width:36px;height:30px;border:0;" onclick="openHistMenu(\'' + w.id + '\')">•••</button></div>' +
      '<div class="hc-stats">' +
        '<span><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 2"/></svg>' + dur + '</span>' +
        '<span><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16"/></svg>' + Math.round(vol).toLocaleString() + ' lb</span>' +
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
  var prs = sets.reduce(function(a, s) { return a + (s.prTypes ? s.prTypes.length : 0); }, 0);
  var dur = fmtDuration(new Date(w.finishedAt) - new Date(w.startedAt));
  var body = '<div class="sheet-grab"></div><h2>' + escapeHtml(w.label || 'Workout') + '</h2>' +
    '<p class="sub">' + fmtDateLong(w.finishedAt) + (w.location ? ' · ' + escapeHtml(w.location) : '') + '</p>' +
    '<div class="hc-stats" style="margin-top:0;"><span>⏱ ' + dur + '</span><span>🏋 ' + Math.round(vol).toLocaleString() + ' lb</span>' + (prs ? '<span class="pr-ct">🏆 ' + prs + '</span>' : '') + '</div>';
  w.exerciseOrder.forEach(function(exId) {
    var ss = sets.filter(function(s) { return s.exerciseId === exId; });
    if (!ss.length) return;
    var best1 = Math.max.apply(null, ss.map(function(s) { return epley(s.weight, s.reps); }));
    body += '<div class="detail-ex"><div class="de-head"><span>' + escapeHtml(ss[0].exerciseName || (exerciseById(exId) || {}).name || 'Exercise') + '</span><span class="de-1rm">1RM ' + best1 + '</span></div>';
    ss.forEach(function(s, i) {
      body += '<div class="detail-set"><span class="ds-n">' + (i + 1) + '</span>' +
        '<span>' + fmtW(s.weight) + ' lb × ' + s.reps +
        (s.prTypes && s.prTypes.length ? ' <span class="pr-badges">' + s.prTypes.map(function(t) { return '<span class="pr-badge">🏆 ' + t + '</span>'; }).join('') + '</span>' : '') +
        '</span><span class="ds-1rm">' + epley(s.weight, s.reps) + '</span></div>';
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
      weight: o.weight, reps: o.reps, done: false, restSec: o.restSec || DEFAULT_REST, seq: nextSeq(), isPR: false, prTypes: [] };
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
    exercises: DATA.exercises, workouts: DATA.workouts, sets: DATA.sets, templates: DATA.templates };
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
