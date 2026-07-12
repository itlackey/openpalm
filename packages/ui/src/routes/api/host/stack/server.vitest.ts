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
import { cleanupTempDirs, resetState, seedSecretsEnv, stackEnvFor, trackDir } from '$lib/server/test-helpers.js';
import { _resetMdnsResponderForTests, _setMdnsSocketFactoryForTests } from '@openpalm/lib';
import type { MdnsRemoteInfo, MdnsSocketFactory, MdnsSocketLike } from '@openpalm/lib/control-plane/mdns-responder.js';

/**
 * #488 — no-op mDNS socket double. The PUT handler now triggers a real
 * reconcileMdnsResponder() call; this stub factory guarantees the unit
 * suite never binds a real UDP 5353 socket.
 */
class NoopMdnsSocket implements MdnsSocketLike {
  bind(_port: number, _address: string, cb?: () => void): void {
    cb?.();
  }
  addMembership(_mcastAddr: string): void {}
  setMulticastTTL(_ttl: number): void {}
  send(_msg: Uint8Array, _port: number, _address: string): void {}
  close(): void {}
  on(event: 'message', cb: (msg: Uint8Array, rinfo: MdnsRemoteInfo) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  on(_event: 'message' | 'error', _cb: never): void {}
  unref(): void {}
}

const noopMdnsSocketFactory: MdnsSocketFactory = () => new NoopMdnsSocket();

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
  'OP_BIND_ADDRESS',
  'OP_ASSISTANT_BIND_ADDRESS',
  'OP_PROJECT_NAME',
  'OP_MDNS',
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
  // #488 — never let the PUT handler's reconcile bind a real UDP socket.
  _setMdnsSocketFactoryForTests(noopMdnsSocketFactory);
});

afterEach(() => {
  _resetMdnsResponderForTests();
  _setMdnsSocketFactoryForTests(null);
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

// #488 — mdns surface on GET/PUT /api/host/stack (spec §2.4, tests 40-44).
describe('GET/PUT /api/host/stack — mdns surface (#488)', () => {
  test('GET includes derived .local names, ports, and inactive state by default', async () => {
    process.env.OP_UI_HOST_MODE = 'host-ui';
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.mdns).toEqual({
      assistant: { name: 'openpalm.local', port: 3800, advertised: false },
      guardian: { name: 'openpalm-guardian.local', port: 3830, advertised: false },
    });
  });

  test('PUT lanExposureEnabled:true flips assistant advertised on (guardian stays off)', async () => {
    process.env.OP_UI_HOST_MODE = 'host-ui';
    const { GET, PUT } = await loadRoute();
    const putRes = await PUT(makePutEvent({ projectName: 'openpalm', lanExposureEnabled: true }));
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as Record<string, unknown>;
    expect(putBody.mdns).toEqual({
      assistant: { name: 'openpalm.local', port: 3800, advertised: true },
      guardian: { name: 'openpalm-guardian.local', port: 3830, advertised: false },
    });

    const getRes = await GET(makeGetEvent());
    const getBody = (await getRes.json()) as Record<string, unknown>;
    expect(getBody.mdns).toEqual(putBody.mdns);
  });

  test('derived names follow a sanitized project name', async () => {
    process.env.OP_UI_HOST_MODE = 'host-ui';
    const { GET, PUT } = await loadRoute();
    const putRes = await PUT(makePutEvent({ projectName: 'my_lab', lanExposureEnabled: false }));
    expect(putRes.status).toBe(200);

    const res = await GET(makeGetEvent());
    const body = (await res.json()) as Record<string, unknown>;
    const mdns = body.mdns as { assistant: { name: string }; guardian: { name: string } };
    expect(mdns.assistant.name).toBe('my-lab.local');
    expect(mdns.guardian.name).toBe('my-lab-guardian.local');
  });

  test('OP_BIND_ADDRESS + GUARDIAN_DIRECT_INGRESS in stack.env marks the guardian name advertised', async () => {
    // PR #564 P2-1: guardian mDNS is gated on direct ingress being enabled, so
    // the advertised front door is never a listener that 404s.
    process.env.OP_UI_HOST_MODE = 'host-ui';
    seedSecretsEnv(homeDir, 'OP_BIND_ADDRESS=0.0.0.0\nGUARDIAN_DIRECT_INGRESS=true\n');
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    const body = (await res.json()) as Record<string, unknown>;
    const mdns = body.mdns as { guardian: { advertised: boolean } };
    expect(mdns.guardian.advertised).toBe(true);
  });

  test('OP_BIND_ADDRESS without GUARDIAN_DIRECT_INGRESS leaves the guardian un-advertised (P2-1)', async () => {
    process.env.OP_UI_HOST_MODE = 'host-ui';
    seedSecretsEnv(homeDir, 'OP_BIND_ADDRESS=0.0.0.0\n');
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    const body = (await res.json()) as Record<string, unknown>;
    const mdns = body.mdns as { guardian: { advertised: boolean } };
    expect(mdns.guardian.advertised).toBe(false);
  });

  test('OP_MDNS=off in stack.env reports both names un-advertised even with LAN exposure on', async () => {
    process.env.OP_UI_HOST_MODE = 'host-ui';
    seedSecretsEnv(homeDir, 'OP_BIND_ADDRESS=0.0.0.0\nOP_ASSISTANT_BIND_ADDRESS=0.0.0.0\nOP_MDNS=off\n');
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    const body = (await res.json()) as Record<string, unknown>;
    const mdns = body.mdns as { assistant: { advertised: boolean }; guardian: { advertised: boolean } };
    expect(mdns.assistant.advertised).toBe(false);
    expect(mdns.guardian.advertised).toBe(false);
  });
});

// #563 — networkPreset surfaced on GET/PUT /api/host/stack (D8, T58-T60).
describe('GET/PUT /api/host/stack — networkPreset surface (#563 D8)', () => {
  test('T58: GET reports networkPreset "this-pc" on a fresh env', async () => {
    process.env.OP_UI_HOST_MODE = 'host-ui';
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.networkPreset).toBe('this-pc');
  });

  test('T59: GET detects a seeded home-password row', async () => {
    process.env.OP_UI_HOST_MODE = 'host-ui';
    seedSecretsEnv(
      homeDir,
      [
        'OP_BIND_ADDRESS=127.0.0.1',
        'OP_ASSISTANT_BIND_ADDRESS=0.0.0.0',
        'OP_CLIENT_BIND_ADDRESS=127.0.0.1',
        'OP_VOICE_BIND_ADDRESS=127.0.0.1',
        'OPENCODE_AUTH=true',
        '',
      ].join('\n'),
    );
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.networkPreset).toBe('home-password');
  });

  test('T59: a drifted env reports networkPreset null', async () => {
    process.env.OP_UI_HOST_MODE = 'host-ui';
    seedSecretsEnv(
      homeDir,
      [
        'OP_BIND_ADDRESS=0.0.0.0',
        'OP_ASSISTANT_BIND_ADDRESS=0.0.0.0',
        'OPENCODE_AUTH=true',
        '',
      ].join('\n'),
    );
    const { GET } = await loadRoute();
    const res = await GET(makeGetEvent());
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.networkPreset).toBeNull();
  });

  test('T60: PUT lanExposureEnabled:true reports networkPreset "home-open" in its response and on the follow-up GET', async () => {
    process.env.OP_UI_HOST_MODE = 'host-ui';
    const { GET, PUT } = await loadRoute();
    const putRes = await PUT(makePutEvent({ projectName: 'openpalm', lanExposureEnabled: true }));
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as Record<string, unknown>;
    expect(putBody.networkPreset).toBe('home-open');

    const getRes = await GET(makeGetEvent());
    const getBody = (await getRes.json()) as Record<string, unknown>;
    expect(getBody.networkPreset).toBe('home-open');
  });
});
