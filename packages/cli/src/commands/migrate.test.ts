import { afterEach, describe, expect, mock, test } from 'bun:test';

const cliStateUrl = new URL('../lib/cli-state.ts', import.meta.url).href;
const migrateModuleUrl = new URL('./migrate.ts', import.meta.url).href;

function stubLib(overrides: Record<string, unknown> = {}) {
  mock.module('@openpalm/lib', () => ({
    ensureMigrated: () => ({ migrated: false, from: 1, to: 1, applied: [], backupDir: null, notes: [], releaseFrom: null, releaseTo: '', releaseApplied: [] }),
    ensureReleaseMigrated: () => ({ migrated: false, from: null, to: 'v0.12.0', applied: [], backupDir: null, notes: [] }),
    resolveDefaultMigrateTarget: async () => 'v0.12.0',
    formatForDisplay: (v: string) => v.replace(/^v/, ''),
    MigrationError: class MigrationError extends Error { guidance = ''; backupDir: string | null = null; },
    ...overrides,
  }));
  mock.module(cliStateUrl, () => ({ ensureValidState: () => ({ homeDir: '/tmp/op' }) }));
}

afterEach(() => {
  mock.restore();
});

describe('migrate --to (#497)', () => {
  test('`--to` without `--dry-run` is rejected (preview only)', async () => {
    stubLib();
    const exit = mock(() => { throw new Error('exit'); });
    const origExit = process.exit;
    // @ts-expect-error test stub
    process.exit = exit;
    const errs: string[] = [];
    const origErr = console.error;
    console.error = (m: unknown) => { errs.push(String(m)); };
    try {
      const cmd = (await import(migrateModuleUrl + `?t=${Math.random()}`)).default;
      await expect(cmd.run({ args: { to: 'v0.12.0', 'dry-run': false } })).rejects.toThrow('exit');
    } finally {
      process.exit = origExit;
      console.error = origErr;
    }
    expect(exit).toHaveBeenCalledWith(1);
    expect(errs.join('\n')).toContain('--dry-run');
  });

  test('`--dry-run --to <version>` routes through ensureReleaseMigrated with the target', async () => {
    let targetSeen: string | null = null;
    stubLib({
      ensureReleaseMigrated: (opts: { targetVersion: string }) => {
        targetSeen = opts.targetVersion;
        return { migrated: false, from: null, to: opts.targetVersion, applied: [], backupDir: null, notes: [] };
      },
    });
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (m: unknown) => { logs.push(String(m)); };
    try {
      const cmd = (await import(migrateModuleUrl + `?t=${Math.random()}`)).default;
      await cmd.run({ args: { to: 'v0.11.5', 'dry-run': true } });
    } finally {
      console.log = origLog;
    }
    expect(targetSeen).toBe('v0.11.5');
    expect(logs.join('\n')).toContain('[dry-run]');
  });

  test('`--dry-run --to` with no value defaults to the newest published tag', async () => {
    let resolved = false;
    let targetSeen: string | null = null;
    stubLib({
      resolveDefaultMigrateTarget: async () => { resolved = true; return 'v0.12.0'; },
      ensureReleaseMigrated: (opts: { targetVersion: string }) => {
        targetSeen = opts.targetVersion;
        return { migrated: false, from: null, to: opts.targetVersion, applied: [], backupDir: null, notes: [] };
      },
    });
    const origLog = console.log;
    console.log = () => {};
    try {
      const cmd = (await import(migrateModuleUrl + `?t=${Math.random()}`)).default;
      await cmd.run({ args: { to: '', 'dry-run': true } });
    } finally {
      console.log = origLog;
    }
    expect(resolved).toBe(true);
    expect(targetSeen).toBe('v0.12.0');
  });
});
