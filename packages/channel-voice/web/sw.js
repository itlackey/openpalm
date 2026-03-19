const CACHE = 'voice-v2'
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
  if (url.pathname.startsWith('/api/')) return
  // Network-first for all assets (cache is offline fallback only)
  e.respondWith(
    fetch(e.request).then((res) => {
      const clone = res.clone()
      caches.open(CACHE).then((c) => c.put(e.request, clone))
      return res
    }).catch(() => caches.match(e.request))
  )
})
