const CACHE = 'voice-v3'
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  // Only cache same-origin GET requests; skip API calls and non-GET methods
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return
  // Network-first: update cache on success, serve from cache when offline
  e.respondWith(
    fetch(e.request).then((res) => {
      const clone = res.clone()
      caches.open(CACHE).then((c) => c.put(e.request, clone))
      return res
    }).catch(() =>
      caches.match(e.request).then((cached) =>
        cached || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
      )
    )
  )
})
