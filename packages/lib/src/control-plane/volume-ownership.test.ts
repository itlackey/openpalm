/**
 * 0.4 (X15 urgent half, R9-F2): repairRootOwnedBindMounts / repairManagedNamedVolumes
 * used to swallow docker-chown failures and return void, so their caller
 * (ownership-reconcile.ts) wrote the "already repaired" marker unconditionally
 * — a failed repair got wedged forever with no automatic retry. These
 * functions now report success/failure so the caller can gate the marker on
 * it (see ownership-reconcile-repair.test.ts for the marker-gating test).
 *
 * docker.js's `run()` is mocked via the subprocess/mock.module harness (no
 * real Docker daemon needed) — same pattern as ownership-reconcile-repair.test.ts,
 * deploy.test.ts, and lifecycle.rollback.test.ts: mock.module() is not undone
 * by mock.restore() and leaks across files in-process, so each scenario runs
 * in a fresh subprocess.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const dockerUrl = new URL('./docker.js', import.meta.url).href;
const volumeOwnershipUrl = new URL('./volume-ownership.js', import.meta.url).href;
const harnessDir = fileURLToPath(new URL('../../', import.meta.url));

function runScenario(body: string): { stdout: string; stderr: string; exitCode: number } {
  const tempDir = mkdtempSync(join(harnessDir, '.tmp-openpalm-volume-ownership-'));
  const scriptPath = join(tempDir, 'scenario.ts');
  const runnerPath = join(tempDir, 'run-bun.sh');

  const script = `
import { mock } from 'bun:test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dockerUrl = ${JSON.stringify(dockerUrl)};
const volumeOwnershipUrl = ${JSON.stringify(volumeOwnershipUrl)};

const runCalls = [];
mock.module(dockerUrl, () => ({
  run: async (args) => {
    runCalls.push(args);
    if (args[0] === 'volume' && args[1] === 'inspect') {
      const volumeName = args[2];
      // Generic inspect failure (daemon down / permission / timeout) — NOT a
      // missing volume. Must be treated as "could not verify", not success.
      if (volumeName.includes('inspect-fail')) {
        return { ok: false, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' };
      }
      const ok = !volumeName.includes('missing-volume');
      return { ok, stdout: '', stderr: ok ? '' : 'Error: No such volume: ' + volumeName };
    }
    // chown run — fail for anything tagged 'fail-chown' (ad hoc dirs/volumes
    // the test names explicitly) or the real 'assistant-artifacts' named
    // volume (SERVICE_NAMED_VOLUMES constant), used to simulate one volume
    // among several failing while the rest still get attempted.
    const target = args.find((a) => typeof a === 'string' && (a.includes('fail-chown') || a.includes('assistant-artifacts')));
    if (target) return { ok: false, stdout: '', stderr: 'chown: permission denied' };
    return { ok: true, stdout: '', stderr: '' };
  },
  resolveComposeProjectName: () => 'openpalm-test',
}));

function makeDir() {
  const dir = mkdtempSync(join(tmpdir(), 'openpalm-vol-own-'));
  return dir;
}

async function main() {
  try {
    const { repairRootOwnedBindMounts, repairManagedNamedVolumes, repairNamedVolumeOwnership } = await import(volumeOwnershipUrl);
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

describe('repairRootOwnedBindMounts / repairManagedNamedVolumes success reporting (0.4)', () => {
  test('repairRootOwnedBindMounts returns true when nothing needs repair (no matching dirs)', () => {
    const result = runScenario(`
    const ok = await repairRootOwnedBindMounts(makeDir(), [join(tmpdir(), 'does-not-exist-anywhere')]);
    ${assert('ok === true')}
    `);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test('repairRootOwnedBindMounts returns true when the docker chown succeeds', () => {
    const result = runScenario(`
    const dir = makeDir();
    const ok = await repairRootOwnedBindMounts(dir, [dir], { deep: true });
    ${assert('ok === true')}
    `);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test('repairRootOwnedBindMounts returns false (non-strict) when the docker chown fails, and does not throw', () => {
    const result = runScenario(`
    const dir = mkdtempSync(join(tmpdir(), 'fail-chown-'));
    const ok = await repairRootOwnedBindMounts(dir, [dir], { deep: true });
    ${assert('ok === false')}
    `);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test('repairRootOwnedBindMounts still throws in strict mode when the docker chown fails', () => {
    const result = runScenario(`
    const dir = mkdtempSync(join(tmpdir(), 'fail-chown-'));
    let threw = false;
    try { await repairRootOwnedBindMounts(dir, [dir], { deep: true, strict: true }); }
    catch { threw = true; }
    ${assert('threw === true')}
    `);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test('repairNamedVolumeOwnership returns true on success, false (non-strict) on failure', () => {
    const result = runScenario(`
    const okGood = await repairNamedVolumeOwnership('openpalm-test_guardian-cache', { uid: 1000, gid: 1000 });
    ${assert('okGood === true')}
    const okBad = await repairNamedVolumeOwnership('openpalm-test_fail-chown-cache', { uid: 1000, gid: 1000 });
    ${assert('okBad === false')}
    `);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test('repairManagedNamedVolumes returns false overall when one of several volumes fails, but still attempts the rest', () => {
    const result = runScenario(`
    const home = makeDir();
    // assistant maps to ['assistant-artifacts' (mocked to fail), 'assistant-persistent' (ok)];
    // guardian maps to ['guardian-cache' (ok)].
    const ok = await repairManagedNamedVolumes(home, ['assistant', 'guardian']);
    ${assert('ok === false')}
    const chownCalls = runCalls.filter((a) => a[0] === 'run');
    ${assert('chownCalls.length === 3')}
    `);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test('repairNamedVolumeOwnership treats a genuinely-missing volume as a benign skip (true) and does not chown', () => {
    const result = runScenario(`
    const ok = await repairNamedVolumeOwnership('openpalm-test_missing-volume-cache', { uid: 1000, gid: 1000 });
    ${assert('ok === true')}
    const chownCalls = runCalls.filter((a) => a[0] === 'run');
    ${assert('chownCalls.length === 0')}
    `);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test('repairNamedVolumeOwnership returns false (non-strict) when inspect fails for a NON-missing reason, and does not chown', () => {
    const result = runScenario(`
    const ok = await repairNamedVolumeOwnership('openpalm-test_inspect-fail-cache', { uid: 1000, gid: 1000 });
    ${assert('ok === false')}
    const chownCalls = runCalls.filter((a) => a[0] === 'run');
    ${assert('chownCalls.length === 0')}
    `);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test('repairNamedVolumeOwnership throws in strict mode when inspect fails for a NON-missing reason', () => {
    const result = runScenario(`
    let threw = false;
    try { await repairNamedVolumeOwnership('openpalm-test_inspect-fail-cache', { uid: 1000, gid: 1000 }, { strict: true }); }
    catch { threw = true; }
    ${assert('threw === true')}
    `);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  test('repairManagedNamedVolumes returns true when every managed volume repairs cleanly', () => {
    const result = runScenario(`
    const home = makeDir();
    const ok = await repairManagedNamedVolumes(home, ['guardian']);
    ${assert('ok === true')}
    `);
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  });
});
