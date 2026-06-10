import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';

type RollbackScenario = {
  mode: 'performUpgrade' | 'applyTagChange';
  composePullOk?: boolean;
  composePullStderr?: string;
  composeUpOk?: boolean;
  composeUpStderr?: string;
  refreshCoreAssetsError?: string;
  expectedError: string;
};

const lifecycleUrl = new URL('./lifecycle.ts', import.meta.url).href;
const moduleUrls = {
  composeArgs: new URL('./compose-args.js', import.meta.url).href,
  docker: new URL('./docker.js', import.meta.url).href,
  configPersistence: new URL('./config-persistence.js', import.meta.url).href,
  coreAssets: new URL('./core-assets.js', import.meta.url).href,
  installLock: new URL('./install-lock.js', import.meta.url).href,
  registry: new URL('./registry.js', import.meta.url).href,
};

function runRollbackScenario(scenario: RollbackScenario): { stdout: string; stderr: string; ok: boolean } {
  const tempDir = mkdtempSync(join(tmpdir(), 'openpalm-lifecycle-rollback-'));
  const scriptPath = join(tempDir, 'rollback-scenario.test.ts');
  const markerPath = join(tempDir, 'rollback-ok.marker');
  const script = `
import { describe, test, expect, mock } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const lifecycleUrl = ${JSON.stringify(lifecycleUrl)};
const scenario = ${JSON.stringify(scenario)};
const markerPath = ${JSON.stringify(markerPath)};

function dockerTagsResponse(names: string[]) {
  return new Response(
    JSON.stringify({ results: names.map((name) => ({ name })) }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function makeState() {
  const home = mkdtempSync(join(tmpdir(), 'openpalm-upgrade-rollback-'));
  mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
  mkdirSync(join(home, 'config', 'stack'), { recursive: true });
  mkdirSync(join(home, 'data'), { recursive: true });
  writeFileSync(
    join(home, 'knowledge', 'env', 'stack.env'),
    'OP_IMAGE_NAMESPACE=openpalm\\nOP_IMAGE_TAG=v0.11.5\\n',
  );
  process.env.OP_HOME = home;
  return {
    homeDir: home,
    configDir: join(home, 'config'),
    stashDir: join(home, 'knowledge'),
    workspaceDir: join(home, 'workspace'),
    dataDir: join(home, 'data'),
    stackDir: join(home, 'config', 'stack'),
    services: {},
    artifacts: { compose: '' },
    artifactMeta: [],
  };
}

mock.module(${JSON.stringify(moduleUrls.composeArgs)}, () => ({
  buildComposeOptions: () => ({ files: [], envFiles: [], profiles: [] }),
}));
mock.module(${JSON.stringify(moduleUrls.docker)}, () => ({
  checkDocker: async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
  composePreflight: async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
  composePull: async () => ({
    ok: scenario.composePullOk ?? true,
    stdout: '',
    stderr: scenario.composePullStderr ?? '',
    code: (scenario.composePullOk ?? true) ? 0 : 1,
  }),
  composeUp: async () => ({
    ok: scenario.composeUpOk ?? true,
    stdout: '',
    stderr: scenario.composeUpStderr ?? '',
    code: (scenario.composeUpOk ?? true) ? 0 : 1,
  }),
  composeConfigServices: async () => ({ ok: true, services: [] }),
  resolveComposeProjectName: () => 'openpalm',
}));
mock.module(${JSON.stringify(moduleUrls.configPersistence)}, () => ({
  resolveRuntimeFiles: () => ({ compose: '' }),
  writeRuntimeFiles: () => {},
  discoverStackOverlays: () => [],
  ensureComposeVolumeTargets: () => {},
}));
mock.module(${JSON.stringify(moduleUrls.coreAssets)}, () => ({
  refreshCoreAssets: async () => {
    if (scenario.refreshCoreAssetsError) throw new Error(scenario.refreshCoreAssetsError);
    return { backupDir: null, updated: [] };
  },
}));
mock.module(${JSON.stringify(moduleUrls.installLock)}, () => ({
  acquireInstallLock: () => ({ path: 'test-lock' }),
  releaseInstallLock: () => {},
}));
mock.module(${JSON.stringify(moduleUrls.registry)}, () => ({
  getAddonServiceNames: () => [],
  listEnabledAddonIds: () => [],
}));

describe('rollback scenario', () => {
  test('restores stack.env', async () => {
    globalThis.fetch = (async () => dockerTagsResponse(['v0.12.0', 'v0.11.5']));
    const state = makeState();
    const stackEnvPath = join(state.stashDir, 'env', 'stack.env');
    const original = readFileSync(stackEnvPath, 'utf-8');
    const lifecycle = await import(lifecycleUrl + '?scenario=' + Math.random());
      const run = scenario.mode === 'performUpgrade'
      ? lifecycle.performUpgrade(state)
      : lifecycle.applyTagChange(state, 'v0.12.0');

      await expect(run).rejects.toThrow(new RegExp(scenario.expectedError));
      expect(readFileSync(stackEnvPath, 'utf-8')).toBe(original);
      writeFileSync(markerPath, 'ok');
    });
});
`;

  try {
    writeFileSync(scriptPath, script);
    const result = spawnSync('bun', ['test', scriptPath], {
      cwd: '/work/itlackey/openpalm/packages/lib',
      encoding: 'utf-8',
    });
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      ok: existsSync(markerPath),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('stack.env rollback during upgrade failures (#476)', () => {
  test('performUpgrade restores stack.env when composePull fails', () => {
    const result = runRollbackScenario({
      mode: 'performUpgrade',
      composePullOk: false,
      composePullStderr: 'pull failed',
      expectedError: 'Failed to pull images: pull failed',
    });

    expect(result.ok, `${result.stdout}\n${result.stderr}`).toBe(true);
  });

  test('performUpgrade restores stack.env when composeUp fails after a successful pull', () => {
    const result = runRollbackScenario({
      mode: 'performUpgrade',
      composeUpOk: false,
      composeUpStderr: 'up failed',
      expectedError: 'Images pulled but failed to recreate containers: up failed',
    });

    expect(result.ok, `${result.stdout}\n${result.stderr}`).toBe(true);
  });

  test('applyTagChange restores stack.env when asset refresh fails', () => {
    const result = runRollbackScenario({
      mode: 'applyTagChange',
      refreshCoreAssetsError: 'asset refresh failed',
      expectedError: 'asset refresh failed',
    });

    expect(result.ok, `${result.stdout}\n${result.stderr}`).toBe(true);
  });
});
