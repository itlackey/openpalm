import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resetState, trackDir, cleanupTempDirs } from '$lib/server/test-helpers.js';
import { getState } from '$lib/server/state.js';
import { GET } from './+server.js';
import { POST as installPost } from './install/+server.js';
import { POST as uninstallPost } from './uninstall/+server.js';
import { POST as refreshPost } from './refresh/+server.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `openpalm-catalog-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return trackDir(dir);
}

function makeGetEvent(token = 'admin-token'): Parameters<typeof GET>[0] {
  return {
    request: new Request('http://localhost/admin/automations/catalog', {
      headers: {
        'x-admin-token': token,
        'x-request-id': 'req-catalog',
      },
    }),
  } as Parameters<typeof GET>[0];
}

function makeInstallEvent(body: Record<string, unknown>, token = 'admin-token'): Parameters<typeof installPost>[0] {
  return {
    request: new Request('http://localhost/admin/automations/catalog/install', {
      method: 'POST',
      headers: {
        'x-admin-token': token,
        'x-request-id': 'req-catalog-install',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof installPost>[0];
}

function makeUninstallEvent(body: Record<string, unknown>, token = 'admin-token'): Parameters<typeof uninstallPost>[0] {
  return {
    request: new Request('http://localhost/admin/automations/catalog/uninstall', {
      method: 'POST',
      headers: {
        'x-admin-token': token,
        'x-request-id': 'req-catalog-uninstall',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  } as Parameters<typeof uninstallPost>[0];
}

function makeRefreshEvent(token = 'admin-token'): Parameters<typeof refreshPost>[0] {
  return {
    request: new Request('http://localhost/admin/automations/catalog/refresh', {
      method: 'POST',
      headers: {
        'x-admin-token': token,
        'x-request-id': 'req-catalog-refresh',
      },
    }),
  } as Parameters<typeof refreshPost>[0];
}

function seedRegistryAutomation(homeDir: string, name: string): void {
  const dir = join(homeDir, 'registry', 'automations');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yml`), `description: ${name} automation\nschedule: daily\naction:\n  type: http\n  url: http://localhost\n`);
}

let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.OP_HOME;
  process.env.OP_HOME = makeTempDir();
  resetState('admin-token');

  // Seed core.compose.yml — needed by resolveRuntimeFiles() in install/uninstall routes
  const state = getState();
  mkdirSync(join(state.homeDir, 'stack'), { recursive: true });
  writeFileSync(join(state.homeDir, 'stack', 'core.compose.yml'), 'services: {}\n');
});

afterEach(() => {
  process.env.OP_HOME = originalHome;
  cleanupTempDirs();
  rmSync(getState().homeDir, { recursive: true, force: true });
});

describe('GET /admin/automations/catalog', () => {
  test('requires auth', async () => {
    const res = await GET(makeGetEvent('bad-token'));
    expect(res.status).toBe(401);
  });

  test('returns empty list when no automations in registry', async () => {
    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);
    const body = await res.json() as { automations: unknown[]; source: string };
    expect(body.automations).toEqual([]);
    expect(body.source).toBe('registry');
  });

  test('lists available automations with installed status', async () => {
    const state = getState();
    seedRegistryAutomation(state.homeDir, 'health-check');
    seedRegistryAutomation(state.homeDir, 'cleanup-logs');

    // Install one
    mkdirSync(join(state.configDir, 'automations'), { recursive: true });
    writeFileSync(join(state.configDir, 'automations', 'health-check.yml'), 'description: installed\n');

    const res = await GET(makeGetEvent());
    expect(res.status).toBe(200);

    const body = await res.json() as { automations: Array<{ name: string; installed: boolean }> };
    expect(body.automations).toHaveLength(2);

    const hc = body.automations.find((a) => a.name === 'health-check');
    const cl = body.automations.find((a) => a.name === 'cleanup-logs');
    expect(hc?.installed).toBe(true);
    expect(cl?.installed).toBe(false);
  });
});

describe('POST /admin/automations/catalog/install', () => {
  test('requires admin token', async () => {
    const res = await installPost(makeInstallEvent({ name: 'health-check', type: 'automation' }, 'bad-token'));
    expect(res.status).toBe(401);
  });

  test('returns 400 when name is missing', async () => {
    const res = await installPost(makeInstallEvent({ type: 'automation' }));
    expect(res.status).toBe(400);
  });

  test('rejects channel type with guidance', async () => {
    const res = await installPost(makeInstallEvent({ name: 'chat', type: 'channel' }));
    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain('/admin/addons');
  });

  test('installs automation from registry to config/automations', async () => {
    const state = getState();
    seedRegistryAutomation(state.homeDir, 'health-check');

    const res = await installPost(makeInstallEvent({ name: 'health-check', type: 'automation' }));
    expect(res.status).toBe(200);

    const body = await res.json() as { ok: boolean; name: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe('health-check');
    expect(existsSync(join(state.configDir, 'automations', 'health-check.yml'))).toBe(true);
  });

  test('rejects duplicate install', async () => {
    const state = getState();
    seedRegistryAutomation(state.homeDir, 'health-check');

    // Install once
    await installPost(makeInstallEvent({ name: 'health-check', type: 'automation' }));

    // Try again
    const res = await installPost(makeInstallEvent({ name: 'health-check', type: 'automation' }));
    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain('already installed');
  });

  test('rejects automation not in registry', async () => {
    const res = await installPost(makeInstallEvent({ name: 'nonexistent', type: 'automation' }));
    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain('not found');
  });
});

describe('POST /admin/automations/catalog/uninstall', () => {
  test('requires admin token', async () => {
    const res = await uninstallPost(makeUninstallEvent({ name: 'health-check', type: 'automation' }, 'bad-token'));
    expect(res.status).toBe(401);
  });

  test('uninstalls installed automation', async () => {
    const state = getState();
    seedRegistryAutomation(state.homeDir, 'health-check');

    // Install first
    mkdirSync(join(state.configDir, 'automations'), { recursive: true });
    writeFileSync(join(state.configDir, 'automations', 'health-check.yml'), 'description: test\n');

    const res = await uninstallPost(makeUninstallEvent({ name: 'health-check', type: 'automation' }));
    expect(res.status).toBe(200);

    const body = await res.json() as { ok: boolean; name: string };
    expect(body.ok).toBe(true);
    expect(existsSync(join(state.configDir, 'automations', 'health-check.yml'))).toBe(false);
  });

  test('rejects uninstall of non-installed automation', async () => {
    const res = await uninstallPost(makeUninstallEvent({ name: 'not-installed', type: 'automation' }));
    expect(res.status).toBe(400);
    const body = await res.json() as { message: string };
    expect(body.message).toContain('not installed');
  });

  test('rejects channel type', async () => {
    const res = await uninstallPost(makeUninstallEvent({ name: 'chat', type: 'channel' }));
    expect(res.status).toBe(400);
  });
});

describe('POST /admin/automations/catalog/refresh', () => {
  test('requires admin token', async () => {
    const res = await refreshPost(makeRefreshEvent('bad-token'));
    expect(res.status).toBe(401);
  });

  test('returns verified catalog counts after refresh', async () => {
    const state = getState();
    const sourceRoot = join(state.homeDir, 'source');
    const addonDir = join(sourceRoot, '.openpalm', 'registry', 'addons', 'chat');
    const automationsDir = join(sourceRoot, '.openpalm', 'registry', 'automations');

    mkdirSync(addonDir, { recursive: true });
    mkdirSync(automationsDir, { recursive: true });
    writeFileSync(join(addonDir, 'compose.yml'), 'services:\n  chat:\n    image: test\n');
    writeFileSync(join(addonDir, '.env.schema'), 'CHANNEL_CHAT_SECRET=\n');
    writeFileSync(join(automationsDir, 'health-check.yml'), 'description: health\nschedule: daily\naction:\n  type: http\n  url: http://localhost\n');
    execFileSync('git', ['init', '--initial-branch=main'], { cwd: sourceRoot, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: sourceRoot, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: sourceRoot, stdio: 'pipe' });
    execFileSync('git', ['add', '.'], { cwd: sourceRoot, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'seed registry'], { cwd: sourceRoot, stdio: 'pipe' });

    const originalUrl = process.env.OP_REGISTRY_URL;
    const originalBranch = process.env.OP_REGISTRY_BRANCH;
    process.env.OP_REGISTRY_URL = sourceRoot;
    process.env.OP_REGISTRY_BRANCH = 'main';

    try {
      const res = await refreshPost(makeRefreshEvent());
      expect(res.status).toBe(200);
      const body = await res.json() as {
        ok: boolean;
        root: string;
        addonCount: number;
        automationCount: number;
      };
      expect(body.ok).toBe(true);
      expect(body.root).toBe(join(state.homeDir, 'registry'));
      expect(body.addonCount).toBe(1);
      expect(body.automationCount).toBe(1);
    } finally {
      if (originalUrl === undefined) delete process.env.OP_REGISTRY_URL;
      else process.env.OP_REGISTRY_URL = originalUrl;
      if (originalBranch === undefined) delete process.env.OP_REGISTRY_BRANCH;
      else process.env.OP_REGISTRY_BRANCH = originalBranch;
    }
  });
});
