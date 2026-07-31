import { afterEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realLib from '../../../lib/src/index.ts';
import * as realCliState from '../lib/cli-state.ts';
import * as realCliCompose from '../lib/cli-compose.ts';

const moduleUrls = {
  cliState: new URL('../lib/cli-state.ts', import.meta.url).href,
  cliCompose: new URL('../lib/cli-compose.ts', import.meta.url).href,
};
const startModuleUrl = new URL('./start.ts', import.meta.url).href;

afterEach(() => {
  mock.restore();
  mock.module('@openpalm/lib', () => ({ ...realLib }));
  mock.module(moduleUrls.cliState, () => ({ ...realCliState }));
  mock.module(moduleUrls.cliCompose, () => ({ ...realCliCompose }));
});

describe('runStartAction', () => {
  test('propagates a host-swap block from the shared lib reconcile', async () => {
    // The CLI is a thin caller: all swap detection/blocking lives in
    // reconcileHostOwnership. HostSwapBlockedError.message contains the
    // actionable "--adopt-host" hint the command wrapper prints.
    mock.module('@openpalm/lib', () => ({
      ...realLib,
      reconcileHostOwnership: async () => {
        throw new realLib.HostSwapBlockedError(
          { kind: 'linux', host: 'host-a', uid: 501, gid: 501 },
          { kind: 'linux', host: 'host-b', uid: 1000, gid: 1000 },
        );
      },
      buildManagedServices: async () => ['assistant'],
      acquireInstallLock: () => ({ path: '/tmp/op-home/data/.install.lock' }),
      releaseInstallLock: () => {},
    }));
    mock.module(moduleUrls.cliState, () => ({ ensureValidState: () => ({ homeDir: '/tmp/op-home', workspaceDir: '/tmp/op-home/workspace', dataDir: '/tmp/op-home/data', stackDir: '/tmp/op-home/system/stack' }) }));
    mock.module(moduleUrls.cliCompose, () => ({ runComposeWithPreflight: async () => {} }));

    const { runStartAction } = await import(`${startModuleUrl}?t=${Math.random()}`);
    await expect(runStartAction([])).rejects.toThrow(/Host swap detected/);
  });

  test('reconciles ownership for all managed services, then composes up', async () => {
    let reconcileArgs: { adoptHost?: boolean; services?: string[] } | null = null;
    const composedArgs: string[][] = [];
    mock.module('@openpalm/lib', () => ({
      ...realLib,
      reconcileHostOwnership: async (_state: unknown, opts: { adoptHost?: boolean; services?: string[] }) => {
        reconcileArgs = opts;
      },
      buildManagedServices: async () => ['assistant', 'guardian'],
      acquireInstallLock: () => ({ path: '/tmp/op-home/data/.install.lock' }),
      releaseInstallLock: () => {},
    }));
    mock.module(moduleUrls.cliState, () => ({ ensureValidState: () => ({ homeDir: '/tmp/op-home', workspaceDir: '/tmp/op-home/workspace', dataDir: '/tmp/op-home/data', stackDir: '/tmp/op-home/system/stack' }) }));
    mock.module(moduleUrls.cliCompose, () => ({ runComposeWithPreflight: async (_state: unknown, args: string[]) => { composedArgs.push(args); } }));

    const { runStartAction } = await import(`${startModuleUrl}?t=${Math.random()}`);
    await runStartAction([]);

    expect(reconcileArgs).toEqual({ adoptHost: false, services: ['assistant', 'guardian'] });
    expect(composedArgs).toEqual([['up', '-d', 'assistant', 'guardian']]);
  });

  test('passes adoptHost through and reconciles the explicit service set', async () => {
    let reconcileArgs: { adoptHost?: boolean; services?: string[] } | null = null;
    const composedArgs: string[][] = [];
    mock.module('@openpalm/lib', () => ({
      ...realLib,
      reconcileHostOwnership: async (_state: unknown, opts: { adoptHost?: boolean; services?: string[] }) => {
        reconcileArgs = opts;
      },
      buildManagedServices: async () => ['assistant'],
      acquireInstallLock: () => ({ path: '/tmp/op-home/data/.install.lock' }),
      releaseInstallLock: () => {},
    }));
    mock.module(moduleUrls.cliState, () => ({ ensureValidState: () => ({ homeDir: '/tmp/op-home', workspaceDir: '/tmp/op-home/workspace', dataDir: '/tmp/op-home/data', stackDir: '/tmp/op-home/system/stack' }) }));
    mock.module(moduleUrls.cliCompose, () => ({ runComposeWithPreflight: async (_state: unknown, args: string[]) => { composedArgs.push(args); } }));

    const { runStartAction } = await import(`${startModuleUrl}?t=${Math.random()}`);
    await runStartAction(['guardian'], { adoptHost: true });

    // Explicit services are passed straight through (no buildManagedServices).
    expect(reconcileArgs).toEqual({ adoptHost: true, services: ['guardian'] });
    expect(composedArgs).toEqual([['up', '-d', 'guardian']]);
  });

  test('refuses with install_in_progress when the install lock is held (no compose up)', async () => {
    let composed = false;
    mock.module('@openpalm/lib', () => ({
      ...realLib,
      reconcileHostOwnership: async () => {},
      buildManagedServices: async () => ['assistant'],
      // Lock held by a concurrent install/update — acquire returns null.
      acquireInstallLock: () => null,
      releaseInstallLock: () => {},
    }));
    mock.module(moduleUrls.cliState, () => ({ ensureValidState: () => ({ homeDir: '/tmp/op-home', workspaceDir: '/tmp/op-home/workspace', dataDir: '/tmp/op-home/data', stackDir: '/tmp/op-home/system/stack' }) }));
    mock.module(moduleUrls.cliCompose, () => ({ runComposeWithPreflight: async () => { composed = true; } }));

    const { runStartAction } = await import(`${startModuleUrl}?t=${Math.random()}`);
    await expect(runStartAction([])).rejects.toThrow(/install_in_progress/);
    // The compose recreate must NOT run while another install holds the lock.
    expect(composed).toBe(false);
  });
});

// C2: `install --file --no-start` runs performSetup (which mints the guardian
// tokens classifyLocalInstall's fallback reads as "installed") but never
// deploys, so the deploy-journal's markSetupComplete callback never fires.
// `openpalm start` bringing up that SAME configured home must fire the
// equivalent stamp itself, or the home is `setup_incomplete` forever.
describe('runStartAction — marks setup complete on a healthy, previously-configured start (C2)', () => {
  function seedConfiguredButUndeployedHome(): { homeDir: string; stackDir: string } {
    const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-start-stamp-'));
    const stackDir = join(homeDir, 'system', 'stack');
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(join(stackDir, 'core.compose.yml'), 'services: {}\n');
    // Guardian tokens are exactly what performSetup leaves behind without a
    // deploy ever running — classifyLocalInstall's documented fallback reads
    // compose + both tokens as "installed" despite OP_SETUP_COMPLETE being
    // unset.
    const secretsDir = join(homeDir, 'knowledge', 'secrets');
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(secretsDir, 'op_guardian_admin_token'), 'admin\n');
    writeFileSync(join(secretsDir, 'op_guardian_mcp_token'), 'mcp\n');
    return { homeDir, stackDir };
  }

  test('stamps OP_SETUP_COMPLETE=true once the started core services report healthy', async () => {
    const { homeDir, stackDir } = seedConfiguredButUndeployedHome();
    mock.module('@openpalm/lib', () => ({
      ...realLib,
      reconcileHostOwnership: async () => {},
      buildManagedServices: async () => ['assistant'],
      acquireInstallLock: () => ({ path: join(homeDir, 'data', '.install.lock') }),
      releaseInstallLock: () => {},
      composePs: async () => ({
        ok: true,
        stdout: JSON.stringify({ Service: 'assistant', State: 'running', Health: 'healthy' }),
        stderr: '',
        code: 0,
      }),
    }));
    mock.module(moduleUrls.cliState, () => ({
      ensureValidState: () => ({
        homeDir,
        workspaceDir: join(homeDir, 'workspace'),
        dataDir: join(homeDir, 'data'),
        stackDir,
      }),
    }));
    mock.module(moduleUrls.cliCompose, () => ({ runComposeWithPreflight: async () => {} }));

    try {
      const { runStartAction } = await import(`${startModuleUrl}?t=${Math.random()}`);
      await runStartAction([]);

      const stackEnv = readFileSync(join(homeDir, 'state', 'stack.env'), 'utf-8');
      expect(stackEnv).toContain('OP_SETUP_COMPLETE=true');
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test('does not stamp completion when the started service is not actually healthy', async () => {
    const { homeDir, stackDir } = seedConfiguredButUndeployedHome();
    mock.module('@openpalm/lib', () => ({
      ...realLib,
      reconcileHostOwnership: async () => {},
      buildManagedServices: async () => ['assistant'],
      acquireInstallLock: () => ({ path: join(homeDir, 'data', '.install.lock') }),
      releaseInstallLock: () => {},
      composePs: async () => ({
        ok: true,
        stdout: JSON.stringify({ Service: 'assistant', State: 'exited', Health: '' }),
        stderr: '',
        code: 0,
      }),
    }));
    mock.module(moduleUrls.cliState, () => ({
      ensureValidState: () => ({
        homeDir,
        workspaceDir: join(homeDir, 'workspace'),
        dataDir: join(homeDir, 'data'),
        stackDir,
      }),
    }));
    mock.module(moduleUrls.cliCompose, () => ({ runComposeWithPreflight: async () => {} }));

    try {
      const { runStartAction } = await import(`${startModuleUrl}?t=${Math.random()}`);
      await runStartAction([]);

      expect(existsSync(join(homeDir, 'state', 'stack.env'))).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  test('never touches a genuinely never-configured home (no compose, no guardian tokens)', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-start-unconfigured-'));
    const stackDir = join(homeDir, 'system', 'stack');
    mock.module('@openpalm/lib', () => ({
      ...realLib,
      reconcileHostOwnership: async () => {},
      buildManagedServices: async () => ['assistant'],
      acquireInstallLock: () => ({ path: join(homeDir, 'data', '.install.lock') }),
      releaseInstallLock: () => {},
      composePs: async () => {
        throw new Error('composePs must not be called for a not_installed home');
      },
    }));
    mock.module(moduleUrls.cliState, () => ({
      ensureValidState: () => ({
        homeDir,
        workspaceDir: join(homeDir, 'workspace'),
        dataDir: join(homeDir, 'data'),
        stackDir,
      }),
    }));
    mock.module(moduleUrls.cliCompose, () => ({ runComposeWithPreflight: async () => {} }));

    try {
      const { runStartAction } = await import(`${startModuleUrl}?t=${Math.random()}`);
      await runStartAction([]);

      expect(existsSync(join(homeDir, 'state', 'stack.env'))).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
