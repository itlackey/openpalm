import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupTempDirs, resetState, trackDir } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';
import { DELETE, GET, PUT } from './+server.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-task-file-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return trackDir(dir);
}

function makeEvent(
  method: 'GET' | 'PUT' | 'DELETE',
  name: string,
  content?: string,
  token = 'admin-token',
): Parameters<typeof GET>[0] {
  const request = new Request(`http://localhost/api/host/automations/${encodeURIComponent(name)}/file`, {
    method,
    headers: {
      cookie: `op_session=${token}`,
      'content-type': 'application/json',
      'x-request-id': 'req-task-file-test',
    },
    ...(content === undefined ? {} : { body: JSON.stringify({ content }) }),
  });
  return { request, params: { name } } as unknown as Parameters<typeof GET>[0];
}

let originalHome: string | undefined;

beforeEach(() => {
  process.env.OP_ENABLE_ADMIN = '1';
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = makeTempDir();
  resetState('admin-token');
});

afterEach(() => {
  delete process.env.OP_ENABLE_ADMIN;
  process.env.OP_HOME = originalHome;
  cleanupTempDirs();
  rmSync(getState().homeDir, { recursive: true, force: true });
});

describe('/api/host/automations/:name/file', () => {
  test('requires authentication', async () => {
    const response = await GET(makeEvent('GET', 'daily.yml', undefined, 'bad-token'));
    expect(response.status).toBe(401);
  });

  test('rejects traversal and legacy task extensions', async () => {
    expect((await PUT(makeEvent('PUT', '../escape.yml', 'version: 2'))).status).toBe(400);
    expect((await PUT(makeEvent('PUT', 'legacy.yaml', 'version: 2'))).status).toBe(400);
    expect((await PUT(makeEvent('PUT', 'legacy.md', 'version: 2'))).status).toBe(400);
  });

  test('rejects malformed or non-mapping YAML', async () => {
    expect((await PUT(makeEvent('PUT', 'daily.yml', 'not: [yaml'))).status).toBe(400);
    expect((await PUT(makeEvent('PUT', 'daily.yml', '- not\n- a\n- mapping\n'))).status).toBe(400);
    expect(existsSync(join(getState().stashDir, 'tasks', 'daily.yml'))).toBe(false);
  });

  test('leaves task-schema validation to AKM', async () => {
    const content = 'version: 1\nenabled: not-a-boolean\nunknown: preserved\n';
    expect((await PUT(makeEvent('PUT', 'daily.yml', content))).status).toBe(200);
    const response = await GET(makeEvent('GET', 'daily.yml'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ content });
  });

  test('preserves a valid raw v2 document byte-for-byte', async () => {
    const content = `# operator comment
version: 2
schedule: "0 9 * * *"
tags: [maintenance]
timeoutMs: 30000
command: ["sh", "-c", "printf '%s\\n' hello"]
`;
    const put = await PUT(makeEvent('PUT', 'daily.yml', content));
    expect(put.status).toBe(200);

    const get = await GET(makeEvent('GET', 'daily.yml'));
    expect(get.status).toBe(200);
    expect((await get.json()) as { content: string }).toMatchObject({ content });

    const remove = await DELETE(makeEvent('DELETE', 'daily.yml'));
    expect(remove.status).toBe(200);
    expect(existsSync(join(getState().stashDir, 'tasks', 'daily.yml'))).toBe(false);
  });
});
