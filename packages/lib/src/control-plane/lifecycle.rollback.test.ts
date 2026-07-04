import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

type RollbackScenario = {
  mode: 'performUpgrade';
  composePullOk?: boolean;
  composePullStderr?: string;
  composeUpOk?: boolean;
  composeUpStderr?: string;
  /** Inject a failure from the bundled OP_HOME seed (reconcileHome → applyHomeSeed). */
  seedError?: string;
  expectedError: string;
};

const lifecycleUrl = new URL('./lifecycle.ts', import.meta.url).href;
const moduleUrls = {
  composeArgs: new URL('./compose-args.js', import.meta.url).href,
  docker: new URL('./docker.js', import.meta.url).href,
  volumeOwnership: new URL('./volume-ownership.js', import.meta.url).href,
  configPersistence: new URL('./config-persistence.js', import.meta.url).href,
  uiAssets: new URL('./ui-assets.js', import.meta.url).href,
  installLock: new URL('./install-lock.js', import.meta.url).href,
  registry: new URL('./addons.js', import.meta.url).href,
  rollback: new URL('./rollback.js', import.meta.url).href,
  versioning: new URL('./versioning.js', import.meta.url).href,
};

// Shared harness snippet: pin PLATFORM_VERSION high so the #492 host-vs-target
// guard never blocks these rollback-mechanics scenarios (they target a stable
// v0.12.0 while the running lib is an rc). The guard has dedicated tests.
const PIN_PLATFORM_VERSION_SNIPPET = `
{
  const realVersioning = await import(${JSON.stringify(new URL('./versioning.js', import.meta.url).href)});
  mock.module(${JSON.stringify(new URL('./versioning.js', import.meta.url).href)}, () => ({
    ...realVersioning,
    PLATFORM_VERSION: 'v99.0.0',
  }));
}
`;
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
    'OP_IMAGE_NAMESPACE=openpalm\\nOP_ASSISTANT_VERSION=v0.11.5\\n',
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
  buildComposePreflightError: (_opts, stderr) => \`Compose preflight failed: \${stderr}\`,
}));
mock.module(${JSON.stringify(moduleUrls.volumeOwnership)}, () => ({
  repairRootOwnedBindMounts: async () => {},
  repairManagedNamedVolumes: async () => {},
}));
mock.module(${JSON.stringify(moduleUrls.configPersistence)}, () => ({
  resolveRuntimeFiles: () => ({ compose: '' }),
  writeRuntimeFiles: () => {},
  discoverStackOverlays: () => [],
  ensureComposeVolumeTargets: () => {},
  discoverHomeBindMountSources: () => [],
}));
mock.module(${JSON.stringify(moduleUrls.uiAssets)}, () => ({
  applyHomeSeed: async () => {
    if (scenario.seedError) throw new Error(scenario.seedError);
    return { updated: [], backupDir: null };
  },
}));
mock.module(${JSON.stringify(moduleUrls.installLock)}, () => ({
  acquireInstallLock: () => ({ path: 'test-lock' }),
  releaseInstallLock: () => {},
}));
mock.module(${JSON.stringify(moduleUrls.registry)}, () => ({
  getAddonServiceNames: () => [],
  listEnabledAddonIds: () => [],
  pruneRemovedAddonState: () => ({ changed: false, removedAddons: [], removedEnvKeys: [] }),
}));
${PIN_PLATFORM_VERSION_SNIPPET}

async function main() {
  try {
    globalThis.fetch = async () => dockerTagsResponse(['v0.12.0', 'v0.11.5']);
    const state = makeState();
    const stackEnvPath = join(state.stashDir, 'env', 'stack.env');
    const original = readFileSync(stackEnvPath, 'utf-8');
    const lifecycle = await import(lifecycleUrl + '?scenario=' + Math.random());
    const run = lifecycle.performUpgrade(state);

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
      expectedError: 'Failed to recreate containers: up failed',
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test('performUpgrade restores stack.env when the bundled OP_HOME seed fails', () => {
    const result = runRollbackScenario({
      mode: 'performUpgrade',
      seedError: 'asset seed failed',
      expectedError: 'asset seed failed',
    });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});

// ── Armed-snapshot protection (B5) ───────────────────────────────────────────
//
// Every lifecycle entry point now flows through reconcileStack, which wraps the
// reconcile in withStackEnvRollback. withStackEnvRollback arms a pre-reconcile
// snapshot for `openpalm rollback` — but ONLY when one is not already armed.
//
// A pre-existing armed snapshot is a pre-operation snapshot from an earlier
// lifecycle run that crashed before it could roll back / clear its arm. It MUST
// be preserved: re-arming would overwrite it with the current (post-crash,
// partially-changed) state, so a later `openpalm rollback` would restore the
// wrong state. reconcileCore runs with skipSnapshot:true, so withStackEnvRollback
// is the only arm point.
//
// The test mocks the rollback module and counts snapshotCurrentState calls, then
// runs applyUpdate and asserts:
//   • preArmed=true  → 0 snapshot calls (the existing armed snapshot is preserved)
//   • preArmed=false → exactly 1 snapshot call (a fresh pre-reconcile arm)
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
    'OP_IMAGE_NAMESPACE=openpalm\\nOP_ASSISTANT_VERSION=v0.11.5\\n',
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
  buildComposePreflightError: (_opts, stderr) => \`Compose preflight failed: \${stderr}\`,
}));
mock.module(${JSON.stringify(moduleUrls.volumeOwnership)}, () => ({
  repairRootOwnedBindMounts: async () => {},
  repairManagedNamedVolumes: async () => {},
}));
mock.module(${JSON.stringify(moduleUrls.configPersistence)}, () => ({
  resolveRuntimeFiles: () => ({ compose: '' }),
  writeRuntimeFiles: () => {},
  discoverStackOverlays: () => [],
  ensureComposeVolumeTargets: () => {},
  discoverHomeBindMountSources: () => [],
}));
mock.module(${JSON.stringify(moduleUrls.uiAssets)}, () => ({
  applyHomeSeed: async () => ({ updated: [], backupDir: null }),
}));
mock.module(${JSON.stringify(moduleUrls.installLock)}, () => ({
  acquireInstallLock: () => ({ path: 'test-lock' }),
  releaseInstallLock: () => {},
}));
mock.module(${JSON.stringify(moduleUrls.registry)}, () => ({
  getAddonServiceNames: () => [],
  listEnabledAddonIds: () => [],
  pruneRemovedAddonState: () => ({ changed: false, removedAddons: [], removedEnvKeys: [] }),
}));

async function main() {
  try {
    const home = mkdtempSync(join(tmpdir(), 'openpalm-armed-snapshot-'));
    const state = makeState(home);
    const lifecycle = await import(lifecycleUrl + '?armed=' + Math.random());
    await lifecycle.applyUpdate(state);

    // withStackEnvRollback arms a pre-reconcile snapshot ONLY when none is
    // already armed; reconcileCore (skipSnapshot:true) never takes a second one.
    //   • preArmed=true  → 0 calls: the existing armed snapshot is PRESERVED
    //     (re-arming would clobber a crashed upgrade's pre-op state).
    //   • preArmed=false → 1 call: a fresh pre-reconcile snapshot is armed.
    const expected = preArmed ? 0 : 1;
    if (snapshotCallCount !== expected) {
      throw new Error(
        'BUG: expected ' + expected + ' snapshotCurrentState call(s) but got ' +
        snapshotCallCount + ' (preArmed=' + preArmed + '). withStackEnvRollback must NOT ' +
        're-arm over a pre-existing armed snapshot, and must arm exactly one when none exists.',
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

describe('armed-snapshot protection via withStackEnvRollback (B5)', () => {
  test('applyUpdate does NOT re-arm (clobber) a pre-existing armed snapshot', () => {
    const result = runArmedSnapshotScenario({ preArmed: true });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test('applyUpdate arms exactly one snapshot when none is already armed', () => {
    const result = runArmedSnapshotScenario({ preArmed: false });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});

// ── Wired-path seed regression (the bug that started the refactor) ────────────
//
// The seed-layer test in ui-assets.test.ts proves applyHomeSeed re-materializes
// data/<svc>/tools/package.json when the version stamp changes. This test proves
// the WIRED path: applyUpdate (the `update` entry point that NEVER invoked seeding
// in HEAD) actually reaches the real seed via reconcileStack → reconcileHome and
// materializes the file into an OP_HOME stamped at an OLDER skeleton version.
//
// Only the side-effecting infra (docker/compose/config-persistence/install-lock)
// is mocked; applyHomeSeed, migrations, core-assets, and rollback run for real
// against the actual repo skeleton (OPENPALM_REPO_ROOT = repo root).
function runWiredSeedScenario(): { stdout: string; stderr: string; exitCode: number } {
  const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
  const tempDir = mkdtempSync(join(rollbackHarnessDir, '.tmp-openpalm-wired-seed-'));
  const scriptPath = join(tempDir, 'wired-seed-scenario.ts');
  const runnerPath = join(tempDir, 'run-bun.sh');

  const script = `
import { mock } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const lifecycleUrl = ${JSON.stringify(lifecycleUrl)};
const repoRoot = ${JSON.stringify(repoRoot)};

// Real skeleton resolution: point OPENPALM_REPO_ROOT at the repo so the real
// applyHomeSeed copies packages/skeleton/** (including data/<svc>/tools).
process.env.OPENPALM_REPO_ROOT = repoRoot;
process.env.OP_SKIP_COMPOSE_PREFLIGHT = '1';

// Mock ONLY the side-effecting infra. applyHomeSeed, migrations, core-assets,
// and rollback run for real.
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
  buildComposePreflightError: (_opts, stderr) => \`Compose preflight failed: \${stderr}\`,
}));
mock.module(${JSON.stringify(moduleUrls.volumeOwnership)}, () => ({
  repairRootOwnedBindMounts: async () => {},
  repairManagedNamedVolumes: async () => {},
}));
mock.module(${JSON.stringify(moduleUrls.configPersistence)}, () => ({
  resolveRuntimeFiles: () => ({ compose: '' }),
  writeRuntimeFiles: () => {},
  discoverStackOverlays: () => [],
  ensureComposeVolumeTargets: () => {},
  discoverHomeBindMountSources: () => [],
}));
mock.module(${JSON.stringify(moduleUrls.installLock)}, () => ({
  acquireInstallLock: () => ({ path: 'test-lock' }),
  releaseInstallLock: () => {},
}));
mock.module(${JSON.stringify(moduleUrls.registry)}, () => ({
  getAddonServiceNames: () => [],
  listEnabledAddonIds: () => [],
  pruneRemovedAddonState: () => ({ changed: false, removedAddons: [], removedEnvKeys: [] }),
}));

function makeState(home) {
  mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
  mkdirSync(join(home, 'config', 'stack'), { recursive: true });
  mkdirSync(join(home, 'data', 'rollback'), { recursive: true });
  writeFileSync(
    join(home, 'knowledge', 'env', 'stack.env'),
    'OP_IMAGE_NAMESPACE=openpalm\\nOP_ASSISTANT_VERSION=v0.11.5\\n',
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

async function main() {
  try {
    const home = mkdtempSync(join(tmpdir(), 'openpalm-wired-seed-'));
    const state = makeState(home);
    const lifecycle = await import(lifecycleUrl + '?wired=' + Math.random());
    const { applyHomeSeed } = await import(${JSON.stringify(moduleUrls.uiAssets)});

    // 1. Seed at an OLDER skeleton version, then DELETE the tool manifests to
    //    simulate an upgraded OP_HOME that predates data/<svc>/tools.
    await applyHomeSeed('v0.0.0-older', home, join(home, 'config'), join(home, 'data'));
    const toolsPkg = (svc) => join(home, 'data', svc, 'tools', 'package.json');
    for (const svc of ['guardian', 'assistant', 'portal']) {
      rmSync(toolsPkg(svc), { force: true });
      if (existsSync(toolsPkg(svc))) throw new Error('precondition: ' + svc + ' tools should be deleted');
    }

    // 2. Run the WIRED update path. In HEAD this NEVER seeded.
    await lifecycle.applyUpdate(state);

    // 3. The real reconcile re-stamps to PLATFORM_VERSION and re-materializes the
    //    missing tool manifests for every service.
    for (const svc of ['guardian', 'assistant', 'portal']) {
      if (!existsSync(toolsPkg(svc))) {
        throw new Error('BUG: applyUpdate did not seed data/' + svc + '/tools/package.json');
      }
      if (!readFileSync(toolsPkg(svc), 'utf-8').includes(svc + '-tools')) {
        throw new Error('seeded ' + svc + ' tools manifest has unexpected content');
      }
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

describe('wired reconcile seeds data/<svc>/tools/package.json on update', () => {
  test('applyUpdate materializes the tool manifests into an older-stamped OP_HOME', () => {
    const result = runWiredSeedScenario();
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
