/**
 * Tests for /api/assistant/akm — assistant-SCOPED AKM configuration (plan
 * ui-runtime-modes-plan.md Phase 4 steps 2+3, §6.4).
 *
 * ALL RED until Phase 4 lands: routes/api/assistant/akm/+server.ts does not
 * exist yet (it is the move of the assistant-scoped part of
 * routes/admin/akm/+server.ts — GET + PATCH over config/akm/config.json).
 * Loaded via computed-specifier dynamic import so svelte-check stays clean
 * while red.
 *
 * Contract under test — the AkmTab split (plan §9 "AKM"):
 *  - The AKM runtime config (config/akm/config.json) is assistant-scoped →
 *    lives under /api/assistant/akm, guarded by the assistant-settings
 *    capabilities + requireAdmin.
 *  - assistant-settings:read/write are BASE capabilities present in every
 *    process → GET/PATCH 200 regardless of admin capability; the requireAdmin
 *    cookie check is still enforced (401 without a session).
 *  - Host-LEVEL AKM (host key sharing) stays under /api/host — pinned by
 *    routes/api/host/guard-hygiene.vitest.ts, not here.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { cleanupTempDirs, resetState, trackDir } from '$lib/server/test-helpers.js';

type RouteHandler = (event: unknown) => Response | Promise<Response>;
type AssistantAkmRouteModule = { GET: RouteHandler; PATCH: RouteHandler };

/** RED-state-safe loader (same pattern as the Phase 2 /api/connections suite). */
async function loadRoute(): Promise<AssistantAkmRouteModule> {
  const specifier = './+server.js';
  return (await import(/* @vite-ignore */ specifier)) as AssistantAkmRouteModule;
}

let homeDir = '';

function makeTempHome(): string {
  const dir = join(tmpdir(), `openpalm-assistant-akm-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return trackDir(dir);
}

function akmConfigFile(): string {
  return join(homeDir, 'config', 'akm', 'config.json');
}

function seedAkmConfig(config: Record<string, unknown>): void {
  mkdirSync(join(homeDir, 'config', 'akm'), { recursive: true });
  writeFileSync(akmConfigFile(), JSON.stringify(config));
}

function makeGetEvent(token = 'admin-token'): unknown {
  const url = new URL('http://127.0.0.1:3880/api/assistant/akm');
  return {
    url,
    request: new Request(url, {
      headers: {
        ...(token ? { cookie: `op_session=${token}` } : {}),
        'x-request-id': 'req-assistant-akm-get',
      },
    }),
    params: {},
    locals: { role: token ? 'admin' : null },
    route: { id: '/api/assistant/akm' },
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
  };
}

function makePatchEvent(body: Record<string, unknown>, token = 'admin-token'): unknown {
  const url = new URL('http://127.0.0.1:3880/api/assistant/akm');
  return {
    url,
    request: new Request(url, {
      method: 'PATCH',
      headers: {
        ...(token ? { cookie: `op_session=${token}` } : {}),
        'x-request-id': 'req-assistant-akm-patch',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    params: {},
    locals: { role: token ? 'admin' : null },
    route: { id: '/api/assistant/akm' },
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
  };
}

const ENV_KEYS = [
  'OP_INSIDE_ELECTRON',
  'OP_ENABLE_ADMIN',
  'OP_HOME',
  'OP_UI_LOGIN_PASSWORD',
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  homeDir = makeTempHome();
  process.env.OP_HOME = homeDir;
  resetState('admin-token');
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const prev = savedEnv[key];
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  cleanupTempDirs();
});

describe('GET /api/assistant/akm — assistant-scoped AKM config (plan Phase 4 step 2)', () => {
  test('200 in a non-admin process with a valid session — returns the config', async () => {
    seedAkmConfig({ defaults: { llm: 'main' } });
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { config: Record<string, unknown> };
    expect((body.config.defaults as Record<string, unknown>).llm).toBe('main');
  });

  test('401 without a session cookie (requireAdmin still enforced)', async () => {
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent(''));
    expect(res.status).toBe(401);
  });
});

describe('PATCH /api/assistant/akm — the browser can edit AKM (Phase 4 acceptance)', () => {
  test('200 in a non-admin process: the patch is persisted to config/akm/config.json', async () => {
    const { PATCH } = await loadRoute();
    const res = await PATCH(makePatchEvent({ defaults: { llm: 'primary' } }));
    expect(res.status).toBe(200);
    expect(readFileSync(akmConfigFile(), 'utf-8')).toContain('primary');
  });

  test('200 in an admin process too (assistant-settings:write is a base capability)', async () => {
    process.env.OP_ENABLE_ADMIN = '1';
    const { PATCH } = await loadRoute();
    const res = await PATCH(makePatchEvent({ defaults: { llm: 'primary' } }));
    expect(res.status).toBe(200);
    expect(readFileSync(akmConfigFile(), 'utf-8')).toContain('primary');
  });
});
