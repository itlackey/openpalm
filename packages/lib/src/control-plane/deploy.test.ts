/**
 * A2b — deploy-spine AC tests
 *
 * Three acceptance criteria:
 *   (a) Collision detection fails closed and retries [0,1s,1s] before refusing.
 *   (b) A successful applyStack outcome propagates per-service "running" status
 *       into deployStatus via the onService progress hook (plan 2.2 — runDeploy
 *       now routes through applyStack, the single compose driver; the
 *       "assistant" vs "assistant-1" container-name-suffix bug class this used
 *       to guard against can no longer occur — applyStack resolves each
 *       service's container via `compose ps -q <service>`, an exact-match
 *       lookup, not a JSON blob keyed by container name. That contract is
 *       pinned directly in apply-stack-di.test.ts / apply-stack-service.test.ts).
 *   (c) Lock-held-through-deploy: a full runDeploy holding the lock does not
 *       false-refuse, while a SECOND concurrent runDeploy DOES refuse.
 *
 * Tests (a) and (b) use the subprocess/mock.module harness to mock docker.js
 * without a running Docker daemon — same pattern as lifecycle.rollback.test.ts.
 * Test (c) tests acquireInstallLock/releaseInstallLock directly (they are
 * exported), verifying the concurrency property without needing a full runDeploy.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { acquireInstallLock, releaseInstallLock } from './install-lock.js';

// ── Subprocess harness setup ──────────────────────────────────────────────────

const deployUrl = new URL('./deploy.ts', import.meta.url).href;
const moduleUrls = {
  docker: new URL('./docker.js', import.meta.url).href,
  volumeOwnership: new URL('./volume-ownership.js', import.meta.url).href,
  composeArgs: new URL('./compose-args.js', import.meta.url).href,
  configPersistence: new URL('./config-persistence.js', import.meta.url).href,
  coreAssets: new URL('./core-assets.js', import.meta.url).href,
  lifecycle: new URL('./lifecycle.js', import.meta.url).href,
  installLock: new URL('./install-lock.js', import.meta.url).href,
};
const harnessDir = fileURLToPath(new URL('../../', import.meta.url));

type DeployScenario = {
  /** How many calls to detectExistingProject should return a foreign project. */
  foreignCollisionCalls?: number;
  /** applyStack outcome — defaults to a clean success for the given services. */
  applyStackOk?: boolean;
  /** Service names to expect in a successful deploy. */
  expectedServices?: string[];
};

function runDeployScenario(scenario: DeployScenario): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const tempDir = mkdtempSync(join(harnessDir, '.tmp-openpalm-deploy-'));
  const scriptPath = join(tempDir, 'deploy-scenario.ts');
  const runnerPath = join(tempDir, 'run-bun.sh');

  const script = `
import { mock } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const deployUrl = ${JSON.stringify(deployUrl)};
const scenario = ${JSON.stringify(scenario)};

function makeState() {
  const home = mkdtempSync(join(tmpdir(), 'openpalm-deploy-ac-'));
  mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
  mkdirSync(join(home, 'config', 'stack'), { recursive: true });
  mkdirSync(join(home, 'data'), { recursive: true });
  // Use a non-dev tag so the (mocked) applyStack failure message path exercised
  // below is the general one, not the dev-build-guidance one.
  writeFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'OP_IMAGE_TAG=v0.12.0\\n');
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

// Track call count for detectExistingProject to verify retry behaviour.
let detectCallCount = 0;

mock.module(${JSON.stringify(moduleUrls.docker)}, () => ({
  detectExistingProject: async () => {
    detectCallCount++;
    const foreignCalls = scenario.foreignCollisionCalls ?? 0;
    if (detectCallCount <= foreignCalls) {
      // Simulate a project with no workingDir label — triggers the "continue"
      // branch in detectProjectCollision (unknown working_dir → retry rather
      // than immediately refuse). After all retries, the fail-closed message fires.
      return { exists: true, isOurs: false, workingDir: '' };
    }
    return { exists: false, isOurs: false, workingDir: '' };
  },
  composeDown: async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
  // applyStack — the single compose driver (plan 2.2). Fire onService for
  // every expected service so the deployStatus wiring in runDeploy is
  // exercised the same way the real driver would drive it.
  applyStack: async (_scope, _opts, _deps, progress) => {
    const ok = scenario.applyStackOk ?? true;
    const services = scenario.expectedServices ?? ['assistant'];
    // "access denied" is a NON-transient failure per runDeploy's retry ladder,
    // so a failing scenario exits after the first attempt instead of burning
    // the real 0/5s/15s retry delays in this test.
    const reason = 'compose up failed: access denied';
    for (const service of services) {
      progress?.onService?.(service, ok ? 'pending' : 'error', ok ? 'Starting...' : reason);
      if (ok) progress?.onService?.(service, 'running', 'Running');
    }
    return {
      ok,
      started: ok ? services : [],
      failed: ok ? [] : services.map((service) => ({ service, reason })),
      ...(ok ? {} : { error: reason }),
    };
  },
  defaultStackDeps: {},
  resolveComposeProjectName: () => 'openpalm',
  isProjectOurs: (workingDir, expected) => workingDir === '' || workingDir === expected,
}));

mock.module(${JSON.stringify(moduleUrls.volumeOwnership)}, () => ({
  repairRootOwnedBindMounts: async () => {},
  repairManagedNamedVolumes: async () => {},
}));

mock.module(${JSON.stringify(moduleUrls.composeArgs)}, () => ({
  buildComposeOptions: () => ({ files: [], envFiles: [], profiles: [] }),
}));

mock.module(${JSON.stringify(moduleUrls.configPersistence)}, () => ({
  resolveRuntimeFiles: () => ({ compose: '' }),
  writeRuntimeFiles: () => {},
  discoverStackOverlays: () => [],
  ensureComposeVolumeTargets: () => {},
}));

mock.module(${JSON.stringify(moduleUrls.coreAssets)}, () => ({
  overwriteSystemTree: () => ({ backupDir: null, updated: [] }),
  ensureOpenCodeSystemConfig: () => {},
}));

mock.module(${JSON.stringify(moduleUrls.lifecycle)}, () => ({
  applyInstall: async () => {},
  buildManagedServices: async () => scenario.expectedServices ?? ['assistant'],
}));

mock.module(${JSON.stringify(moduleUrls.installLock)}, () => ({
  acquireInstallLock: () => ({ path: 'test-lock' }),
  releaseInstallLock: () => {},
}));

async function main() {
  try {
    const state = makeState();
    const deploy = await import(deployUrl + '?t=' + Math.random());
    const progress = await deploy.runDeploy(state, {});

    const result = {
      detectCallCount,
      deployError: progress.deployError,
      deploying: progress.deploying,
      phase: progress.phase,
      deployStatus: progress.deployStatus,
    };
    console.log(JSON.stringify(result));
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
      timeout: 60_000,
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

// ── (a) Collision detection: fails closed with retry ─────────────────────────

describe('A2b(a): collision detection fails closed with retry', () => {
  it('refuses and surfaces an error when all 3 attempts detect a foreign project', () => {
    // foreignCollisionCalls=3 means all 3 retry slots return a foreign project.
    // The final fallback in detectProjectCollision returns the fail-closed message.
    const result = runDeployScenario({ foreignCollisionCalls: 3 });
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

    const output = JSON.parse(result.stdout.trim().split('\n').filter(l => l.startsWith('{')).at(-1) ?? '{}');
    expect(output.deployError).toBeTruthy();
    expect(output.deploying).toBe(false);
    // The error must mention the collision — not a lock or image error.
    expect(output.deployError).toMatch(/Refusing to deploy|could not be verified safely/);
  });

  it('succeeds on the third attempt when the first two see a foreign project that clears', () => {
    // foreignCollisionCalls=2 → attempts 1+2 see foreign (empty workingDir → retry);
    // attempt 3 sees nothing → deploy proceeds.
    const result = runDeployScenario({
      foreignCollisionCalls: 2,
      expectedServices: ['assistant'],
    });
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

    const output = JSON.parse(result.stdout.trim().split('\n').filter(l => l.startsWith('{')).at(-1) ?? '{}');
    // detectCallCount should be 3 (two foreign + one clear).
    expect(output.detectCallCount).toBe(3);
    // No collision error; deploy completed successfully.
    expect(output.deployError).toBeFalsy();
    expect(output.phase).toBe('ready');
  });
});

// ── (b) applyStack outcome propagates into deployStatus via onService ────────

describe('A2b(b): applyStack outcome propagates into deployStatus', () => {
  it('marks a service "running" when applyStack reports it started', () => {
    const result = runDeployScenario({ expectedServices: ['assistant'] });
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

    const output = JSON.parse(result.stdout.trim().split('\n').filter(l => l.startsWith('{')).at(-1) ?? '{}');
    expect(output.deployError).toBeFalsy();
    expect(output.phase).toBe('ready');

    const entry = (output.deployStatus as Array<{ service: string; status: string }>)
      .find((e) => e.service === 'assistant');
    expect(entry).toBeTruthy();
    expect(entry?.status).toBe('running');
  });

  it('marks a service "error" and surfaces deployError when applyStack fails', () => {
    const result = runDeployScenario({ expectedServices: ['assistant'], applyStackOk: false });
    expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);

    const output = JSON.parse(result.stdout.trim().split('\n').filter(l => l.startsWith('{')).at(-1) ?? '{}');
    expect(output.deployError).toBeTruthy();
    expect(output.deploying).toBe(false);

    const entry = (output.deployStatus as Array<{ service: string; status: string }>)
      .find((e) => e.service === 'assistant');
    expect(entry).toBeTruthy();
    expect(entry?.status).toBe('error');
  });
});

// ── (c) Lock concurrency: held lock refuses second deploy ─────────────────────

describe('A2b(c): install lock held through deploy; second concurrent deploy refused', () => {
  let lockDir: string | null = null;

  afterEach(() => {
    if (lockDir) {
      rmSync(lockDir, { recursive: true, force: true });
      lockDir = null;
    }
  });

  it('acquires the lock successfully when none is held', () => {
    lockDir = mkdtempSync(join(tmpdir(), 'op-lock-test-'));
    const handle = acquireInstallLock(lockDir);
    expect(handle).not.toBeNull();
    releaseInstallLock(handle);
  });

  it('second SAME-PROCESS acquire is reentrant (no self-deadlock) while first lock is held', () => {
    lockDir = mkdtempSync(join(tmpdir(), 'op-lock-test-'));
    const first = acquireInstallLock(lockDir);
    expect(first).not.toBeNull();
    expect(first?.reentrant).toBeFalsy();

    try {
      // A nested acquire from the SAME process (e.g. a lifecycle wrapper holds the
      // lock, then a migration helper acquires it again) must NOT deadlock — it
      // returns a reentrant no-op handle. Releasing it does not clear the file.
      const second = acquireInstallLock(lockDir);
      expect(second).not.toBeNull();
      expect(second?.reentrant).toBe(true);
      releaseInstallLock(second);
      // The outer lock is still held after releasing the reentrant handle.
      expect(existsSync(join(lockDir, '.install.lock'))).toBe(true);
    } finally {
      releaseInstallLock(first);
    }
    // Outermost release clears the file.
    expect(existsSync(join(lockDir, '.install.lock'))).toBe(false);
  });

  it('lock becomes acquirable again after release', () => {
    lockDir = mkdtempSync(join(tmpdir(), 'op-lock-test-'));
    const first = acquireInstallLock(lockDir);
    expect(first).not.toBeNull();
    releaseInstallLock(first);

    // After release, a new acquire must succeed.
    const second = acquireInstallLock(lockDir);
    expect(second).not.toBeNull();
    releaseInstallLock(second);
  });

  it('acquireInstallLock returns null when lock file is held by a live FOREIGN PID', () => {
    // Pre-write the lock file as a DIFFERENT live process (PID 1 / init is always
    // alive) so it is genuinely "held by another install". A foreign live holder
    // must be refused (returns null) — the reentrancy short-circuit only applies
    // to the CURRENT process's own PID.
    lockDir = mkdtempSync(join(tmpdir(), 'op-lock-ac-'));
    mkdirSync(lockDir, { recursive: true });
    const lockPath = join(lockDir, '.install.lock');
    writeFileSync(lockPath, `1\n${Date.now()}\n`, { mode: 0o644 });

    // acquireInstallLock sees EEXIST, the holder PID is foreign and alive and the
    // timestamp is recent → not stale, not reentrant → returns null.
    const handle = acquireInstallLock(lockDir);
    expect(handle).toBeNull();
  });
});
