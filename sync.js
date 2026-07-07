'use strict';

// ── LiftLog · cloud sync ──────────────────────────────────────────────────────
// Ported from PepBros. Local IndexedDB is the offline working copy; Supabase is
// the canonical per-user copy. On sign-in (and "Sync now") we PULL → MERGE
// (last-write-wins by updatedAt, tombstones win) → refresh UI → PUSH. Edits push
// incrementally (debounced). Dormant until auth.js has a configured client (sb).

var SYNC_DEBOUNCE_MS = 1500;
var _pushTimer  = null;
var _busy       = false;
var _lastSyncAt = 0;

function syncEnabled() { return typeof authReady === 'function' && authReady(); }
function isOffline()   { return (typeof navigator !== 'undefined') && navigator.onLine === false; }

function getLocalOwner() { try { return localStorage.getItem('ll_owner_uid') || null; } catch (e) { return null; } }
function setLocalOwner(uid) { try { localStorage.setItem('ll_owner_uid', uid); } catch (e) {} }

async function wipeLocalForSwitch() {
  for (var i = 0; i < STORES.length; i++) await dbClear(STORES[i]);
  await dbClear('_tombstones');
  await dbClear('_pending');
}

async function resolveUid() {
  if (typeof currentUser === 'function' && currentUser()) return currentUser().id;
  try {
    var u = await sb.auth.getUser();
    return (u && u.data && u.data.user) ? u.data.user.id : null;
  } catch (e) { return null; }
}

function setSyncStatus(text) { var el = document.getElementById('sync-status'); if (el) el.textContent = text; }
function errText(e) {
  if (!e) return 'unknown error';
  return e.message || e.error_description || e.hint || e.code || JSON.stringify(e);
}

function rowForRecord(rec, uid) { return { id: rec.id, user_id: uid, data: rec, updated_at: rec.updatedAt || nowISO(), deleted: false }; }
function rowForTombstone(t, uid) { return { id: t.id, user_id: uid, data: {}, updated_at: t.updatedAt || nowISO(), deleted: true }; }

// Timestamps come in two formats — local records store toISOString() ("…Z"),
// Postgres returns timestamptz ("…+00:00") — so compare as epoch ms, never as
// strings. Missing/invalid → 0 (older than everything).
function ts(x) { var t = new Date(x || 0).getTime(); return isNaN(t) ? 0 : t; }

// Supabase caps every response at its max-rows setting (default 1000) no matter
// what limit you request, so pull page-by-page until a page comes back empty.
var PULL_PAGE = 1000;

async function _pullAll(uid) {
  var tombs = await dbGetTombstones();
  var tombByKey = {};
  tombs.forEach(function(t) { tombByKey[t.key] = t; });
  var applied = 0;
  for (var i = 0; i < STORES.length; i++) {
    var store = STORES[i];
    var from = 0;
    for (;;) {
      var res = await sb.from(store).select('id,data,updated_at,deleted')
        .order('id', { ascending: true }).range(from, from + PULL_PAGE - 1);
      if (res.error) throw res.error;
      var rows = res.data || [];
      for (var r = 0; r < rows.length; r++) applied += await _mergeRemoteRow(store, rows[r], tombByKey);
      if (!rows.length) break;
      from += rows.length;
    }
  }
  return applied;
}

async function _mergeRemoteRow(store, row, tombByKey) {
  var id = row.id, remoteTs = ts(row.updated_at), key = store + ':' + id;
  var localRec = await dbGet(store, id);
  var localTomb = tombByKey[key];
  if (row.deleted) {
    if (localRec && remoteTs >= ts(localRec.updatedAt)) { await dbDelete(store, id, { raw: true }); return 1; }
    return 0;
  }
  if (localTomb) {
    if (ts(localTomb.updatedAt) > remoteTs) return 0;
    await dbPut(store, row.data, { raw: true }); await dbClearTombstone(key); return 1;
  }
  if (!localRec) { await dbPut(store, row.data, { raw: true }); return 1; }
  if (remoteTs > ts(localRec.updatedAt)) { await dbPut(store, row.data, { raw: true }); return 1; }
  return 0;
}

async function _pushAll(uid) {
  var pendBefore = await dbGetPending();
  var count = 0;
  for (var i = 0; i < STORES.length; i++) {
    var store = STORES[i];
    var recs = await dbGetAll(store);
    if (!recs.length) continue;
    var rows = recs.map(function(r) { return rowForRecord(r, uid); });
    var res = await sb.from(store).upsert(rows, { onConflict: 'user_id,id' });
    if (res.error) throw res.error;
    count += rows.length;
  }
  var tombs = await dbGetTombstones(), byStore = {};
  tombs.forEach(function(t) { (byStore[t.store] = byStore[t.store] || []).push(rowForTombstone(t, uid)); });
  for (var s in byStore) {
    if (!byStore.hasOwnProperty(s)) continue;
    var rt = await sb.from(s).upsert(byStore[s], { onConflict: 'user_id,id' });
    if (rt.error) throw rt.error;
    count += byStore[s].length;
  }
  for (var j = 0; j < pendBefore.length; j++) await dbClearPending(pendBefore[j].key);
  return count;
}

async function _pushPending(uid) {
  var pend = await dbGetPending();
  if (!pend.length) return 0;
  var count = 0;
  for (var i = 0; i < pend.length; i++) {
    var p = pend[i], row;
    if (p.op === 'delete') { row = { id: p.id, user_id: uid, data: {}, updated_at: nowISO(), deleted: true }; }
    else { var rec = await dbGet(p.store, p.id); if (!rec) { await dbClearPending(p.key); continue; } row = rowForRecord(rec, uid); }
    var res = await sb.from(p.store).upsert([row], { onConflict: 'user_id,id' });
    if (res.error) throw res.error;
    await dbClearPending(p.key); count++;
  }
  return count;
}

async function reloadLocalUI() {
  if (typeof loadAllData === 'function') await loadAllData();
  if (typeof renderAll === 'function') { try { renderAll(); } catch (e) {} }
}

async function fullSync() {
  if (!syncEnabled() || _busy) return;
  if (isOffline()) { setSyncStatus('Offline — will sync when reconnected'); return; }
  _busy = true;
  try {
    var uid = await resolveUid();
    if (!uid) { setSyncStatus('Not signed in — sign in to sync.'); return; }
    var owner = getLocalOwner();
    if (owner && owner !== uid) { setSyncStatus('Switching account…'); await wipeLocalForSwitch(); await reloadLocalUI(); }
    setSyncStatus('Syncing…');
    var pulled = await _pullAll(uid);
    if (pulled) await reloadLocalUI();
    var pushed = await _pushAll(uid);
    setLocalOwner(uid); _lastSyncAt = Date.now();
    setSyncStatus('Synced ✓' + (pulled ? (' — restored ' + pulled) : '') + (pushed ? (', sent ' + pushed) : (pulled ? '' : ' — up to date')));
  } catch (e) { console.warn('[sync] fullSync failed:', e); setSyncStatus('Sync error: ' + errText(e)); }
  finally { _busy = false; }
}

async function pushChanges() {
  if (!syncEnabled() || _busy) return;
  if (isOffline()) { setSyncStatus('Offline — changes saved, will sync later'); return; }
  _busy = true; var deferToFull = false;
  try {
    var uid = await resolveUid(); if (!uid) return;
    var owner = getLocalOwner();
    if (owner && owner !== uid) { deferToFull = true; return; }
    var n = await _pushPending(uid);
    if (n) setSyncStatus('Backed up ✓');
  } catch (e) { console.warn('[sync] pushChanges failed:', e); setSyncStatus('Sync error: ' + errText(e)); }
  finally { _busy = false; }
  if (deferToFull) fullSync();
}

function forceSync() { if (!syncEnabled()) { setSyncStatus('Sync unavailable (offline or not configured).'); return; } fullSync(); }

async function deleteAccountData() {
  var uid = await resolveUid(); if (!uid) throw new Error('Not signed in');
  for (var i = 0; i < STORES.length; i++) { var res = await sb.from(STORES[i]).delete().eq('user_id', uid); if (res.error) throw res.error; }
}

// db.js calls this after any local data write/delete.
function onLocalChange() {
  if (!syncEnabled()) return;
  clearTimeout(_pushTimer);
  _pushTimer = setTimeout(function() { pushChanges(); }, SYNC_DEBOUNCE_MS);
}
// auth.js calls this when a session becomes available.
function onAuthReady(user, event) { if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') fullSync(); }

if (typeof window !== 'undefined') {
  window.addEventListener('online', function() { if (syncEnabled()) fullSync(); });
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState === 'visible' && syncEnabled() && !isOffline() && (Date.now() - _lastSyncAt > 30000)) fullSync();
    });
  }
}
