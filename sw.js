'use strict';

var CACHE = 'liftlog-v5';
var ASSETS = [
  '/liftlog/',
  '/liftlog/index.html',
  '/liftlog/styles.css',
  '/liftlog/db.js',
  '/liftlog/app.js',
  '/liftlog/auth.js',
  '/liftlog/sync.js',
  '/liftlog/manifest.json',
  '/liftlog/icon.svg'
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

// Network-first: always try fresh, fall back to cache when offline.
self.addEventListener('fetch', function(e) {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request).then(function(response) {
      var clone = response.clone();
      caches.open(CACHE).then(function(c) { c.put(e.request, clone); });
      return response;
    }).catch(function() { return caches.match(e.request); })
  );
});
