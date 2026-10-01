/**
 * Service worker — the app still opens with no signal.
 *
 * Hand-written, no library. It keeps one thing: the secretary interface
 * itself (the page, the stylesheet, every script, and the engine files that
 * apps/web/server.ts serves with their types stripped), in the browser's
 * Cache API. The rodeo's data is not here; that is the packet, in IndexedDB.
 *
 * Network first, cache when the network does not answer in time: with a
 * signal she always gets the current app, without one she gets the last copy.
 * API calls are never cached — a stale score served as if it were the
 * server's answer is exactly the lie the offline desk exists to avoid.
 */

const CACHE = 'rodeo-os-shell-v1';
const NETWORK_TIMEOUT_MS = 3000;

const SHELL = [
  '/',
  '/index.html',
  '/app.css',
  '/config.json',
  '/js/app.js',
  '/js/api.js',
  '/js/ui.js',
  '/js/offline.js',
  '/js/night.js',
  '/js/views/arena.js',
  '/js/views/books.js',
  '/js/views/compliance.js',
  '/js/views/contestant.js',
  '/js/views/corrections.js',
  '/js/views/daysheet.js',
  '/js/views/desk.js',
  '/js/views/draw.js',
  '/js/views/entries.js',
  '/js/views/grounds.js',
  '/js/views/payouts.js',
  '/js/views/results.js',
  '/js/views/rodeo.js',
  '/js/views/scoring.js',
  '/js/views/setup.js',
  '/js/views/waivers.js',
  '/js/views/yearend.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    let engine = [];
    try {
      const res = await fetch('/engine/manifest.json', { cache: 'no-store' });
      if (res.ok) engine = await res.json();
    } catch { /* no engine server: the offline payout will say so */ }
    // addAll is all-or-nothing: a half-cached shell would open and then fail
    // on the first view it could not load.
    await cache.addAll([...SHELL, ...engine]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/v1/')) return; // the API, if it shares the origin

  const navigation = req.mode === 'navigate';
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await withTimeout(fetch(req), NETWORK_TIMEOUT_MS);
      if (res.ok) cache.put(navigation ? '/index.html' : req, res.clone());
      return res;
    } catch {
      const hit = await cache.match(navigation ? '/index.html' : req, { ignoreSearch: true });
      if (hit) return hit;
      return new Response('Offline, and this file was never saved on this browser.', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
