/**
 * What /advanced frames. The regression class this pins: the locked default
 * connection resolves to this app's own origin (`/oc`), and framing that URL
 * rendered a dead "refused to connect" panel — it is an API proxy, not a UI.
 * The locked default frames the static bundle instead; a framable remote
 * OpenCode frames itself; everything else gets the notice (null).
 */
import { describe, expect, test } from 'vitest';
import { isEmbeddableOpencodeUi, resolveFrameBase } from './embeddable.js';
import { OPENCODE_WEB_PREFIX, opencodeWebShellUrl } from '$lib/opencode-web.js';

const LAN_PAGE = { origin: 'http://192.168.0.201:3800', protocol: 'http:' };
const HTTPS_PAGE = { origin: 'https://openpalm.example', protocol: 'https:' };

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

describe('resolveFrameBase — this install’s assistant frames the static bundle', () => {
  const LOCKED = { baseUrl: '/oc', hasPassword: false, isDefault: true };

  test('frames the bundle shell for the locked root-relative seed', () => {
    expect(resolveFrameBase(LOCKED, LAN_PAGE)).toBe(`${OPENCODE_WEB_PREFIX}/`);
    expect(resolveFrameBase(LOCKED, LAN_PAGE)).toBe(opencodeWebShellUrl());
  });

  test('frames it for the resolved same-origin form too', () => {
    expect(
      resolveFrameBase({ ...LOCKED, baseUrl: 'http://192.168.0.201:3800/oc' }, LAN_PAGE),
    ).toBe(opencodeWebShellUrl());
  });

  test('works from an https page — same origin, no mixed content in play', () => {
    expect(resolveFrameBase(LOCKED, HTTPS_PAGE)).toBe(opencodeWebShellUrl());
  });
});

describe('resolveFrameBase — every other connection keeps its own path', () => {
  test('a framable remote OpenCode frames itself, not the local bundle', () => {
    // The bundle is built to talk to THIS origin's /oc — it cannot serve a
    // connection naming someone else's server.
    expect(
      resolveFrameBase(
        { baseUrl: 'http://192.168.0.201:3810', hasPassword: false, isDefault: false },
        LAN_PAGE,
      ),
    ).toBe('http://192.168.0.201:3810');
  });

  test('a credentialed connection gets the notice (null)', () => {
    expect(
      resolveFrameBase(
        { baseUrl: 'http://assistant.lan:4096', hasPassword: true, isDefault: false },
        LAN_PAGE,
      ),
    ).toBeNull();
  });

  test('a user-added entry naming this origin is not the locked assistant', () => {
    expect(
      resolveFrameBase(
        { baseUrl: 'http://192.168.0.201:3800/oc', hasPassword: false, isDefault: false },
        LAN_PAGE,
      ),
    ).toBeNull();
  });
});
