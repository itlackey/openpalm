import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetState, stackEnvFor } from '$lib/server/test-helpers.js';
import { GET, PUT } from './+server.js';

let rootDir = '';
let originalHome: string | undefined;

function makeGetEvent(path = '/admin/assistant', token = 'admin-token') {
  const url = new URL(`http://localhost${path}`);
  return {
    request: new Request(url, {
      method: 'GET',
      headers: {
        cookie: token ? `op_session=${token}` : '',
        'x-request-id': 'req-assistant-get',
      },
    }),
    url,
    params: {},
  } as Parameters<typeof GET>[0];
}

function makePutEvent(body: unknown, token = 'admin-token') {
  const url = new URL('http://localhost/admin/assistant');
  return {
    request: new Request(url, {
      method: 'PUT',
      headers: {
        cookie: token ? `op_session=${token}` : '',
        'x-request-id': 'req-assistant-put',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    url,
    params: {},
  } as Parameters<typeof PUT>[0];
}

beforeEach(() => {
  rootDir = join(tmpdir(), `openpalm-assistant-${randomBytes(4).toString('hex')}`);
  mkdirSync(rootDir, { recursive: true });
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = rootDir;
  resetState('admin-token');
});

afterEach(() => {
  process.env.OP_HOME = originalHome;
  rmSync(rootDir, { recursive: true, force: true });
});

describe('GET /admin/assistant', () => {
  test('401 without auth', async () => {
    expect((await GET(makeGetEvent('/admin/assistant', ''))).status).toBe(401);
  });

  test('returns default project name and persona content', async () => {
    const personaDir = join(rootDir, 'config', 'assistant');
    mkdirSync(personaDir, { recursive: true });
    const personaPath = join(personaDir, 'persona.md');
    const content = '# Persona\n';
    writeFileSync(personaPath, content);

    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, string>;
    expect(body.projectName).toBe('openpalm');
    expect(body.lanExposureEnabled).toBe(false);
    expect(body.personaContent).toBe(content);
    expect(body.personaPath).toBe('config/assistant/persona.md');
  });

  test('returns enabled LAN exposure when stack.env binds assistant to all interfaces', async () => {
    writeFileSync(stackEnvFor(rootDir), 'OP_ASSISTANT_BIND_ADDRESS=0.0.0.0\n');

    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;
    expect(body.lanExposureEnabled).toBe(true);
  });
});

describe('PUT /admin/assistant', () => {
  test('rejects invalid project name', async () => {
    const res = await PUT(makePutEvent({ projectName: 'Open Palm', lanExposureEnabled: false, personaContent: 'x' }));
    expect(res.status).toBe(400);
  });

  test('rejects invalid LAN exposure toggle values', async () => {
    const res = await PUT(makePutEvent({ projectName: 'openpalm', lanExposureEnabled: 'yes', personaContent: 'x' }));
    expect(res.status).toBe(400);
  });

  test('writes project name to stack.env and persona to assistant config', async () => {
    const res = await PUT(makePutEvent({ projectName: 'openpalm-dev', lanExposureEnabled: true, personaContent: '# Updated persona' }));
    expect(res.status).toBe(200);

    const stackEnv = readFileSync(stackEnvFor(rootDir), 'utf-8');
    expect(stackEnv).toContain('OP_PROJECT_NAME=openpalm-dev');
    expect(stackEnv).toContain('OP_ASSISTANT_BIND_ADDRESS=0.0.0.0');

    const personaPath = join(rootDir, 'config', 'assistant', 'persona.md');
    expect(readFileSync(personaPath, 'utf-8')).toBe('# Updated persona\n');
  });

  test('records a project rename so the next apply can tear down the old project (#540)', async () => {
    const res = await PUT(makePutEvent({ projectName: 'my-agent', lanExposureEnabled: false, personaContent: '# P' }));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.projectRenamed).toBe(true);

    const stateEnv = readFileSync(join(rootDir, 'state', 'stack.state.env'), 'utf-8');
    expect(stateEnv).toContain('OP_PREVIOUS_PROJECT_NAME=openpalm');
  });

  test('does not record a rename when the project name is unchanged', async () => {
    const res = await PUT(makePutEvent({ projectName: 'openpalm', lanExposureEnabled: false, personaContent: '# P' }));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.projectRenamed).toBe(false);
    expect(existsSync(join(rootDir, 'state', 'stack.state.env'))).toBe(false);
  });

  test('renaming back to the still-running project clears the recorded marker (#540)', async () => {
    await PUT(makePutEvent({ projectName: 'my-agent', lanExposureEnabled: false, personaContent: '# P' }));
    await PUT(makePutEvent({ projectName: 'openpalm', lanExposureEnabled: false, personaContent: '# P' }));

    const stateEnv = readFileSync(join(rootDir, 'state', 'stack.state.env'), 'utf-8');
    expect(stateEnv).toContain('OP_PREVIOUS_PROJECT_NAME=\n');
  });

  test('disables LAN exposure by restoring loopback bind address', async () => {
    writeFileSync(stackEnvFor(rootDir), 'OP_ASSISTANT_BIND_ADDRESS=0.0.0.0\n');

    const res = await PUT(makePutEvent({ projectName: 'openpalm', lanExposureEnabled: false, personaContent: '# Persona' }));
    expect(res.status).toBe(200);

    const stackEnv = readFileSync(stackEnvFor(rootDir), 'utf-8');
    expect(stackEnv).toContain('OP_ASSISTANT_BIND_ADDRESS=127.0.0.1');
  });
});
