#!/usr/bin/env node
/**
 * Zero-dependency static file server for the @openpalm/client build (P5b
 * item 4, #555; plan §6.9 Slice A / §6.10). Serves the adapter-static
 * bundle with an SPA fallback to index.html, plus a runtime-config.json if
 * one exists beside the build (the assistant container writes it in P5d).
 *
 * No API routes, no @openpalm/lib, no auth — this process serves bytes.
 * Binds loopback by default; pass --host only where the surrounding policy
 * already gates exposure (e.g. inside the assistant container, #510).
 *
 * Usage: serve.mjs [--port N] [--host ADDR] [--dir PATH]
 * Env:   PORT, HOST, OP_CLIENT_DIR
 */
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

// D4 (review 2026-07-10 §D4): 3890 mirrors the platform's default client
// port (packages/lib DEFAULT_CLIENT_PORT) everywhere else — Electron, the
// CLI, and docs all converge on it. This package deliberately never depends
// on @openpalm/lib (see the file header above), so the literal is pinned
// here instead of imported; a direct `openpalm-client-serve`/`node
// bin/serve.mjs` invocation with no --port/PORT used to be the one surface
// still landing on the unrelated 4180.
const port = Number(arg('port') ?? process.env.PORT ?? 3890);
const host = arg('host') ?? process.env.HOST ?? '127.0.0.1';
const dir = resolve(
  arg('dir') ?? process.env.OP_CLIENT_DIR ?? join(fileURLToPath(new URL('..', import.meta.url)), 'build')
);
const runtimeConfigPath = process.env.OP_CLIENT_RUNTIME_CONFIG
  ? resolve(process.env.OP_CLIENT_RUNTIME_CONFIG)
  : '';

function readDocumentCsp() {
  const indexPath = join(dir, 'index.html');
  if (!existsSync(indexPath)) return '';
  const html = readFileSync(indexPath, 'utf8');
  const match = html.match(/<meta\s+http-equiv=["']content-security-policy["']\s+content=(["'])([\s\S]*?)\1/i);
  if (!match) return '';
  const policy = match[2]
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&#x27;', "'")
    .replaceAll('&amp;', '&');
  return policy.includes('frame-ancestors') ? policy : `${policy}; frame-ancestors 'none'`;
}

const documentCsp = readDocumentCsp();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, path, status = 200, extraHeaders = {}, includeBody = true) {
  res.writeHead(status, {
    'content-type': MIME[extname(path)] ?? 'application/octet-stream',
    ...extraHeaders,
  });
  if (!includeBody) return res.end();
  createReadStream(path).pipe(res);
}

function runtimeConfigHeaders() {
  return { 'cache-control': 'no-store' };
}

// H2 (review 2026-07-10 §H2): index.html/sw.js/registerSW.js are the three
// files a browser/SW re-fetches to decide "is there a new build" — letting
// an intermediary cache them (even briefly) can wedge an install on a stale
// answer to that question. Everything else under the build dir is a
// content-hashed, genuinely immutable asset and keeps no explicit
// cache-control (the default: cacheable).
const NEVER_CACHE_NAMES = new Set(['/index.html', '/sw.js', '/registerSW.js']);

function staticHeaders(pathname) {
  return NEVER_CACHE_NAMES.has(pathname) || pathname === '/' ? { 'cache-control': 'no-cache' } : {};
}

function documentHeaders(pathname) {
  return {
    ...staticHeaders(pathname),
    ...(documentCsp ? { 'content-security-policy': documentCsp } : {}),
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  };
}

// H2: the SPA fallback used to answer ANY unresolved path with a 200
// index.html — including a JS/CSS chunk URL the SW's precache manifest
// names but that never made it to disk (a non-atomic artifact swap/seed, a
// partial copy). Workbox's generateSW strategy trusts whatever body comes
// back for that URL: an HTML document gets precached under a `.js` cache
// key and durably corrupts every future load of that chunk until a
// byte-different sw.js ships. Only a genuine navigation — a client-side
// route with no file extension, or a request that explicitly declares it
// wants HTML — gets the SPA shell; anything else that doesn't exist on disk
// is a real 404.
function looksLikeNavigation(req, pathname) {
  const accept = req.headers.accept;
  if (typeof accept === 'string' && accept.includes('text/html')) return true;
  // The last path segment has no '.' -> no file extension -> a client-side
  // route (e.g. /connections/new), not a missing static asset.
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  return !lastSegment.includes('.');
}

const server = createServer((req, res) => {
  const method = req.method ?? 'GET';
  const supportsBody = method !== 'HEAD';

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  } catch {
    // Malformed percent-escapes (e.g. /%zz) throw; a bad request must never
    // take down the co-process the harness and assistant container rely on.
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('bad request');
  }
  // normalize() collapses any ../ segments; the join stays inside dir.
  const candidate = join(dir, normalize(join('/', pathname)));
  if (existsSync(candidate) && statSync(candidate).isFile()) {
    if (pathname === '/runtime-config.json') {
      return send(res, candidate, 200, runtimeConfigHeaders(), supportsBody);
    }
    return send(
      res,
      candidate,
      200,
      extname(candidate) === '.html' ? documentHeaders(pathname) : staticHeaders(pathname),
      supportsBody,
    );
  }
  // runtime-config.json may live beside the build dir instead of inside it
  // (the assistant container writes it next to the extracted bundle, P5d).
  if (pathname === '/runtime-config.json') {
    const candidates = [runtimeConfigPath, join(dir, '..', 'runtime-config.json')].filter(Boolean);
    for (const path of candidates) {
      if (existsSync(path) && statSync(path).isFile()) {
        return send(res, path, 200, runtimeConfigHeaders(), supportsBody);
      }
    }
    res.writeHead(404, {
      'content-type': 'text/plain; charset=utf-8',
      ...runtimeConfigHeaders(),
    });
    return res.end('no runtime-config.json');
  }
  // SPA fallback: a client-side route is client-rendered from index.html;
  // a missing static asset is a genuine 404 (H2 — see looksLikeNavigation).
  if (looksLikeNavigation(req, pathname)) {
    const fallback = join(dir, 'index.html');
    if (existsSync(fallback)) {
      return send(res, fallback, 200, documentHeaders('/index.html'), supportsBody);
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('client build not found — run `bun run client:build`');
});

server.listen(port, host, () => {
  console.log(`[openpalm-client] serving ${dir} on http://${host}:${port}`);
});
