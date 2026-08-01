import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dir, 'prepare-akm-09-config.mjs');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runMigration(source: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'openpalm-akm-09-'));
  roots.push(root);
  const sourcePath = join(root, 'config.json');
  const targetPath = join(root, 'target.json');
  writeFileSync(sourcePath, JSON.stringify(source));
  const result = Bun.spawnSync(['node', script, sourcePath, targetPath], {
    env: { ...process.env, AKM_BUNDLE_DIR: '/stash' },
  });
  return {
    result,
    target: result.exitCode === 0 ? JSON.parse(readFileSync(targetPath, 'utf8')) : undefined,
  };
}

describe('prepare-akm-09-config', () => {
  test('converts profiles, defaults, processes, and refs without touching source locations', () => {
    const { result, target } = runMigration({
      configVersion: '0.8.0',
      stashDir: '/stash',
      sources: [{ type: 'filesystem', path: '/host-stash', name: 'host-akm', writable: true }],
      profiles: {
        llm: { default: { endpoint: 'https://api.example/v1/chat/completions', model: 'model' } },
        agent: { worker: { platform: 'opencode' } },
        improve: {
          nightly: {
            processes: {
              reflect: { mode: 'llm', profile: 'default' },
              recombine: { enabled: true, minClusterSize: 3 },
            },
          },
        },
      },
      defaults: { llm: 'default', agent: 'worker', improve: 'nightly' },
    });

    expect(result.exitCode).toBe(0);
    expect(target.configVersion).toBe('0.9.0');
    expect(target.engines.default).toMatchObject({ kind: 'llm', model: 'model' });
    expect(target.engines.worker).toMatchObject({ kind: 'agent', platform: 'opencode' });
    expect(target.defaults).toMatchObject({ engine: 'worker', llmEngine: 'default', improveStrategy: 'nightly' });
    expect(target.improve.strategies.nightly.processes.reflect).toEqual({ engine: 'default' });
    expect(target.improve.strategies.nightly.processes.recombine).toEqual({
      enabled: false,
      minClusterSize: 3,
    });
    expect(result.stderr.toString()).toContain('disabled removed AKM improve process nightly.recombine');
    expect(target.profiles).toBeUndefined();
    expect(target.stashDir).toBe('/stash');
    expect(target.sources).toHaveLength(1);
  });

  test('fails rather than dropping a literal API key', () => {
    const { result } = runMigration({
      configVersion: '0.8.0',
      profiles: {
        llm: {
          default: {
            endpoint: 'https://api.example/v1/chat/completions',
            model: 'model',
            apiKey: 'secret',
          },
        },
      },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('literal apiKey');
  });
});
