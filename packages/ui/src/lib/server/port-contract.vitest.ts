import { afterEach, describe, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileSupervisedPortContract } from './port-contract.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(stackEnv: string): { homeDir: string; uiBuildDir: string } {
  const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-port-contract-'));
  const uiBuildDir = join(homeDir, 'ui');
  homes.push(homeDir);
  mkdirSync(join(homeDir, 'knowledge', 'env'), { recursive: true });
  writeFileSync(join(homeDir, 'knowledge', 'env', 'stack.env'), stackEnv);
  return { homeDir, uiBuildDir };
}

function runtimeBaseUrl(uiBuildDir: string): string {
  const config = JSON.parse(
    readFileSync(join(uiBuildDir, 'client', 'runtime-config.json'), 'utf8'),
  ) as { connections: Array<{ baseUrl: string }> };
  return config.connections[0]?.baseUrl ?? '';
}

describe('supervised UI port-contract migration', () => {
  test('repairs retired inherited defaults and reseeds the browser connection', () => {
    const { homeDir, uiBuildDir } = fixture('OP_ASSISTANT_PORT=3800\n');
    const env: Record<string, string | undefined> = {
      OP_UI_SUPERVISOR: 'electron',
      OP_ASSISTANT_PORT: '3800',
      OP_UI_PORT: '3810',
      OP_OPENCODE_URL: 'http://127.0.0.1:3800',
    };

    expect(reconcileSupervisedPortContract(homeDir, uiBuildDir, env)).toBe(true);
    expect(env.OP_ASSISTANT_PORT).toBe('3810');
    expect(env.OP_UI_PORT).toBe('3800');
    expect(env.OP_OPENCODE_URL).toBeUndefined();
    expect(runtimeBaseUrl(uiBuildDir)).toBe('http://127.0.0.1:3810');
  });

  test('preserves :3800 when migrated config intentionally keeps OpenCode there', () => {
    const { homeDir, uiBuildDir } = fixture('OP_UI_PORT=4900\n');
    const env: Record<string, string | undefined> = {
      OP_UI_SUPERVISOR: 'electron',
      OP_ASSISTANT_PORT: '3800',
      OP_UI_PORT: '4900',
      OP_OPENCODE_URL: 'http://127.0.0.1:3800',
    };

    expect(reconcileSupervisedPortContract(homeDir, uiBuildDir, env)).toBe(true);
    expect(env.OP_OPENCODE_URL).toBe('http://127.0.0.1:3800');
    expect(runtimeBaseUrl(uiBuildDir)).toBe('http://127.0.0.1:3800');
  });

  test('preserves an explicit CLI OpenCode URL override', () => {
    const { homeDir, uiBuildDir } = fixture('OP_ASSISTANT_PORT=3800\n');
    const env: Record<string, string | undefined> = {
      OP_UI_SUPERVISOR: 'cli',
      OP_ASSISTANT_PORT: '3800',
      OP_UI_PORT: '3810',
      OP_OPENCODE_URL: 'http://127.0.0.1:3800',
    };

    expect(reconcileSupervisedPortContract(homeDir, uiBuildDir, env)).toBe(true);
    expect(env.OP_ASSISTANT_PORT).toBe('3810');
    expect(env.OP_OPENCODE_URL).toBe('http://127.0.0.1:3800');
    expect(runtimeBaseUrl(uiBuildDir)).toBe('http://127.0.0.1:3800');
  });
});
