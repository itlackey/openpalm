import { afterEach, describe, expect, test } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUiRuntimeConfigJson, UI_RUNTIME_CONFIG_ENV } from '@openpalm/lib';
import { reconcileSupervisedPortContract } from './port-contract.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(stackEnv: string): string {
  const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-port-contract-'));
  homes.push(homeDir);
  mkdirSync(join(homeDir, 'system', 'stack'), { recursive: true });
  writeFileSync(join(homeDir, 'system', 'stack', 'core.compose.yml'), 'services: {}\n');
  // A pre-consolidation home with no schema stamp: this is exactly the shape
  // the supervised repair exists for, and what runHomeMigrations upgrades.
  mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
  writeFileSync(
    join(homeDir, 'knowledge', 'env', 'stack.env'),
    `OP_SETUP_COMPLETE=true\n${stackEnv}`,
  );
  return homeDir;
}

function runtimeBaseUrl(env: Record<string, string | undefined>): string {
  const parsed = parseUiRuntimeConfigJson(env[UI_RUNTIME_CONFIG_ENV]);
  return parsed.status === 'valid' ? parsed.config.connections[0]?.baseUrl ?? '' : '';
}

describe('supervised UI port-contract migration', () => {
  test('repairs retired inherited defaults and reseeds the browser connection', () => {
    const homeDir = fixture('OP_ASSISTANT_PORT=3800\n');
    const env: Record<string, string | undefined> = {
      OP_UI_SUPERVISOR: 'electron',
      OP_ASSISTANT_PORT: '3800',
      OP_UI_PORT: '3810',
      OP_OPENCODE_URL: 'http://127.0.0.1:3800',
    };

    expect(reconcileSupervisedPortContract(homeDir, env)).toBe(true);
    expect(env.OP_ASSISTANT_PORT).toBe('3810');
    expect(env.OP_UI_PORT).toBe('3800');
    expect(env.OP_OPENCODE_URL).toBeUndefined();
    expect(runtimeBaseUrl(env)).toBe('/oc');
    expect(existsSync(join(homeDir, 'ui', 'client', 'runtime-config.json'))).toBe(false);
  });

  test('preserves :3800 when migrated config intentionally keeps OpenCode there', () => {
    const homeDir = fixture('OP_UI_PORT=4900\n');
    const env: Record<string, string | undefined> = {
      OP_UI_SUPERVISOR: 'electron',
      OP_ASSISTANT_PORT: '3800',
      OP_UI_PORT: '4900',
      OP_OPENCODE_URL: 'http://127.0.0.1:3800',
    };

    expect(reconcileSupervisedPortContract(homeDir, env)).toBe(true);
    expect(env.OP_OPENCODE_URL).toBe('http://127.0.0.1:3800');
  });

  test('preserves an explicit CLI OpenCode URL override', () => {
    const homeDir = fixture('OP_ASSISTANT_PORT=3800\n');
    const env: Record<string, string | undefined> = {
      OP_UI_SUPERVISOR: 'cli',
      OP_ASSISTANT_PORT: '3800',
      OP_UI_PORT: '3810',
      OP_OPENCODE_URL: 'http://127.0.0.1:3800',
    };

    expect(reconcileSupervisedPortContract(homeDir, env)).toBe(true);
    expect(env.OP_ASSISTANT_PORT).toBe('3810');
    expect(env.OP_OPENCODE_URL).toBe('http://127.0.0.1:3800');
  });

  // The reason the two tests above no longer assert a browser-facing URL: the
  // seed is origin-relative, so a port migration cannot strand it. Whatever
  // OP_OPENCODE_URL ends up as is the SERVER's upstream, resolved per-request
  // by the /oc proxy — the browser never holds a port at all.
  test('the browser seed is origin-relative regardless of which ports moved', () => {
    for (const [stackEnv, opencodeUrl] of [
      ['OP_ASSISTANT_PORT=3800\n', 'http://127.0.0.1:3800'],
      ['OP_UI_PORT=4900\n', 'http://127.0.0.1:3800'],
    ] as const) {
      const env: Record<string, string | undefined> = {
        OP_UI_SUPERVISOR: 'cli',
        OP_ASSISTANT_PORT: '3800',
        OP_UI_PORT: '3810',
        OP_OPENCODE_URL: opencodeUrl,
      };
      expect(reconcileSupervisedPortContract(fixture(stackEnv), env)).toBe(true);
      expect(runtimeBaseUrl(env)).toBe('/oc');
    }
  });
});
