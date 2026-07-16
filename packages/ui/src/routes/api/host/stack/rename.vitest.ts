/**
 * Behavior carried over from the old /admin/assistant suite (Phase 4 moved
 * the host-scoped half to /api/host/stack): stack.env writes, the #540
 * project-rename marker, and LAN-exposure toggling. Persona is no longer part
 * of this endpoint — see routes/api/assistant/persona. The Phase 4 red suite
 * (server.vitest.ts alongside) pins the capability guard + payload split.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetState, stackEnvFor } from '$lib/server/test-helpers.js';
import { GET, PUT } from './+server.js';

let rootDir = '';
let originalHome: string | undefined;

function makeGetEvent(path = '/api/host/stack', token = 'admin-token') {
  const url = new URL(`http://localhost${path}`);
  return {
    request: new Request(url, {
      method: 'GET',
      headers: {
        cookie: token ? `op_session=${token}` : '',
        'x-request-id': 'req-host-stack-get',
      },
    }),
    url,
    params: {},
  } as Parameters<typeof GET>[0];
}

function makePutEvent(body: unknown, token = 'admin-token') {
  const url = new URL('http://localhost/api/host/stack');
  return {
    request: new Request(url, {
      method: 'PUT',
      headers: {
        cookie: token ? `op_session=${token}` : '',
        'x-request-id': 'req-host-stack-put',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    url,
    params: {},
  } as Parameters<typeof PUT>[0];
}

beforeEach(() => {
  // Phase 4: /api/host endpoints are capability-guarded; run as a host mode.
  process.env.OP_ENABLE_ADMIN = '1';
  rootDir = join(tmpdir(), `openpalm-host-stack-${randomBytes(4).toString('hex')}`);
  mkdirSync(rootDir, { recursive: true });
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState('admin-token');
});

afterEach(() => {
  delete process.env.OP_ENABLE_ADMIN;
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
});

describe('GET /api/host/stack', () => {
  test('401 without auth', async () => {
    expect((await GET(makeGetEvent('/api/host/stack', ''))).status).toBe(401);
  });

  test('returns the default project name', async () => {
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.projectName).toBe('openpalm');
    expect(body.lanExposureEnabled).toBe(false);
    expect(body.stackEnvPath).toBe('knowledge/env/stack.env');
  });

  test('returns enabled LAN exposure when stack.env binds assistant to all interfaces', async () => {
    writeFileSync(stackEnvFor(rootDir), 'OP_ASSISTANT_BIND_ADDRESS=0.0.0.0\n');

    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.lanExposureEnabled).toBe(true);
  });
});

describe('PUT /api/host/stack', () => {
  test('rejects invalid project name', async () => {
    const res = await PUT(makePutEvent({ projectName: 'Open Palm', lanExposureEnabled: false }));
    expect(res.status).toBe(400);
  });

  test('rejects invalid LAN exposure toggle values', async () => {
    const res = await PUT(makePutEvent({ projectName: 'openpalm', lanExposureEnabled: 'yes' }));
    expect(res.status).toBe(400);
  });

  test('records a project rename so the next apply can tear down the old project (#540)', async () => {
    const res = await PUT(makePutEvent({ projectName: 'my-agent', lanExposureEnabled: false }));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.projectRenamed).toBe(true);

    const stateEnv = readFileSync(join(rootDir, 'state', 'stack.state.env'), 'utf-8');
    expect(stateEnv).toContain('OP_PREVIOUS_PROJECT_NAME=openpalm');
  });

  test('does not record a rename when the project name is unchanged', async () => {
    const res = await PUT(makePutEvent({ projectName: 'openpalm', lanExposureEnabled: false }));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.projectRenamed).toBe(false);
    expect(existsSync(join(rootDir, 'state', 'stack.state.env'))).toBe(false);
  });

  test('renaming back to the still-running project clears the recorded marker (#540)', async () => {
    await PUT(makePutEvent({ projectName: 'my-agent', lanExposureEnabled: false }));
    await PUT(makePutEvent({ projectName: 'openpalm', lanExposureEnabled: false }));

    const stateEnv = readFileSync(join(rootDir, 'state', 'stack.state.env'), 'utf-8');
    expect(stateEnv).toContain('OP_PREVIOUS_PROJECT_NAME=\n');
  });

  test('disables LAN exposure by restoring loopback bind address', async () => {
    writeFileSync(stackEnvFor(rootDir), 'OP_ASSISTANT_BIND_ADDRESS=0.0.0.0\n');

    const res = await PUT(makePutEvent({ projectName: 'openpalm', lanExposureEnabled: false }));
    expect(res.status).toBe(200);

    const stackEnv = readFileSync(stackEnvFor(rootDir), 'utf-8');
    expect(stackEnv).toContain('OP_ASSISTANT_BIND_ADDRESS=127.0.0.1');
  });
});
