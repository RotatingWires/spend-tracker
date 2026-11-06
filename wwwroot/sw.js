// Network-first shell cache: the latest files are always used when the server is reachable; the cache is only an offline fallback.
const CACHE = 'spend-tracker-shell';
const STATIC = [
  '/', '/index.html', '/login.html', '/login.js', '/version.json', '/manifest.webmanifest', '/icons/spend.svg',
  '/theme.css', '/style.css', '/auth.css', '/theme.js',
  '/app.js', '/widgets.js', '/charts.js', '/transactions.js', '/calendar.js', '/stats.js',
  '/people.js', '/events.js', '/history.js', '/manage.js', '/bulk.js', '/ui.js'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(STATIC)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
    const cache = await caches.open(CACHE);
    const requests = await cache.keys();
    await Promise.all(requests
      .filter(request => !STATIC.includes(new URL(request.url).pathname))
      .map(request => cache.delete(request)));
  })());
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Never cache API responses: they contain private financial data.
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request, { cache: 'no-store' }).then(response => {
      if (response.ok && STATIC.includes(url.pathname)) {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy));
      }
      return response;
    }).catch(async () => {
      // Offline: use the cached copy. With no copy, answer with a normal network error instead of nothing.
      return (await caches.match(event.request)) ?? (await caches.match(url.pathname)) ?? Response.error();
    })
  );
});
