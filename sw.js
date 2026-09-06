const CACHE = 'progressos-v2';

const PRECACHE_URLS = [
  '/',
  '/app',
  '/landing.html',
  '/index.html',
  '/js/auth.js',
  '/manifest.json',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

async function fromCacheOrFallback(request, fallbackStatus = 503) {
  const cached = await caches.match(request);
  return cached || new Response(null, { status: fallbackStatus });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API requests: network-only (never cached to protect sensitive/authenticated data)
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  // CDN / external requests: network-first
  if (url.origin !== self.location.origin) {
    event.respondWith(
      fetch(request).catch(() => fromCacheOrFallback(request, 503))
    );
    return;
  }

  // HTML: network-first for fresh content
  if (url.pathname.endsWith('.html') || url.pathname === '/' || url.pathname === '/app') {
    event.respondWith(
      fetch(request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, clone));
        }
        return response;
      }).catch(() => fromCacheOrFallback(request, 503))
    );
    return;
  }

  // Static assets: stale-while-revalidate
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        fetch(request).then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, clone));
          }
        });
        return cached;
      }
      return fetch(request).catch(() => new Response(null, { status: 503 }));
    })
  );
});
