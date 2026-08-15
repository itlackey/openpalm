/**
 * The workspace listener, against a real socket and a real upstream.
 *
 * Every assertion here is about the two properties the design rests on: the
 * OpenPalm session is the ONLY thing a browser needs to reach OpenCode, and
 * OpenCode is never reachable through this port without one. The rest —
 * header handling, streaming, hangups — is what makes those two survive
 * contact with a browser.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as netConnect, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';

const VALID_SESSION = 'good-token';

vi.mock('./session-store.js', () => ({
  validateSession: (token: string) => token === VALID_SESSION,
}));
vi.mock('./opencode-target.js', () => ({
  getAssistantOpencodeTarget: () => ({
    id: 'default',
    label: 'Local Assistant',
    url: upstreamUrl,
    username: 'opencode',
    password: 'upstream-secret',
    isDefault: true,
  }),
}));

/** Set once the fake upstream is listening; read lazily by the mock above. */
let upstreamUrl = '';
let upstream: Server;
let listener: Server | undefined;
let workspaceOrigin = '';

/** Every request the fake upstream saw, in order. */
const seen: { url: string; method: string; headers: IncomingMessage['headers']; body: string }[] = [];
/** Every upgrade handshake the fake upstream saw, in order. */
const upgradeHandshakes: IncomingMessage['headers'][] = [];

/** A minimal upstream that completes the handshake and echoes what it is sent. */
function onUpgrade(req: IncomingMessage, socket: Duplex): void {
  upgradeHandshakes.push(req.headers);
  socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
  socket.on('data', (chunk: Buffer) => socket.write(`echo:${chunk.toString()}`));
}
/** What the fake upstream answers unless a test overrides `respond`. */
const DEFAULT_RESPOND = (req: IncomingMessage, res: ServerResponse): void => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, path: req.url }));
};
let respond: (req: IncomingMessage, res: ServerResponse) => void = DEFAULT_RESPOND;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

beforeAll(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        url: req.url ?? '',
        method: req.method ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });
      respond(req, res);
    });
  });
  upstreamUrl = `http://127.0.0.1:${await listen(upstream)}`;

  // The port is chosen the same way the upstream's was, then handed to the
  // listener through the env key it actually reads — so this exercises the
  // real startup path rather than a test-only entry point.
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));

  process.env.OP_WORKSPACE_PORT = String(port);
  process.env.HOST = '127.0.0.1';
  const { startWorkspaceListener } = await import('./workspace-listener.js');
  listener = startWorkspaceListener();
  await new Promise((resolve) => listener?.once('listening', resolve));
  workspaceOrigin = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  // closeAllConnections first, and never await close() alone: the streaming and
  // upgrade tests deliberately leave sockets open on both servers, and a plain
  // close() waits for every one of them to end on its own.
  for (const server of [listener, upstream]) {
    if (!server) continue;
    server.closeAllConnections();
    await Promise.race([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    server.unref();
  }
});

afterEach(() => {
  seen.length = 0;
  upgradeHandshakes.length = 0;
  upstream.removeAllListeners('upgrade');
  respond = DEFAULT_RESPOND;
});

const asSession = (token: string) => ({ cookie: `op_session=${token}` });

describe('the OpenPalm session is the credential', () => {
  test('a signed-in browser reaches OpenCode with nothing else attached', async () => {
    const res = await fetch(`${workspaceOrigin}/api/health`, { headers: asSession(VALID_SESSION) });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, path: '/api/health' });
  });

  test('OpenCode’s own credential is added upstream, never handed to the browser', async () => {
    const res = await fetch(`${workspaceOrigin}/`, { headers: asSession(VALID_SESSION) });

    const expected = `Basic ${Buffer.from('opencode:upstream-secret').toString('base64')}`;
    expect(seen[0]?.headers.authorization).toBe(expected);
    // Nothing in the response tells the browser what that credential was, and
    // no challenge invites it to supply one.
    expect(res.headers.get('www-authenticate')).toBeNull();
  });

  test('the OpenPalm cookie stops here — it means nothing to OpenCode', async () => {
    await fetch(`${workspaceOrigin}/`, {
      headers: { cookie: `op_session=${VALID_SESSION}; other=keep` },
    });

    expect(seen[0]?.headers.cookie).toBeUndefined();
  });

  test('and the upstream cannot write into this app’s cookie jar', async () => {
    // Cookies are scoped by HOST, not by port — the very property that lets one
    // OpenPalm login authenticate this listener. That cuts both ways: a
    // Set-Cookie forwarded from OpenCode would land in the same jar as
    // op_session on the UI's own origin.
    respond = (_req, res) => {
      res.writeHead(200, { 'set-cookie': 'opencode_session=upstream; Path=/' });
      res.end('ok');
    };
    const res = await fetch(`${workspaceOrigin}/`, { headers: asSession(VALID_SESSION) });

    expect(res.headers.getSetCookie?.() ?? []).toEqual([]);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  test('the session is read out of a cookie header carrying other cookies too', async () => {
    const res = await fetch(`${workspaceOrigin}/`, {
      headers: { cookie: `theme=dark; op_session=${VALID_SESSION}; tz=utc` },
    });

    expect(res.status).toBe(200);
  });
});

describe('OpenCode is not reachable here without one', () => {
  test('no cookie at all is refused, with a pointer to the login that fixes it', async () => {
    const res = await fetch(`${workspaceOrigin}/`);

    expect(res.status).toBe(401);
    await expect(res.text()).resolves.toContain('Sign in to OpenPalm');
    expect(seen).toHaveLength(0);
  });

  test('a forged or expired session is refused', async () => {
    for (const cookie of ['op_session=forged', 'op_session=', 'unrelated=1']) {
      const res = await fetch(`${workspaceOrigin}/`, { headers: { cookie } });
      expect(res.status, cookie).toBe(401);
    }
    expect(seen).toHaveLength(0);
  });

  test('refusal happens before the upstream is called, on writes as well as reads', async () => {
    const res = await fetch(`${workspaceOrigin}/session`, { method: 'POST', body: '{"x":1}' });

    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test('a valid session is not enough for a write from ANOTHER origin', async () => {
    // The cookie is SameSite=Lax, and "same site" ignores the port — so every
    // other origin on this host (the UI itself; any unrelated app on any other
    // port) has this cookie sent for it. session-cookie.ts records that Lax is
    // safe *because* state-mutating requests are independently guarded by the
    // Origin check; this listener runs outside SvelteKit's handle, so it brings
    // its own half of that pair.
    const res = await fetch(`${workspaceOrigin}/session`, {
      method: 'POST',
      headers: { ...asSession(VALID_SESSION), origin: 'http://127.0.0.1:3800' },
      body: '{"x":1}',
    });

    expect(res.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test('the workspace page’s own writes pass — its Origin is this listener', async () => {
    const origin = new URL(workspaceOrigin).host;
    const res = await fetch(`${workspaceOrigin}/session`, {
      method: 'POST',
      headers: { ...asSession(VALID_SESSION), origin: `http://${origin}` },
      body: '{"x":1}',
    });

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
  });

  test('a write with NO Origin still passes — that is the non-browser contract', async () => {
    // curl, the TUI, and a script send none, and the main origin's own check
    // allows that case for exactly the same reason.
    const res = await fetch(`${workspaceOrigin}/session`, {
      method: 'POST',
      headers: asSession(VALID_SESSION),
      body: '{"x":1}',
    });

    expect(res.status).toBe(200);
  });

  test('reads are never blocked by Origin — only state-changing methods are', async () => {
    const res = await fetch(`${workspaceOrigin}/session`, {
      headers: { ...asSession(VALID_SESSION), origin: 'http://127.0.0.1:3800' },
    });

    expect(res.status).toBe(200);
  });
});

describe('an external OpenCode client is not broken by any of this', () => {
  test('a client supplying its own credential is proxied verbatim', async () => {
    // A TUI or script already holding the server password talks to this port
    // exactly as it would to OpenCode: no OpenPalm session, no rewrite.
    const own = `Basic ${Buffer.from('opencode:its-own-key').toString('base64')}`;
    const res = await fetch(`${workspaceOrigin}/api/health`, { headers: { authorization: own } });

    expect(res.status).toBe(200);
    expect(seen[0]?.headers.authorization).toBe(own);
  });

  test('a wrong credential fails at OpenCode, not here — this port does not adjudicate it', async () => {
    respond = (_req, res) => {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="opencode"' });
      res.end('Unauthorized');
    };
    const res = await fetch(`${workspaceOrigin}/api/health`, { headers: { authorization: 'Basic bogus' } });

    expect(res.status).toBe(401);
    expect(seen).toHaveLength(1);
    expect(res.headers.get('www-authenticate')).toBe('Basic realm="opencode"');
  });
});

describe('the proxy is transparent in both directions', () => {
  test('method, path, query and body all arrive unchanged', async () => {
    const res = await fetch(`${workspaceOrigin}/session/abc/message?directory=%2Fwork`, {
      method: 'POST',
      headers: { ...asSession(VALID_SESSION), 'content-type': 'application/json' },
      body: '{"parts":[{"type":"text","text":"hi"}]}',
    });

    expect(res.status).toBe(200);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      url: '/session/abc/message?directory=%2Fwork',
      body: '{"parts":[{"type":"text","text":"hi"}]}',
    });
    expect(seen[0]?.headers['content-type']).toBe('application/json');
  });

  test('upstream status and headers come back as sent', async () => {
    respond = (_req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain', 'x-opencode': 'yes' });
      res.end('nope');
    };
    const res = await fetch(`${workspaceOrigin}/missing`, { headers: asSession(VALID_SESSION) });

    expect(res.status).toBe(404);
    expect(res.headers.get('x-opencode')).toBe('yes');
    await expect(res.text()).resolves.toBe('nope');
  });

  test('a stale content-encoding is not forwarded onto an already-decoded body', async () => {
    // node's fetch decompresses transparently while still reporting the
    // ORIGINAL encoding. Passing that header through tells the browser to
    // decompress plain bytes, and it gives up mid-response — which is how a
    // 3 MB script arrives truncated and the app never boots.
    const { gzipSync } = await import('node:zlib');
    respond = (_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/javascript' });
      res.end(gzipSync(Buffer.from('console.log("boot")')));
    };
    const res = await fetch(`${workspaceOrigin}/assets/index.js`, { headers: asSession(VALID_SESSION) });

    expect(res.headers.get('content-encoding')).toBeNull();
    await expect(res.text()).resolves.toBe('console.log("boot")');
  });

  test('a streamed response is piped, not buffered — the first byte does not wait for the last', async () => {
    let push: ((chunk: string) => void) | undefined;
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: one\n\n');
      push = (chunk) => res.write(chunk);
    };
    const res = await fetch(`${workspaceOrigin}/event`, { headers: asSession(VALID_SESSION) });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();

    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: one\n\n');
    push?.('data: two\n\n');
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe('data: two\n\n');
    await reader.cancel();
  });
});

describe('protocol upgrades tunnel too — OpenCode’s terminal is a WebSocket', () => {
  /**
   * Speak the raw handshake, since fetch cannot: returns everything received.
   *
   * Settles on `until` (or the peer closing), never on a fixed window. A blind
   * timer made this flaky on a loaded runner — the handshake alone can outlast
   * a few hundred milliseconds there, and the splice this asserts costs a
   * further two round trips through the proxy.
   */
  function upgradeRequest(
    path: string,
    headers: Record<string, string>,
    options: { sendOnUpgrade?: string; until: (received: string) => boolean } = {
      until: (received) => received.includes('\r\n\r\n'),
    },
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const { port } = new URL(workspaceOrigin);
      const socket = netConnect({ host: '127.0.0.1', port: Number(port) }, () => {
        const lines = [
          `GET ${path} HTTP/1.1`,
          `host: 127.0.0.1:${port}`,
          'connection: Upgrade',
          'upgrade: websocket',
          'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version: 13',
          ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
        ];
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      });

      let received = '';
      let sent = false;
      const settle = (): void => {
        clearTimeout(ceiling);
        socket.destroy();
        resolve(received);
      };
      // A ceiling only so a genuine hang fails as an assertion on what DID
      // arrive, rather than as an opaque test timeout.
      const ceiling = setTimeout(settle, 8000);

      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString();
        // Write only once the tunnel is actually up: before the 101 there is
        // nothing on the far side to echo it back.
        if (options.sendOnUpgrade && !sent && received.includes('101 Switching Protocols')) {
          sent = true;
          socket.write(options.sendOnUpgrade);
        }
        if (options.until(received)) settle();
      });
      socket.on('close', settle);
      socket.on('error', reject);
    });
  }

  test('a signed-in client is spliced through to the upstream, credential attached', async () => {
    upstream.on('upgrade', onUpgrade);
    const received = await upgradeRequest(
      '/api/pty',
      { cookie: `op_session=${VALID_SESSION}` },
      { sendOnUpgrade: 'ping', until: (r) => r.includes('echo:ping') },
    );

    expect(received).toContain('HTTP/1.1 101 Switching Protocols');
    // Bytes cross in BOTH directions after the handshake — a splice, not a
    // one-shot response.
    expect(received).toContain('echo:ping');
    expect(upgradeHandshakes[0]?.authorization).toBe(
      `Basic ${Buffer.from('opencode:upstream-secret').toString('base64')}`,
    );
    // The upstream must see a handshake addressed to ITSELF, or it rejects it.
    expect(upgradeHandshakes[0]?.host).toBe(new URL(upstreamUrl).host);
    expect(upgradeHandshakes[0]?.['sec-websocket-key']).toBe('dGhlIHNhbXBsZSBub25jZQ==');
    expect(upgradeHandshakes[0]?.cookie).toBeUndefined();
  }, 15000);

  test('an unauthenticated upgrade is refused before any socket is opened', async () => {
    upstream.on('upgrade', onUpgrade);
    const received = await upgradeRequest('/api/pty', {}, { until: (r) => r.includes('\r\n\r\n') });

    expect(received).toContain('401 Unauthorized');
    expect(upgradeHandshakes).toHaveLength(0);
  }, 15000);
});

describe('a client that hangs up takes nothing down with it', () => {
  test('abandoning an open stream leaves the listener serving', async () => {
    // The regression: `.pipe` forwards no errors, so aborting a live SSE stream
    // raised an unhandled `error` event and killed the whole UI process — every
    // time anyone closed the workspace tab.
    respond = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: hello\n\n');
    };
    const abort = new AbortController();
    const res = await fetch(`${workspaceOrigin}/event`, {
      headers: asSession(VALID_SESSION),
      signal: abort.signal,
    });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    await reader.read();
    abort.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));

    respond = (_req, r) => {
      r.writeHead(200, { 'content-type': 'text/plain' });
      r.end('still here');
    };
    const after = await fetch(`${workspaceOrigin}/api/health`, { headers: asSession(VALID_SESSION) });
    await expect(after.text()).resolves.toBe('still here');
  });

  test('an unreachable assistant is reported, not crashed on', async () => {
    // Point the resolver at a port that was bound and released, rather than
    // stopping the shared upstream — a connection refusal is the fact under
    // test, and every other test still needs the real one.
    const live = upstreamUrl;
    const probe = createServer();
    upstreamUrl = `http://127.0.0.1:${await listen(probe)}`;
    await new Promise((resolve) => probe.close(resolve));
    try {
      const res = await fetch(`${workspaceOrigin}/`, { headers: asSession(VALID_SESSION) });

      expect(res.status).toBe(502);
      await expect(res.text()).resolves.toContain('not responding');
    } finally {
      upstreamUrl = live;
    }
  });
});
