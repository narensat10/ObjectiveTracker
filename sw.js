// Everything is fetched network-first (revalidating past GitHub Pages' 10-minute HTTP cache),
// so updates show up on the next open; the cache is only the offline fallback.
// Bump CACHE_VERSION when app files change so old caches get cleaned up.
// Progress lives in localStorage, which this worker never touches, so updates keep it.
var CACHE_VERSION = 'fc27-tracker-v5.0.0';
var DATA_URL = 'data/objectives.json';
var ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './' + DATA_URL,
  './data/sbcs.json',
  './data/evos.json',
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

// The app mirrors a small summary (unfinished tracked groups, this week's stats) into IndexedDB,
// because notifications are built here and a service worker can't read localStorage.
function readSummary() {
  return new Promise(function (resolve) {
    try {
      var req = indexedDB.open('fc27-tracker', 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
      req.onerror = function () { resolve(null); };
      req.onsuccess = function () {
        try {
          var get = req.result.transaction('kv').objectStore('kv').get('summary');
          get.onsuccess = function () { resolve(get.result || null); req.result.close(); };
          get.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      };
    } catch (e) { resolve(null); }
  });
}

function names(list) {
  return list.slice(0, 3).join(', ') + (list.length > 3 ? ' and ' + (list.length - 3) + ' more' : '');
}

// Turn a push from tools/notify.js into one notification, personalised with the summary.
function compose(msg, sum) {
  if (msg.type === 'recap') {
    var w = sum && sum.week;
    var body = w && (w.m || w.done || w.sbc)
      ? 'This week: ' + w.m + ' match' + (w.m === 1 ? '' : 'es') + (w.m ? ' (' + w.w + 'W ' + w.d + 'D ' + w.l + 'L)' : '') + ', ' + w.done + ' objective' + (w.done === 1 ? '' : 's') + ' done' + (w.sbc ? ', ' + w.sbc + ' SBC' + (w.sbc === 1 ? '' : 's') : '') + '.'
      : 'Quiet week. Open the tracker to see what’s left before the weekly reset on Thursday.';
    if (sum && sum.left) body += ' ' + sum.left + ' tracked objective' + (sum.left === 1 ? '' : 's') + ' to go.';
    return { title: 'Your FC 27 weekly recap', body: body, url: './?view=stats', tag: 'recap' };
  }
  if (!msg.type) return { title: msg.title || 'New FC 27 objectives', body: msg.body || 'Open the tracker to see what was added.', url: msg.url || './?filter=new', tag: 'new-objectives' };

  var added = msg.added || [], sbcs = msg.sbcs || [], ending = msg.ending || [], sbcEnding = msg.sbcEnding || [];
  var mine = sum ? ending.filter(function (e) { return sum.unfinished.indexOf(e.id) !== -1; }) : [];
  var mineSbc = sum ? sbcEnding.filter(function (e) { return (sum.sbcOpen || []).indexOf(e.id) !== -1; }) : [];
  var parts = [];
  if (added.length) parts.push('New: ' + names(added) + '.');
  if (sbcs.length) parts.push('New SBC' + (sbcs.length > 1 ? 's' : '') + ': ' + names(sbcs) + '.');
  if (mine.length || mineSbc.length) {
    var m = mine.map(function (e) { return e.name; }).concat(mineSbc.map(function (e) { return e.name + ' SBC'; }));
    return { title: '⏳ Ending soon: ' + m[0] + (m.length > 1 ? ' +' + (m.length - 1) : ''), body: 'You haven’t finished ' + names(m) + ' yet.' + (parts.length ? ' ' + parts.join(' ') : ''), url: './?filter=soon', tag: 'ending' };
  }
  if (added.length || sbcs.length) {
    var n = added.length + sbcs.length;
    if (ending.length) parts.push('Ending soon: ' + names(ending.map(function (e) { return e.name; })) + '.');
    return { title: n + ' new in FC 27', body: parts.join(' '), url: added.length ? './?filter=new' : './?sbc=new', tag: 'new-objectives' };
  }
  var all = ending.map(function (e) { return e.name; }).concat(sbcEnding.map(function (e) { return e.name + ' SBC'; }));
  return { title: 'Ending soon in FC 27', body: names(all) + (all.length === 1 ? ' is' : ' are') + ' about to leave the game.', url: './?filter=soon', tag: 'ending' };
}

self.addEventListener('push', function (event) {
  var msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch (e) { msg = { body: event.data && event.data.text() }; }
  event.waitUntil(readSummary().then(function (sum) {
    var n = compose(msg, sum);
    if (sum && sum.badge && self.navigator && self.navigator.setAppBadge) {
      (sum.left ? self.navigator.setAppBadge(sum.left) : self.navigator.clearAppBadge()).catch(function () {});
    }
    return self.registration.showNotification(n.title, {
      body: n.body,
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag: n.tag,
      data: { url: n.url }
    });
  }));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = new URL((event.notification.data && event.notification.data.url) || './?filter=new', self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      if ('navigate' in list[i]) return list[i].navigate(url).then(function (c) { return c && c.focus(); });
    }
    return self.clients.openWindow(url);
  }));
});
