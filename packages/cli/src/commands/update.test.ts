import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveUpgradeState } from './update.ts';

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
