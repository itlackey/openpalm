import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliCurrencyError, describeUpgradeFailure, ensureCliCurrent, resolveUpgradeState } from './update.ts';
import type { EnsureCliCurrentDeps } from './update.ts';

const homes: string[] = [];

afterEach(() => {
  delete process.env.OP_HOME;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe('resolveUpgradeState', () => {
  test('accepts a pre-system-tree install so update can migrate it', () => {
    const home = mkdtempSync(join(tmpdir(), 'openpalm-update-legacy-'));
    homes.push(home);
    process.env.OP_HOME = home;
    mkdirSync(join(home, 'config', 'stack'), { recursive: true });
    mkdirSync(join(home, 'knowledge', 'secrets'), { recursive: true });
    writeFileSync(join(home, 'config', 'stack', 'core.compose.yml'), 'services: {}\n');
    writeFileSync(join(home, 'knowledge', 'secrets', 'op_guardian_admin_token'), 'admin\n');
    writeFileSync(join(home, 'knowledge', 'secrets', 'op_guardian_mcp_token'), 'mcp\n');

    const state = resolveUpgradeState();

    expect(state.homeDir).toBe(home);
    expect(state.stackDir).toBe(join(home, 'system', 'stack'));
  });

  test('still rejects an empty home', () => {
    const home = mkdtempSync(join(tmpdir(), 'openpalm-update-empty-'));
    homes.push(home);
    process.env.OP_HOME = home;

    expect(() => resolveUpgradeState()).toThrow('OpenPalm is not installed');
  });
});

// #674: `openpalm update` phase 1 — bring an older CLI current BEFORE it
// deploys anything, rather than #662's same-build comparison that could
// never trip inside a compiled binary (cliPkg.version and PLATFORM_VERSION
// are stamped from the same build). Every test injects deps so none of this
// touches the network or a real executable.
describe('ensureCliCurrent', () => {
  function fakeDeps(overrides: Partial<EnsureCliCurrentDeps> = {}): {
    deps: Partial<EnsureCliCurrentDeps>;
    calls: { resolveLatestTag: number; downloadBinary: string[]; replaceExecutable: Array<[string, string]>; reexec: string[][] };
  } {
    const calls = {
      resolveLatestTag: 0,
      downloadBinary: [] as string[],
      replaceExecutable: [] as Array<[string, string]>,
      reexec: [] as string[][],
    };
    const deps: Partial<EnsureCliCurrentDeps> = {
      resolveLatestTag: async () => {
        calls.resolveLatestTag++;
        return '9.9.9';
      },
      downloadBinary: async (tag) => {
        calls.downloadBinary.push(tag);
        return '/tmp/fake-openpalm-binary';
      },
      replaceExecutable: (tempBinary, execPath) => {
        calls.replaceExecutable.push([tempBinary, execPath]);
      },
      reexec: (argv) => {
        calls.reexec.push(argv);
        return 0;
      },
      canReplace: () => true,
      canWriteDir: () => true,
      platform: 'linux',
      execPath: '/opt/openpalm/bin/openpalm',
      ...overrides,
    };
    return { deps, calls };
  }

  test('an older CLI downloads, replaces, and re-execs with the original argv plus --no-self-update, passing through the exit code', async () => {
    const { deps, calls } = fakeDeps();
    const originalArgv = process.argv;
    process.argv = ['bun', 'openpalm', 'update', '--allow-version-skew'];
    try {
      const result = await ensureCliCurrent({ cliVersion: '0.0.1' }, deps);
      expect(result).toEqual({ action: 'reexec', exitCode: 0 });
    } finally {
      process.argv = originalArgv;
    }
    expect(calls.downloadBinary).toEqual(['9.9.9']);
    expect(calls.replaceExecutable).toEqual([['/tmp/fake-openpalm-binary', '/opt/openpalm/bin/openpalm']]);
    expect(calls.reexec).toEqual([['update', '--allow-version-skew', '--no-self-update']]);
  });

  test('a phase-1 abort reports that nothing was changed, not the rollback hint', async () => {
    const { deps } = fakeDeps({ resolveLatestTag: async () => null });
    let thrown: unknown;
    try {
      await ensureCliCurrent({ cliVersion: '0.0.1' }, deps);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CliCurrencyError);
    const outcome = describeUpgradeFailure(thrown);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.finalStateLine).toContain('nothing was changed');
    expect(outcome.finalStateLine).not.toContain('rollback');
  });

  test('propagates a non-zero re-exec exit code', async () => {
    const { deps } = fakeDeps({ reexec: () => 3 });
    const result = await ensureCliCurrent({ cliVersion: '0.0.1' }, deps);
    expect(result).toEqual({ action: 'reexec', exitCode: 3 });
  });

  test('an equal CLI version is a no-op — no download, no reexec', async () => {
    const { deps, calls } = fakeDeps();
    const result = await ensureCliCurrent({ cliVersion: '9.9.9' }, deps);
    expect(result).toEqual({ action: 'current' });
    expect(calls.downloadBinary).toEqual([]);
    expect(calls.reexec.length).toBe(0);
  });

  test('a newer CLI version is a no-op (the normal upgrade direction)', async () => {
    const { deps, calls } = fakeDeps();
    const result = await ensureCliCurrent({ cliVersion: '999.0.0' }, deps);
    expect(result).toEqual({ action: 'current' });
    expect(calls.downloadBinary).toEqual([]);
  });

  test('an unparseable CLI version never even resolves the latest tag', async () => {
    const { deps, calls } = fakeDeps();
    const result = await ensureCliCurrent({ cliVersion: 'dev' }, deps);
    expect(result).toEqual({ action: 'current' });
    expect(calls.resolveLatestTag).toBe(0);
  });

  test('--no-self-update skips phase 1 entirely, without resolving a tag', async () => {
    const { deps, calls } = fakeDeps();
    const result = await ensureCliCurrent({ cliVersion: '0.0.1', noSelfUpdate: true }, deps);
    expect(result).toEqual({ action: 'skip' });
    expect(calls.resolveLatestTag).toBe(0);
  });

  test('an unresolvable target release aborts without --allow-version-skew, naming both flags', async () => {
    const { deps } = fakeDeps({ resolveLatestTag: async () => null });
    await expect(ensureCliCurrent({ cliVersion: '0.0.1' }, deps)).rejects.toThrow(
      /--no-self-update/,
    );
    await expect(ensureCliCurrent({ cliVersion: '0.0.1' }, deps)).rejects.toThrow(
      /--allow-version-skew/,
    );
  });

  test('an unresolvable target release falls back with --allow-version-skew instead of aborting', async () => {
    const { deps, calls } = fakeDeps({ resolveLatestTag: async () => null });
    const result = await ensureCliCurrent({ cliVersion: '0.0.1', allowVersionSkew: true }, deps);
    expect(result.action).toBe('fallback');
    expect(calls.downloadBinary).toEqual([]);
  });

  test('refuses on win32, naming setup.ps1 --cli-only, without downloading', async () => {
    const { deps, calls } = fakeDeps({ platform: 'win32' });
    await expect(ensureCliCurrent({ cliVersion: '0.0.1' }, deps)).rejects.toThrow(
      /setup\.ps1 --cli-only/,
    );
    expect(calls.downloadBinary).toEqual([]);
  });

  test('refuses a bun-run checkout, naming setup.sh --cli-only, without downloading', async () => {
    const { deps, calls } = fakeDeps({ canReplace: () => false });
    await expect(ensureCliCurrent({ cliVersion: '0.0.1' }, deps)).rejects.toThrow(
      /setup\.sh --cli-only/,
    );
    expect(calls.downloadBinary).toEqual([]);
  });

  test('refuses an unwritable executable directory, naming an alternative, without downloading', async () => {
    const { deps, calls } = fakeDeps({ canWriteDir: () => false });
    await expect(ensureCliCurrent({ cliVersion: '0.0.1' }, deps)).rejects.toThrow(
      /setup\.sh --cli-only/,
    );
    expect(calls.downloadBinary).toEqual([]);
  });

});

// #667: `openpalm update` exits 0 when both the upgrade and the automatic
// rollback fail and the stack is left down. `isRollbackRecoveryFailure`
// (lifecycle.ts) keys off a module-private marker only `runWithSnapshotRollback`
// can set — driving that end-to-end (a real performUpgrade whose automatic
// rollback also fails) belongs in packages/lib, alongside the marker itself:
// see pre-mutation-refusal-and-rollback-failure coverage in
// packages/lib/src/control-plane/rollback-recovery-marker.test.ts. This file
// covers what `describeUpgradeFailure` does with the two shapes it can
// actually be handed: an ordinary Error, and a non-Error throw.
describe('describeUpgradeFailure', () => {
  test('an ordinary upgrade failure (rollback recovered, or nothing attempted) exits 1 with the generic rollback hint', () => {
    const outcome = describeUpgradeFailure(new Error('Failed to apply stack: simulated'));
    expect(outcome.exitCode).toBe(1);
    expect(outcome.finalStateLine).toContain('openpalm rollback');
    expect(outcome.finalStateLine).not.toMatch(/DOWN/);
  });

  test('a non-Error thrown value still gets the generic (exit 1) outcome', () => {
    const outcome = describeUpgradeFailure('a plain string throw');
    expect(outcome.exitCode).toBe(1);
  });
});
