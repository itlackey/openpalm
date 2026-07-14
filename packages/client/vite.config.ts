import { sveltekit } from '@sveltejs/kit/vite';
import { SvelteKitPWA, type SvelteKitPWAOptions } from '@vite-pwa/sveltekit';
import { defineConfig } from 'vite';

export const PWA_ICON_ENTRIES = [
  {
    src: 'pwa-192x192.png',
    sizes: '192x192',
    type: 'image/png',
  },
  {
    src: 'pwa-512x512.png',
    sizes: '512x512',
    type: 'image/png',
  },
  {
    src: 'maskable-512x512.png',
    sizes: '512x512',
    type: 'image/png',
    purpose: 'maskable',
  },
];

export const pwaOptions: Partial<SvelteKitPWAOptions> = {
  strategies: 'generateSW',
  injectRegister: 'auto',
  registerType: 'autoUpdate',
  includeAssets: ['pwa-192x192.png', 'pwa-512x512.png', 'maskable-512x512.png'],
  manifest: {
    name: 'OpenPalm',
    short_name: 'OpenPalm',
    description: 'OpenPalm client app for chat and connection switching.',
    display: 'standalone',
    start_url: '/',
    scope: '/',
    background_color: '#f9fafb',
    theme_color: '#f9fafb',
    icons: [...PWA_ICON_ENTRIES],
  },
  workbox: {
    globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
    globIgnores: ['**/runtime-config.json'],
    // adapter-static writes index.html after the PWA plugin scans SvelteKit's
    // output, so add the navigation fallback explicitly to the precache.
    additionalManifestEntries: [{ url: '/index.html', revision: null }],
    navigateFallback: '/index.html',
    runtimeCaching: [
      {
        urlPattern: ({ request, url }) => {
          if (request.method !== 'GET') return false;
          if (request.headers.get('authorization') || request.headers.has('cookie')) return false;
          if (request.credentials !== 'omit') return false;
          return url.pathname === '/runtime-config.json';
        },
        handler: 'NetworkFirst',
        options: {
          cacheName: 'runtime-config',
          cacheableResponse: { statuses: [200] },
        },
      },
      {
        // H1 (review 2026-07-10 §H1): this used to have no
        // networkTimeoutSeconds/expiration at all — any unauthenticated GET
        // (session lists, health probes) could be served from cache
        // indefinitely, so a real outage after a healthy period was
        // invisible (cached data kept rendering as if the assistant were
        // up), and the same broad match would try to cache a future
        // unauthenticated SSE stream's (infinite) body. Excluding
        // `Accept: text/event-stream` plus a short network timeout and a
        // bounded expiration turn this back into "prefer live data, fall
        // back briefly to a recent cache" instead of "cache forever".
        urlPattern: ({ request, url }) => {
          if (request.method !== 'GET') return false;

          // A `cache: 'no-store'` request (probeHealth() sets it, §H1) must
          // reach the real network — bypassing the browser HTTP cache is not
          // enough, because a NetworkFirst SW route would still satisfy it
          // from Cache Storage on a failure/timeout, keeping the health badge
          // "accessible" through an outage. Never intercept no-store.
          if (request.cache === 'no-store' || request.cache === 'reload') {
            return false;
          }

          const authorization = request.headers.get('authorization');
          const hasCookieHeader = request.headers.has('cookie');
          if (authorization || hasCookieHeader || request.credentials === 'include') {
            return false;
          }

          if (
            request.credentials === 'same-origin' &&
            typeof location !== 'undefined' &&
            url.origin === location.origin
          ) {
            return false;
          }

          // Never intercept an SSE subscription (transport subscribeEvents()
          // GETs /event with Accept: text/event-stream) — NetworkFirst would
          // otherwise buffer the whole (never-ending) stream body trying to
          // decide whether to cache it.
          if (request.headers.get('accept') === 'text/event-stream') return false;

          return url.protocol === 'http:' || url.protocol === 'https:';
        },
        handler: 'NetworkFirst',
        options: {
          cacheName: 'openpalm-public-get',
          cacheableResponse: { statuses: [200] },
          // A slow/hanging connection falls back to cache after 3s instead
          // of leaving the UI waiting on a dead network indefinitely.
          networkTimeoutSeconds: 3,
          // Bounded so a cached outage-era response can't outlive its
          // usefulness — old session lists/health data expire on their own.
          expiration: { maxEntries: 50, maxAgeSeconds: 60 },
        },
      },
    ],
  },
};

export default defineConfig({
  plugins: [
    sveltekit(),
    SvelteKitPWA(pwaOptions),
  ],
  optimizeDeps: {
    // Raw-source Svelte package — esbuild cannot prebundle .svelte files;
    // vite-plugin-svelte compiles it as part of the app instead (same
    // arrangement as packages/ui).
    exclude: ['@openpalm/ui-kit'],
  },
});
