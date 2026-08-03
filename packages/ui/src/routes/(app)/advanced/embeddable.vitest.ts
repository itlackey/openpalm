/**
 * Which connections /advanced may frame. The regression this pins: the locked
 * default connection resolves to this app's own origin (`/oc`), and framing it
 * rendered a dead "refused to connect" panel instead of a conversation.
 */
import { describe, expect, test } from 'vitest';
import { isEmbeddableOpencodeUi } from './embeddable.js';

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
