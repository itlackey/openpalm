import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as realLib from '@openpalm/lib';
import * as realCliState from '../lib/cli-state.ts';

const moduleUrls = {
  cliState: new URL('../lib/cli-state.ts', import.meta.url).href,
};
const updateModuleUrl = new URL('./update.ts', import.meta.url).href;

afterEach(() => {
  mock.restore();
  // mock.restore() does NOT undo mock.module(), so these mocks would otherwise leak
  // into every other test file in the shared `bun test` process (other CLI tests get a
  // partial @openpalm/lib → undefined fns → flaky rejection). Re-point to the real modules.
  mock.module('@openpalm/lib', () => ({ ...realLib }));
  mock.module(moduleUrls.cliState, () => ({ ...realCliState }));
});

describe('runUpgradeAction', () => {
  test('passes performUpgrade.imageTag to the UI updater for prerelease channel selection', async () => {
    let currentVersionArg: string | null = null;

    mock.module('@openpalm/lib', () => ({
      performUpgrade: async () => ({
        imageTag: 'v0.12.0-rc.1',
        namespace: 'openpalm',
        backupDir: null,
        assetsUpdated: [],
        restarted: [],
      }),
      checkAndUpdateUiBuild: async (currentVersion: string) => {
        currentVersionArg = currentVersion;
        return { updated: false, latestVersion: '0.12.0-rc.3' };
      },
      checkAndUpdateClientBuild: async () => ({ updated: false, latestVersion: '0.12.0-rc.3' }),
    }));
    mock.module(moduleUrls.cliState, () => ({
      ensureValidState: () => ({ dataDir: '/tmp/openpalm-data' }),
    }));

    const { runUpgradeAction } = await import(`${updateModuleUrl}?t=${Math.random()}`);
    await runUpgradeAction();

    expect(currentVersionArg).toBe('v0.12.0-rc.1');
  });

  // C3: `openpalm update` previously never refreshed the client artifact —
  // checkAndUpdateClientBuild was dead code, only ever called lazily at
  // `openpalm ui serve` time. It must now run on every `openpalm update`,
  // passed the SAME reference version as the UI build check.
  test('also refreshes the client app build (C3) — checkAndUpdateClientBuild was previously never called by update', async () => {
    let clientVersionArg: string | null = null;

    mock.module('@openpalm/lib', () => ({
      performUpgrade: async () => ({
        imageTag: 'v0.12.5',
        namespace: 'openpalm',
        backupDir: null,
        assetsUpdated: [],
        restarted: [],
      }),
      checkAndUpdateUiBuild: async () => ({ updated: false, latestVersion: '0.12.5' }),
      checkAndUpdateClientBuild: async (currentVersion: string) => {
        clientVersionArg = currentVersion;
        return { updated: true, latestVersion: '0.12.6' };
      },
    }));
    mock.module(moduleUrls.cliState, () => ({
      ensureValidState: () => ({ dataDir: '/tmp/openpalm-data' }),
    }));

    const { runUpgradeAction } = await import(`${updateModuleUrl}?t=${Math.random()}`);
    await runUpgradeAction();

    expect(clientVersionArg).toBe('v0.12.5');
  });

  // #494: `openpalm update` stays on stable by default; `--pre` opts into rc/beta.
  test('threads allowPrerelease into performUpgrade (default false, --pre true)', async () => {
    const calls: Array<boolean | undefined> = [];

    mock.module('@openpalm/lib', () => ({
      performUpgrade: async (_state: unknown, opts?: { allowPrerelease?: boolean }) => {
        calls.push(opts?.allowPrerelease);
        return { imageTag: 'v0.12.0', namespace: 'openpalm', backupDir: null, assetsUpdated: [], restarted: [] };
      },
      checkAndUpdateUiBuild: async () => ({ updated: false, latestVersion: '0.12.0' }),
      checkAndUpdateClientBuild: async () => ({ updated: false, latestVersion: '0.12.0' }),
    }));
    mock.module(moduleUrls.cliState, () => ({
      ensureValidState: () => ({ dataDir: '/tmp/openpalm-data' }),
    }));

    const { runUpgradeAction } = await import(`${updateModuleUrl}?t=${Math.random()}`);

    await runUpgradeAction();                       // default: stable only
    await runUpgradeAction({ allowPrerelease: true }); // --pre

    expect(calls).toEqual([undefined, true]);
  });
});
