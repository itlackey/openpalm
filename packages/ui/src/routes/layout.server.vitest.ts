/**
 * Tests for routes/+layout.server.ts — Phase 1 RuntimeContext v2 (issue #509).
 *
 * TDD status:
 *  - The `features.admin` characterization block that protected the derived
 *    alias through Phases 1–3 was retired with the alias itself in Phase 4
 *    (delete when grep finds no reader — nothing
 *    consumed `data.features` anymore). The env → admin mapping it pinned
 *    is covered by the serverRuntimeContext tests below.
 *  - The `serverRuntimeContext` tests describe the #509 layout payload: the
 *    load returns the ServerRuntimeContext computed by
 *    computeServerRuntimeContext(event).
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

const MODE_ENV_KEYS = ['OP_INSIDE_ELECTRON', 'OP_ENABLE_ADMIN'] as const;
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

// The features.admin alias characterization block lived here through Phases
// 1–3. Phase 4 deleted the alias with its last readers; the layout payload
// now carries only serverRuntimeContext.

// ── serverRuntimeContext (#509 layout payload) ────────────────────────────────

describe('+layout.server load — serverRuntimeContext', () => {
  test('layout data includes serverRuntimeContext with contract version 2', async () => {
    const data = await runLoad();
    const ctx = data.serverRuntimeContext as ServerRuntimeContext | undefined;
    expect(ctx, 'load() must return serverRuntimeContext').toBeDefined();
    expect(ctx?.version).toBe(2);
  });

  test('serverRuntimeContext.admin maps OP_INSIDE_ELECTRON=1 → true', async () => {
    process.env.OP_INSIDE_ELECTRON = '1';
    const data = await runLoad();
    const ctx = data.serverRuntimeContext as ServerRuntimeContext | undefined;
    expect(ctx?.admin).toBe(true);
  });

  test('serverRuntimeContext.admin maps OP_ENABLE_ADMIN=1 → true', async () => {
    process.env.OP_ENABLE_ADMIN = '1';
    const data = await runLoad();
    const ctx = data.serverRuntimeContext as ServerRuntimeContext | undefined;
    expect(ctx?.admin).toBe(true);
  });

  test('serverRuntimeContext.admin is false when no admin env is set (served baseline)', async () => {
    const data = await runLoad();
    const ctx = data.serverRuntimeContext as ServerRuntimeContext | undefined;
    expect(ctx?.admin).toBe(false);
  });
});
