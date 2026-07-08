/**
 * Tests for /api/host/stack — the HOST-SCOPED half of the old
 * /admin/assistant endpoint (plan ui-runtime-modes-plan.md Phase 4 step 2,
 * §5.F, §6.4).
 *
 * ALL RED until Phase 4 lands: routes/api/host/stack/+server.ts does not
 * exist yet. Loaded via computed-specifier dynamic import so svelte-check
 * stays clean while red.
 *
 * Contract under test — the AssistantTab split (plan §9 "Assistant settings"):
 *  - Project name (OP_PROJECT_NAME) and assistant bind address
 *    (OP_ASSISTANT_BIND_ADDRESS, surfaced as lanExposureEnabled) are HOST
 *    STACK settings → they live at GET/PUT /api/host/stack, guarded by the
 *    host:* capability set (host:stack:write for writes) + requireAdmin.
 *  - Persona is NOT part of this payload anymore — it is assistant-owned and
 *    moves to /api/assistant/* (see routes/api/assistant/persona tests).
 *    PUT therefore no longer requires personaContent.
 *  - Phase 4 acceptance: assistant-container can edit persona/AKM but NOT
 *    project name or bind address → 403 here even with a valid admin
 *    session, and stack.env stays untouched.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { cleanupTempDirs, resetState, stackEnvFor, trackDir } from '$lib/server/test-helpers.js';

type RouteHandler = (event: unknown) => Response | Promise<Response>;
type HostStackRouteModule = { GET: RouteHandler; PUT: RouteHandler };

/** RED-state-safe loader (same pattern as the Phase 2 /api/connections suite). */
async function loadRoute(): Promise<HostStackRouteModule> {
  const specifier = './+server.js';
  return (await import(/* @vite-ignore */ specifier)) as HostStackRouteModule;
}

let homeDir = '';

function makeTempHome(): string {
  const dir = join(tmpdir(), `openpalm-host-stack-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return trackDir(dir);
}

function makeGetEvent(token = 'admin-token'): unknown {
  const url = new URL('http://127.0.0.1:3880/api/host/stack');
  return {
    url,
    request: new Request(url, {
      headers: {
        ...(token ? { cookie: `op_session=${token}` } : {}),
        'x-request-id': 'req-host-stack-get',
      },
    }),
    params: {},
    locals: { role: token ? 'admin' : null },
    route: { id: '/api/host/stack' },
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
  };
}

function makePutEvent(body: Record<string, unknown>, token = 'admin-token'): unknown {
  const url = new URL('http://127.0.0.1:3880/api/host/stack');
  return {
    url,
    request: new Request(url, {
      method: 'PUT',
      headers: {
        ...(token ? { cookie: `op_session=${token}` } : {}),
        'x-request-id': 'req-host-stack-put',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    params: {},
    locals: { role: token ? 'admin' : null },
    route: { id: '/api/host/stack' },
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
  };
}

function readStackEnvIfAny(): string {
  const path = stackEnvFor(homeDir);
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

const ENV_KEYS = [
  'OP_UI_HOST_MODE',
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

describe('GET /api/host/stack — host stack settings (plan Phase 4 step 2)', () => {
  test('200 in host-ui mode: project name + LAN exposure, and NO persona (partitioned)', async () => {
    process.env.OP_UI_HOST_MODE = 'host-ui';
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.projectName).toBe('openpalm');
    expect(body.lanExposureEnabled).toBe(false);
    // Persona is assistant-owned now — it must not leak into the host payload.
    expect(body).not.toHaveProperty('personaContent');
  });

  test('403 in assistant-container mode even with a valid admin session', async () => {
    process.env.OP_UI_HOST_MODE = 'assistant-container';
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(403);
  });

  test('403 in pwa-static mode even with a valid admin session', async () => {
    process.env.OP_UI_HOST_MODE = 'pwa-static';
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(403);
  });

  test('401 in host-ui mode without a session cookie', async () => {
    process.env.OP_UI_HOST_MODE = 'host-ui';
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent(''));
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/host/stack — host:stack:write guard (Phase 4 acceptance)', () => {
  test('updates project name and bind address in host-ui mode — persona no longer required', async () => {
    process.env.OP_UI_HOST_MODE = 'host-ui';
    const { PUT } = await loadRoute();
    const res = await PUT(makePutEvent({ projectName: 'openpalm-dev', lanExposureEnabled: true }));
    expect(res.status).toBe(200);

    const stackEnv = readFileSync(stackEnvFor(homeDir), 'utf-8');
    expect(stackEnv).toContain('OP_PROJECT_NAME=openpalm-dev');
    expect(stackEnv).toContain('OP_ASSISTANT_BIND_ADDRESS=0.0.0.0');
  });

  test('assistant-container cannot edit project name or bind address: 403 with a valid session', async () => {
    process.env.OP_UI_HOST_MODE = 'assistant-container';
    const { PUT } = await loadRoute();
    const res = await PUT(makePutEvent({ projectName: 'intruder', lanExposureEnabled: true }));
    expect(res.status).toBe(403);
    // The write must have been refused before touching the stack env.
    expect(readStackEnvIfAny()).not.toContain('intruder');
  });

  test('401 in host-ui mode without a session cookie', async () => {
    process.env.OP_UI_HOST_MODE = 'host-ui';
    const { PUT } = await loadRoute();
    const res = await PUT(makePutEvent({ projectName: 'openpalm', lanExposureEnabled: false }, ''));
    expect(res.status).toBe(401);
  });
});
