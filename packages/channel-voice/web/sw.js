const CACHE = 'voice-v2'
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.webmanifest']

async function offlineFallback(request) {
  const cached = await caches.match(request)
  if (cached) return cached

  if (request.mode === 'navigate') {
    const appShell = await caches.match('/index.html')
    if (appShell) return appShell
  }

  return new Response('Offline', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })
}

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
  if (e.request.method !== 'GET') return
  const url = new URL(e.request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/')) return
  // Network-first for all assets (cache is offline fallback only)
  e.respondWith(
    fetch(e.request).then((res) => {
      const clone = res.clone()
      caches.open(CACHE).then((c) => c.put(e.request, clone))
      return res
    }).catch(() => offlineFallback(e.request))
  )
})
