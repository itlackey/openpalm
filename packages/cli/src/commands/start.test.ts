import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as realLib from '@openpalm/lib';
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
    mock.module(moduleUrls.cliState, () => ({ ensureValidState: () => ({ homeDir: '/tmp/op-home', workspaceDir: '/tmp/op-home/workspace', dataDir: '/tmp/op-home/data' }) }));
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
    mock.module(moduleUrls.cliState, () => ({ ensureValidState: () => ({ homeDir: '/tmp/op-home', workspaceDir: '/tmp/op-home/workspace', dataDir: '/tmp/op-home/data' }) }));
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
    mock.module(moduleUrls.cliState, () => ({ ensureValidState: () => ({ homeDir: '/tmp/op-home', workspaceDir: '/tmp/op-home/workspace', dataDir: '/tmp/op-home/data' }) }));
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
    mock.module(moduleUrls.cliState, () => ({ ensureValidState: () => ({ homeDir: '/tmp/op-home', workspaceDir: '/tmp/op-home/workspace', dataDir: '/tmp/op-home/data' }) }));
    mock.module(moduleUrls.cliCompose, () => ({ runComposeWithPreflight: async () => { composed = true; } }));

    const { runStartAction } = await import(`${startModuleUrl}?t=${Math.random()}`);
    await expect(runStartAction([])).rejects.toThrow(/install_in_progress/);
    // The compose recreate must NOT run while another install holds the lock.
    expect(composed).toBe(false);
  });
});
