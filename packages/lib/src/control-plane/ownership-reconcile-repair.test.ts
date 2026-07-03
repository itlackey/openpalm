import { describe, test, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// reconcileHostOwnership drives docker chown side effects (repairRootOwnedBindMounts,
// repairManagedNamedVolumes). To assert the orchestration (deep flag, strict on
// adopt, named-volume service set, OP_UID/OP_GID patch, marker) WITHOUT running
// real `docker run`, we mock volume-ownership.js in a fresh subprocess — the only
// reliable isolation, since an in-process mock.module can't override the module
// once a sibling test file has statically imported it (bun cross-file module cache).

const volumeOwnershipUrl = new URL('./volume-ownership.js', import.meta.url).href;
const reconcileUrl = new URL('./ownership-reconcile.js', import.meta.url).href;
const harnessDir = fileURLToPath(new URL('../../', import.meta.url));

function runScenario(body: string): { stdout: string; stderr: string; exitCode: number } {
  const tempDir = mkdtempSync(join(harnessDir, '.tmp-openpalm-reconcile-repair-'));
  const scriptPath = join(tempDir, 'scenario.ts');
  const runnerPath = join(tempDir, 'run-bun.sh');

  const script = `
import { mock } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const volumeOwnershipUrl = ${JSON.stringify(volumeOwnershipUrl)};
const reconcileUrl = ${JSON.stringify(reconcileUrl)};

const calls = { deep: undefined, strict: undefined, services: null };
mock.module(volumeOwnershipUrl, () => ({
  repairRootOwnedBindMounts: async (_h, _paths, opts) => { calls.deep = opts?.deep; calls.strict = opts?.strict; },
  repairManagedNamedVolumes: async (_h, services) => { calls.services = services; },
}));

function makeState() {
  const home = mkdtempSync(join(tmpdir(), 'openpalm-reconcile-repair-'));
  mkdirSync(join(home, 'state'), { recursive: true });
  mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
  mkdirSync(join(home, 'workspace'), { recursive: true });
  return {
    homeDir: home,
    configDir: join(home, 'config'),
    stashDir: join(home, 'knowledge'),
    workspaceDir: join(home, 'workspace'),
    dataDir: join(home, 'data'),
    stackDir: join(home, 'system', 'stack'),
    services: {},
    artifacts: { compose: '' },
    artifactMeta: [],
  };
}

async function main() {
  try {
    const { reconcileHostOwnership, ownershipRepairMarkerMatches } = await import(reconcileUrl);
    const { writeHostIdentity, readHostIdentity } = await import(${JSON.stringify(new URL('./host-identity.js', import.meta.url).href)});
    const { hostIdentityFile } = await import(${JSON.stringify(new URL('./home.js', import.meta.url).href)});
${body}
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
    const proc = spawnSync('bash', [runnerPath, scriptPath], { cwd: harnessDir, encoding: 'utf8' });
    return { stdout: proc.stdout ?? '', stderr: proc.stderr ?? '', exitCode: proc.status ?? 1 };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function assert(cond: string): string {
  return `if (!(${cond})) throw new Error('assertion failed: ${cond.replace(/'/g, "\\'")}');`;
}

describe('reconcileHostOwnership repair orchestration (R2/R3/R4)', () => {
  test('first run for a session uid: deep bind repair + named-volume repair, marker recorded', () => {
    const result = runScenario(`
    const state = makeState();
    const uid = process.getuid();
    const gid = process.getgid();
    await reconcileHostOwnership(state, { services: ['assistant', 'guardian'] });
    ${assert('calls.deep === true')}
    ${assert('calls.strict === false')}
    ${assert('JSON.stringify(calls.services) === JSON.stringify(["assistant","guardian"])')}
    ${assert('ownershipRepairMarkerMatches(state.homeDir, { uid, gid })')}
    ${assert('readHostIdentity(hostIdentityFile(state.homeDir)).uid === uid')}
    `);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test('adopt on a swap: strict repair + OP_UID/OP_GID patched to the session ids', () => {
    const result = runScenario(`
    const state = makeState();
    // Seed a canary + a previous identity for a DIFFERENT host/uid, then stub
    // the live session to a uid that does NOT own the canaries → swap.
    writeFileSync(join(state.homeDir, 'state', 'stack.state.env'), 'OP_SETUP_COMPLETE=true\\n');
    writeHostIdentity(hostIdentityFile(state.homeDir), { kind: 'linux', host: 'old-host', uid: 1234, gid: 1234 });
    process.getuid = () => 999999;
    process.getgid = () => 999999;
    await reconcileHostOwnership(state, { adoptHost: true, services: ['assistant'] });
    ${assert('calls.strict === true')}
    ${assert('calls.deep === true')}
    const stateEnv = readFileSync(join(state.homeDir, 'state', 'stack.state.env'), 'utf8');
    ${assert("stateEnv.includes('OP_UID=999999')")}
    ${assert("stateEnv.includes('OP_GID=999999')")}
    ${assert('readHostIdentity(hostIdentityFile(state.homeDir)).uid === 999999')}
    `);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test('un-adopted swap throws HostSwapBlockedError before any repair', () => {
    const result = runScenario(`
    const state = makeState();
    writeFileSync(join(state.homeDir, 'state', 'stack.state.env'), 'OP_SETUP_COMPLETE=true\\n');
    writeHostIdentity(hostIdentityFile(state.homeDir), { kind: 'linux', host: 'old-host', uid: 1234, gid: 1234 });
    process.getuid = () => 999999;
    process.getgid = () => 999999;
    let threw = null;
    try { await reconcileHostOwnership(state, { services: ['assistant'] }); }
    catch (e) { threw = e; }
    ${assert("threw && threw.code === 'host_swap_blocked'")}
    ${assert('calls.deep === undefined')}
    `);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test('VM-mediated runtime (Docker Desktop): no swap block, no bind-mount chown, named volumes still repaired', () => {
    const result = runScenario(`
    const state = makeState();
    // Seed a canary + a previous identity for a DIFFERENT host — on native Linux
    // this would be a swap and would throw. On a VM-mediated runtime the host-uid
    // comparison is unreliable, so the block must NOT fire.
    writeFileSync(join(state.homeDir, 'state', 'stack.state.env'), 'OP_SETUP_COMPLETE=true\\n');
    writeHostIdentity(hostIdentityFile(state.homeDir), { kind: 'linux', host: 'old-host', uid: 1234, gid: 1234 });
    process.getuid = () => 999999;
    process.getgid = () => 999999;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    let threw = null;
    try { await reconcileHostOwnership(state, { services: ['assistant', 'guardian'] }); }
    catch (e) { threw = e; }
    ${assert('threw === null')}
    ${assert('calls.deep === undefined')}
    ${assert('JSON.stringify(calls.services) === JSON.stringify(["assistant","guardian"])')}
    ${assert('readHostIdentity(hostIdentityFile(state.homeDir)).kind === "darwin"')}
    `);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
