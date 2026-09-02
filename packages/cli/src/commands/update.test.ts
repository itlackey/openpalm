import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLATFORM_VERSION } from '@openpalm/lib';
import { assertCliVersionAllowsUpgrade, describeUpgradeFailure, resolveUpgradeState } from './update.ts';

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

// #662: `openpalm update` finishing with an older CLI managing a newer stack.
describe('assertCliVersionAllowsUpgrade', () => {
  test('is a no-op when the CLI matches the target release', () => {
    expect(() => assertCliVersionAllowsUpgrade(PLATFORM_VERSION, false)).not.toThrow();
  });

  test('is a no-op when the CLI is NEWER than the target (the normal upgrade direction)', () => {
    expect(() => assertCliVersionAllowsUpgrade('999.0.0', false)).not.toThrow();
  });

  test('refuses and names `openpalm self-update` when the CLI is older than the target release', () => {
    expect(() => assertCliVersionAllowsUpgrade('0.0.1', false)).toThrow(/openpalm self-update/);
    try {
      assertCliVersionAllowsUpgrade('0.0.1', false);
      throw new Error('expected assertCliVersionAllowsUpgrade to throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain('0.0.1');
      expect(message).toContain(PLATFORM_VERSION);
      expect(message).toContain('--allow-version-skew');
    }
  });

  test('--allow-version-skew proceeds anyway', () => {
    expect(() => assertCliVersionAllowsUpgrade('0.0.1', true)).not.toThrow();
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
