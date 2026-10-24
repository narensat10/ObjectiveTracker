// Bump CACHE_VERSION whenever you change an app file (not needed for data/objectives.json).
// Progress lives in localStorage, which this worker never touches, so updates keep it.
var CACHE_VERSION = 'fc27-tracker-v2.0.0';
var DATA_URL = 'data/objectives.json';
var ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './' + DATA_URL,
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(function (cache) { return cache.addAll(ASSETS.map(function (u) { return new Request(u, { cache: 'reload' }); })); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE_VERSION) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function networkFirst(req, fallbackKey) {
  return fetch(req).then(function (res) {
    if (res.ok) {
      var copy = res.clone();
      caches.open(CACHE_VERSION).then(function (c) { c.put(fallbackKey || req, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(fallbackKey || req, { ignoreSearch: true }).then(function (r) {
      return r || caches.match('./');
    });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  var url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // Pages and the daily objectives data: network first so updates show up, cache when offline.
  if (req.mode === 'navigate') { event.respondWith(networkFirst(req, './index.html')); return; }
  if (url.pathname.endsWith('/' + DATA_URL)) { event.respondWith(networkFirst(req, './' + DATA_URL)); return; }

  // Other assets: cache first, then network (and cache the result).
  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;
      return fetch(req).then(function (res) {
        if (res.ok) {
          var copy = res.clone();
          caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});
