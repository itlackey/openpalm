/**
 * Basic PWA support (#511) — source-pin + JSON-shape tests. Idiom:
 * hooks.server.landing.vitest.ts (handle() integration for the auth/landing
 * gates).
 *
 * Covers:
 *  - app.html links the manifest.
 *  - static/manifest.webmanifest parses as JSON with the required fields.
 *  - src/service-worker.ts sources the required $service-worker exports and
 *    guards /api (and other sensitive) traffic with a network-only
 *    passthrough — no respondWith for anything outside the precache list.
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP_HTML_PATH = fileURLToPath(new URL('./app.html', import.meta.url));
const MANIFEST_PATH = fileURLToPath(new URL('../static/manifest.webmanifest', import.meta.url));
const SERVICE_WORKER_PATH = fileURLToPath(new URL('./service-worker.ts', import.meta.url));
const SVELTE_CONFIG_PATH = fileURLToPath(new URL('../svelte.config.js', import.meta.url));

function appHtmlSource(): string {
  return readFileSync(APP_HTML_PATH, 'utf-8');
}

function serviceWorkerSource(): string {
  return readFileSync(SERVICE_WORKER_PATH, 'utf-8');
}

type Manifest = {
  name?: string;
  short_name?: string;
  start_url?: string;
  display?: string;
  background_color?: string;
  theme_color?: string;
  icons?: Array<{ src?: string; sizes?: string; type?: string; purpose?: string }>;
};

function loadManifest(): Manifest {
  return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as Manifest;
}

describe('app.html — manifest link', () => {
  test('links static/manifest.webmanifest', () => {
    const src = appHtmlSource();
    expect(src).toMatch(/<link\s+rel="manifest"\s+href="\/manifest\.webmanifest"\s*\/?>/);
  });

  test('carries a theme-color meta tag', () => {
    const src = appHtmlSource();
    expect(src).toMatch(/<meta\s+name="theme-color"/);
  });
});

describe('static/manifest.webmanifest', () => {
  test('parses as JSON with the required installability fields', () => {
    const manifest = loadManifest();
    expect(manifest.name).toBe('OpenPalm');
    expect(manifest.short_name).toBe('OpenPalm');
    expect(manifest.display).toBe('standalone');
    expect(typeof manifest.start_url).toBe('string');
    expect(manifest.start_url?.length).toBeGreaterThan(0);
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons?.length).toBeGreaterThan(0);
  });

  test('carries background/theme colors consistent with the Stillness paper token (--s-paper light)', () => {
    const manifest = loadManifest();
    expect(manifest.background_color).toBe('#E5E1D5');
    expect(manifest.theme_color).toBe('#E5E1D5');
  });

  test('advertises 192/512 icons plus a maskable 512 icon, each backed by a static file', () => {
    const manifest = loadManifest();
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' }),
        expect.objectContaining({ src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' }),
        expect.objectContaining({
          src: '/maskable-512x512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'maskable',
        }),
      ]),
    );
    for (const icon of manifest.icons ?? []) {
      const staticPath = fileURLToPath(new URL(`../static${icon.src}`, import.meta.url));
      expect(() => readFileSync(staticPath)).not.toThrow();
    }
  });
});

describe('src/service-worker.ts — precache + network-only guard', () => {
  test('registers the generated worker from the origin root on nested routes', () => {
    const config = readFileSync(SVELTE_CONFIG_PATH, 'utf-8');
    expect(config).toMatch(/paths:\s*\{\s*relative:\s*false\s*\}/);
  });

  test('sources build/files/version from the native $service-worker module (zero extra deps)', () => {
    const src = serviceWorkerSource();
    expect(src).toMatch(/from\s+['"]\$service-worker['"]/);
    expect(src).toMatch(/\bbuild\b/);
    expect(src).toMatch(/\bfiles\b/);
    expect(src).toMatch(/\bversion\b/);
  });

  test('only calls respondWith for a precached-asset path — everything else is a bare passthrough', () => {
    const src = serviceWorkerSource();
    // The fetch handler must return (no respondWith) before doing anything
    // else when the request path isn't in the precache list.
    expect(src).toMatch(/if\s*\(\s*!PRECACHE_ASSETS\.includes\([^)]*\)\s*\)\s*return;/);
    // The respondWith call must appear strictly after that early return in
    // the file. ('event.respondWith' — the bare word also occurs in the
    // header comment describing the passthrough behavior.)
    const guardIndex = src.indexOf('PRECACHE_ASSETS.includes');
    const respondWithIndex = src.indexOf('event.respondWith');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(respondWithIndex).toBeGreaterThan(guardIndex);
  });

  test('never special-cases /api, /login, /voice, or /health — they fall through the same generic guard', () => {
    const src = serviceWorkerSource();
    // No bespoke caching/handling branch for these prefixes: the safety
    // property comes entirely from the generic PRECACHE_ASSETS.includes()
    // guard above, not from a maintained exclusion list that could drift.
    expect(src).not.toMatch(/pathname\.startsWith\(\s*['"]\/api/);
    expect(src).not.toMatch(/pathname\.startsWith\(\s*['"]\/login/);
    expect(src).not.toMatch(/pathname\.startsWith\(\s*['"]\/voice/);
    expect(src).not.toMatch(/pathname\.startsWith\(\s*['"]\/health/);
  });

  test('cross-origin requests are never touched by this worker', () => {
    const src = serviceWorkerSource();
    expect(src).toMatch(/url\.origin\s*!==\s*sw\.location\.origin/);
  });

  test('deletes stale caches on activate', () => {
    const src = serviceWorkerSource();
    expect(src).toMatch(/addEventListener\(\s*['"]activate['"]/);
    expect(src).toMatch(/caches\.delete\(/);
  });
});
