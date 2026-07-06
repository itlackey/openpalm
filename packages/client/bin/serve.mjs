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
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

const port = Number(arg('port') ?? process.env.PORT ?? 4180);
const host = arg('host') ?? process.env.HOST ?? '127.0.0.1';
const dir = resolve(
  arg('dir') ?? process.env.OP_CLIENT_DIR ?? join(fileURLToPath(new URL('..', import.meta.url)), 'build')
);

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

function send(res, path, status = 200) {
  res.writeHead(status, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
  createReadStream(path).pipe(res);
}

const server = createServer((req, res) => {
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
  if (existsSync(candidate) && statSync(candidate).isFile()) return send(res, candidate);
  // runtime-config.json may live beside the build dir instead of inside it
  // (the assistant container writes it next to the extracted bundle, P5d).
  if (pathname === '/runtime-config.json') {
    const sibling = join(dir, '..', 'runtime-config.json');
    if (existsSync(sibling) && statSync(sibling).isFile()) return send(res, sibling);
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('no runtime-config.json');
  }
  // SPA fallback: every route is client-rendered from index.html.
  const fallback = join(dir, 'index.html');
  if (existsSync(fallback)) return send(res, fallback);
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('client build not found — run `bun run client:build`');
});

server.listen(port, host, () => {
  console.log(`[openpalm-client] serving ${dir} on http://${host}:${port}`);
});
