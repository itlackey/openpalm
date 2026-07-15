import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// serve.mjs must survive hostile requests: a malformed percent-escape in the
// path (e.g. /%zz) makes decodeURIComponent throw, and an uncaught throw in
// the request handler kills the whole co-process that P5c/P5d rely on.

const SERVE = fileURLToPath(new URL('../bin/serve.mjs', import.meta.url));
const PORT = 41000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;

let rootDir: string;
let dir: string;
let runtimeConfigDir: string;
let explicitRuntimeConfig: string;
let child: ReturnType<typeof Bun.spawn>;

beforeAll(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'op-client-serve-'));
  dir = join(rootDir, 'build');
  runtimeConfigDir = rootDir;
  explicitRuntimeConfig = join(rootDir, 'explicit-runtime-config.json');
  mkdirSync(join(dir, '_app', 'immutable', 'chunks'), { recursive: true });
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><meta http-equiv="content-security-policy" content="default-src \'self\'; script-src \'self\' \'sha256-test=\'; connect-src \'self\' http: https:; frame-src \'self\' http: https:; object-src \'none\'; base-uri \'none\'"><title>ok</title>',
  );
  writeFileSync(join(dir, 'sw.js'), 'self.addEventListener("install",()=>{});');
  writeFileSync(join(dir, 'registerSW.js'), 'navigator.serviceWorker?.register("/sw.js");');
  // A real build asset — present on disk, must be served normally (not the
  // H2 scenario below).
  writeFileSync(join(dir, '_app', 'immutable', 'chunks', 'present-abc123.js'), 'export default 1;');
  writeFileSync(join(runtimeConfigDir, 'runtime-config.json'), '{"connections":[]}');
  writeFileSync(explicitRuntimeConfig, '{"connections":[{"id":"explicit"}]}');
  child = Bun.spawn(['node', SERVE, '--port', String(PORT), '--dir', dir], {
    env: { ...process.env, OP_CLIENT_RUNTIME_CONFIG: explicitRuntimeConfig },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // wait for the listen log
  const started = Date.now();
  while (Date.now() - started < 5000) {
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok) return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error('serve.mjs did not start');
});

afterAll(() => {
  child?.kill();
  rmSync(rootDir, { recursive: true, force: true });
});

describe('serve.mjs resilience', () => {
  it('returns 400 for a malformed percent-escape instead of crashing', async () => {
    const res = await fetch(`${BASE}/%zz`);
    expect(res.status).toBe(400);
  });

  it('keeps serving after the malformed request (process not killed)', async () => {
    await fetch(`${BASE}/%zz`).catch(() => undefined);
    const res = await fetch(`${BASE}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('ok');
  });

  it('still SPA-falls-back for normal unknown routes', async () => {
    const res = await fetch(`${BASE}/connections/new`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('supports HEAD requests with no response body', async () => {
    const res = await fetch(`${BASE}/`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe('');
  });

  it('serves runtime-config.json with no-store caching', async () => {
    const res = await fetch(`${BASE}/runtime-config.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('explicit');
  });

  it('also serves runtime-config.json from the build dir with no-store caching', async () => {
    unlinkSync(join(runtimeConfigDir, 'runtime-config.json'));
    unlinkSync(explicitRuntimeConfig);
    writeFileSync(join(dir, 'runtime-config.json'), '{"connections":[{"id":"build"}]}');

    const res = await fetch(`${BASE}/runtime-config.json`);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('build');
  });
});

// H2 (review 2026-07-10 §H2): a non-atomic artifact swap/seed or any partial
// copy used to be invisible — any missing on-disk asset (a JS chunk the SW's
// precache manifest names, a CSS file, …) fell through the unconditional-200
// SPA fallback and got index.html back with a 200. The SW's generateSW
// precache strategy trusts the response body for whatever URL it asked for;
// caching index.html under a .js URL durably corrupts every future load of
// that chunk until a byte-different sw.js ships. The fallback must be
// restricted to navigation-style requests (extensionless path, or an
// explicit `Accept: text/html`) — everything else that 404s on disk 404s.
describe('serve.mjs SPA fallback scope (H2)', () => {
  it('404s a missing extensioned asset instead of returning index.html', async () => {
    const res = await fetch(`${BASE}/_app/immutable/chunks/missing-def456.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).not.toContain('text/html');
  });

  it('404s a missing .css asset the same way', async () => {
    const res = await fetch(`${BASE}/_app/immutable/assets/missing.css`);
    expect(res.status).toBe(404);
  });

  it('still serves an asset that genuinely exists on disk', async () => {
    const res = await fetch(`${BASE}/_app/immutable/chunks/present-abc123.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('export default 1');
  });

  it('SPA-falls-back for an extensionless deep link (client-side route)', async () => {
    const res = await fetch(`${BASE}/connections/new`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('SPA-falls-back for an extensioned path when the request declares Accept: text/html (a real navigation)', async () => {
    const res = await fetch(`${BASE}/some/deep.route`, {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});

// H2: the SW must never precache a stale index.html/sw.js/registerSW.js
// under `no-cache` semantics — a byte-identical-looking install would
// otherwise wedge on a browser/CDN cache instead of always revalidating.
describe('serve.mjs cache-control (H2)', () => {
  it('serves index.html with cache-control: no-cache', async () => {
    const res = await fetch(`${BASE}/`);
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('serves sw.js with cache-control: no-cache', async () => {
    const res = await fetch(`${BASE}/sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('serves registerSW.js with cache-control: no-cache', async () => {
    const res = await fetch(`${BASE}/registerSW.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('does not force no-cache on an ordinary hashed asset (safe to cache immutably)', async () => {
    const res = await fetch(`${BASE}/_app/immutable/chunks/present-abc123.js`);
    expect(res.headers.get('cache-control')).not.toBe('no-cache');
  });
});

describe('serve.mjs production security headers', () => {
  it('promotes the generated document CSP to a header without relaxing non-frame directives', async () => {
    const res = await fetch(`${BASE}/advanced`);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self' 'sha256-test='");
    expect(csp).toContain("connect-src 'self' http: https:");
    expect(csp).toContain("frame-src 'self' http: https:");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});

// D4 (review 2026-07-10 §D4, half): the direct `openpalm-client-serve`/
// `node bin/serve.mjs` invocation was the only place in the repo that
// defaulted to port 4180 — every other surface (Electron, CLI, docs)
// converges on the platform's 3890 (packages/lib DEFAULT_CLIENT_PORT). This
// package deliberately never depends on @openpalm/lib (see package.json),
// so the fallback is pinned here as a literal instead of a shared import.
describe('serve.mjs default port (D4)', () => {
  it('falls back to the platform default port 3890, not 4180', () => {
    const source = readFileSync(SERVE, 'utf8');
    expect(source).not.toMatch(/\?\?\s*4180/);
    expect(source).toMatch(/\?\?\s*3890/);
  });
});
