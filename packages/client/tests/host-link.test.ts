/**
 * A2 [HIGH] (review 2026-07-10 §A2, client half) — the client SPA has no way
 * back to the host admin/chat UI. The foundation lane added an optional
 * `hostUrl` field to `writeClientRuntimeConfig` (packages/lib) that
 * Electron/CLI write when a host UI exists alongside the client server; this
 * pins the client reading that field through to `getClientBoot()` so
 * `+layout.svelte` can render a "Manage assistant" link from it — rendered
 * only when present (a container-only deployment with no host process omits
 * the field entirely).
 *
 * RED until src/lib/connections/index.ts's RuntimeConfig carries hostUrl and
 * src/lib/boot.ts threads it through.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

type MutableGlobals = typeof globalThis & {
  fetch?: typeof globalThis.fetch;
  indexedDB?: IDBFactory;
};

function seededConfigResponse(hostUrl?: string): Response {
  const body: Record<string, unknown> = {
    connections: [
      {
        id: 'seed-local-opencode',
        label: 'This assistant',
        kind: 'local-opencode',
        url: 'http://127.0.0.1:4096',
        auth: { mode: 'none' },
        isDefault: true,
        locked: true,
      },
    ],
  };
  if (hostUrl !== undefined) body.hostUrl = hostUrl;
  return Response.json(body);
}

describe('runtime-config hostUrl passthrough', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    const globals = globalThis as MutableGlobals;
    if (originalFetch === undefined) delete globals.fetch;
    else globals.fetch = originalFetch;
  });

  test('loadRuntimeConfig() carries hostUrl through when the file has one', async () => {
    (globalThis as MutableGlobals).fetch = async () => seededConfigResponse('http://127.0.0.1:3880/host');
    const { loadRuntimeConfig } = await import('../src/lib/connections/index.ts');
    const config = await loadRuntimeConfig();
    expect(config?.hostUrl).toBe('http://127.0.0.1:3880/host');
  });

  test('loadRuntimeConfig() omits hostUrl when the file has none (container-only deployment)', async () => {
    (globalThis as MutableGlobals).fetch = async () => seededConfigResponse(undefined);
    const { loadRuntimeConfig } = await import('../src/lib/connections/index.ts');
    const config = await loadRuntimeConfig();
    expect(config?.hostUrl).toBeUndefined();
  });
});

describe('getClientBoot() exposes hostUrl', () => {
  const originalFetch = globalThis.fetch;
  const originalIndexedDb = globalThis.indexedDB;

  beforeEach(() => {
    (globalThis as MutableGlobals).indexedDB = undefined;
  });

  afterEach(() => {
    const globals = globalThis as MutableGlobals;
    if (originalFetch === undefined) delete globals.fetch;
    else globals.fetch = originalFetch;
    if (originalIndexedDb === undefined) delete globals.indexedDB;
    else globals.indexedDB = originalIndexedDb;
  });

  test('ClientBoot.hostUrl reflects the runtime config when Electron/CLI wrote one', async () => {
    (globalThis as MutableGlobals).fetch = async () => seededConfigResponse('http://127.0.0.1:3880/host');
    // Cache-bust: boot.ts memoizes bootPromise at module scope, and prior
    // tests in this process may have already resolved it.
    const boot = await import(`../src/lib/boot.ts?hostlink=${Date.now()}-${Math.random()}`);
    const result = await boot.getClientBoot();
    expect(result.hostUrl).toBe('http://127.0.0.1:3880/host');
  });

  test('ClientBoot.hostUrl is undefined when the runtime config has none', async () => {
    (globalThis as MutableGlobals).fetch = async () => seededConfigResponse(undefined);
    const boot = await import(`../src/lib/boot.ts?hostlink=${Date.now()}-${Math.random()}`);
    const result = await boot.getClientBoot();
    expect(result.hostUrl).toBeUndefined();
  });
});
