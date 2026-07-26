import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as realLib from '../../../lib/src/index.ts';
import * as realCliState from '../lib/cli-state.ts';

const moduleUrls = {
  cliState: new URL('../lib/cli-state.ts', import.meta.url).href,
};
const repairOwnershipModuleUrl = new URL('./repair-ownership.ts', import.meta.url).href;

afterEach(() => {
  mock.restore();
  // mock.restore() does NOT undo mock.module() — re-point back to the real
  // modules so this file's mocks don't leak into other test files sharing
  // the same `bun test` process.
  mock.module('@openpalm/lib', () => ({ ...realLib }));
  mock.module(moduleUrls.cliState, () => ({ ...realCliState }));
});

describe('runRepairOwnershipAction', () => {
  test('reconciles ownership for the full managed service set, without starting anything', async () => {
    let reconcileArgs: { adoptHost?: boolean; services?: string[] } | null = null;
    mock.module('@openpalm/lib', () => ({
      ...realLib,
      reconcileHostOwnership: async (_state: unknown, opts: { adoptHost?: boolean; services?: string[] }) => {
        reconcileArgs = opts;
      },
      buildManagedServices: async () => ['assistant', 'guardian'],
    }));
    mock.module(moduleUrls.cliState, () => ({
      ensureValidState: () => ({ homeDir: '/tmp/op-home', workspaceDir: '/tmp/op-home/workspace' }),
    }));

    const { runRepairOwnershipAction } = await import(`${repairOwnershipModuleUrl}?t=${Math.random()}`);
    await runRepairOwnershipAction();

    expect(reconcileArgs).toEqual({ adoptHost: false, services: ['assistant', 'guardian'] });
  });

  test('passes --adopt through as adoptHost', async () => {
    let reconcileArgs: { adoptHost?: boolean; services?: string[] } | null = null;
    mock.module('@openpalm/lib', () => ({
      ...realLib,
      reconcileHostOwnership: async (_state: unknown, opts: { adoptHost?: boolean; services?: string[] }) => {
        reconcileArgs = opts;
      },
      buildManagedServices: async () => ['assistant'],
    }));
    mock.module(moduleUrls.cliState, () => ({
      ensureValidState: () => ({ homeDir: '/tmp/op-home', workspaceDir: '/tmp/op-home/workspace' }),
    }));

    const { runRepairOwnershipAction } = await import(`${repairOwnershipModuleUrl}?t=${Math.random()}`);
    await runRepairOwnershipAction({ adopt: true });

    expect(reconcileArgs).toEqual({ adoptHost: true, services: ['assistant'] });
  });

  test('propagates a host-swap block from the shared lib reconcile (no --adopt)', async () => {
    mock.module('@openpalm/lib', () => ({
      ...realLib,
      reconcileHostOwnership: async () => {
        throw new realLib.HostSwapBlockedError(
          { kind: 'linux', host: 'host-a', uid: 501, gid: 501 },
          { kind: 'linux', host: 'host-b', uid: 1000, gid: 1000 },
        );
      },
      buildManagedServices: async () => ['assistant'],
    }));
    mock.module(moduleUrls.cliState, () => ({
      ensureValidState: () => ({ homeDir: '/tmp/op-home', workspaceDir: '/tmp/op-home/workspace' }),
    }));

    const { runRepairOwnershipAction } = await import(`${repairOwnershipModuleUrl}?t=${Math.random()}`);
    await expect(runRepairOwnershipAction()).rejects.toThrow(/Host swap detected/);
  });

  test('command definition wires the --adopt flag through to the action', async () => {
    let reconcileArgs: { adoptHost?: boolean; services?: string[] } | null = null;
    mock.module('@openpalm/lib', () => ({
      ...realLib,
      reconcileHostOwnership: async (_state: unknown, opts: { adoptHost?: boolean; services?: string[] }) => {
        reconcileArgs = opts;
      },
      buildManagedServices: async () => ['assistant'],
    }));
    mock.module(moduleUrls.cliState, () => ({
      ensureValidState: () => ({ homeDir: '/tmp/op-home', workspaceDir: '/tmp/op-home/workspace' }),
    }));

    const mod = await import(`${repairOwnershipModuleUrl}?t=${Math.random()}`);
    await mod.default.run({ args: { adopt: true } } as never);

    expect(reconcileArgs).toEqual({ adoptHost: true, services: ['assistant'] });
  });
});
