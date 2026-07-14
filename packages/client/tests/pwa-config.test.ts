import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url));
const BUILD_DIR = join(PKG_ROOT, 'build');
const STATIC_DIR = join(PKG_ROOT, 'static');
const APP_HTML_PATH = join(PKG_ROOT, 'src', 'app.html');

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function loadViteConfig() {
  const mod = await import('../vite.config.ts');
  return typeof mod.default === 'function' ? mod.default({ command: 'build', mode: 'test' }) : mod.default;
}

async function loadPwaModule() {
  return import('../vite.config.ts');
}

async function loadSvelteConfig() {
  const mod = await import('../svelte.config.js');
  return mod.default;
}

function builtFiles(): string[] {
  if (!existsSync(BUILD_DIR)) {
    throw new Error(`client build output missing at ${BUILD_DIR} — run \`bun run client:build\` first`);
  }
  return walk(BUILD_DIR);
}

function withLocationOrigin<T>(origin: string, run: () => T): T {
  const originalLocation = globalThis.location;
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin }
  });

  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      value: originalLocation
    });
  }
}

function makeRequest(init: {
  method?: string;
  authorization?: string;
  cookie?: string;
  credentials?: RequestCredentials;
  accept?: string;
  cache?: RequestCache;
}): Request {
  const headers = new Headers();
  if (init.authorization) headers.set('authorization', init.authorization);
  if (init.cookie) headers.set('cookie', init.cookie);
  if (init.accept) headers.set('accept', init.accept);

  return {
    method: init.method ?? 'GET',
    headers,
    credentials: init.credentials ?? 'omit',
    cache: init.cache ?? 'default'
  } as Request;
}

describe('PWA source config', () => {
  test('SvelteKit CSP allows only the app shell — H4 (review 2026-07-10): fonts are self-hosted, so no external font origin is needed for style-src/font-src to open, and offline typography survives without them', async () => {
    const config = await loadSvelteConfig();
    expect(config.kit?.csp?.mode).toBe('hash');
    expect(config.kit?.csp?.directives?.['default-src']).toEqual(['self']);
    expect(config.kit?.csp?.directives?.['script-src']).toEqual(['self']);
    expect(config.kit?.csp?.directives?.['style-src']).toEqual(['self', 'unsafe-inline']);
    expect(config.kit?.csp?.directives?.['font-src']).toEqual(['self']);
    expect(config.kit?.csp?.directives?.['connect-src']).toEqual(['self', 'http:', 'https:']);
    expect(config.kit?.csp?.directives?.['object-src']).toEqual(['none']);
    expect(config.kit?.csp?.directives?.['base-uri']).toEqual(['none']);
  });

  test('H4 (review 2026-07-10 §H4): fonts are self-hosted under static/fonts so offline typography survives — no fonts.googleapis.com/fonts.gstatic.com reference anywhere in the app shell or stylesheet source', () => {
    const appHtml = readFileSync(APP_HTML_PATH, 'utf8');
    expect(appHtml).not.toContain('fonts.googleapis.com');
    expect(appHtml).not.toContain('fonts.gstatic.com');
    const appCss = readFileSync(join(PKG_ROOT, 'src', 'app.css'), 'utf8');
    expect(appCss).not.toContain('fonts.googleapis.com');
    expect(appCss).not.toContain('fonts.gstatic.com');
    expect(appCss).toContain('@font-face');
    expect(existsSync(join(STATIC_DIR, 'fonts', 'poor-story-400.woff2'))).toBe(true);
    expect(existsSync(join(STATIC_DIR, 'fonts', 'iosevka-charon-mono-400.woff2'))).toBe(true);
  });

  test('app shell explicitly wires the generated PWA registration script', () => {
    const appHtml = readFileSync(APP_HTML_PATH, 'utf8');
    expect(appHtml).toContain('/registerSW.js');
  });

  test('@vite-pwa/sveltekit is configured with the required manifest and cache rules', async () => {
    const config = await loadViteConfig();
    const pluginModule = await loadPwaModule();
    const options = pluginModule.pwaOptions;
    expect((config as { plugins?: unknown[] }).plugins?.length).toBeGreaterThan(1);
    expect(options).toBeTruthy();

    expect(options?.manifest?.name).toBe('OpenPalm');
    expect(options?.manifest?.short_name).toBe('OpenPalm');
    expect(options?.manifest?.display).toBe('standalone');
    expect(options?.manifest?.theme_color).toBeTruthy();
    expect(options?.manifest?.background_color).toBeTruthy();

    expect(options?.manifest?.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' }),
        expect.objectContaining({ src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' }),
        expect.objectContaining({
          src: 'maskable-512x512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable'
        })
      ])
    );

    expect(existsSync(join(STATIC_DIR, 'pwa-192x192.png'))).toBe(true);
    expect(existsSync(join(STATIC_DIR, 'pwa-512x512.png'))).toBe(true);
    expect(existsSync(join(STATIC_DIR, 'maskable-512x512.png'))).toBe(true);

    expect(options?.strategies).toBe('generateSW');
    expect(options?.workbox?.globPatterns).toEqual(
      expect.arrayContaining(['**/*.{js,css,html,ico,png,svg,webmanifest}'])
    );
    expect(options?.workbox?.globIgnores).toEqual(
      expect.arrayContaining(['**/runtime-config.json'])
    );
    expect(options?.workbox?.additionalManifestEntries).toContainEqual({
      url: '/index.html',
      revision: null
    });
    expect(options?.workbox?.navigateFallback).toBe('/index.html');

    const runtimeConfigRule = options?.workbox?.runtimeCaching?.find((rule) => rule.options?.cacheName === 'runtime-config');
    expect(runtimeConfigRule?.handler).toBe('NetworkFirst');
    expect(runtimeConfigRule?.urlPattern?.({
      request: makeRequest({}),
      url: new URL('https://app.openpalm.dev/runtime-config.json')
    })).toBe(true);
    expect(runtimeConfigRule?.urlPattern?.({
      request: makeRequest({ credentials: 'include' }),
      url: new URL('https://app.openpalm.dev/runtime-config.json')
    })).toBe(false);
    expect(runtimeConfigRule?.urlPattern?.({
      request: makeRequest({ method: 'POST', credentials: 'omit' }),
      url: new URL('https://app.openpalm.dev/runtime-config.json')
    })).toBe(false);
    expect(runtimeConfigRule?.urlPattern?.({
      request: makeRequest({}),
      url: new URL('https://app.openpalm.dev/other.json')
    })).toBe(false);

    const apiRule = options?.workbox?.runtimeCaching?.find((rule) => rule.options?.cacheName === 'openpalm-public-get');
    expect(apiRule?.handler).toBe('NetworkFirst');
    expect(apiRule?.options?.cacheableResponse?.statuses).toEqual([200]);

    const sameOrigin = new URL('https://app.openpalm.dev/oc/v1/sessions');
    const crossOrigin = new URL('https://guardian.example.test/oc/v1/sessions');
    const credentialed = makeRequest({
      authorization: 'Basic abc',
      cookie: 'a=b',
      credentials: 'include'
    });
    const sameOriginCredentialed = makeRequest({ credentials: 'same-origin' });
    const anonymous = makeRequest({ credentials: 'omit' });
    const nonGet = makeRequest({ method: 'POST' });
    expect(apiRule?.urlPattern?.({ request: credentialed, url: crossOrigin })).toBe(false);
    expect(withLocationOrigin('https://app.openpalm.dev', () => (
      apiRule?.urlPattern?.({ request: sameOriginCredentialed, url: sameOrigin })
    ))).toBe(false);
    expect(apiRule?.urlPattern?.({ request: anonymous, url: sameOrigin })).toBe(true);
    expect(apiRule?.urlPattern?.({ request: nonGet, url: sameOrigin })).toBe(false);

    // H1 (review 2026-07-10 §H1): the rule used to have no
    // networkTimeoutSeconds/expiration at all — a healthy period followed by
    // an outage was invisible (cached health probes/session lists kept
    // rendering as if the assistant were up) and the same broad urlPattern
    // would happily try to cache a future unauthenticated SSE response body.
    expect(apiRule?.options?.networkTimeoutSeconds).toBeGreaterThan(0);
    expect(apiRule?.options?.expiration?.maxEntries).toBeGreaterThan(0);
    expect(apiRule?.options?.expiration?.maxAgeSeconds).toBeGreaterThan(0);
    const eventStreamRequest = makeRequest({ accept: 'text/event-stream' });
    expect(apiRule?.urlPattern?.({ request: eventStreamRequest, url: sameOrigin })).toBe(false);
    // A plain anonymous GET (no Accept: text/event-stream) is still eligible.
    expect(apiRule?.urlPattern?.({ request: anonymous, url: sameOrigin })).toBe(true);

    // §H1 completeness (Codex review of PR #562): probeHealth() sets
    // `cache: 'no-store'`, but that only bypasses the browser HTTP cache — a
    // NetworkFirst service-worker route still serves the request from Cache
    // Storage on a network failure/timeout, so a single cached 200 would keep
    // the health badge "accessible" through an outage. The urlPattern must
    // exclude no-store requests so the probe always hits the real network.
    const noStoreProbe = makeRequest({ credentials: 'omit', cache: 'no-store' });
    expect(apiRule?.urlPattern?.({ request: noStoreProbe, url: sameOrigin })).toBe(false);
  });
});

describe('PWA build output', () => {
  test('build emits manifest, service worker, and icon assets', () => {
    const files = builtFiles();
    expect(files.some((file) => file.endsWith('manifest.webmanifest'))).toBe(true);
    expect(files.some((file) => file.endsWith('sw.js'))).toBe(true);
    expect(files.some((file) => file.endsWith('workbox-') || file.includes('/workbox-'))).toBe(true);
    expect(files.some((file) => file.endsWith('pwa-192x192.png'))).toBe(true);
    expect(files.some((file) => file.endsWith('pwa-512x512.png'))).toBe(true);
    expect(files.some((file) => file.endsWith('maskable-512x512.png'))).toBe(true);
    expect(readFileSync(join(BUILD_DIR, 'index.html'), 'utf8')).toContain('/registerSW.js');
  });

  test('built manifest advertises standalone installability with maskable icon support', () => {
    const manifestPath = join(BUILD_DIR, 'manifest.webmanifest');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      name?: string;
      short_name?: string;
      display?: string;
      icons?: Array<{ src?: string; sizes?: string; purpose?: string }>;
    };
    expect(manifest.name).toBe('OpenPalm');
    expect(manifest.short_name).toBe('OpenPalm');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: 'pwa-192x192.png', sizes: '192x192' }),
        expect.objectContaining({ src: 'pwa-512x512.png', sizes: '512x512' }),
        expect.objectContaining({ src: 'maskable-512x512.png', sizes: '512x512', purpose: 'maskable' })
      ])
    );
  });

  test('service worker preserves runtime-config freshness and avoids caching credentialed guardian/OpenCode traffic', () => {
    const serviceWorker = readFileSync(join(BUILD_DIR, 'sw.js'), 'utf8');
    expect(serviceWorker).toContain('url:"/index.html",revision:null');
    expect(serviceWorker).toContain('runtime-config');
    expect(serviceWorker).toContain('NetworkFirst');
    expect(serviceWorker).toContain('runtime-config.json');
    expect(serviceWorker).toContain('openpalm-public-get');
    expect(serviceWorker).not.toContain('isCredentialedRequest');
    expect(serviceWorker).not.toContain('isSameOrigin');
    expect(serviceWorker).not.toContain('isCacheablePublicGet');
    expect(serviceWorker).not.toContain('isRuntimeConfigRequest');
    expect(serviceWorker).toContain('"GET"!==');
    expect(serviceWorker).toContain('headers.get("authorization")');
    expect(serviceWorker).toContain('headers.has("cookie")');
    expect(serviceWorker).toContain('"omit"===');
    expect(serviceWorker).toContain('"same-origin"!==');
    expect(serviceWorker).toContain('origin!==location.origin');
  });
});
