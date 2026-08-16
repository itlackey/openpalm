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
 * When a reverse proxy publishes the workspace on a HOSTNAME of its own — the
 * idiomatic Caddy deployment, everything on 443 — that cookie is not sent, and
 * the opening navigation carries a one-minute ticket instead, which this trades
 * for a cookie of this host's own (see workspace-ticket.ts). Same credential,
 * same verification; the only thing that changes is how it first arrives.
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
 * starting from there needs no change to any of the four spawn paths. A bind
 * failure is logged and swallowed rather than taking the UI down with it — the
 * workspace is an enhancement, the UI is the product.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect } from 'node:net';
import { pipeline as pipelineCallback, Readable, type Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createLogger, DEFAULT_WORKSPACE_PORT, resolveEnvPort } from '@openpalm/lib';
import { assistantAuthHeaders } from './basic-auth.js';
import {
  STRIPPED_REQUEST_HEADERS,
  STRIPPED_RESPONSE_HEADERS,
} from './opencode-proxy-headers.js';
import {
  getAssistantOpencodeTarget,
  type AssistantOpencodeTarget,
} from './opencode-target.js';
import {
  buildSessionCookieHeader,
  isSecureForwarded,
  sessionTokenFromCookieHeader,
} from './session-cookie.js';
import { createSession, validateSession } from './session-store.js';
import { redeemWorkspaceTicket, WORKSPACE_TICKET_PARAM } from './workspace-ticket.js';

const logger = createLogger('workspace');

/**
 * May this request pass, and with whose credential?
 *
 * A client bringing its own `Authorization` is an external OpenCode client (a
 * TUI, a script) that already holds the server password — it is proxied as-is.
 * Otherwise the OpenPalm session IS the credential, and the caller attaches
 * OpenCode's own server-side. Either way the browser never holds it.
 *
 * Shared by both entry points so the request lane and the upgrade lane cannot
 * drift into two different answers about who may reach OpenCode.
 */
function authorize(req: IncomingMessage): { ok: boolean; clientAuthorization?: string } {
  const clientAuthorization = req.headers.authorization;
  if (clientAuthorization) return { ok: true, clientAuthorization };
  if (crossOriginWrite(req)) return { ok: false };
  return { ok: validateSession(sessionTokenFromCookieHeader(req.headers.cookie)) };
}

/**
 * A state-changing request from another origin — refused, the way SEC-2 refuses
 * it on the main origin (`checkOriginHeader` in helpers.ts).
 *
 * The session cookie is `SameSite=Lax`, and session-cookie.ts records why that
 * is safe: "State-mutating requests are independently CSRF-guarded by the
 * Origin check (SEC-2) in hooks.server.ts". This listener inherits the cookie
 * without inheriting SvelteKit's `handle`, so it has to bring its own half of
 * that pair. Lax alone is not enough here: "same site" ignores the port, so
 * ANY other origin on this host — the UI itself, or an unrelated app on some
 * other port — is same-site with this one and would have its cookie sent.
 *
 * Absent Origin is allowed, matching the main check: non-browser clients (the
 * TUI, curl, a script) send none, and a browser omits it on the top-level
 * navigations that load the workspace in the first place.
 */
function crossOriginWrite(req: IncomingMessage): boolean {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return false;
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    // The Host header is this listener's own authority as the client reached
    // it, which is exactly what an in-page request's Origin must equal.
    return new URL(origin).host !== req.headers.host;
  } catch {
    return true; // Unparseable Origin is treated as hostile.
  }
}

/**
 * The credential to send upstream: the client's own, or OpenCode's.
 *
 * `assistantAuthHeaders` returns `{}` or `{ authorization }`, so this is the
 * typed spelling of "whatever it produced" — reading it positionally would
 * silently depend on that object having exactly one key.
 */
function upstreamAuthorization(
  target: AssistantOpencodeTarget,
  clientAuthorization: string | undefined,
): string | undefined {
  return clientAuthorization ?? assistantAuthHeaders(target).authorization;
}

/**
 * Trade a workspace ticket for a cookie on THIS host, and return true when the
 * request was handled.
 *
 * Only for the navigation that opens the workspace: a ticket arrives as a query
 * parameter on a GET, is spent immediately, and the browser is redirected to
 * the same path without it. Everything after that is an ordinary cookie
 * request, so the SPA's own traffic never carries a credential in a URL.
 *
 * The redirect happens whether or not the ticket was good. A spent or expired
 * one just lands on the 401 the next request produces — which is the honest
 * answer — while leaving a dead ticket in the address bar would make every
 * reload look like a fresh failure. There is no loop: the parameter is gone.
 *
 * See workspace-ticket.ts for why the cross-hostname case needs this at all.
 */
function redeemTicket(req: IncomingMessage, res: ServerResponse): boolean {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  // The listener only ever sees an origin-relative target; the base is a
  // placeholder so URLSearchParams can do the parsing.
  let requested: URL;
  try {
    requested = new URL(req.url ?? '/', 'http://workspace.invalid');
  } catch {
    return false;
  }
  const ticket = requested.searchParams.get(WORKSPACE_TICKET_PARAM);
  if (!ticket) return false;
  requested.searchParams.delete(WORKSPACE_TICKET_PARAM);

  const headers: Record<string, string> = {
    location: `${requested.pathname}${requested.search}`,
    'x-content-type-options': 'nosniff',
  };
  if (redeemWorkspaceTicket(ticket)) {
    // A full session for this host, minted the same way the login route mints
    // one — the ticket's own one-minute life is about how long it may sit in a
    // URL, not how long the operator stays signed in.
    headers['set-cookie'] = buildSessionCookieHeader(
      createSession(),
      isSecureForwarded(req.headers['x-forwarded-proto']),
    );
  }
  res.writeHead(302, headers);
  res.end();
  return true;
}

/** The 401 a browser gets here, which has no UI of its own to render one. */
function refuse(res: ServerResponse): void {
  res.writeHead(401, {
    'content-type': 'text/plain; charset=utf-8',
    // The main origin gets this from hooks.server.ts. This listener proxies
    // arbitrary upstream bytes on a port that is SAME-SITE with that origin, so
    // a response sniffed as HTML would run script with reach into its cookies.
    'x-content-type-options': 'nosniff',
  });
  res.end('Sign in to OpenPalm first, then reload this page.\n');
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (redeemTicket(req, res)) return;
  const { ok, clientAuthorization } = authorize(req);
  if (!ok) {
    refuse(res);
    return;
  }

  const target = getAssistantOpencodeTarget();
  const upstreamUrl = `${target.url.replace(/\/$/, '')}${req.url ?? '/'}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || STRIPPED_REQUEST_HEADERS.has(key)) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const authorization = upstreamAuthorization(target, clientAuthorization);
  if (authorization) headers.set('authorization', authorization);

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
    if (STRIPPED_RESPONSE_HEADERS.has(key)) continue;
    out[key] = value;
  }
  // Stamped AFTER the upstream's own headers so it cannot be weakened by them.
  // hooks.server.ts gives the main origin the same header; this port is
  // same-site with that origin, so a response sniffed as HTML here would run
  // script with reach into its cookies.
  out['x-content-type-options'] = 'nosniff';
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
 * is swapped for OpenCode's own credential. Everything else — the WebSocket
 * key above all — is passed through, since dropping any of it fails the
 * handshake.
 */
function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const { ok, clientAuthorization } = authorize(req);
  if (!ok) {
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

  // Serialized BEFORE connecting so the callback below captures one buffer
  // rather than the whole handshake scope — `req`, its header map, and `head`
  // would otherwise stay reachable for the life of a tunnel that may run for
  // hours.
  const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`, `host: ${upstreamHost.host}`];
  for (const [key, value] of Object.entries(req.headers)) {
    // Same policy as the request lane, minus the one exception that defines
    // this lane: `connection: Upgrade` and `upgrade: websocket` ARE the
    // request here, so stripping them as hop-by-hop would fail the handshake.
    if (value === undefined) continue;
    if (STRIPPED_REQUEST_HEADERS.has(key) && key !== 'connection' && key !== 'upgrade') continue;
    for (const one of Array.isArray(value) ? value : [value]) lines.push(`${key}: ${one}`);
  }
  const authorization = upstreamAuthorization(target, clientAuthorization);
  if (authorization) lines.push(`authorization: ${authorization}`);
  const handshake = Buffer.concat([
    Buffer.from(`${lines.join('\r\n')}\r\n\r\n`),
    head?.length ? head : Buffer.alloc(0),
  ]);

  const upstream = connect(
    { host: upstreamHost.hostname, port: Number(upstreamHost.port) || 80 },
    () => {
      upstream.write(handshake);
      // Crossed pipelines rather than `.pipe` plus four teardown listeners:
      // `pipeline` destroys BOTH ends of its chain on failure and absorbs the
      // error events, so an abandoned terminal cannot leave a half-open pair
      // behind or raise an unhandled `error`.
      pipelineCallback(socket, upstream, () => {});
      pipelineCallback(upstream, socket, () => {});
    },
  );
  // The connect attempt itself can fail before any pipeline exists.
  upstream.on('error', () => socket.destroy());
}

let started = false;

/**
 * Bind the workspace listener, once per process.
 *
 * `OP_WORKSPACE_PORT` is resolved by the same {@link resolveEnvPort} every
 * other port in the tree uses, and by the same call the advertisement
 * `/advanced` reads makes — so the port that gets bound and the port offered to
 * a browser cannot disagree.
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

  const port = resolveEnvPort('OP_WORKSPACE_PORT', DEFAULT_WORKSPACE_PORT, process.env);
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
