/**
 * Pure unit tests for the browser-owned pairing-code decoder — the decode half
 * of @openpalm/lib's encodePairingCode/decodePairingCode. Pinned compatible
 * against the lib encoder by the last test (tests-only cross-import).
 *
 * Ported from packages/client/tests/connections-pairing.test.ts.
 */
import { describe, expect, test } from 'vitest';
import { parsePairingCode } from './pairing.js';

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

describe('parsePairingCode', () => {
  test('parses a valid openpalm-pair code', () => {
    const result = parsePairingCode(localEncode(PAYLOAD));
    expect(result).toEqual({ ok: true, payload: PAYLOAD });
  });

  test('accepts the bare base64url payload without the prefix', () => {
    const result = parsePairingCode(localEncode(PAYLOAD, false));
    expect(result).toEqual({ ok: true, payload: PAYLOAD });
  });

  test('rejects malformed base64/JSON with a clear error', () => {
    const badBase64 = parsePairingCode('openpalm-pair:not*valid*base64url!!');
    expect(badBase64.ok).toBe(false);
    if (badBase64.ok) throw new Error('expected refusal');
    expect(typeof badBase64.error).toBe('string');

    const badJson = parsePairingCode(`openpalm-pair:${Buffer.from('not json').toString('base64url')}`);
    expect(badJson.ok).toBe(false);
  });

  test('rejects unsupported version with an actionable message', () => {
    const result = parsePairingCode(localEncode({ ...PAYLOAD, v: 2 }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error).toMatch(/version/i);
  });

  test('rejects payloads missing url, username, or secret', () => {
    const { url: _url, ...missingUrl } = PAYLOAD;
    expect(parsePairingCode(localEncode(missingUrl)).ok).toBe(false);

    const { username: _username, ...missingUsername } = PAYLOAD;
    expect(parsePairingCode(localEncode(missingUsername)).ok).toBe(false);

    const { secret: _secret, ...missingSecret } = PAYLOAD;
    expect(parsePairingCode(localEncode(missingSecret)).ok).toBe(false);
  });

  test('rejects a pairing URL carrying userinfo before it can prefill the form', () => {
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
    const { encodePairingCode } = await import('@openpalm/lib/control-plane/pairing.js');
    const code = encodePairingCode(PAYLOAD);
    const result = parsePairingCode(code);
    expect(result).toEqual({ ok: true, payload: PAYLOAD });
  });
});
