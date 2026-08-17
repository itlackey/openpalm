/**
 * Which connections /advanced may frame. The regression this pins: the locked
 * default connection resolves to this app's own origin (`/oc`), and framing it
 * rendered a dead "refused to connect" panel instead of a conversation.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { isEmbeddableOpencodeUi, isWorkspaceReachable, resolveWorkspaceUrl } from './embeddable.js';

const LAN_PAGE = { origin: 'http://192.168.0.201:3800', protocol: 'http:' };
const HTTPS_PAGE = { origin: 'https://openpalm.example', protocol: 'https:' };
const LOCAL_ACTIVE_CONNECTION = { isDefault: true, hasPassword: false };
const REMOTE_ACTIVE_CONNECTION = { isDefault: false, hasPassword: false };
/** The server's advertisement: a port and nothing else. */
const HINT = { port: 3820 } as const;

describe('isEmbeddableOpencodeUi — this app’s own origin is not an OpenCode UI', () => {
  test('refuses the locked same-origin /oc pass-through', () => {
    expect(
      isEmbeddableOpencodeUi({ baseUrl: 'http://192.168.0.201:3800/oc', hasPassword: false }, LAN_PAGE),
    ).toBe(false);
  });

  test('refuses it under the unresolved root-relative seed too', () => {
    expect(isEmbeddableOpencodeUi({ baseUrl: '/oc', hasPassword: false }, LAN_PAGE)).toBe(false);
  });

  test('still frames a separate OpenCode origin on the same host', () => {
    expect(
      isEmbeddableOpencodeUi({ baseUrl: 'http://192.168.0.201:3810', hasPassword: false }, LAN_PAGE),
    ).toBe(true);
  });
});

describe('isEmbeddableOpencodeUi — credentials never ride in an iframe URL', () => {
  test('refuses a connection with an attached password', () => {
    expect(
      isEmbeddableOpencodeUi({ baseUrl: 'http://assistant.lan:4096', hasPassword: true }, LAN_PAGE),
    ).toBe(false);
  });

  test('refuses a URL carrying userinfo', () => {
    expect(
      isEmbeddableOpencodeUi(
        { baseUrl: 'http://user:secret@assistant.lan:4096', hasPassword: false },
        LAN_PAGE,
      ),
    ).toBe(false);
  });
});

describe('resolveWorkspaceUrl — composed from the page the browser is on', () => {
  const HTTP = { protocol: 'http:' };

  test('uses the host the browser actually visited', () => {
    expect(
      resolveWorkspaceUrl(HINT, { hostname: '192.168.0.201', ...HTTP }, LOCAL_ACTIVE_CONNECTION),
    ).toBe('http://192.168.0.201:3820');
  });

  test('offers the local advertisement only for the active default connection', () => {
    expect(
      resolveWorkspaceUrl(HINT, { hostname: '192.168.0.201', ...HTTP }, REMOTE_ACTIVE_CONNECTION),
    ).toBeNull();
  });

  test('does not offer the local advertisement when the default has credentials', () => {
    expect(
      resolveWorkspaceUrl(
        HINT,
        { hostname: '192.168.0.201', ...HTTP },
        { isDefault: true, hasPassword: true },
      ),
    ).toBeNull();
  });

  test('brackets an IPv6 host so the address is a valid URL', () => {
    // page.url.hostname arrives bracketed from the WHATWG parser, but the bare
    // spelling must not produce "http://::1:3820" either.
    for (const hostname of ['[::1]', '::1']) {
      const url = resolveWorkspaceUrl(HINT, { hostname, ...HTTP }, LOCAL_ACTIVE_CONNECTION);
      expect(url, hostname).toBe('http://[::1]:3820');
      expect(new URL(url ?? '').port, hostname).toBe('3820');
    }
  });

  test('offers nothing without an advertisement', () => {
    expect(
      resolveWorkspaceUrl(undefined, { hostname: 'localhost', ...HTTP }, LOCAL_ACTIVE_CONNECTION),
    ).toBeNull();
  });
});

describe('resolveWorkspaceUrl — the scheme follows the page, or the frame is blocked', () => {
  // This is the regression that made every TLS-fronted deployment — Caddy,
  // Tailscale Serve — show a blank workspace: an https page may not embed a
  // plain-http frame at all, so a hardcoded http:// address is not "degraded",
  // it is silently refused by the browser before a request is made.

  test('an https page gets an https workspace', () => {
    expect(
      resolveWorkspaceUrl(
        HINT,
        { hostname: 'openpalm.example', protocol: 'https:' },
        LOCAL_ACTIVE_CONNECTION,
      ),
    ).toBe('https://openpalm.example:3820');
  });

  test('a plain-http page keeps plain http — LAN and host-only never had TLS', () => {
    expect(
      resolveWorkspaceUrl(
        HINT,
        { hostname: 'openpalm.local', protocol: 'http:' },
        LOCAL_ACTIVE_CONNECTION,
      ),
    ).toBe('http://openpalm.local:3820');
  });

  test('refuses to compose an address for a non-http(s) page', () => {
    expect(
      resolveWorkspaceUrl(HINT, { hostname: 'x', protocol: 'file:' }, LOCAL_ACTIVE_CONNECTION),
    ).toBeNull();
  });
});

describe('isWorkspaceReachable — an opaque answer is the whole test', () => {
  afterEach(() => vi.unstubAllGlobals());

  test('any HTTP reply counts, including the listener’s own 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(isWorkspaceReachable('http://host:3820')).resolves.toBe(true);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ mode: 'no-cors', credentials: 'include' });
  });

  test('a refused connection is not reachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(isWorkspaceReachable('http://host:3820')).resolves.toBe(false);
  });

  test('a dropped connection gives up instead of hanging the page', async () => {
    // A port nobody forwarded does not refuse — it swallows the packet, and
    // without the abort the /advanced spinner would outlast the user's patience.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      ),
    );
    await expect(isWorkspaceReachable('http://host:3820', 10)).resolves.toBe(false);
  });
});

describe('isEmbeddableOpencodeUi — platform rules', () => {
  test('allows a loopback target from any page', () => {
    expect(
      isEmbeddableOpencodeUi({ baseUrl: 'http://127.0.0.1:3810', hasPassword: false }, HTTPS_PAGE),
    ).toBe(true);
  });

  test('refuses a plain-http remote target from an https page (mixed content)', () => {
    expect(
      isEmbeddableOpencodeUi({ baseUrl: 'http://assistant.lan:4096', hasPassword: false }, HTTPS_PAGE),
    ).toBe(false);
  });

  test('refuses a non-http(s) or unparsable address', () => {
    for (const baseUrl of ['ws://assistant.lan:4096', 'not a url']) {
      expect(isEmbeddableOpencodeUi({ baseUrl, hasPassword: false }, LAN_PAGE), baseUrl).toBe(false);
    }
  });
});
