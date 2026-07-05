import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * (R9 S6 Gap B) `ownershipRepairPaths` derives the repair-path list from the
 * managed compose files on disk via `discoverHomeBindMountSources`. Those
 * files are only guaranteed current AFTER `applyHome` has written/refreshed
 * them. Running the ownership reconcile BEFORE `applyHome` (as
 * `reconcileStack` used to) risks under-reporting mount sources on a
 * partially-migrated home (crash mid-migration, or a first upgrade from a
 * pre-`system/stack` layout) — the walk then misses data directories, and the
 * repair marker suppresses any later, complete repair.
 *
 * This test drives the real `applyInstall` lifecycle entry point (mocking
 * only the side-effecting infra, same as lifecycle.rollback.test.ts) and
 * records the call order of `discoverHomeBindMountSources` (ownership-path
 * discovery) vs `applyHomeSeed` (the write applyHome performs). It asserts
 * discovery happens AFTER the seed — i.e. after the managed compose tree is
 * up to date.
 *
 * Runs in a subprocess (bun mock.module leaks across files within one
 * process — see bun-mock-module-leaks-across-files.md).
 */
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
const harnessDir = fileURLToPath(new URL('../../', import.meta.url));

function runOrderScenario(): { order: string[]; exitCode: number; stdout: string; stderr: string } {
  const tempDir = mkdtempSync(join(harnessDir, '.tmp-openpalm-ownership-order-'));
  const scriptPath = join(tempDir, 'ownership-order-scenario.ts');
  const runnerPath = join(tempDir, 'run-bun.sh');

  const script = `
import { mock } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const lifecycleUrl = ${JSON.stringify(lifecycleUrl)};
const order = [];

function makeState() {
  const home = mkdtempSync(join(tmpdir(), 'openpalm-ownership-order-'));
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

mock.module(${JSON.stringify(moduleUrls.rollback)}, () => ({
  snapshotCurrentState: () => {},
  hasArmedSnapshot: () => false,
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
  // The function under test: recorded, not skipped, so we can see WHEN the
  // real reconcile (ownership-reconcile.ts, unmocked) calls it relative to
  // applyHomeSeed below.
  discoverHomeBindMountSources: () => { order.push('discover-repair-paths'); return []; },
}));
mock.module(${JSON.stringify(moduleUrls.uiAssets)}, () => ({
  applyHomeSeed: async () => { order.push('apply-home-seed'); return { updated: [], backupDir: null }; },
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
{
  const realVersioning = await import(${JSON.stringify(moduleUrls.versioning)});
  mock.module(${JSON.stringify(moduleUrls.versioning)}, () => ({
    ...realVersioning,
    PLATFORM_VERSION: 'v99.0.0',
  }));
}

async function main() {
  try {
    const state = makeState();
    const lifecycle = await import(lifecycleUrl + '?scenario=' + Math.random());
    // Only "upgrade" runs the ownership reconcile inside reconcileStack
    // (planLifecycleOp: install/update/uninstall all set compose:false —
    // their routes own a bespoke compose phase; upgrade is the only kind
    // that pulls+recreates inside the wrapper, per lifecycle.ts's own
    // planLifecycleOp doc comment).
    await lifecycle.performUpgrade(state);
    console.log('ORDER_JSON:' + JSON.stringify(order));
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
      cwd: harnessDir,
      encoding: 'utf8',
    });
    const stdout = proc.stdout ?? '';
    const marker = stdout.split('\n').find((line) => line.startsWith('ORDER_JSON:'));
    const order = marker ? JSON.parse(marker.slice('ORDER_JSON:'.length)) : [];
    return { order, exitCode: proc.status ?? 1, stdout, stderr: proc.stderr ?? '' };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('ownership repair-path discovery ordering (R9 S6 Gap B)', () => {
  test('discovers repair paths AFTER applyHome writes the managed compose tree, not before', () => {
    const result = runOrderScenario();
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);

    const firstSeedIndex = result.order.indexOf('apply-home-seed');
    const firstDiscoverIndex = result.order.indexOf('discover-repair-paths');

    expect(firstSeedIndex, `call order was: ${JSON.stringify(result.order)}`).toBeGreaterThanOrEqual(0);
    expect(firstDiscoverIndex, `call order was: ${JSON.stringify(result.order)}`).toBeGreaterThanOrEqual(0);
    expect(
      firstDiscoverIndex,
      `BUG (R9 S6 Gap B): repair-path discovery ran before applyHome (order: ${JSON.stringify(result.order)}). ` +
        'The managed compose tree may not be materialized yet, so discovery under-reports mount sources.',
    ).toBeGreaterThan(firstSeedIndex);
  });
});
