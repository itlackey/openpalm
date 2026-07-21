/**
 * Basic PWA service worker (issue #511) — SvelteKit's native
 * `$service-worker` support, zero extra dependencies.
 *
 * Scope is deliberately narrow: this is a minimal "static shell" cache, not
 * an offline-first app.
 *
 *  - Precaches the build output + everything in `static/` (manifest, icons,
 *    fonts, etc.) and serves ONLY those exact paths cache-first.
 *  - Everything else — every `/api/*` route (including SSE event streams),
 *    `/login`, `/voice/*`, `/health`, page navigations, and any
 *    cross-origin request (a connection's OpenCode/Guardian base URL) — is
 *    never intercepted: no `respondWith`, no caching, no offline fallback.
 *    Auth and streaming responses must never be served from a
 *    service-worker cache, and page navigations must always reach
 *    hooks.server.ts so the auth/landing gates keep deciding what renders.
 *  - Old caches from a previous deploy are deleted on activate.
 */
/// <reference types="@sveltejs/kit" />
/// <reference no-default-lib="true" />
/// <reference lib="esnext" />
/// <reference lib="webworker" />

import { build, files, version } from '$service-worker';

const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE_NAME = `openpalm-shell-${version}`;

// `build` = the hashed JS/CSS the app just built; `files` = everything under
// static/ (manifest.webmanifest, pwa-*.png, fonts, etc.). Both are same-
// origin absolute paths (e.g. "/pwa-192x192.png").
const PRECACHE_ASSETS: readonly string[] = [...build, ...files];

sw.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(PRECACHE_ASSETS);
    })(),
  );
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Cross-origin (a connection's OpenCode/Guardian base URL, voice provider
  // calls, etc.) is never this service worker's business.
  if (url.origin !== sw.location.origin) return;

  // NETWORK-ONLY passthrough for anything that isn't a precached asset —
  // this is the guard that keeps /api/* (including SSE streams), /login,
  // /voice/*, /health, and every server-rendered page navigation completely
  // untouched by this worker.
  if (!PRECACHE_ASSETS.includes(url.pathname)) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(url.pathname);
      if (cached) return cached;

      // Not cached yet (e.g. shipped after this worker's install ran) —
      // fetch once and backfill the cache for next time.
      const response = await fetch(request);
      if (response.status === 200) {
        cache.put(url.pathname, response.clone());
      }
      return response;
    })(),
  );
});
