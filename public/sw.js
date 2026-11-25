// sw.js — offline support for the installed (Home screen) OpenWings app.
// The game is one HTML file. Online: always fetch the latest copy (and keep it); offline or on a
// dead connection: play the kept copy. Because the app still runs from the https site, the phone's
// motion sensor (TILT TO FLY) keeps working offline, unlike a downloaded file.
const CACHE = 'openwings-v1';
const CORE = ['./', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// network first, give up after a few seconds, then the kept copy
function fresh(req, key) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('slow')), 6000);
    fetch(req).then(res => {
      clearTimeout(t);
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key || req, copy)); }
      resolve(res);
    }, (err) => { clearTimeout(t); reject(err); });
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  if (req.mode === 'navigate') {
    // every page of the site is the game: index.html / OpenWings.html share one kept copy
    e.respondWith(fresh(req, './').catch(() => caches.match('./', { ignoreSearch: true })
      .then(r => r || caches.match(req, { ignoreSearch: true }))
      .then(r => r || fetch(req))));        // nothing kept yet (first visit on a slow line): just wait
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fresh(req)));
});
