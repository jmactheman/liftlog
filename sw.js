'use strict';

var CACHE = 'liftlog-v10';
// Precache URLs must match how index.html requests them (incl. ?v=) — cache
// matching is exact-URL, so unversioned entries would never be hit.
var ASSETS = [
  '/liftlog/',
  '/liftlog/index.html',
  '/liftlog/styles.css?v=10',
  '/liftlog/db.js?v=10',
  '/liftlog/app.js?v=10',
  '/liftlog/sync.js?v=10',
  '/liftlog/auth.js?v=10',
  '/liftlog/manifest.json?v=10',
  '/liftlog/icon.svg?v=10'
];

self.addEventListener('install', function(e) {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(function(c) { return c.addAll(ASSETS); }).catch(function() {}));
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
    }).then(function() { return self.clients.claim(); })
  );
});

// What's worth keeping for offline: our own successful responses, plus the
// supabase-js CDN script (an opaque no-cors response — ok is always false for
// those). Never cache Supabase API/auth traffic (stale data + wasted storage),
// and never cache error responses.
function cacheable(request, response) {
  var url = new URL(request.url);
  if (url.hostname.endsWith('.supabase.co')) return false;
  if (url.origin === self.location.origin) return response.ok;
  return response.ok || response.type === 'opaque';
}

// Network-first: always try fresh, fall back to cache when offline.
self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(function(response) {
      if (cacheable(e.request, response)) {
        var clone = response.clone();
        caches.open(CACHE).then(function(c) { return c.put(e.request, clone); }).catch(function() {});
      }
      return response;
    }).catch(function() {
      return caches.match(e.request).then(function(hit) {
        if (hit) return hit;
        // offline navigation to any path we serve → the app shell
        if (e.request.mode === 'navigate') return caches.match('/liftlog/index.html');
        return hit;
      });
    })
  );
});
