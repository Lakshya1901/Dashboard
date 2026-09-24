// sw.js — minimal app-shell service worker with network-first.

const CACHE_NAME = "tasks-cache-v4";
const SHELL_URLS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./scheduler.js",
  "./sync.js",
  "./stats.js",
  "./stats.css",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // leave cross-origin (api.github.com) alone

  // Network first so updates show immediately; the cache is only the offline fallback.
  // Page loads share one cache entry regardless of ?now= / ?sample
  const key = request.mode === "navigate" ? "./" : request;
  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      fetch(request.url, { cache: "no-cache" }) // revalidate, so a new deploy shows on the next load
        .then((response) => {
          if (response && response.ok) cache.put(key, response.clone());
          return response;
        })
        .catch(async () => (await cache.match(key)) || Response.error())
    )
  );
});
