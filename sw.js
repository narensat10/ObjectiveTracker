// Everything is fetched network-first (revalidating past GitHub Pages' 10-minute HTTP cache),
// so updates show up on the next open; the cache is only the offline fallback.
// Bump CACHE_VERSION when app files change so old caches get cleaned up.
// Progress lives in localStorage, which this worker never touches, so updates keep it.
var CACHE_VERSION = 'fc27-tracker-v2.2.0';
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
  return fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then(function (res) {
    if (res.ok) {
      var copy = res.clone();
      caches.open(CACHE_VERSION).then(function (c) { c.put(fallbackKey || req, copy); });
    }
    return res;
  }).catch(function () {
    return caches.match(fallbackKey || req, { ignoreSearch: true }).then(function (r) {
      return r || (req.mode === 'navigate' ? caches.match('./') : Response.error());
    });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  var url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') { event.respondWith(networkFirst(req, './index.html')); return; }
  if (url.pathname.endsWith('/' + DATA_URL)) { event.respondWith(networkFirst(req, './' + DATA_URL)); return; }
  event.respondWith(networkFirst(req));
});
