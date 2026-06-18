'use strict';

// ── LiftLog IndexedDB layer ──────────────────────────────────────────────────
// Ported from the PepBros tracker. IndexedDB is the offline working copy;
// Supabase (when configured) is the canonical per-user copy. Every put to a data
// store stamps `updatedAt`, queues the change in _pending, and clears stale
// tombstones; deletes write a tombstone so removals propagate. { raw:true } skips
// all of that (used by the sync layer when applying remote changes).

var DB_NAME    = 'LiftLogDB';
var DB_VERSION = 1;
// Data stores that hold user records and participate in cloud sync.
var STORES     = ['exercises','workouts','sets','templates','settings'];
// Local-only bookkeeping stores (never synced as data; they DRIVE sync).
var META_STORES = ['_tombstones','_pending'];

var idb = null;

function nowISO()            { return new Date().toISOString(); }
function syncKey(store, id)  { return store + ':' + id; }
function isDataStore(store)  { return STORES.indexOf(store) > -1; }

function openDB() {
    return new Promise(function(resolve, reject) {
        if (idb) { resolve(idb); return; }
        var req = indexedDB.open(DB_NAME, DB_VERSION);

        req.onupgradeneeded = function(e) {
            var db = e.target.result;
            STORES.forEach(function(s) {
                if (!db.objectStoreNames.contains(s)) {
                    db.createObjectStore(s, { keyPath: 'id' });
                }
            });
            META_STORES.forEach(function(s) {
                if (!db.objectStoreNames.contains(s)) {
                    db.createObjectStore(s, { keyPath: 'key' });
                }
            });
        };

        req.onsuccess = function(e) { idb = e.target.result; resolve(idb); };
        req.onerror   = function(e) { reject(e.target.error); };
    });
}

function dbGetAll(store) {
    return openDB().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx  = db.transaction(store, 'readonly');
            var req = tx.objectStore(store).getAll();
            req.onsuccess = function() { resolve(req.result || []); };
            req.onerror   = function() { reject(req.error); };
        });
    });
}

// Put a record. For data stores this also stamps `updatedAt`, queues the record
// for push (_pending), and clears any stale tombstone for the same id — all in
// one atomic transaction. Pass { raw: true } to write exactly as given without
// stamping or dirtying (used by the sync layer when applying remote changes).
function dbPut(store, obj, opts) {
    opts = opts || {};
    return openDB().then(function(db) {
        return new Promise(function(resolve, reject) {
            var doSync = !opts.raw && isDataStore(store);
            if (doSync) obj.updatedAt = nowISO();
            var names = doSync ? [store, '_pending', '_tombstones'] : [store];
            var tx = db.transaction(names, 'readwrite');
            tx.objectStore(store).put(obj);
            if (doSync) {
                var k = syncKey(store, obj.id);
                tx.objectStore('_pending').put({ key: k, store: store, id: obj.id, op: 'put' });
                tx.objectStore('_tombstones').delete(k); // un-delete on resurrection
            }
            tx.oncomplete = function() {
                if (doSync && typeof onLocalChange === 'function') { try { onLocalChange(); } catch (e) {} }
                resolve();
            };
            tx.onerror = function() { reject(tx.error); };
            tx.onabort = function() { reject(tx.error); };
        });
    });
}

// Delete a record. For data stores this removes the row AND records a tombstone
// + a pending delete so the removal syncs to the cloud. Pass { raw: true } to
// hard-delete locally without leaving a tombstone (used by sync when applying a
// remote deletion that already happened elsewhere).
function dbDelete(store, id, opts) {
    opts = opts || {};
    return openDB().then(function(db) {
        return new Promise(function(resolve, reject) {
            var k = syncKey(store, id);
            if (opts.raw || !isDataStore(store)) {
                var tx0 = db.transaction([store], 'readwrite');
                tx0.objectStore(store).delete(id);
                tx0.oncomplete = function() { resolve(); };
                tx0.onerror    = function() { reject(tx0.error); };
                tx0.onabort    = function() { reject(tx0.error); };
                return;
            }
            var tx = db.transaction([store, '_tombstones', '_pending'], 'readwrite');
            tx.objectStore(store).delete(id);
            tx.objectStore('_tombstones').put({ key: k, store: store, id: id, updatedAt: nowISO() });
            tx.objectStore('_pending').put({ key: k, store: store, id: id, op: 'delete' });
            tx.oncomplete = function() {
                if (typeof onLocalChange === 'function') { try { onLocalChange(); } catch (e) {} }
                resolve();
            };
            tx.onerror = function() { reject(tx.error); };
            tx.onabort = function() { reject(tx.error); };
        });
    });
}

function dbClear(store) {
    return openDB().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx  = db.transaction(store, 'readwrite');
            var req = tx.objectStore(store).clear();
            req.onsuccess = function() { resolve(); };
            req.onerror   = function() { reject(req.error); };
        });
    });
}

function dbGet(store, id) {
    return openDB().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx  = db.transaction(store, 'readonly');
            var req = tx.objectStore(store).get(id);
            req.onsuccess = function() { resolve(req.result || null); };
            req.onerror   = function() { reject(req.error); };
        });
    });
}

// ── Sync helpers (used by sync.js) ───────────────────────────────────────────
function dbGetPending()    { return dbGetAll('_pending'); }
function dbGetTombstones() { return dbGetAll('_tombstones'); }

function dbClearPending(key) {
    return openDB().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx  = db.transaction('_pending', 'readwrite');
            var req = tx.objectStore('_pending').delete(key);
            req.onsuccess = function() { resolve(); };
            req.onerror   = function() { reject(req.error); };
        });
    });
}

function dbClearTombstone(key) {
    return openDB().then(function(db) {
        return new Promise(function(resolve, reject) {
            var tx  = db.transaction('_tombstones', 'readwrite');
            var req = tx.objectStore('_tombstones').delete(key);
            req.onsuccess = function() { resolve(); };
            req.onerror   = function() { reject(req.error); };
        });
    });
}
