import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  decodePairingCode,
  encodePairingCode,
  normalizeGuardianPairingUrl,
  type PairingPayloadV1,
} from './pairing.js';

const PAYLOAD: PairingPayloadV1 = {
  v: 1,
  kind: 'openpalm-connection',
  url: 'https://openpalm.example/oc',
  label: 'Élise’s phone 📱',
  username: 'phone-a1',
  secret: 's'.repeat(64),
};

function encodeTestPayload(payload: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `openpalm-pair:${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

describe('browser-safe pairing codec', () => {
  it('round-trips UTF-8 payloads without Node-only APIs', () => {
    expect(decodePairingCode(encodePairingCode(PAYLOAD))).toEqual({ ok: true, payload: PAYLOAD });
    const source = readFileSync(fileURLToPath(new URL('./pairing.ts', import.meta.url)), 'utf-8');
    expect(source).not.toMatch(/node:|Buffer|Bun|readSecret|control-plane/);
  });

  it('normalizes only the root and /oc forms', () => {
    expect(normalizeGuardianPairingUrl('https://openpalm.example')).toEqual({
      ok: true,
      url: 'https://openpalm.example/oc',
    });
    expect(normalizeGuardianPairingUrl('https://openpalm.example/oc/')).toEqual({
      ok: true,
      url: 'https://openpalm.example/oc',
    });
    expect(normalizeGuardianPairingUrl('https://openpalm.example/other').ok).toBe(false);
  });

  it('returns nontechnical guidance for malformed or incomplete codes', () => {
    for (const code of [
      'not-a-code',
      encodeTestPayload({ ...PAYLOAD, v: 2 }),
      encodeTestPayload({ ...PAYLOAD, secret: undefined }),
    ]) {
      const result = decodePairingCode(code);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected invalid pairing code');
      expect(result.error).toMatch(/pairing code/i);
      expect(result.error).not.toMatch(/base64|json|payload|kind|version/i);
    }
  });
});
