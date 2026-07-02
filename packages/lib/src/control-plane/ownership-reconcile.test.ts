import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildReconcileDecision,
  decideOwnershipFromCanaries,
  ownershipRepairPaths,
  ownershipCanaryPaths,
  readCanaryOwners,
} from './ownership-reconcile.js';

let homeDir = '';

afterEach(() => {
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  homeDir = '';
});

function makeState() {
  homeDir = mkdtempSync(join(tmpdir(), 'openpalm-reconcile-'));
  const workspaceDir = join(homeDir, 'workspace');
  mkdirSync(join(homeDir, 'state'), { recursive: true });
  mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
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
      join(homeDir, 'state', 'stack.state.env'),
      join(homeDir, 'state'),
      join(homeDir, 'knowledge'),
      join(homeDir, 'workspace'),
    ]);
  });

  test('repair paths cover the user-owned bind-mount roots', () => {
    const state = makeState();
    expect(ownershipRepairPaths(state)).toContain(join(homeDir, 'knowledge'));
    expect(ownershipRepairPaths(state)).toContain(join(homeDir, 'state'));
    expect(ownershipRepairPaths(state)).toContain(join(homeDir, 'workspace'));
  });
});

describe('canary owner detection', () => {
  test('returns all existing canary owners in priority order', () => {
    const state = makeState();
    const stateEnv = join(homeDir, 'state', 'stack.state.env');
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

  test('returns swap when previous identity differs and canary mismatches current ids', () => {
    const decision = decideOwnershipFromCanaries({
      currentIdentity: { kind: 'linux', host: 'host-b', uid: 99999, gid: 99999 },
      previousIdentity: { kind: 'linux', host: 'host-a', uid: 1000, gid: 1000 },
      canaries: [{ path: '/tmp/canary', uid: 1000, gid: 1000 }],
    });
    expect(decision).toBe('swap');
  });

  test('returns drift when previous identity differs but at least one canary already matches current ids', () => {
    const current = { kind: 'linux', host: 'host-b', uid: process.getuid?.() ?? 1000, gid: process.getgid?.() ?? 1000 };
    const decision = decideOwnershipFromCanaries({
      currentIdentity: current,
      previousIdentity: { kind: 'linux', host: 'host-a', uid: 1000, gid: 1000 },
      canaries: [
        { path: '/tmp/match', uid: current.uid, gid: current.gid },
        { path: '/tmp/mismatch', uid: current.uid + 1, gid: current.gid + 1 },
      ],
    });
    expect(decision).toBe('drift');
  });
});
