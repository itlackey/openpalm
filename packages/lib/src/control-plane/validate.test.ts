/**
 * Tests for validateProposedState()'s akm-engines advisory (issue #645).
 *
 * `openpalm validate` used to report "Configuration OK." with no signal at
 * all when the assistant's akm config had migrated to the current
 * `configVersion` but ended up with zero configured `engines` — exactly the
 * state a 0.12.x -> 0.13.x upgrade left behind before profiles.llm.* was
 * translated forward. This is a non-blocking WARNING, not an error: akm 0.9
 * itself treats zero configured engines as a supported state (it falls back
 * to opencode-sdk when the opencode binary is present), so promoting this to
 * an error would fail closed on a state akm does not consider broken.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateProposedState } from './validate.js';
import type { ControlPlaneState } from './types.js';

const homes: string[] = [];

afterEach(() => {
  let home = homes.pop();
  while (home) {
    rmSync(home, { recursive: true, force: true });
    home = homes.pop();
  }
});

/** A temp OP_HOME with the two required-secret checks already satisfied. */
function seedHome(): { state: ControlPlaneState; home: string } {
  const home = mkdtempSync(join(tmpdir(), 'validate-akm-engines-'));
  homes.push(home);

  mkdirSync(join(home, 'state'), { recursive: true });
  writeFileSync(join(home, 'state', 'stack.env'), 'OP_IMAGE_TAG=v0.13.1\n');
  const stateSecrets = join(home, 'state', 'secrets');
  mkdirSync(stateSecrets, { recursive: true, mode: 0o700 });
  writeFileSync(join(stateSecrets, 'op_ui_login_password'), 'test-password\n', { mode: 0o600 });

  const state = {
    homeDir: home,
    configDir: join(home, 'config'),
    stashDir: join(home, 'knowledge'),
    workspaceDir: join(home, 'workspace'),
    dataDir: join(home, 'data'),
  } as unknown as ControlPlaneState;

  return { state, home };
}

function writeAkmConfig(home: string, config: Record<string, unknown>): void {
  const dir = join(home, 'config', 'akm');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
}

describe('validateProposedState: akm engines advisory (issue #645)', () => {
  it('warns, but stays ok, when an existing akm config has zero engines', async () => {
    const { state, home } = seedHome();
    writeAkmConfig(home, {
      configVersion: '0.9.0',
      bundles: { openpalm: { path: '/stash', writable: true } },
      defaultBundle: 'openpalm',
      engines: {},
    });

    const result = await validateProposedState(state);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('no akm engines configured');
  });

  it('does not warn when the config carries a configured engine', async () => {
    const { state, home } = seedHome();
    writeAkmConfig(home, {
      configVersion: '0.9.0',
      bundles: { openpalm: { path: '/stash', writable: true } },
      defaultBundle: 'openpalm',
      engines: { default: { kind: 'llm', endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' } },
    });

    const result = await validateProposedState(state);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('does not warn when there is no akm config yet (nothing installed)', async () => {
    const { state } = seedHome();

    const result = await validateProposedState(state);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it('does not warn on an unparseable akm config — akm itself fails closed and names the parse error', async () => {
    const { state, home } = seedHome();
    const dir = join(home, 'config', 'akm');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), '{ not json');

    const result = await validateProposedState(state);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });
});
