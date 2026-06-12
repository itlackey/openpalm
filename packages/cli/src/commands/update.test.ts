import { afterEach, describe, expect, mock, test } from 'bun:test';

const moduleUrls = {
  cliState: new URL('../lib/cli-state.ts', import.meta.url).href,
};
const updateModuleUrl = new URL('./update.ts', import.meta.url).href;

afterEach(() => {
  mock.restore();
});

describe('runUpgradeAction', () => {
  test('passes performUpgrade.imageTag to the UI updater for prerelease channel selection', async () => {
    let currentVersionArg: string | null = null;

    mock.module('@openpalm/lib', () => ({
      ensureMigrated: () => ({ migrated: false, from: 1, to: 1, applied: [], backupDir: null, notes: [], releaseFrom: null, releaseTo: '', releaseApplied: [] }),
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
      MigrationError: class MigrationError extends Error {},
    }));
    mock.module(moduleUrls.cliState, () => ({
      ensureValidState: () => ({ dataDir: '/tmp/openpalm-data' }),
    }));

    const { runUpgradeAction } = await import(updateModuleUrl + `?t=${Math.random()}`);
    await runUpgradeAction();

    expect(currentVersionArg).toBe('v0.12.0-rc.1');
  });
});
