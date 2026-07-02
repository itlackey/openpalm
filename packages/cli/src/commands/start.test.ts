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
  test('blocks cross-host swap without adoptHost', async () => {
    mock.module('@openpalm/lib', () => ({
      ...realLib,
      detectHostIdentity: () => ({ kind: 'linux', host: 'host-b', uid: 1000, gid: 1000 }),
      hostIdentityFile: () => '/tmp/op-home/state/host-identity.json',
      readHostIdentity: () => ({ kind: 'linux', host: 'host-a', uid: 1000, gid: 1000 }),
      buildReconcileDecision: () => ({ decision: 'swap', currentIdentity: { kind: 'linux', host: 'host-b', uid: 1000, gid: 1000 }, previousIdentity: { kind: 'linux', host: 'host-a', uid: 1000, gid: 1000 }, canaries: [] }),
      buildManagedServices: async () => ['assistant'],
    }));
    mock.module(moduleUrls.cliState, () => ({ ensureValidState: () => ({ homeDir: '/tmp/op-home', workspaceDir: '/tmp/op-home/workspace' }) }));
    mock.module(moduleUrls.cliCompose, () => ({ runComposeWithPreflight: async () => {} }));

    const { runStartAction } = await import(startModuleUrl + `?t=${Math.random()}`);
    await expect(runStartAction([])).rejects.toThrow(/Host swap detected/);
  });

  test('repairs and records identity on adoptHost', async () => {
    let repaired = false;
    let wrote = false;
    mock.module('@openpalm/lib', () => ({
      ...realLib,
      detectHostIdentity: () => ({ kind: 'linux', host: 'host-b', uid: 1000, gid: 1000 }),
      hostIdentityFile: () => '/tmp/op-home/state/host-identity.json',
      readHostIdentity: () => ({ kind: 'linux', host: 'host-a', uid: 1000, gid: 1000 }),
      buildReconcileDecision: () => ({ decision: 'swap', currentIdentity: { kind: 'linux', host: 'host-b', uid: 1000, gid: 1000 }, previousIdentity: { kind: 'linux', host: 'host-a', uid: 1000, gid: 1000 }, canaries: [] }),
      ownershipRepairPaths: () => ['/tmp/op-home/knowledge'],
      repairRootOwnedBindMounts: async () => {
        repaired = true;
      },
      writeHostIdentity: () => {
        wrote = true;
      },
      buildManagedServices: async () => ['assistant'],
    }));
    mock.module(moduleUrls.cliState, () => ({ ensureValidState: () => ({ homeDir: '/tmp/op-home', workspaceDir: '/tmp/op-home/workspace' }) }));
    mock.module(moduleUrls.cliCompose, () => ({ runComposeWithPreflight: async () => {} }));

    const { runStartAction } = await import(startModuleUrl + `?t=${Math.random()}`);
    await runStartAction([], { adoptHost: true });
    expect(repaired).toBe(true);
    expect(wrote).toBe(true);
  });

  test('repairs guardian-cache named volume before starting guardian', async () => {
    let volumeName = '';

    mock.module('@openpalm/lib', () => ({
      ...realLib,
      detectHostIdentity: () => ({ kind: 'linux', host: 'host-a', uid: 1000, gid: 1000 }),
      hostIdentityFile: () => '/tmp/op-home/state/host-identity.json',
      readHostIdentity: () => null,
      buildReconcileDecision: () => ({ decision: 'match', currentIdentity: { kind: 'linux', host: 'host-a', uid: 1000, gid: 1000 }, previousIdentity: null, canaries: [] }),
      readStackEnv: () => ({ OP_PROJECT_NAME: 'custom-project' }),
      resolveComposeProjectName: () => 'custom-project',
      resolveOperatorIds: () => ({ uid: 1000, gid: 1000 }),
      repairNamedVolumeOwnership: async (name: string) => {
        volumeName = name;
      },
      buildManagedServices: async () => ['assistant', 'guardian'],
      writeHostIdentity: () => {},
    }));
    mock.module(moduleUrls.cliState, () => ({ ensureValidState: () => ({ homeDir: '/tmp/op-home', workspaceDir: '/tmp/op-home/workspace' }) }));
    mock.module(moduleUrls.cliCompose, () => ({ runComposeWithPreflight: async () => {} }));

    const { runStartAction } = await import(startModuleUrl + `?t=${Math.random()}`);
    await runStartAction([]);

    expect(volumeName).toBe('custom-project_guardian-cache');
  });
});
