/**
 * Which connections /advanced may frame. The regression this pins: the locked
 * default connection resolves to this app's own origin (`/oc`), and framing it
 * rendered a dead "refused to connect" panel instead of a conversation.
 */
import { describe, expect, test } from 'vitest';
import {
  isEmbeddableOpencodeUi,
  OPENCODE_WORKSPACE_PATH,
  resolveFrameBase,
  resolveWorkspaceUrl,
} from './embeddable.js';
import { WORKSPACE_PREFIX } from '$lib/server/opencode-workspace.js';

const LAN_PAGE = { origin: 'http://192.168.0.201:3800', protocol: 'http:' };
const HTTPS_PAGE = { origin: 'https://openpalm.example', protocol: 'https:' };
const LOCAL_ACTIVE_CONNECTION = { isDefault: true, hasPassword: false };
const REMOTE_ACTIVE_CONNECTION = { isDefault: false, hasPassword: false };

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

describe('resolveWorkspaceUrl — composed from the host the browser visited', () => {
  test('uses the visited LAN host when the assistant port is published beyond loopback', () => {
    expect(
      resolveWorkspaceUrl(
        { port: 3810, loopbackOnly: false, requiresAuth: false },
        { hostname: '192.168.0.201' },
        LOCAL_ACTIVE_CONNECTION,
      ),
    ).toBe('http://192.168.0.201:3810');
  });

  test('offers the local advertisement only for the active default connection', () => {
    expect(
      resolveWorkspaceUrl(
        { port: 3810, loopbackOnly: false, requiresAuth: false },
        { hostname: '192.168.0.201' },
        REMOTE_ACTIVE_CONNECTION,
      ),
    ).toBeNull();
  });

  test('does not offer the local advertisement when the default has credentials', () => {
    expect(
      resolveWorkspaceUrl(
        { port: 3810, loopbackOnly: false, requiresAuth: false },
        { hostname: '192.168.0.201' },
        { isDefault: true, hasPassword: true },
      ),
    ).toBeNull();
  });

  test('offers nothing to a LAN client when the publish is loopback-only', () => {
    expect(
      resolveWorkspaceUrl(
        { port: 3810, loopbackOnly: true, requiresAuth: false },
        { hostname: '192.168.0.201' },
        LOCAL_ACTIVE_CONNECTION,
      ),
    ).toBeNull();
  });

  test('offers the loopback-only publish to a client on the machine itself', () => {
    for (const hostname of ['localhost', '127.0.0.1']) {
      expect(
        resolveWorkspaceUrl({ port: 3810, loopbackOnly: true, requiresAuth: false }, { hostname }, LOCAL_ACTIVE_CONNECTION),
        hostname,
      ).toBe(`http://${hostname}:3810`);
    }
  });

  test('brackets an IPv6 host so the address is a valid URL', () => {
    // page.url.hostname arrives bracketed from the WHATWG parser; isLoopbackHost
    // also accepts the bare spelling, and that one must not produce
    // "http://::1:3810".
    for (const hostname of ['[::1]', '::1']) {
      const url = resolveWorkspaceUrl(
        { port: 3810, loopbackOnly: true, requiresAuth: false },
        { hostname },
        LOCAL_ACTIVE_CONNECTION,
      );
      expect(url, hostname).toBe('http://[::1]:3810');
      expect(new URL(url ?? '').port, hostname).toBe('3810');
    }
  });

  test('offers nothing without an advertisement', () => {
    expect(
      resolveWorkspaceUrl(undefined, { hostname: 'localhost' }, LOCAL_ACTIVE_CONNECTION),
    ).toBeNull();
  });
});

describe('resolveWorkspaceUrl — a credentialed workspace is only for a client that can authenticate', () => {
  const AUTHED_HINT = { port: 3810, loopbackOnly: true, requiresAuth: true };
  const CAN_AUTHENTICATE = true;

  test('offers nothing to an ordinary browser — it holds no OpenCode credential', () => {
    expect(
      resolveWorkspaceUrl(AUTHED_HINT, { hostname: '127.0.0.1' }, LOCAL_ACTIVE_CONNECTION),
    ).toBeNull();
  });

  test('offers it to the desktop shell, which answers the Basic challenge in its main process', () => {
    // The `assistantDirect`-on desktop install: /advanced framed nothing at all
    // while OpenCode was running and reachable one port over.
    expect(
      resolveWorkspaceUrl(
        AUTHED_HINT,
        { hostname: '127.0.0.1' },
        LOCAL_ACTIVE_CONNECTION,
        CAN_AUTHENTICATE,
      ),
    ).toBe('http://127.0.0.1:3810');
  });

  test('being able to authenticate does not override reachability', () => {
    expect(
      resolveWorkspaceUrl(
        AUTHED_HINT,
        { hostname: '192.168.0.201' },
        LOCAL_ACTIVE_CONNECTION,
        CAN_AUTHENTICATE,
      ),
    ).toBeNull();
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

describe('resolveFrameBase — this install’s assistant frames the workspace proxy', () => {
  const LOCKED = { baseUrl: '/oc', hasPassword: false, isDefault: true };

  test('the client path matches the server route it must hit', () => {
    // Duplicated as a literal in embeddable.ts so the server-only module (it
    // hashes the shim with node:crypto) stays out of the client bundle.
    expect(OPENCODE_WORKSPACE_PATH).toBe(WORKSPACE_PREFIX);
  });

  test('frames /_opencode for the locked root-relative seed', () => {
    expect(resolveFrameBase(LOCKED, LAN_PAGE, null)).toBe(OPENCODE_WORKSPACE_PATH);
  });

  test('frames /_opencode for the resolved same-origin form too', () => {
    expect(
      resolveFrameBase({ ...LOCKED, baseUrl: 'http://192.168.0.201:3800/oc' }, LAN_PAGE, null),
    ).toBe(OPENCODE_WORKSPACE_PATH);
  });

  test('prefers the proxy over the direct-port workspace — that is the whole point', () => {
    // The direct port is exactly what fails behind a reverse proxy, on a phone,
    // and whenever OPENCODE_AUTH is on.
    expect(resolveFrameBase(LOCKED, LAN_PAGE, 'http://192.168.0.201:3810')).toBe(
      OPENCODE_WORKSPACE_PATH,
    );
  });

  test('works from an https page, where the direct http port is unframable', () => {
    expect(resolveFrameBase({ ...LOCKED, baseUrl: '/oc' }, HTTPS_PAGE, null)).toBe(
      OPENCODE_WORKSPACE_PATH,
    );
  });
});

describe('resolveFrameBase — every other connection keeps its own path', () => {
  test('a framable remote OpenCode frames itself, not this app’s assistant', () => {
    expect(
      resolveFrameBase(
        { baseUrl: 'http://192.168.0.201:3810', hasPassword: false, isDefault: false },
        LAN_PAGE,
        null,
      ),
    ).toBe('http://192.168.0.201:3810');
  });

  test('a credentialed connection falls back to the direct-port workspace', () => {
    expect(
      resolveFrameBase(
        { baseUrl: 'http://assistant.lan:4096', hasPassword: true, isDefault: false },
        LAN_PAGE,
        'http://192.168.0.201:3810',
      ),
    ).toBe('http://192.168.0.201:3810');
  });

  test('with no fallback it returns null, and the page renders the native surface', () => {
    expect(
      resolveFrameBase(
        { baseUrl: 'http://assistant.lan:4096', hasPassword: true, isDefault: false },
        HTTPS_PAGE,
        null,
      ),
    ).toBeNull();
  });

  test('a user-added entry naming this origin is not the locked assistant', () => {
    // isDefault false: the workspace proxy forwards to THIS process's
    // assistant, which is not what that connection asked for.
    expect(
      resolveFrameBase(
        { baseUrl: 'http://192.168.0.201:3800/oc', hasPassword: false, isDefault: false },
        LAN_PAGE,
        null,
      ),
    ).toBeNull();
  });
});
