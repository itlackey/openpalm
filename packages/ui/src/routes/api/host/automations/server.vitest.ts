import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getState } from '$lib/server/state.js';
import { resetState } from '$lib/server/test-helpers.js';
import { GET } from './+server.js';

let originalHome: string | undefined;
let homeDir = '';

beforeEach(() => {
  process.env.OP_ENABLE_ADMIN = '1';
  originalHome = process.env.OP_HOME;
  homeDir = mkdtempSync(join(tmpdir(), 'openpalm-automations-list-'));
  process.env.OP_HOME = homeDir;
  resetState('admin-token');
});

afterEach(() => {
  delete process.env.OP_ENABLE_ADMIN;
  process.env.OP_HOME = originalHome;
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
});

function event(): Parameters<typeof GET>[0] {
  return {
    request: new Request('http://localhost/api/host/automations', {
      headers: { cookie: 'op_session=admin-token' },
    }),
  } as Parameters<typeof GET>[0];
}

describe('GET /api/host/automations', () => {
  test('keeps a schema-invalid raw task visible for repair', async () => {
    const tasksDir = join(getState().stashDir, 'tasks');
    mkdirSync(tasksDir, { recursive: true });
    writeFileSync(join(tasksDir, 'broken.yml'), 'version: 2\nenabled: true\n');

    const response = await GET(event());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      automations: [{
        name: 'broken',
        fileName: 'broken.yml',
        valid: false,
        enabled: false,
      }],
    });
  });
});
