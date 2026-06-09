/**
 * Route-level tests for GET /admin/versions.
 *
 * Locks the contract that the desktop (Electron) version + update info are
 * surfaced to the UI. The env-var NAMES here must stay in sync with
 * buildUIServerEnv() in packages/electron/src/main.ts — a rename there would
 * silently blank the "Desktop app" row in the Updates tab, so pin them.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { resetState } from '$lib/server/test-helpers.js';
import { GET } from './+server.js';

const ELECTRON_ENV = ['OP_INSIDE_ELECTRON', 'OP_ELECTRON_VERSION', 'OP_ELECTRON_LATEST_VERSION', 'OP_ELECTRON_LATEST_URL'] as const;
const saved: Record<string, string | undefined> = {};

function makeGetEvent(token = 'admin-token'): Parameters<typeof GET>[0] {
  return {
    request: new Request('http://localhost/admin/versions', {
      method: 'GET',
      headers: { cookie: `op_session=${token}`, 'x-request-id': 'req-versions-test' },
    }),
  } as Parameters<typeof GET>[0];
}

beforeEach(() => {
  resetState('admin-token');
  for (const k of ELECTRON_ENV) { saved[k] = process.env[k]; delete process.env[k]; }
});

afterEach(() => {
  for (const k of ELECTRON_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

type VersionsBody = {
  imageTag: string;
  inElectron: boolean;
  electronVersion: string | null;
  electronLatestVersion: string | null;
  electronLatestUrl: string | null;
  electronUpdateAvailable: boolean;
};

describe('GET /admin/versions', () => {
  test('requires admin auth', async () => {
    const res = await GET(makeGetEvent('bad-token'));
    expect(res.status).toBe(401);
  });

  test('reports no Electron info outside the desktop app', async () => {
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = (await res.json()) as VersionsBody;
    expect(body.inElectron).toBe(false);
    expect(body.electronVersion).toBeNull();
    expect(body.electronUpdateAvailable).toBe(false);
  });

  test('surfaces the Electron version (up to date)', async () => {
    process.env.OP_INSIDE_ELECTRON = '1';
    process.env.OP_ELECTRON_VERSION = '0.11.2';
    const res = await GET(makeGetEvent());
    const body = (await res.json()) as VersionsBody;
    expect(body.inElectron).toBe(true);
    expect(body.electronVersion).toBe('0.11.2');
    expect(body.electronUpdateAvailable).toBe(false);
    expect(body.electronLatestVersion).toBeNull();
  });

  test('surfaces an available desktop update with its download URL', async () => {
    process.env.OP_INSIDE_ELECTRON = '1';
    process.env.OP_ELECTRON_VERSION = '0.11.2';
    process.env.OP_ELECTRON_LATEST_VERSION = '0.11.3';
    process.env.OP_ELECTRON_LATEST_URL = 'https://github.com/itlackey/openpalm/releases/tag/v0.11.3';
    const res = await GET(makeGetEvent());
    const body = (await res.json()) as VersionsBody;
    expect(body.electronUpdateAvailable).toBe(true);
    expect(body.electronLatestVersion).toBe('0.11.3');
    expect(body.electronLatestUrl).toContain('releases/tag/v0.11.3');
  });
});
