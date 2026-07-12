/**
 * #557 D1/D6 — pure unit tests for the new
 * src/lib/connections/url-policy.ts leaf module: validateConnectionUrl()
 * refuses a plain-HTTP non-loopback connection URL iff the app itself runs
 * on an https: origin (the mixed-content platform rule), while preserving
 * every other plain-HTTP tier the assessment named:
 *   - loopback targets from any origin (mixed-content loopback exemption),
 *   - non-loopback targets from a loopback-origin client (zero-TLS desktop
 *     default — D1's deviation from the assessment's broader sketch),
 *   - non-loopback targets from a non-loopback http origin (the LAN-served
 *     client tier, `rewriteLoopbackUrlForBrowserHost`).
 *
 * Idiom: dynamic-import the module under test (transport-health-cors.test.ts
 * pattern) so origin is passed explicitly — no globalThis.location stubbing
 * needed here (that's transport-health-insecure.test.ts's job).
 *
 * RED until packages/client/src/lib/connections/url-policy.ts exists: every
 * test fails with "Cannot find module …/src/lib/connections/url-policy.ts".
 */
import { describe, expect, test } from 'bun:test';

async function loadUrlPolicyModule() {
  return import('../src/lib/connections/url-policy.ts');
}

describe('validateConnectionUrl (#557 D1)', () => {
  test('allows an https target from any origin', async () => {
    const { validateConnectionUrl } = await loadUrlPolicyModule();
    expect(
      validateConnectionUrl('https://gw.ts.net', { protocol: 'https:', hostname: 'app.openpalm.dev' })
    ).toEqual({ ok: true });
    expect(
      validateConnectionUrl('https://gw.ts.net', { protocol: 'http:', hostname: '127.0.0.1' })
    ).toEqual({ ok: true });
  });

  test('allows plain-http loopback targets from an https origin', async () => {
    const { validateConnectionUrl } = await loadUrlPolicyModule();
    const origin = { protocol: 'https:', hostname: 'app.openpalm.dev' };
    for (const url of ['http://127.0.0.1:3800', 'http://localhost:3800', 'http://[::1]:3800']) {
      expect(validateConnectionUrl(url, origin), url).toEqual({ ok: true });
    }
  });

  test('refuses a plain-http non-loopback target from an https origin', async () => {
    const { validateConnectionUrl, TLS_GUIDE_URL } = await loadUrlPolicyModule();
    const verdict = validateConnectionUrl('http://192.168.1.5:3830', {
      protocol: 'https:',
      hostname: 'app.openpalm.dev'
    });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected refusal');
    expect(verdict.reason).toBe('insecure-remote');
    expect(verdict.message).toMatch(/https/i);
    expect((verdict as { guideUrl?: string }).guideUrl).toBe(TLS_GUIDE_URL);
  });

  test('allows a plain-http non-loopback target from a loopback origin (zero-TLS desktop default)', async () => {
    const { validateConnectionUrl } = await loadUrlPolicyModule();
    expect(
      validateConnectionUrl('http://192.168.1.5:3830', { protocol: 'http:', hostname: '127.0.0.1' })
    ).toEqual({ ok: true });
  });

  test('allows a plain-http non-loopback target from a non-loopback http origin (LAN-served client tier)', async () => {
    const { validateConnectionUrl } = await loadUrlPolicyModule();
    expect(
      validateConnectionUrl('http://192.168.1.5:3830', { protocol: 'http:', hostname: '192.168.1.7' })
    ).toEqual({ ok: true });
  });

  test('allows everything when no browser origin is available', async () => {
    const { validateConnectionUrl } = await loadUrlPolicyModule();
    expect(validateConnectionUrl('http://192.168.1.5:3830', null)).toEqual({ ok: true });
  });

  test('rejects an unparseable URL as invalid-url', async () => {
    const { validateConnectionUrl } = await loadUrlPolicyModule();
    const verdict = validateConnectionUrl('not a url', { protocol: 'https:', hostname: 'app.openpalm.dev' });
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('expected refusal');
    expect(verdict.reason).toBe('invalid-url');
    // Also from a loopback origin — invalid-url refusal is origin-independent.
    const verdict2 = validateConnectionUrl('not a url', { protocol: 'http:', hostname: '127.0.0.1' });
    expect(verdict2.ok).toBe(false);
    if (verdict2.ok) throw new Error('expected refusal');
    expect(verdict2.reason).toBe('invalid-url');
  });

  test('rejects non-http(s) schemes as invalid-url', async () => {
    const { validateConnectionUrl } = await loadUrlPolicyModule();
    const origin = { protocol: 'https:', hostname: 'app.openpalm.dev' };
    for (const url of ['ws://gw.example:8080', 'file:///etc/passwd']) {
      const verdict = validateConnectionUrl(url, origin);
      expect(verdict.ok, url).toBe(false);
      if (verdict.ok) throw new Error('expected refusal');
      expect(verdict.reason).toBe('invalid-url');
    }
  });

  test('TLS_GUIDE_URL deep-links docs/remote-access-tls.md on GitHub', async () => {
    const { TLS_GUIDE_URL } = await loadUrlPolicyModule();
    expect(TLS_GUIDE_URL).toMatch(
      /^https:\/\/github\.com\/itlackey\/openpalm\/blob\/main\/docs\/remote-access-tls\.md$/
    );
  });
});
