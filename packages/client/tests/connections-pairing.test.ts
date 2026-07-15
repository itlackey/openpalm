/**
 * #511 D3/D4 — packages/client/src/lib/connections/pairing.ts:
 * parsePairingCode(), the client-side twin of @openpalm/lib's
 * encodePairingCode/decodePairingCode (packages/client never imports
 * @openpalm/lib — purity gate — so this is a ~25-line hand-maintained twin,
 * pinned compatible against the lib encoder by the last test below, which
 * imports the lib module TESTS-ONLY (precedent:
 * tests/remote-attach.e2e.test.ts:58 imports
 * ../../guardian/src/oc-doc-fixture.ts; purity.test.ts scans only src/ and
 * build/).
 *
 * Idiom: dynamic-import the module under test (connections-url-policy.test.ts
 * pattern).
 *
 * RED reason (every test): packages/client/src/lib/connections/pairing.ts
 * does not exist yet — the dynamic import fails.
 */
import { describe, expect, test } from 'bun:test';

async function loadPairingModule() {
  return import('../src/lib/connections/pairing.ts');
}

const PAYLOAD = {
  v: 1 as const,
  kind: 'openpalm-client-api' as const,
  url: 'https://gw.example.ts.net/oc',
  label: 'My Phone',
  username: 'my-phone-ab12',
  secret: 'f'.repeat(64),
};

/** Local base64url encoder — independent of both codecs under test. */
function localEncode(payload: unknown, withPrefix = true): string {
  const json = JSON.stringify(payload);
  const b64url = Buffer.from(json, 'utf-8').toString('base64url');
  return withPrefix ? `openpalm-pair:${b64url}` : b64url;
}

describe('parsePairingCode (#511 D3/D4)', () => {
  test('parses a valid openpalm-pair code', async () => {
    const { parsePairingCode } = await loadPairingModule();
    const code = localEncode(PAYLOAD);
    const result = parsePairingCode(code);
    expect(result).toEqual({ ok: true, payload: PAYLOAD });
  });

  test('accepts the bare base64url payload without the prefix', async () => {
    const { parsePairingCode } = await loadPairingModule();
    const bare = localEncode(PAYLOAD, false);
    const result = parsePairingCode(bare);
    expect(result).toEqual({ ok: true, payload: PAYLOAD });
  });

  test('rejects malformed base64/JSON with a clear error', async () => {
    const { parsePairingCode } = await loadPairingModule();
    const badBase64 = parsePairingCode('openpalm-pair:not*valid*base64url!!');
    expect(badBase64.ok).toBe(false);
    if (badBase64.ok) throw new Error('expected refusal');
    expect(typeof badBase64.error).toBe('string');

    const badJson = parsePairingCode(`openpalm-pair:${Buffer.from('not json').toString('base64url')}`);
    expect(badJson.ok).toBe(false);
  });

  test('rejects unsupported version with an actionable message', async () => {
    const { parsePairingCode } = await loadPairingModule();
    const code = localEncode({ ...PAYLOAD, v: 2 });
    const result = parsePairingCode(code);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error).toMatch(/version/i);
  });

  test('rejects payloads missing url, username, or secret', async () => {
    const { parsePairingCode } = await loadPairingModule();
    const { url: _url, ...missingUrl } = PAYLOAD;
    expect(parsePairingCode(localEncode(missingUrl)).ok).toBe(false);

    const { username: _username, ...missingUsername } = PAYLOAD;
    expect(parsePairingCode(localEncode(missingUsername)).ok).toBe(false);

    const { secret: _secret, ...missingSecret } = PAYLOAD;
    expect(parsePairingCode(localEncode(missingSecret)).ok).toBe(false);
  });

  test('rejects a pairing URL carrying userinfo before it can prefill the form', async () => {
    const { parsePairingCode } = await loadPairingModule();
    const result = parsePairingCode(
      localEncode({ ...PAYLOAD, url: 'https://url-user:url-password@gw.example/oc' })
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error).toMatch(/Authentication fields/);
    expect(JSON.stringify(result)).not.toContain('url-user');
    expect(JSON.stringify(result)).not.toContain('url-password');
  });

  test('round-trips a code minted by @openpalm/lib', async () => {
    const { parsePairingCode } = await loadPairingModule();
    // Tests-only cross-import — packages/client never imports @openpalm/lib
    // in src/ or build/ (purity.test.ts enforces the boundary there).
    const { encodePairingCode } = await import('../../lib/src/control-plane/pairing.ts');
    const code = encodePairingCode(PAYLOAD);
    const result = parsePairingCode(code);
    expect(result).toEqual({ ok: true, payload: PAYLOAD });
  });
});
