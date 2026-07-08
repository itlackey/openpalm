/**
 * Tests for /api/assistant/persona — the ASSISTANT-OWNED half of the old
 * /admin/assistant endpoint (plan ui-runtime-modes-plan.md Phase 4 step 2,
 * §5.F, §6.4 "/api/assistant/* — assistant-owned settings").
 *
 * ALL RED until Phase 4 lands: routes/api/assistant/persona/+server.ts does
 * not exist yet. Loaded via computed-specifier dynamic import so
 * svelte-check stays clean while red.
 *
 * Contract under test:
 *  - Persona is assistant-scoped (config/assistant/persona.md — one of the
 *    two read/write mounts the assistant container keeps, plan §6.9). It is
 *    served from /api/assistant/persona guarded by the assistant-settings
 *    capabilities + the requireAdmin cookie check.
 *  - Phase 4 acceptance: assistant-container CAN edit persona — its
 *    serverCapabilities carry assistant-settings:read/write → 200 here.
 *  - Host modes keep assistant-settings:write → 200 in host-ui too.
 *  - pwa-static carries NO assistant-settings capability → 403 even with a
 *    valid admin session (capability-based, not session-based; plan §8.5).
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { cleanupTempDirs, resetState, trackDir } from '$lib/server/test-helpers.js';

type RouteHandler = (event: unknown) => Response | Promise<Response>;
type PersonaRouteModule = { GET: RouteHandler; PUT: RouteHandler };

/** RED-state-safe loader (same pattern as the Phase 2 /api/connections suite). */
async function loadRoute(): Promise<PersonaRouteModule> {
  const specifier = './+server.js';
  return (await import(/* @vite-ignore */ specifier)) as PersonaRouteModule;
}

let homeDir = '';

function makeTempHome(): string {
  const dir = join(tmpdir(), `openpalm-assistant-persona-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return trackDir(dir);
}

function personaFile(): string {
  return join(homeDir, 'config', 'assistant', 'persona.md');
}

function seedPersona(content: string): void {
  mkdirSync(join(homeDir, 'config', 'assistant'), { recursive: true });
  writeFileSync(personaFile(), content);
}

function makeGetEvent(token = 'admin-token'): unknown {
  const url = new URL('http://127.0.0.1:3880/api/assistant/persona');
  return {
    url,
    request: new Request(url, {
      headers: {
        ...(token ? { cookie: `op_session=${token}` } : {}),
        'x-request-id': 'req-assistant-persona-get',
      },
    }),
    params: {},
    locals: { role: token ? 'admin' : null },
    route: { id: '/api/assistant/persona' },
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
  };
}

function makePutEvent(body: Record<string, unknown>, token = 'admin-token'): unknown {
  const url = new URL('http://127.0.0.1:3880/api/assistant/persona');
  return {
    url,
    request: new Request(url, {
      method: 'PUT',
      headers: {
        ...(token ? { cookie: `op_session=${token}` } : {}),
        'x-request-id': 'req-assistant-persona-put',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    params: {},
    locals: { role: token ? 'admin' : null },
    route: { id: '/api/assistant/persona' },
    getClientAddress: () => '127.0.0.1',
    isDataRequest: false,
    isSubRequest: false,
  };
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

describe('GET /api/assistant/persona — assistant-settings guard (plan Phase 4 step 2)', () => {
  test('200 in assistant-container mode with a valid session — returns the persona', async () => {
    process.env.OP_UI_HOST_MODE = 'assistant-container';
    seedPersona('# Persona\n');
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.personaContent).toBe('# Persona\n');
  });

  test('403 in pwa-static mode even with a valid admin session', async () => {
    process.env.OP_UI_HOST_MODE = 'pwa-static';
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(403);
  });

  test('401 without a session cookie (requireAdmin still enforced)', async () => {
    process.env.OP_UI_HOST_MODE = 'assistant-container';
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent(''));
    expect(res.status).toBe(401);
  });
});

describe('PUT /api/assistant/persona — assistant-settings:write (Phase 4 acceptance)', () => {
  test('assistant-container CAN edit the persona: 200 + write to config/assistant/persona.md', async () => {
    process.env.OP_UI_HOST_MODE = 'assistant-container';
    const { PUT } = await loadRoute();
    const res = await PUT(makePutEvent({ personaContent: '# Updated persona' }));
    expect(res.status).toBe(200);
    expect(readFileSync(personaFile(), 'utf-8').trimEnd()).toBe('# Updated persona');
  });

  test('200 in host-ui mode (host modes keep assistant-settings:write)', async () => {
    process.env.OP_UI_HOST_MODE = 'host-ui';
    const { PUT } = await loadRoute();
    const res = await PUT(makePutEvent({ personaContent: '# Host-edited persona' }));
    expect(res.status).toBe(200);
    expect(readFileSync(personaFile(), 'utf-8').trimEnd()).toBe('# Host-edited persona');
  });

  test('403 in pwa-static mode even with a valid session — capability guard, not auth', async () => {
    process.env.OP_UI_HOST_MODE = 'pwa-static';
    const { PUT } = await loadRoute();
    const res = await PUT(makePutEvent({ personaContent: 'nope' }));
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('capability_not_available');
  });

  test('401 without a session cookie', async () => {
    process.env.OP_UI_HOST_MODE = 'assistant-container';
    const { PUT } = await loadRoute();
    const res = await PUT(makePutEvent({ personaContent: '# P' }, ''));
    expect(res.status).toBe(401);
  });
});
