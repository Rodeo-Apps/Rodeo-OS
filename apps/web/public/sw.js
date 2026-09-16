/**
 * Service worker — the app keeps working when the arena network does not.
 *
 * ---------------------------------------------------------------------------
 * OFFLINE IS THE NORMAL CASE, NOT THE EXCEPTION.
 * ---------------------------------------------------------------------------
 * A rodeo runs in a metal building at the end of a dirt road on one bar of
 * signal. The office cannot stop because the hotspot dropped. So the shell —
 * the HTML, the CSS, the modules — is cached on install and served from the
 * cache first, and read requests to the API fall back to the last response we
 * saw. Writes made offline are NOT handled here; they are queued in the page
 * (offline.js) and replayed when the connection returns, because a service
 * worker cannot tell the secretary "saved, will sync" — the page can.
 *
 * Two caches, each versioned by CACHE_VERSION so a deploy cleans up after the
 * one before it:
 *   shell — the static app, precached, cache-first.
 *   api   — GET responses, network-first with a cached fallback.
 */

const CACHE_VERSION = 'v1';
const SHELL_CACHE = `rodeo-shell-${CACHE_VERSION}`;
const API_CACHE = `rodeo-api-${CACHE_VERSION}`;

// The app shell. Everything here has to be present for the app to boot with no
// network at all. The view modules are code-split and imported on demand, so
// they are not listed — they are picked up by the runtime cache the first time
// they load, which is fine: a secretary opens the screens she uses before she
// loses signal, and those are then cached.
const SHELL = [
  '/',
  '/index.html',
  '/app.css',
  '/manifest.webmanifest',
  '/icon.svg',
  '/js/app.js',
  '/js/api.js',
  '/js/ui.js',
  '/js/offline.js',
];
// /config.json is deliberately not precached: it is optional (the app falls
// back to same-origin when it is absent) and addAll is atomic, so listing a
// file that may 404 would fail the whole install and leave nothing cached.

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // addAll is atomic; one 404 fails the install. The shell is the set of
      // files that must exist, so failing loudly here is correct.
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== API_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** A GET to our own API — the reads that should survive going offline. */
function isApiGet(request, url) {
  return request.method === 'GET' && url.pathname.startsWith('/v1/');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only same-origin traffic is ours to cache. Anything cross-origin (a map
  // tile, a font) goes straight to the network untouched.
  if (url.origin !== self.location.origin) return;

  // Writes are never cached and never queued here — the page owns that. If we
  // are offline the fetch rejects, and offline.js has already stored the write.
  if (request.method !== 'GET') return;

  if (isApiGet(request, url)) {
    // Network-first: live data when there is a network, the last copy when
    // there is not. A read that has never succeeded once simply fails, which
    // the view already handles.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(API_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request)),
    );
    return;
  }

  // The shell: cache-first, since it only changes on deploy and the activate
  // step already cleared the old version.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          // Cache same-origin static assets (the code-split view modules) as
          // they are first fetched, so the next offline load has them.
          if (response.ok && (url.pathname.startsWith('/js/') || url.pathname.endsWith('.css'))) {
            const copy = response.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => {
          // A navigation with no network and no exact cache hit still gets the
          // app shell, so deep links open offline and the router takes over.
          if (request.mode === 'navigate') return caches.match('/index.html');
          return undefined;
        });
    }),
  );
});
