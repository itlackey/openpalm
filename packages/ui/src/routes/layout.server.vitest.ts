/**
 * Tests for routes/+layout.server.ts — Phase 1 RuntimeContext v2 (issue #509).
 *
 * TDD status:
 *  - The `features.admin` tests are CHARACTERIZATION: they pass pre-change and
 *    MUST keep passing — Phase 1 keeps `features.admin` as a derived alias so
 *    all existing code and routes work unchanged (zero behavior change).
 *  - The `serverRuntimeContext` tests are RED until #509 lands: the layout
 *    load must additionally return the ServerRuntimeContext computed by
 *    computeServerRuntimeContext(event) (plan Phase 1 step 3).
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { ServerRuntimeContext } from '$lib/types.js';
import { load } from './+layout.server.js';

function makeEvent(url = 'http://127.0.0.1:3880/') {
  const u = new URL(url);
  return {
    url: u,
    request: new Request(u, { headers: { host: u.host } }),
    params: {},
    locals: {},
    route: { id: '/' },
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
  } as unknown as Parameters<typeof load>[0];
}

async function runLoad(): Promise<Record<string, unknown>> {
  return (await load(makeEvent())) as unknown as Record<string, unknown>;
}

const MODE_ENV_KEYS = ['OP_UI_HOST_MODE', 'OP_INSIDE_ELECTRON', 'OP_ENABLE_ADMIN'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of MODE_ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of MODE_ENV_KEYS) {
    const prev = savedEnv[key];
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
});

// ── features.admin alias (CHARACTERIZATION — green pre-change) ───────────────

describe('+layout.server load — features.admin alias (characterization)', () => {
  test('features.admin is true under OP_INSIDE_ELECTRON=1', async () => {
    process.env.OP_INSIDE_ELECTRON = '1';
    const data = await runLoad();
    expect((data.features as { admin: boolean }).admin).toBe(true);
  });

  test('features.admin is true under OP_ENABLE_ADMIN=1', async () => {
    process.env.OP_ENABLE_ADMIN = '1';
    const data = await runLoad();
    expect((data.features as { admin: boolean }).admin).toBe(true);
  });

  test('features.admin is false when neither legacy env is set', async () => {
    const data = await runLoad();
    expect((data.features as { admin: boolean }).admin).toBe(false);
  });
});

// ── serverRuntimeContext (RED until #509 lands) ──────────────────────────────

describe('+layout.server load — serverRuntimeContext (plan Phase 1)', () => {
  test('layout data includes serverRuntimeContext with contract version 2', async () => {
    const data = await runLoad();
    const ctx = data.serverRuntimeContext as ServerRuntimeContext | undefined;
    expect(ctx, 'load() must return serverRuntimeContext').toBeDefined();
    expect(ctx?.version).toBe(2);
  });

  test("serverRuntimeContext.hostMode maps OP_INSIDE_ELECTRON=1 → 'electron-host'", async () => {
    process.env.OP_INSIDE_ELECTRON = '1';
    const data = await runLoad();
    const ctx = data.serverRuntimeContext as ServerRuntimeContext | undefined;
    expect(ctx?.hostMode).toBe('electron-host');
  });

  test("serverRuntimeContext.hostMode maps OP_ENABLE_ADMIN=1 → 'host-ui'", async () => {
    process.env.OP_ENABLE_ADMIN = '1';
    const data = await runLoad();
    const ctx = data.serverRuntimeContext as ServerRuntimeContext | undefined;
    expect(ctx?.hostMode).toBe('host-ui');
  });
});
