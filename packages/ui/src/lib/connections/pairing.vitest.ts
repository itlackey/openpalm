/**
 * Pure unit tests for the browser-owned pairing-code decoder — the decode half
 * of @openpalm/lib's encodePairingCode/decodePairingCode. Pinned compatible
 * against the lib encoder by the last test (tests-only cross-import).
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parsePairingCode } from './pairing.js';

const PAYLOAD = {
  v: 1 as const,
  kind: 'openpalm-connection' as const,
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
    if (badJson.ok) throw new Error('expected refusal');
    for (const error of [badBase64.error, badJson.error]) {
      expect(error).toMatch(/pairing code/i);
      expect(error).not.toMatch(/base64|json|payload|kind|version/i);
    }
  });

  test('rejects unsupported version with an actionable message', () => {
    const result = parsePairingCode(localEncode({ ...PAYLOAD, v: 2 }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error).toMatch(/new code/i);
    expect(result.error).not.toMatch(/version|kind|json|base64/i);
  });

  test('rejects payloads missing url, username, or secret', () => {
    expect(parsePairingCode(localEncode({ ...PAYLOAD, url: undefined })).ok).toBe(false);
    expect(parsePairingCode(localEncode({ ...PAYLOAD, username: undefined })).ok).toBe(false);
    expect(parsePairingCode(localEncode({ ...PAYLOAD, secret: undefined })).ok).toBe(false);
  });

  test('rejects a pairing URL carrying userinfo before it can prefill the form', () => {
    const result = parsePairingCode(
      localEncode({ ...PAYLOAD, url: 'https://url-user:url-password@gw.example/oc' })
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.error).toMatch(/new code/i);
    expect(JSON.stringify(result)).not.toContain('url-user');
    expect(JSON.stringify(result)).not.toContain('url-password');
  });

  test('normalizes a guardian root to /oc and keeps /oc stable', () => {
    const root = parsePairingCode(localEncode({ ...PAYLOAD, url: 'https://gw.example.ts.net' }));
    expect(root).toEqual({
      ok: true,
      payload: { ...PAYLOAD, url: 'https://gw.example.ts.net/oc' },
    });

    const oc = parsePairingCode(localEncode({ ...PAYLOAD, url: 'https://gw.example.ts.net/oc/' }));
    expect(oc).toEqual({
      ok: true,
      payload: { ...PAYLOAD, url: 'https://gw.example.ts.net/oc' },
    });
  });

  test('rejects arbitrary paths, queries, and fragments in guardian pairing URLs', () => {
    for (const url of [
      'https://gw.example.ts.net/api',
      'https://gw.example.ts.net/oc/extra',
      'https://gw.example.ts.net?tenant=home',
      'https://gw.example.ts.net/oc#secret',
    ]) {
      const result = parsePairingCode(localEncode({ ...PAYLOAD, url }));
      expect(result.ok, url).toBe(false);
    }
  });

  test('round-trips a code minted by @openpalm/lib', async () => {
    const { encodePairingCode } = await import('@openpalm/lib/pairing.js');
    const code = encodePairingCode(PAYLOAD);
    const result = parsePairingCode(code);
    expect(result).toEqual({ ok: true, payload: PAYLOAD });
  });

  test('delegates decoding to the browser-safe @openpalm/lib pairing module', () => {
    const source = readFileSync(fileURLToPath(new URL('./pairing.ts', import.meta.url)), 'utf-8');
    expect(source).toContain('@openpalm/lib/pairing.js');
    expect(source).not.toMatch(/atob|TextDecoder|normalizeGuardian/);
  });
});
