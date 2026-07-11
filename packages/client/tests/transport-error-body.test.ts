/**
 * E5 [LOW] (review 2026-07-10 §E5) — the transport discarded server error
 * bodies, regressing structured errors (e.g. `cors_origin_denied`, provider
 * auth failures) to a bare "HTTP <status>". Mirrors the old
 * `readErrorMessage` (`git show 455d8728:packages/ui/src/lib/api/core.ts`):
 * prefer a JSON `message`/`error` field, else trimmed response text, else the
 * "HTTP <status>" fallback.
 *
 * New file — does not modify the shared tests/helpers/*.ts contract.
 */
import { describe, expect, test } from 'bun:test';

async function loadTransportModule() {
  return import('../src/lib/transport/index.ts');
}

const BASE = 'http://gw.example:8443';

function jsonErrorResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('non-ok error message extraction (E5)', () => {
  test('prefers a JSON "message" field', async () => {
    const { createTransport } = await loadTransportModule();
    const fetch = (async () =>
      jsonErrorResponse({ message: 'cors_origin_denied' }, 403)) as typeof globalThis.fetch;
    const transport = createTransport({ baseUrl: BASE, fetch });
    let caught: unknown;
    try {
      await transport.listSessions();
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe('cors_origin_denied');
    expect((caught as { status?: number }).status).toBe(403);
  });

  test('falls back to a JSON "error" field when there is no "message"', async () => {
    const { createTransport } = await loadTransportModule();
    const fetch = (async () => jsonErrorResponse({ error: 'provider_auth_failed' }, 502)) as typeof globalThis.fetch;
    const transport = createTransport({ baseUrl: BASE, fetch });
    let caught: unknown;
    try {
      await transport.listSessions();
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe('provider_auth_failed');
  });

  test('falls back to trimmed response text when the body is not JSON', async () => {
    const { createTransport } = await loadTransportModule();
    const fetch = (async () =>
      new Response('  upstream is on fire  \n', { status: 500, headers: { 'content-type': 'text/plain' } })) as typeof globalThis.fetch;
    const transport = createTransport({ baseUrl: BASE, fetch });
    let caught: unknown;
    try {
      await transport.listSessions();
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe('upstream is on fire');
  });

  test('falls back to "HTTP <status>" when the body is empty', async () => {
    const { createTransport } = await loadTransportModule();
    const fetch = (async () => new Response('', { status: 500 })) as typeof globalThis.fetch;
    const transport = createTransport({ baseUrl: BASE, fetch });
    let caught: unknown;
    try {
      await transport.listSessions();
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe('HTTP 500');
  });

  test('a JSON body with neither message nor error falls back to the raw text', async () => {
    const { createTransport } = await loadTransportModule();
    const fetch = (async () => jsonErrorResponse({ code: 'X' }, 400)) as typeof globalThis.fetch;
    const transport = createTransport({ baseUrl: BASE, fetch });
    let caught: unknown;
    try {
      await transport.listSessions();
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toBe(JSON.stringify({ code: 'X' }));
  });
});
