/**
 * Pure unit tests for the browser-owned connection URL policy:
 * validateConnectionUrl() refuses a plain-HTTP non-loopback connection URL iff
 * the app itself runs on an https: origin (the mixed-content platform rule),
 * while preserving every other plain-HTTP tier.
 *
 * There is intentionally no guardian `/oc`-normalization block — Guardian is a
 * transparent OpenCode proxy now, so there is no path inference to test.
 */
import { describe, expect, test } from 'vitest';
import {
  hasSameLoopbackPort,
  isAppOriginUrl,
  redactUrlUserinfo,
  TLS_GUIDE_URL,
  validateConnectionUrl,
} from './url-policy.js';

describe('isAppOriginUrl — the /oc pass-through is not an embeddable UI origin', () => {
  test('recognizes the resolved same-origin proxy connection', () => {
    expect(isAppOriginUrl('http://192.168.0.201:3800/oc', 'http://192.168.0.201:3800')).toBe(true);
  });

  test('recognizes the unresolved root-relative seed', () => {
    expect(isAppOriginUrl('/oc', 'http://192.168.0.201:3800')).toBe(true);
  });

  test('leaves a remote assistant on another host, port, or scheme alone', () => {
    for (const raw of [
      'http://192.168.0.42:3800/oc',
      'http://192.168.0.201:3810',
      'https://192.168.0.201:3800/oc',
    ]) {
      expect(isAppOriginUrl(raw, 'http://192.168.0.201:3800'), raw).toBe(false);
    }
  });

  test('answers false without an app origin (SSR)', () => {
    expect(isAppOriginUrl('http://192.168.0.201:3800/oc', null)).toBe(false);
    expect(isAppOriginUrl('/oc', '')).toBe(false);
  });
});

describe('hasSameLoopbackPort', () => {
  test('treats localhost, IPv4, and IPv6 loopback aliases on the same port as equivalent', () => {
    expect(hasSameLoopbackPort('http://localhost:3810', 'http://127.0.0.1:3810/')).toBe(true);
    expect(hasSameLoopbackPort('http://[::1]:3810/oc', 'http://localhost:3810')).toBe(true);
  });

  test('requires matching effective ports and two loopback hosts', () => {
    expect(hasSameLoopbackPort('http://localhost:3810', 'http://127.0.0.1:3830')).toBe(false);
    expect(hasSameLoopbackPort('http://localhost', 'http://127.0.0.1:80')).toBe(true);
    expect(hasSameLoopbackPort('http://localhost:3810', 'http://192.168.1.10:3810')).toBe(false);
    expect(hasSameLoopbackPort('not a url', 'http://localhost:3810')).toBe(false);
  });
});

describe('validateConnectionUrl', () => {
  test('allows an https target from any origin', () => {
    expect(
      validateConnectionUrl('https://gw.ts.net', { protocol: 'https:', hostname: 'app.openpalm.dev' })
    ).toEqual({ ok: true });
    expect(
      validateConnectionUrl('https://gw.ts.net', { protocol: 'http:', hostname: '127.0.0.1' })
    ).toEqual({ ok: true });
  });

  test('allows plain-http loopback targets from an https origin', () => {
    const origin = { protocol: 'https:', hostname: 'app.openpalm.dev' };
    for (const url of ['http://127.0.0.1:3800', 'http://localhost:3800', 'http://[::1]:3800']) {
      expect(validateConnectionUrl(url, origin), url).toEqual({ ok: true });
    }
  });

  test('refuses a plain-http non-loopback target from an https origin', () => {
    const verdict = validateConnectionUrl('http://192.168.1.5:3830', {
      protocol: 'https:',
      hostname: 'app.openpalm.dev',
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected refusal');
    expect(verdict.reason).toBe('insecure-remote');
    expect(verdict.message).toMatch(/https/i);
    expect((verdict as { guideUrl?: string }).guideUrl).toBe(TLS_GUIDE_URL);
  });

  test('allows a plain-http non-loopback target from a loopback origin (zero-TLS desktop default)', () => {
    expect(
      validateConnectionUrl('http://192.168.1.5:3830', { protocol: 'http:', hostname: '127.0.0.1' })
    ).toEqual({ ok: true });
  });

  test('allows a plain-http non-loopback target from a non-loopback http origin (LAN-served tier)', () => {
    expect(
      validateConnectionUrl('http://192.168.1.5:3830', { protocol: 'http:', hostname: '192.168.1.7' })
    ).toEqual({ ok: true });
  });

  test('allows everything when no browser origin is available', () => {
    expect(validateConnectionUrl('http://192.168.1.5:3830', null)).toEqual({ ok: true });
  });

  test('rejects an unparseable URL as invalid-url', () => {
    const verdict = validateConnectionUrl('not a url', { protocol: 'https:', hostname: 'app.openpalm.dev' });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected refusal');
    expect(verdict.reason).toBe('invalid-url');
    const verdict2 = validateConnectionUrl('not a url', { protocol: 'http:', hostname: '127.0.0.1' });
    expect(verdict2.ok).toBe(false);
    if (verdict2.ok) throw new Error('expected refusal');
    expect(verdict2.reason).toBe('invalid-url');
  });

  test('rejects non-http(s) schemes as invalid-url', () => {
    const origin = { protocol: 'https:', hostname: 'app.openpalm.dev' };
    for (const url of ['ws://gw.example:8080', 'file:///etc/passwd']) {
      const verdict = validateConnectionUrl(url, origin);
      expect(verdict.ok, url).toBe(false);
      if (verdict.ok) throw new Error('expected refusal');
      expect(verdict.reason).toBe('invalid-url');
    }
  });

  test('rejects URL userinfo and redacts it without preserving either credential', () => {
    const raw = 'https://url-user:url-password@assistant.example:4096';
    const verdict = validateConnectionUrl(raw, null);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected refusal');
    expect(verdict.reason).toBe('userinfo-not-allowed');
    expect(verdict.message).toMatch(/Authentication fields/);
    expect(redactUrlUserinfo(raw)).toBe('https://assistant.example:4096');
  });

  test('rejects query strings and fragments before callers append API paths', () => {
    for (const raw of [
      'https://assistant.example?tenant=home',
      'https://assistant.example/#credential',
    ]) {
      const verdict = validateConnectionUrl(raw, null);
      expect(verdict.ok, raw).toBe(false);
      if (verdict.ok) throw new Error('expected refusal');
      expect(verdict.reason).toBe('query-or-fragment-not-allowed');
      expect(verdict.message).not.toContain('tenant=home');
      expect(verdict.message).not.toContain('credential');
    }
  });

  test('TLS_GUIDE_URL deep-links docs/remote-access-tls.md on GitHub', () => {
    expect(TLS_GUIDE_URL).toMatch(
      /^https:\/\/github\.com\/itlackey\/openpalm\/blob\/main\/docs\/remote-access-tls\.md$/
    );
  });
});
