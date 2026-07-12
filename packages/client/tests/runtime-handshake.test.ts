/**
 * #511 D2 — packages/client/src/lib/runtime-handshake.ts: client-side
 * `/api/runtime` contract-version handshake. A new leaf module (NOT a
 * transport change): the transport is scoped to a connection's
 * OpenCode/guardian API surface; the handshake probes a different,
 * OpenPalm-host contract at the connection's ORIGIN ROOT and must treat
 * "endpoint absent" as the normal legacy case, not an error.
 *
 * Idiom: dynamic-import the module under test (connections-url-policy.test.ts
 * pattern), injected fetch (never a real network call).
 *
 * RED reason (every test): packages/client/src/lib/runtime-handshake.ts does
 * not exist yet — the dynamic import fails.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

async function loadHandshakeModule() {
  return import('../src/lib/runtime-handshake.ts');
}

function jsonFetch(body: unknown, init: { status?: number; contentType?: string } = {}) {
  return async (_input: RequestInfo | URL, _requestInit?: RequestInit) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': init.contentType ?? 'application/json' },
    });
}

describe('checkRuntimeContract (#511 D2)', () => {
  test('compatible when /api/runtime returns the supported version', async () => {
    const { checkRuntimeContract } = await loadHandshakeModule();
    const fetchImpl = jsonFetch({ version: 2, hostMode: 'host-ui' });
    const result = await checkRuntimeContract('https://gw.example/oc', fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ state: 'compatible', version: 2 });
  });

  test('newer when the server version exceeds the supported contract', async () => {
    const { checkRuntimeContract } = await loadHandshakeModule();
    const fetchImpl = jsonFetch({ version: 3 });
    const result = await checkRuntimeContract('https://gw.example/oc', fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ state: 'newer', version: 3 });
  });

  test('older for a lower version', async () => {
    const { checkRuntimeContract } = await loadHandshakeModule();
    const fetchImpl = jsonFetch({ version: 1 });
    const result = await checkRuntimeContract('https://gw.example/oc', fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ state: 'older', version: 1 });
  });

  test('legacy on 404 (plain OpenCode/guardian — the normal case, not an error)', async () => {
    const { checkRuntimeContract } = await loadHandshakeModule();
    const fetchImpl = jsonFetch({ error: 'not_found' }, { status: 404 });
    const result = await checkRuntimeContract('https://gw.example/oc', fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ state: 'legacy' });
  });

  test('legacy on network error', async () => {
    const { checkRuntimeContract } = await loadHandshakeModule();
    const fetchImpl = async () => {
      throw new TypeError('fetch failed');
    };
    const result = await checkRuntimeContract('https://gw.example/oc', fetchImpl as unknown as typeof fetch);
    expect(result).toEqual({ state: 'legacy' });
  });

  test('legacy on non-JSON body and on missing/non-integer version', async () => {
    const { checkRuntimeContract } = await loadHandshakeModule();

    const htmlFetch = jsonFetch('<html>not json</html>', { contentType: 'text/html' });
    expect(await checkRuntimeContract('https://gw.example/oc', htmlFetch as unknown as typeof fetch)).toEqual({
      state: 'legacy',
    });

    const stringVersionFetch = jsonFetch({ version: '2' });
    expect(
      await checkRuntimeContract('https://gw.example/oc', stringVersionFetch as unknown as typeof fetch),
    ).toEqual({ state: 'legacy' });

    const missingVersionFetch = jsonFetch({ hostMode: 'host-ui' });
    expect(
      await checkRuntimeContract('https://gw.example/oc', missingVersionFetch as unknown as typeof fetch),
    ).toEqual({ state: 'legacy' });
  });

  test('probes the connection ORIGIN root with credentials omitted and no-store', async () => {
    const { checkRuntimeContract } = await loadHandshakeModule();
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ version: 2 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await checkRuntimeContract('https://gw.example/oc', fetchImpl as unknown as typeof fetch);

    expect(capturedUrl).toBe('https://gw.example/api/runtime');
    expect(capturedInit?.credentials).toBe('omit');
    expect(capturedInit?.cache).toBe('no-store');
  });

  test('SUPPORTED_RUNTIME_CONTRACT_VERSION pins the host contract', async () => {
    const { SUPPORTED_RUNTIME_CONTRACT_VERSION } = await loadHandshakeModule();
    expect(SUPPORTED_RUNTIME_CONTRACT_VERSION).toBe(2);

    // Cross-package source pin — tests-only read, no import (packages/client
    // never imports packages/ui).
    const typesPath = fileURLToPath(new URL('../../ui/src/lib/types.ts', import.meta.url));
    const typesSource = readFileSync(typesPath, 'utf-8');
    expect(typesSource).toMatch(/version:\s*2/);
  });
});
