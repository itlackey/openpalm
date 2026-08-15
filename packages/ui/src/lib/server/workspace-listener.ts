/**
 * The OpenCode workspace listener — OpenCode's own web UI, at an origin root,
 * behind this app's login.
 *
 * ## Why a second listener and not a path on the main one
 *
 * OpenCode's web UI is a single-page app compiled to live at the ROOT of an
 * origin: its HTML asks for `/assets/…` and its client asks for `/api/…`,
 * both resolved against `location.origin`, with no base-path option in the
 * server or the build we ship. Serving it under a path on this app's origin
 * therefore cannot work — every one of those requests would land on OpenPalm,
 * and `/api/*` is a namespace OpenPalm already owns. The only ways to make a
 * path work are to patch OpenCode's source or to rewrite its behaviour in the
 * browser at runtime; both were tried and both are rejected on this project.
 *
 * So OpenCode gets what it actually needs: an origin whose root IS OpenCode.
 * A second port on this same process is the cheapest origin there is — no DNS,
 * no certificate, no second service to deploy. Everything under it proxies 1:1
 * to the assistant's OpenCode, unmodified in both directions.
 *
 * ## Why this is not a second credential
 *
 * Browser cookies are scoped by HOST, not by port, so the `op_session` cookie
 * the operator already holds for the UI is sent to this listener too. This
 * checks that cookie with the SAME `validateSession` every other route uses,
 * then attaches OpenCode's own Basic credential upstream, server-side. The
 * operator types one password — the OpenPalm login — and OpenCode is never
 * reachable through here without it.
 *
 * A request carrying its own `Authorization` header is passed through
 * untouched, so an external OpenCode client (a TUI, a script) that already
 * holds the server password keeps working exactly as it does against OpenCode
 * directly.
 *
 * ## Why it starts here
 *
 * `hooks.server.ts` is loaded once by every launch mode — the assistant
 * container's co-process, `openpalm app`, `openpalm admin`, and Electron — so
 * starting from there needs no change to any of the four spawn paths. Absent
 * or unset port means no listener at all: this is opt-in per deployment, and a
 * bind failure is logged and swallowed rather than taking the UI down with it.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect } from 'node:net';
import { Readable, type Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createLogger } from '@openpalm/lib';
import { assistantAuthHeaders } from './basic-auth.js';
import { resolveWorkspacePort } from './features.js';
import { getAssistantOpencodeTarget } from './opencode-target.js';
import { SESSION_COOKIE_NAME } from './session-cookie.js';
import { validateSession } from './session-store.js';

const logger = createLogger('workspace');

/** Hop-by-hop headers that must not be forwarded in either direction. */
const STRIPPED = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-authenticate',
  'te',
  'trailer',
  // Recomputed by fetch/undici from the actual body.
  'content-length',
  // node's fetch transparently decompresses while still reporting the ORIGINAL
  // encoding, so forwarding this truncates the stream the browser receives.
  'content-encoding',
]);

/** The session cookie value from a raw Cookie header, or ''. */
function sessionToken(cookieHeader: string | undefined): string {
  if (!cookieHeader) return '';
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE_NAME) continue;
    return part.slice(eq + 1).trim();
  }
  return '';
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // An external OpenCode client supplying its own credential is proxied as-is;
  // otherwise the OpenPalm session is the credential and this attaches
  // OpenCode's own, server-side. Either way the browser never holds it.
  const clientAuthorization = req.headers.authorization;
  if (!clientAuthorization && !validateSession(sessionToken(req.headers.cookie))) {
    // A browser landing here without a session gets a pointer to the login it
    // needs, not a bare 401 it cannot act on — this listener has no UI of its
    // own to render one.
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Sign in to OpenPalm first, then reload this page.\n');
    return;
  }

  const target = getAssistantOpencodeTarget();
  const upstreamUrl = `${target.url.replace(/\/$/, '')}${req.url ?? '/'}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || STRIPPED.has(key.toLowerCase())) continue;
    // The OpenPalm session cookie is this app's credential, not OpenCode's.
    if (key.toLowerCase() === 'cookie') continue;
    if (key.toLowerCase() === 'host') continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  if (clientAuthorization) headers.set('authorization', clientAuthorization);
  else for (const [k, v] of Object.entries(assistantAuthHeaders(target))) headers.set(k, v);

  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';

  const abort = new AbortController();
  // A client that hangs up — closed tab, abandoned SSE stream, reload — must
  // take the upstream request with it, or every abandoned stream leaks an open
  // fetch against OpenCode. `close` on the RESPONSE covers both endings: it
  // fires on a dropped connection and on an ordinary completed response, where
  // aborting an already-settled request is a no-op.
  res.on('close', () => abort.abort());
  // Both node streams here need an `error` listener even though there is
  // nothing to do with the error: a client reset raises ECONNRESET on the
  // request, and an unhandled `error` event on a stream is a process-level
  // throw, not a failed request.
  req.on('error', () => {});
  res.on('error', () => {});

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers,
      // Streamed straight through, so a large upload is never buffered here.
      body: hasBody ? (Readable.toWeb(req) as unknown as ReadableStream) : undefined,
      // Required by undici whenever a stream is the body.
      ...(hasBody ? { duplex: 'half' } : {}),
      signal: abort.signal,
      redirect: 'manual',
    } as RequestInit);
  } catch {
    if (abort.signal.aborted) {
      // The client left before the assistant answered. Nothing to send it.
      res.destroy();
      return;
    }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('The assistant is not responding — it may still be starting.\n');
    return;
  }

  const out: Record<string, string> = {};
  for (const [key, value] of upstream.headers) {
    if (STRIPPED.has(key.toLowerCase())) continue;
    out[key] = value;
  }
  res.writeHead(upstream.status, out);
  if (!upstream.body) {
    res.end();
    return;
  }
  // Piped rather than buffered: `/event` is an SSE stream that never ends.
  // `pipeline` (not `.pipe`) because `.pipe` forwards no errors and destroys
  // nothing: an abandoned SSE stream ends by erroring the source, which `.pipe`
  // would raise as an unhandled `error` event — i.e. it would take the whole UI
  // process down every time someone closed the workspace tab.
  try {
    await pipeline(Readable.fromWeb(upstream.body as never), res);
  } catch {
    // Either end can hang up first, and on a stream held open for the length of
    // a chat turn that is the ORDINARY ending, not a failure. Nothing to log
    // and nothing left to send.
    res.destroy();
  }
}

/**
 * Tunnel a protocol upgrade — OpenCode's terminal is a WebSocket on `/api/pty`.
 *
 * Once a connection upgrades it stops being HTTP, so `fetch` cannot carry it
 * and neither can any framework handler: the only correct proxy is a raw TCP
 * splice. Owning a plain `http.Server` is precisely what makes that possible
 * here, and it is why the workspace is "OpenCode 1:1" rather than "OpenCode
 * except the terminal" — a server that quietly drops upgrades looks identical
 * until someone opens a shell.
 *
 * The handshake is re-serialized rather than forwarded verbatim because two
 * headers must change: `host` becomes the upstream's, and the OpenPalm cookie
 * is swapped for OpenCode's own credential. Everything else — including the
 * `connection`/`upgrade` pair and the WebSocket key — is passed through, since
 * dropping any of it fails the handshake.
 */
function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const clientAuthorization = req.headers.authorization;
  if (!clientAuthorization && !validateSession(sessionToken(req.headers.cookie))) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
    return;
  }

  const target = getAssistantOpencodeTarget();
  let upstreamHost: URL;
  try {
    upstreamHost = new URL(target.url);
  } catch {
    socket.destroy();
    return;
  }
  if (upstreamHost.protocol !== 'http:') {
    // The assistant's OpenCode is plain HTTP inside the stack. Refusing loudly
    // beats splicing a TLS connection as if it were cleartext.
    socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n');
    return;
  }

  const upstream = connect(
    { host: upstreamHost.hostname, port: Number(upstreamHost.port) || 80 },
    () => {
      const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`, `host: ${upstreamHost.host}`];
      for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        const lower = key.toLowerCase();
        if (lower === 'host' || lower === 'cookie' || lower === 'authorization') continue;
        for (const one of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${one}`);
      }
      const authorization = clientAuthorization
        ?? Object.values(assistantAuthHeaders(target))[0];
      if (authorization) lines.push(`authorization: ${authorization}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head?.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    },
  );

  // Either end closing must tear down the other, or an abandoned terminal
  // leaves a half-open socket pair behind for the life of the process.
  const teardown = (): void => {
    socket.destroy();
    upstream.destroy();
  };
  socket.on('error', teardown);
  socket.on('close', teardown);
  upstream.on('error', teardown);
  upstream.on('close', teardown);
}

let started = false;

/**
 * Bind the workspace listener, once per process.
 *
 * The port comes from {@link resolveWorkspacePort}, shared with the
 * advertisement `/advanced` reads, so the port that gets bound and the port
 * that gets offered to a browser cannot disagree. An operator who sets
 * `OP_WORKSPACE_PORT` to something unusable gets no listener at all, and
 * `/advanced` falls back to the native chat surface.
 *
 * The interface is `HOST`: adapter-node's own bind variable, so this listener
 * lands on exactly the interface the UI itself is on, in every launch mode,
 * with no second knob to keep in sync. That distinction matters most in the
 * container, where the UI child is always started `HOST=0.0.0.0` because
 * Docker's published mapping cannot reach a container-loopback socket —
 * whether that mapping is exposed to the LAN is `OP_UI_BIND_ADDRESS`, a
 * separate fact, and the one computeOpencodeWorkspace() advertises.
 *
 * Returns the server so a caller that needs the bound address can read it
 * (the tests do); production callers ignore it.
 */
export function startWorkspaceListener(): Server | undefined {
  if (started) return undefined;
  started = true;

  const resolved = resolveWorkspacePort(process.env.OP_WORKSPACE_PORT?.trim());
  if (!resolved) return undefined;
  const { port } = resolved;
  const host = process.env.HOST?.trim() || '0.0.0.0';

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      // A dead socket is not an incident — it is what a closed tab looks like
      // from here, and there is no one left to tell.
      if (res.destroyed || res.writableEnded) return;
      logger.error('workspace proxy request failed', { error: String(error) });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  server.on('upgrade', (req, socket, head) => {
    try {
      handleUpgrade(req, socket, head);
    } catch (error) {
      logger.error('workspace upgrade failed', { error: String(error) });
      socket.destroy();
    }
  });
  // SSE streams live for the length of a chat turn; the default 5s idle timeout
  // would cut them.
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.on('error', (error) => {
    // A port collision must not take the UI down with it — the workspace is an
    // enhancement, the UI is the product.
    logger.error('workspace listener failed to bind', { port, error: String(error) });
  });
  server.listen(port, host, () => {
    logger.info('workspace listener started', { port, host });
  });
  server.unref();
  return server;
}
