// Minimal service worker: cache the static shell so the app installs as a
// PWA.  API requests always go to the network.
const CACHE = "learn-abc-v3";
// Service worker scope = the directory it's served from, so all paths here
// are *relative to the SW's location*.  For GitHub Pages project sites this
// keeps the cache scoped to /<repo-name>/ and not the whole user site.
const SHELL = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js",
  "./abcjs-basic-min.js",
  "./manifest.json",
  "./icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Cache-first for same-origin GETs only.  Cross-origin (Modal API) is
  // always a network fetch — no caching.
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});
