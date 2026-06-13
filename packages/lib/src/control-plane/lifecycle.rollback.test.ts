import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

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
  registry: new URL('./addons.js', import.meta.url).href,
  rollback: new URL('./rollback.js', import.meta.url).href,
};
const rollbackHarnessDir = fileURLToPath(new URL('../../', import.meta.url));

function runRollbackScenario(scenario: RollbackScenario): { stdout: string; stderr: string; exitCode: number } {
  const tempDir = mkdtempSync(join(rollbackHarnessDir, '.tmp-openpalm-lifecycle-rollback-'));
  const scriptPath = join(tempDir, 'rollback-scenario.ts');
  const runnerPath = join(tempDir, 'run-bun.sh');
  const script = `
import { mock } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const lifecycleUrl = ${JSON.stringify(lifecycleUrl)};
const scenario = ${JSON.stringify(scenario)};

function dockerTagsResponse(names) {
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
  process.env.OP_SKIP_COMPOSE_PREFLIGHT = '1';
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

async function main() {
  try {
    globalThis.fetch = async () => dockerTagsResponse(['v0.12.0', 'v0.11.5']);
    const state = makeState();
    const stackEnvPath = join(state.stashDir, 'env', 'stack.env');
    const original = readFileSync(stackEnvPath, 'utf-8');
    const lifecycle = await import(lifecycleUrl + '?scenario=' + Math.random());
    const run = scenario.mode === 'performUpgrade'
      ? lifecycle.performUpgrade(state)
      : lifecycle.applyTagChange(state, 'v0.12.0');

    let threw = false;
    try {
      await run;
    } catch (error) {
      threw = true;
      const message = error instanceof Error ? error.message : String(error);
      if (!new RegExp(scenario.expectedError).test(message)) {
        throw new Error('Unexpected error: ' + message);
      }
    }
    if (!threw) throw new Error('Expected rollback scenario to throw.');
    if (readFileSync(stackEnvPath, 'utf-8') !== original) {
      throw new Error('stack.env was not restored after failure.');
    }
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

await main();
`;
  const runner = '#!/usr/bin/env bash\nexec bun "$1"\n';

  try {
    writeFileSync(scriptPath, script);
    writeFileSync(runnerPath, runner);
    const proc = spawnSync('bash', [runnerPath, scriptPath], {
      cwd: rollbackHarnessDir,
      encoding: 'utf8',
    });
    return {
      stdout: proc.stdout ?? '',
      stderr: proc.stderr ?? '',
      exitCode: proc.status ?? 1,
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

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test('performUpgrade restores stack.env when composeUp fails after a successful pull', () => {
    const result = runRollbackScenario({
      mode: 'performUpgrade',
      composeUpOk: false,
      composeUpStderr: 'up failed',
      expectedError: 'Images pulled but failed to recreate containers: up failed',
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test('applyTagChange restores stack.env when asset refresh fails', () => {
    const result = runRollbackScenario({
      mode: 'applyTagChange',
      refreshCoreAssetsError: 'asset refresh failed',
      expectedError: 'asset refresh failed',
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});

// ── Armed-snapshot protection (B5 step 17) ───────────────────────────────────
//
// reconcileCore guards re-snapshot with hasArmedSnapshot(): while an armed
// snapshot exists (i.e. an upgrade is in progress / has not been cleared by a
// successful rollback), a subsequent reconcileCore call MUST NOT overwrite the
// pre-upgrade snapshot with the post-write live state.  The guard lives at:
//   lifecycle.ts: if (!opts.skipSnapshot && !hasArmedSnapshot()) snapshotCurrentState(state);
//
// The test mocks the rollback module and counts snapshotCurrentState calls.
// It pre-plants the armed-snapshot marker, then runs applyUpdate (which calls
// reconcileCore without skipSnapshot), and asserts the call count is 0.
//
function runArmedSnapshotScenario(opts: { preArmed: boolean }): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const tempDir = mkdtempSync(join(rollbackHarnessDir, '.tmp-openpalm-armed-snapshot-'));
  const scriptPath = join(tempDir, 'armed-snapshot-scenario.ts');
  const runnerPath = join(tempDir, 'run-bun.sh');

  const script = `
import { mock } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const lifecycleUrl = ${JSON.stringify(lifecycleUrl)};
const preArmed = ${JSON.stringify(opts.preArmed)};

function makeState(home) {
  mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
  mkdirSync(join(home, 'config', 'stack'), { recursive: true });
  mkdirSync(join(home, 'data', 'rollback'), { recursive: true });
  writeFileSync(
    join(home, 'knowledge', 'env', 'stack.env'),
    'OP_IMAGE_NAMESPACE=openpalm\\nOP_IMAGE_TAG=v0.11.5\\n',
  );
  process.env.OP_HOME = home;
  process.env.OP_SKIP_COMPOSE_PREFLIGHT = '1';
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

// Track snapshotCurrentState calls via the mocked rollback module.
let snapshotCallCount = 0;
const rollbackUrl = ${JSON.stringify(moduleUrls.rollback)};

mock.module(rollbackUrl, () => ({
  snapshotCurrentState: () => { snapshotCallCount++; },
  hasArmedSnapshot: () => preArmed,
  clearArmedSnapshot: () => {},
  hasSnapshot: () => false,
  snapshotTimestamp: () => null,
  restoreSnapshot: () => {},
}));
mock.module(${JSON.stringify(moduleUrls.composeArgs)}, () => ({
  buildComposeOptions: () => ({ files: [], envFiles: [], profiles: [] }),
}));
mock.module(${JSON.stringify(moduleUrls.docker)}, () => ({
  checkDocker: async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
  composePreflight: async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
  composePull: async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
  composeUp: async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
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
  refreshCoreAssets: async () => ({ backupDir: null, updated: [] }),
}));
mock.module(${JSON.stringify(moduleUrls.installLock)}, () => ({
  acquireInstallLock: () => ({ path: 'test-lock' }),
  releaseInstallLock: () => {},
}));
mock.module(${JSON.stringify(moduleUrls.registry)}, () => ({
  getAddonServiceNames: () => [],
  listEnabledAddonIds: () => [],
}));

async function main() {
  try {
    const home = mkdtempSync(join(tmpdir(), 'openpalm-armed-snapshot-'));
    const state = makeState(home);
    const lifecycle = await import(lifecycleUrl + '?armed=' + Math.random());
    await lifecycle.applyUpdate(state);

    // Verify the guard behavior:
    // - preArmed=true  → hasArmedSnapshot() returned true → snapshotCurrentState must NOT be called
    // - preArmed=false → hasArmedSnapshot() returned false → snapshotCurrentState IS called
    if (preArmed && snapshotCallCount !== 0) {
      throw new Error(
        'BUG: snapshotCurrentState was called ' + snapshotCallCount + ' time(s) even though an armed snapshot was present. ' +
        'reconcileCore must skip re-snapshot while hasArmedSnapshot() is true.',
      );
    }
    if (!preArmed && snapshotCallCount === 0) {
      throw new Error(
        'BUG: snapshotCurrentState was never called when no armed snapshot was present. ' +
        'reconcileCore must snapshot before writing when no armed snapshot exists.',
      );
    }
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}

await main();
`;
  const runner = '#!/usr/bin/env bash\nexec bun "$1"\n';

  try {
    writeFileSync(scriptPath, script);
    writeFileSync(runnerPath, runner);
    const proc = spawnSync('bash', [runnerPath, scriptPath], {
      cwd: rollbackHarnessDir,
      encoding: 'utf8',
    });
    return {
      stdout: proc.stdout ?? '',
      stderr: proc.stderr ?? '',
      exitCode: proc.status ?? 1,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('armed-snapshot protection in reconcileCore (B5)', () => {
  test('reconcileCore skips snapshotCurrentState while an armed snapshot is present', () => {
    const result = runArmedSnapshotScenario({ preArmed: true });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test('reconcileCore calls snapshotCurrentState when no armed snapshot is present', () => {
    const result = runArmedSnapshotScenario({ preArmed: false });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
