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
        urlPattern: ({ request, url }) => {
          if (request.method !== 'GET') return false;

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

          return url.protocol === 'http:' || url.protocol === 'https:';
        },
        handler: 'NetworkFirst',
        options: {
          cacheName: 'openpalm-public-get',
          cacheableResponse: { statuses: [200] },
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
