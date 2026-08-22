import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildReconcileDecision,
  decideOwnershipFromCanaries,
  ownershipRepairPaths,
  ownershipCanaryPaths,
  readCanaryOwners,
  ownershipRepairMarkerFile,
  ownershipRepairMarkerMatches,
  writeOwnershipRepairMarker,
  reconcileHostOwnership,
  HostSwapBlockedError,
} from './ownership-reconcile.js';
import { writeHostIdentity, readHostIdentity } from './host-identity.js';
import { hostIdentityFile } from './home.js';

let homeDir = '';
let restoreIds: (() => void) | null = null;

afterEach(() => {
  if (restoreIds) { restoreIds(); restoreIds = null; }
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  homeDir = '';
});

/** Stub the live session uid/gid (restored in afterEach). */
function stubSessionIds(uid: number, gid: number): void {
  const origUid = process.getuid;
  const origGid = process.getgid;
  (process as unknown as { getuid: () => number }).getuid = () => uid;
  (process as unknown as { getgid: () => number }).getgid = () => gid;
  restoreIds = () => {
    (process as unknown as { getuid: typeof origUid }).getuid = origUid;
    (process as unknown as { getgid: typeof origGid }).getgid = origGid;
  };
}

function makeState() {
  homeDir = mkdtempSync(join(tmpdir(), 'openpalm-reconcile-'));
  const workspaceDir = join(homeDir, 'workspace');
  mkdirSync(join(homeDir, 'state'), { recursive: true });
  mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
  mkdirSync(join(homeDir, 'state'), { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  return {
    homeDir,
    configDir: join(homeDir, 'config'),
    stashDir: join(homeDir, 'knowledge'),
    workspaceDir,
    dataDir: join(homeDir, 'data'),
    stackDir: join(homeDir, 'system', 'stack'),
    services: {},
    artifacts: { compose: '' },
    artifactMeta: [],
  };
}

describe('ownership canary paths', () => {
  test('includes state, env, and workspace canaries', () => {
    const state = makeState();
    const paths = ownershipCanaryPaths(state);
    expect(paths).toEqual([
      join(homeDir, 'state', 'stack.env'),
      join(homeDir, 'state'),
       join(homeDir, 'config'),
       join(homeDir, 'knowledge'),
       join(homeDir, 'workspace'),
      join(homeDir, 'data', 'assistant'),
      join(homeDir, 'data', 'guardian'),
      join(homeDir, 'data', 'portal'),
      join(homeDir, 'data', 'akm'),
      join(homeDir, 'data', 'logs'),
    ]);
  });

  test('repair paths cover the user-owned bind-mount roots', () => {
    const state = makeState();
    expect(ownershipRepairPaths(state)).toContain(join(homeDir, 'knowledge'));
    // state/ covers the credentials too, now that private/ has folded into it.
    expect(ownershipRepairPaths(state)).toContain(join(homeDir, 'state'));
    expect(ownershipRepairPaths(state)).not.toContain(join(homeDir, 'private'));
    expect(ownershipRepairPaths(state)).toContain(join(homeDir, 'workspace'));
    expect(ownershipRepairPaths(state)).toContain(join(homeDir, 'data', 'assistant'));
    expect(ownershipRepairPaths(state)).toContain(join(homeDir, 'data', 'guardian'));
    expect(ownershipRepairPaths(state)).toContain(join(homeDir, 'data', 'akm'));
  });

  test('excludes the regenerable cache tree from repair and canary recursion', () => {
    const state = makeState();
    const cacheRoot = join(homeDir, 'cache');
    const cacheBackup = join(homeDir, 'cache-backup');
    const durableBind = join(homeDir, 'data', 'custom');
    const discoveredMounts = [
      { path: join(cacheRoot, 'assistant'), isFile: false },
      { path: join(cacheRoot, 'guardian', 'index.db'), isFile: true },
      { path: join(homeDir, 'root-secret'), isFile: true },
      { path: homeDir, isFile: false },
      { path: cacheBackup, isFile: false },
      { path: durableBind, isFile: false },
    ];

    const repairPaths = ownershipRepairPaths(state, discoveredMounts);
    const canaryPaths = ownershipCanaryPaths(state, discoveredMounts);
    for (const paths of [repairPaths, canaryPaths]) {
      expect(paths).not.toContain(join(cacheRoot, 'assistant'));
      expect(paths).not.toContain(join(cacheRoot, 'guardian'));
      expect(paths).toContain(cacheBackup);
      expect(paths).toContain(durableBind);
      expect(paths).toContain(join(homeDir, 'root-secret'));
      expect(paths).not.toContain(homeDir);
    }
  });
});

describe('canary owner detection', () => {
  test('returns all existing canary owners in priority order', () => {
    const state = makeState();
    const stateEnv = join(homeDir, 'state', 'stack.env');
    const userEnv = join(homeDir, 'knowledge', 'env', 'user.env');
    writeFileSync(stateEnv, 'OP_SETUP_COMPLETE=true\n');
    writeFileSync(userEnv, '');
    const owners = readCanaryOwners(ownershipCanaryPaths(state));
    expect(owners.map((owner) => owner.path)).toEqual([stateEnv, join(homeDir, 'state'), join(homeDir, 'knowledge'), join(homeDir, 'workspace')]);
  });
});

describe('reconcile decision building', () => {
  test('returns match when all canary owners match current operator ids', () => {
    const state = makeState();
    const userEnv = join(homeDir, 'knowledge', 'env', 'user.env');
    writeFileSync(userEnv, '');
    const current = { kind: 'linux', host: 'host-a', uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 };
    const decision = buildReconcileDecision({
      state,
      currentIdentity: current,
      previousIdentity: null,
    });
    expect(decision.decision).toBe('match');
    expect(decision.canaries.some((canary) => canary.path === join(homeDir, 'knowledge'))).toBe(true);
  });

  test('a different recorded host is a swap (regardless of canary ownership)', () => {
    const decision = decideOwnershipFromCanaries({
      currentIdentity: { kind: 'linux', host: 'host-b', uid: 99999, gid: 99999 },
      previousIdentity: { kind: 'linux', host: 'host-a', uid: 1000, gid: 1000 },
      canaries: [{ path: '/tmp/canary', uid: 1000, gid: 1000 }],
    });
    expect(decision).toBe('swap');
  });

  test('a different recorded host is STILL a swap even when a canary is owned by the current uid', () => {
    // The bug this guards: a coincidentally current-uid-owned path must not
    // downgrade a real host swap to drift and silently skip the block.
    const current = { kind: 'linux', host: 'host-b', uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 };
    const decision = decideOwnershipFromCanaries({
      currentIdentity: current,
      previousIdentity: { kind: 'linux', host: 'host-a', uid: 1000, gid: 1000 },
      canaries: [
        { path: '/tmp/match', uid: current.uid, gid: current.gid },
        { path: '/tmp/mismatch', uid: current.uid + 1, gid: current.gid + 1 },
      ],
    });
    expect(decision).toBe('swap');
  });

  test('same recorded host with some root-owned canaries is drift (repair), not swap', () => {
    // The session identity is stated explicitly rather than read from the live
    // process: the premise is a NON-root operator finding root-owned files, and
    // deriving it from the runner made the test assert the opposite whenever
    // the suite itself ran as root (where root-owned canaries correctly match).
    const current = { kind: 'linux', host: 'host-a', uid: 1000, gid: 1000 };
    const decision = decideOwnershipFromCanaries({
      currentIdentity: current,
      previousIdentity: { kind: 'linux', host: 'host-a', uid: current.uid, gid: current.gid },
      canaries: [{ path: '/tmp/rootowned', uid: 0, gid: 0 }],
    });
    expect(decision).toBe('drift');
  });

  test('a root session with root-owned canaries on the same host is match, not drift', () => {
    // Root installs are supported: when the operator IS root, root-owned files
    // are correctly owned and there is nothing to repair.
    const decision = decideOwnershipFromCanaries({
      currentIdentity: { kind: 'linux', host: 'host-a', uid: 0, gid: 0 },
      previousIdentity: { kind: 'linux', host: 'host-a', uid: 0, gid: 0 },
      canaries: [{ path: '/tmp/rootowned', uid: 0, gid: 0 }],
    });
    expect(decision).toBe('match');
  });

  test('null session on the SAME recorded host is match, not a spurious swap', () => {
    // No usable session identity — win32, or a runtime without getuid. (A root
    // session now resolves to uid 0 rather than null.) Same kind+host → not a
    // swap; nothing to repair against → match (no spurious block).
    const decision = decideOwnershipFromCanaries({
      currentIdentity: { kind: 'linux', host: 'host-a', uid: null, gid: null },
      previousIdentity: { kind: 'linux', host: 'host-a', uid: 1000, gid: 1000 },
      canaries: [{ path: '/tmp/canary', uid: 1000, gid: 1000 }],
    });
    expect(decision).toBe('match');
  });

  test('null session on a DIFFERENT recorded host is a swap (moved drive, no usable session id)', () => {
    // A drive moved to a new host and started as root (or on a root CI runner):
    // uid is null, but the recorded host differs — this must still block so the
    // stack is not silently started against foreign-owned files.
    const decision = decideOwnershipFromCanaries({
      currentIdentity: { kind: 'linux', host: 'host-b', uid: null, gid: null },
      previousIdentity: { kind: 'linux', host: 'host-a', uid: 1000, gid: 1000 },
      canaries: [{ path: '/tmp/canary', uid: 0, gid: 0 }],
    });
    expect(decision).toBe('swap');
  });

  test('null session with no recorded previous host is match, never a block', () => {
    const decision = decideOwnershipFromCanaries({
      currentIdentity: { kind: 'linux', host: 'host-a', uid: null, gid: null },
      previousIdentity: null,
      canaries: [{ path: '/tmp/canary', uid: 0, gid: 0 }],
    });
    expect(decision).toBe('match');
  });
});

describe('ownership repair marker (R4)', () => {
  test('marker round-trips and matches only the recorded session ids', () => {
    const state = makeState();
    expect(ownershipRepairMarkerMatches(state.homeDir, { uid: 1000, gid: 1000 })).toBe(false);
    writeOwnershipRepairMarker(state.homeDir, { uid: 1000, gid: 1000 });
    expect(ownershipRepairMarkerMatches(state.homeDir, { uid: 1000, gid: 1000 })).toBe(true);
    expect(ownershipRepairMarkerMatches(state.homeDir, { uid: 1001, gid: 1001 })).toBe(false);
    expect(existsSync(ownershipRepairMarkerFile(state.homeDir))).toBe(true);
  });
});

describe('reconcileHostOwnership swap block + fast path (R2/R4)', () => {
  // Docker-dependent repair orchestration (deep flag, strict, named volumes,
  // env patch) is covered in ownership-reconcile-repair.test.ts, which mocks the
  // docker chown side effects. These two paths invoke NO docker.

  test('throws HostSwapBlockedError on an un-adopted host swap (before any repair)', async () => {
    if (process.platform === 'win32') return;
    const state = makeState();
    writeFileSync(join(state.homeDir, 'state', 'stack.env'), 'OP_SETUP_COMPLETE=true\n');
    writeHostIdentity(hostIdentityFile(state.homeDir), { kind: 'linux', host: 'old-host', uid: 1234, gid: 1234 });
    // Live session is a uid that does NOT own the canaries → swap. The block
    // throws before any docker chown, so this needs no docker.
    stubSessionIds(999999, 999999);
    await expect(reconcileHostOwnership(state, {})).rejects.toBeInstanceOf(HostSwapBlockedError);
  });

  test('repairs to and records the stack.env pinned ids for a root session (FINDING 12)', async () => {
    // A root session over a root-owned OP_HOME whose stack.env pins non-root
    // OP_UID/OP_GID — the exact setup the OP_ALLOW_ROOT refusal message
    // recommends. Requires the suite itself to run as root on Linux (a
    // non-root runner cannot fabricate a root-owned OP_HOME), which is the
    // very environment the fix targets; skipped elsewhere.
    if (process.platform !== 'linux' || process.getuid?.() !== 0) return;
    const state = makeState();
    writeFileSync(join(state.homeDir, 'state', 'stack.env'), 'OP_UID=4242\nOP_GID=4243\n');

    // Fake docker (the OP_DOCKER_BIN seam) records argv and succeeds, so the
    // repair walk runs without a daemon.
    const argvLog = join(state.homeDir, 'docker-argv.log');
    const fakeDocker = join(state.homeDir, 'fake-docker.sh');
    writeFileSync(fakeDocker, `#!/bin/sh\necho "$@" >> ${argvLog}\nexit 0\n`);
    chmodSync(fakeDocker, 0o755);
    const savedDockerBin = process.env.OP_DOCKER_BIN;
    process.env.OP_DOCKER_BIN = fakeDocker;
    try {
      await reconcileHostOwnership(state, {});
    } finally {
      if (savedDockerBin === undefined) delete process.env.OP_DOCKER_BIN;
      else process.env.OP_DOCKER_BIN = savedDockerBin;
    }

    // The chown targeted the PINNED identity, never 0:0.
    const logged = readFileSync(argvLog, 'utf8');
    expect(logged).toContain('chown -R 4242:4243');
    expect(logged).not.toContain('chown -R 0:0');
    // The marker and recorded host identity carry the pinned ids too, so the
    // next start's fast path compares against what was actually repaired.
    expect(ownershipRepairMarkerMatches(state.homeDir, { uid: 4242, gid: 4243 })).toBe(true);
    expect(readHostIdentity(hostIdentityFile(state.homeDir))?.uid).toBe(4242);
  });

  test('skips the repair walk (no docker) when the marker already matches the session', async () => {
    if (process.platform === 'win32') return;
    const state = makeState();
    // process.getuid/getgid are defined on POSIX (win32 returned early above).
    // biome-ignore lint/style/noNonNullAssertion: process.getuid is defined on POSIX (win32 returned early).
    const sessionUid = process.getuid!();
    // biome-ignore lint/style/noNonNullAssertion: process.getgid is defined on POSIX (win32 returned early).
    const sessionGid = process.getgid!();
    // Marker present + match decision → needsRepair false → no docker invoked.
    writeOwnershipRepairMarker(state.homeDir, { uid: sessionUid, gid: sessionGid });
    await reconcileHostOwnership(state, { services: ['assistant'] });
    // Identity is still recorded even on the fast path.
    expect(readHostIdentity(hostIdentityFile(state.homeDir))?.uid).toBe(sessionUid);
  });
});
