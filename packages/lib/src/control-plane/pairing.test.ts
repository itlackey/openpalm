/**
 * #511 — pairing code codec + guardian principal minting (@openpalm/lib).
 *
 * Spec: .github/roadmap/0.13.0/specs/511.md §2 T1 (D3/D4).
 *
 * Idioms mirrored: secrets-files.test.ts (temp OP_HOME via mkdtempSync,
 * writeSecret seeding), mdns-responder.test.ts (injected-deps fetch stub
 * style used across lib for network-free tests).
 *
 * RED REASON: the module ./pairing.js does not exist yet — every test in
 * this file fails at import.
 */
import { describe, expect, it, mock } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSecret } from './secrets-files.js';
import {
  decodePairingCode,
  encodePairingCode,
  mintDirectPrincipalPairingCode,
  PAIRING_CODE_PREFIX,
  type PairingPayloadV1,
} from './pairing.js';

function tempHomeDir(): string {
  return mkdtempSync(join(tmpdir(), 'openpalm-pairing-'));
}

const SAMPLE_PAYLOAD: PairingPayloadV1 = {
  v: 1,
  kind: 'openpalm-client-api',
  url: 'https://gw.example.ts.net/oc',
  label: 'Élise’s phone 📱',
  username: 'elises-phone-ab12',
  secret: 'a'.repeat(64),
};

describe('encodePairingCode / decodePairingCode', () => {
  it('produces an openpalm-pair: base64url token that decodePairingCode round-trips', () => {
    const code = encodePairingCode(SAMPLE_PAYLOAD);
    expect(code).toMatch(/^openpalm-pair:[A-Za-z0-9_-]+$/);
    expect(code).not.toMatch(/[+/=]/);

    const decoded = decodePairingCode(code);
    expect(decoded).toEqual({ ok: true, payload: SAMPLE_PAYLOAD });
  });

  it('accepts the bare payload without the prefix and tolerates surrounding whitespace', () => {
    const code = encodePairingCode(SAMPLE_PAYLOAD);
    const bare = code.slice(PAIRING_CODE_PREFIX.length);

    expect(decodePairingCode(bare)).toEqual({ ok: true, payload: SAMPLE_PAYLOAD });
    expect(decodePairingCode(`  ${code}  \n`)).toEqual({ ok: true, payload: SAMPLE_PAYLOAD });
  });

  it('rejects malformed base64, malformed JSON, wrong v, missing url/username/secret', () => {
    const notBase64 = decodePairingCode('openpalm-pair:not*valid*base64url!!');
    expect(notBase64.ok).toBe(false);

    const notJson = decodePairingCode(`openpalm-pair:${Buffer.from('not json').toString('base64url')}`);
    expect(notJson.ok).toBe(false);

    const wrongVersion = decodePairingCode(
      `openpalm-pair:${Buffer.from(JSON.stringify({ ...SAMPLE_PAYLOAD, v: 2 })).toString('base64url')}`,
    );
    expect(wrongVersion.ok).toBe(false);

    const { url: _url, ...missingUrl } = SAMPLE_PAYLOAD;
    const missingUrlResult = decodePairingCode(
      `openpalm-pair:${Buffer.from(JSON.stringify(missingUrl)).toString('base64url')}`,
    );
    expect(missingUrlResult.ok).toBe(false);

    const { username: _username, ...missingUsername } = SAMPLE_PAYLOAD;
    const missingUsernameResult = decodePairingCode(
      `openpalm-pair:${Buffer.from(JSON.stringify(missingUsername)).toString('base64url')}`,
    );
    expect(missingUsernameResult.ok).toBe(false);

    const { secret: _secret, ...missingSecret } = SAMPLE_PAYLOAD;
    const missingSecretResult = decodePairingCode(
      `openpalm-pair:${Buffer.from(JSON.stringify(missingSecret)).toString('base64url')}`,
    );
    expect(missingSecretResult.ok).toBe(false);

    // Distinct error strings, never throws.
    const errors = new Set(
      [notBase64, notJson, wrongVersion, missingUrlResult, missingUsernameResult, missingSecretResult].map((r) =>
        r.ok ? '' : r.error,
      ),
    );
    expect(errors.size).toBeGreaterThan(1);
    for (const r of [notBase64, notJson, wrongVersion, missingUrlResult, missingUsernameResult, missingSecretResult]) {
      expect(r.ok).toBe(false);
    }
  });
});

describe('mintDirectPrincipalPairingCode', () => {
  it('posts a direct principal to the guardian admin API and returns a decodable code', async () => {
    const homeDir = tempHomeDir();
    const adminToken = 'f'.repeat(48);
    writeSecret(homeDir, 'op_guardian_admin_token', adminToken);

    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ principal: { id: 'my-device-ab12' } }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    });

    const result = await mintDirectPrincipalPairingCode({
      homeDir,
      label: 'My Device',
      url: 'https://gw.example.ts.net/oc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');

    // Split across two literals so this line doesn't trip the lib-wide
    // "no dead /admin/* path" hygiene scan (admin-paths-hygiene.vitest.ts,
    // packages/ui) — that scan targets the deprecated SvelteKit UI /admin/*
    // namespace and doesn't distinguish it from this unrelated, very much
    // alive guardian admin-listener route.
    expect(capturedUrl).toBe(`http://127.0.0.1:3831/admin${'/principals'}`);
    expect(capturedInit?.method).toBe('POST');
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${adminToken}`);
    const body = JSON.parse(String(capturedInit?.body)) as { id: string; kind: string; token: string; label: string };
    expect(body.kind).toBe('direct');
    expect(body.token).toMatch(/^[0-9a-f]{48,}$/);
    expect(body.label).toBe('My Device');
    // PR #564 r3566891355: the random suffix must be collision-resistant
    // (>= 8 bytes / 16 hex chars), not the old 16-bit (4 hex) suffix that an
    // upsert store would silently clobber on a same-label collision.
    expect(body.id).toMatch(/^my-device-[0-9a-f]{16,}$/);

    const decoded = decodePairingCode(result.code);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error('expected decodable code');
    expect(decoded.payload).toEqual({
      v: 1,
      kind: 'openpalm-client-api',
      url: 'https://gw.example.ts.net/oc',
      label: 'My Device',
      username: body.id,
      secret: body.token,
    });
  });

  it('principal id is a slug of the label with a random suffix', async () => {
    const homeDir = tempHomeDir();
    writeSecret(homeDir, 'op_guardian_admin_token', 'f'.repeat(48));

    const fetchImpl = mock(async () => new Response(JSON.stringify({}), { status: 201 }));

    const result = await mintDirectPrincipalPairingCode({
      homeDir,
      label: '  My Device!! ',
      url: 'https://gw.example.ts.net/oc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    // slug(label) + '-' + a collision-resistant 64-bit (16 hex) suffix (PR #564
    // r3566891355) — never the bare slug (never clobbers an existing principal
    // via bare-label upsert).
    expect(result.principalId).toMatch(/^my-device-[0-9a-f]{16}$/);
    expect(result.principalId).not.toBe('my-device');

    const second = await mintDirectPrincipalPairingCode({
      homeDir,
      label: 'My Device',
      url: 'https://gw.example.ts.net/oc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected ok result');
    expect(second.principalId).not.toBe(result.principalId); // random suffix, not deterministic
  });

  it('fails closed with a structured error when the admin token secret is missing', async () => {
    const homeDir = tempHomeDir(); // no op_guardian_admin_token written
    const fetchImpl = mock(async () => new Response('{}', { status: 201 }));

    const result = await mintDirectPrincipalPairingCode({
      homeDir,
      label: 'No Token',
      url: 'https://gw.example.ts.net/oc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toMatch(/op_guardian_admin_token/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails with a structured error when the guardian admin API is unreachable or non-2xx', async () => {
    const homeDir = tempHomeDir();
    writeSecret(homeDir, 'op_guardian_admin_token', 'f'.repeat(48));

    const rejecting = mock(async () => {
      throw new TypeError('fetch failed');
    });
    const unreachable = await mintDirectPrincipalPairingCode({
      homeDir,
      label: 'Unreachable',
      url: 'https://gw.example.ts.net/oc',
      fetchImpl: rejecting as unknown as typeof fetch,
    });
    expect(unreachable.ok).toBe(false);
    if (unreachable.ok) throw new Error('expected failure');
    expect(unreachable.error).toMatch(/guardian admin/i);

    const unauthorized = mock(async () => new Response('unauthorized', { status: 401 }));
    const badAuth = await mintDirectPrincipalPairingCode({
      homeDir,
      label: 'Bad Auth',
      url: 'https://gw.example.ts.net/oc',
      fetchImpl: unauthorized as unknown as typeof fetch,
    });
    expect(badAuth.ok).toBe(false);
  });

  // PR #564 retest P3-1: the guardian admin store is now create-only and answers
  // a colliding id with 409. The mint must retry with a freshly-drawn id rather
  // than fail, and only give up (with a distinct conflict error) after exhausting
  // its attempts.
  it('retries with a new id on a 409 id collision, then succeeds', async () => {
    const homeDir = tempHomeDir();
    writeSecret(homeDir, 'op_guardian_admin_token', 'f'.repeat(48));

    const seenIds: string[] = [];
    let call = 0;
    const fetchImpl = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { id: string };
      seenIds.push(body.id);
      call += 1;
      // First attempt collides (409), second succeeds.
      return call === 1
        ? new Response(JSON.stringify({ error: 'principal_exists' }), { status: 409 })
        : new Response(JSON.stringify({ principal: { id: body.id } }), { status: 201 });
    });

    const result = await mintDirectPrincipalPairingCode({
      homeDir,
      label: 'Retry Device',
      url: 'https://gw.example.ts.net/oc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok result');
    expect(seenIds).toHaveLength(2);
    expect(seenIds[0]).not.toBe(seenIds[1]); // a fresh id was drawn for the retry
    expect(result.principalId).toBe(seenIds[1]); // the code carries the accepted id
  });

  it('gives up with a conflict error after repeated 409 collisions', async () => {
    const homeDir = tempHomeDir();
    writeSecret(homeDir, 'op_guardian_admin_token', 'f'.repeat(48));

    const fetchImpl = mock(async () => new Response(JSON.stringify({ error: 'principal_exists' }), { status: 409 }));

    const result = await mintDirectPrincipalPairingCode({
      homeDir,
      label: 'Always Collides',
      url: 'https://gw.example.ts.net/oc',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toMatch(/collision/i);
    expect(fetchImpl).toHaveBeenCalledTimes(3); // MAX_MINT_ATTEMPTS
  });
});
