import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = join(import.meta.dir, 'prepare-akm-09-config.mjs');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runMigration(source: Record<string, unknown>, existingTarget?: string) {
  const root = mkdtempSync(join(tmpdir(), 'openpalm-akm-09-'));
  roots.push(root);
  const sourcePath = join(root, 'config.json');
  const targetPath = join(root, 'target.json');
  writeFileSync(sourcePath, JSON.stringify(source));
  if (existingTarget !== undefined) writeFileSync(targetPath, existingTarget);
  const result = Bun.spawnSync(['node', script, sourcePath, targetPath], {
    env: { ...process.env, AKM_BUNDLE_DIR: '/stash' },
  });
  return {
    root,
    result,
    sourcePath,
    targetPath,
    target: result.exitCode === 0 ? JSON.parse(readFileSync(targetPath, 'utf8')) : undefined,
  };
}

function stampMissingVersion(source: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'openpalm-akm-09-stamp-'));
  roots.push(root);
  const sourcePath = join(root, 'config.json');
  writeFileSync(sourcePath, JSON.stringify(source));
  const result = Bun.spawnSync(['node', script, '--stamp-missing', sourcePath]);
  return { root, result, sourcePath };
}

function expectCollisionPreservesTarget(source: Record<string, unknown>, expectedError: string) {
  const retained = 'retained-target\n';
  const { result, targetPath } = runMigration(source, retained);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr.toString()).toContain(expectedError);
  expect(readFileSync(targetPath, 'utf8')).toBe(retained);
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

  test('accepts valid lowercase API key environment references', () => {
    const { result, target } = runMigration({
      configVersion: '0.8.0',
      profiles: {
        llm: {
          default: {
            endpoint: 'https://api.example/v1/chat/completions',
            model: 'model',
            apiKey: '${provider_api_key}',
          },
        },
      },
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(target.engines.default.apiKey).toBe('${provider_api_key}');
  });

  test('preserves explicit top-level writable intent on the primary old-shape source', () => {
    for (const writable of [false, true]) {
      const { result, target } = runMigration({
        configVersion: '0.8.0',
        stashDir: '/stash',
        writable,
        sources: [{ type: 'filesystem', path: '/host-stash', name: 'host-akm' }],
      });

      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(target.writable).toBeUndefined();
      expect(target.sources[0]).toEqual({
        type: 'filesystem',
        path: '/stash',
        primary: true,
        writable,
      });
      expect(target.sources[1]).toMatchObject({ path: '/host-stash', name: 'host-akm' });
    }

    const explicitPrimary = runMigration({
      configVersion: '0.8.0',
      stashDir: '/stash',
      writable: false,
      sources: [{ type: 'filesystem', path: '/custom-primary', primary: true, writable: true }],
    });
    expect(explicitPrimary.result.exitCode, explicitPrimary.result.stderr.toString()).toBe(0);
    expect(explicitPrimary.target.sources[0].writable).toBe(false);
  });

  test('uses explicit process and judgment modes to resolve profile names', () => {
    const { result, target } = runMigration({
      configVersion: '0.8.0',
      profiles: {
        llm: {
          reviewer: { endpoint: 'https://api.example/v1/chat/completions', model: 'llm' },
        },
        agent: {
          worker: { platform: 'opencode' },
          'sdk-worker': { platform: 'opencode-sdk' },
        },
        improve: {
          default: {
            processes: {
              reflect: { mode: 'llm', profile: 'reviewer' },
              distill: { mode: 'agent', profile: 'worker' },
              validation: { mode: 'agent' },
              triage: { judgment: { mode: 'sdk', profile: 'sdk-worker' } },
            },
          },
        },
      },
      defaults: { agent: 'worker' },
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    const processes = target.improve.strategies.default.processes;
    expect(processes.reflect.engine).toBe('reviewer');
    expect(processes.distill.engine).toBe('worker');
    expect(processes.validation.engine).toBe('worker');
    expect(processes.triage.judgment.engine).toBe('sdk-worker');
  });

  test('rejects unsupported process modes without replacing the target', () => {
    const profiles = {
      llm: { reviewer: { endpoint: 'https://api.example/v1/chat/completions', model: 'llm' } },
      agent: { worker: { platform: 'opencode' } },
    };
    expectCollisionPreservesTarget(
      {
        configVersion: '0.8.0',
        profiles: {
          ...profiles,
          improve: { default: { processes: { reflect: { mode: 'human', profile: 'worker' } } } },
        },
      },
      'unsupported mode "human"',
    );
  });

  test('rejects mode/profile mismatches without replacing the target', () => {
    const profiles = {
      llm: { llm: { endpoint: 'https://api.example/v1/chat/completions', model: 'llm' } },
      agent: {
        agent: { platform: 'opencode' },
        sdk: { platform: 'opencode-sdk' },
      },
    };
    const withTriage = (triage: Record<string, unknown>) => ({
      configVersion: '0.8.0',
      profiles: {
        ...profiles,
        improve: { default: { processes: { triage } } },
      },
    });

    expectCollisionPreservesTarget(
      withTriage({ mode: 'llm', profile: 'agent' }),
      'unknown LLM profile "agent"',
    );
    expectCollisionPreservesTarget(
      withTriage({ mode: 'agent', profile: 'llm' }),
      'unknown agent profile "llm"',
    );
    expectCollisionPreservesTarget(
      withTriage({ mode: 'sdk', profile: 'agent' }),
      'mode "sdk" requires an agent profile with platform "opencode-sdk"',
    );
    expectCollisionPreservesTarget(
      withTriage({ mode: 'agent', profile: 'sdk' }),
      'mode "agent" cannot use an "opencode-sdk" agent profile',
    );
    expectCollisionPreservesTarget(
      withTriage({ judgment: { mode: 'agent', profile: 'llm' } }),
      'judgment references unknown agent profile "llm"',
    );
  });

  test('fails with actionable guidance instead of dropping improve autoAccept', () => {
    for (const autoAccept of [0, 90]) {
      expectCollisionPreservesTarget(
        {
          configVersion: '0.8.0',
          profiles: { improve: { default: { autoAccept } } },
        },
        'akm proposal drain --promote --yes',
      );
    }
    const { result } = runMigration({
      configVersion: '0.8.0',
      profiles: { improve: { default: { autoAccept: 90 } } },
    });
    expect(result.stderr.toString()).toContain('triage `applyMode: "promote"`');
  });

  test('rejects colliding normalized profile slugs without replacing the target', () => {
    expectCollisionPreservesTarget(
      {
        configVersion: '0.8.0',
        profiles: { llm: { 'Primary Model': {}, primary_model: {} } },
      },
      'both normalize to engine "primary-model"',
    );
    expectCollisionPreservesTarget(
      {
        configVersion: '0.8.0',
        profiles: { agent: { 'Code Worker': {}, code_worker: {} } },
      },
      'both normalize to engine "code-worker"',
    );
    expectCollisionPreservesTarget(
      {
        configVersion: '0.8.0',
        profiles: { llm: { worker: {} }, agent: { worker: {} } },
      },
      'LLM and agent profiles both normalize to engine "worker"',
    );
  });

  test('rejects truncation and fallback collisions without replacing the target', () => {
    const prefix = 'a'.repeat(63);
    expectCollisionPreservesTarget(
      {
        configVersion: '0.8.0',
        profiles: { llm: { [`${prefix}x`]: {}, [`${prefix}y`]: {} } },
      },
      `both normalize to engine "${prefix}"`,
    );
    expectCollisionPreservesTarget(
      {
        configVersion: '0.8.0',
        profiles: { improve: { '!!!': {}, 'akm-reserved': {} } },
      },
      'both normalize to strategy "custom"',
    );
  });

  test('rejects profile collisions with existing engines and strategies without replacing the target', () => {
    expectCollisionPreservesTarget(
      {
        configVersion: '0.8.0',
        engines: { shared: { kind: 'llm' } },
        profiles: { llm: { shared: {} } },
      },
      'normalizes to existing engine "shared"',
    );
    expectCollisionPreservesTarget(
      {
        configVersion: '0.8.0',
        engines: { shared: { kind: 'agent' } },
        profiles: { agent: { shared: {} } },
      },
      'normalizes to existing engine "shared"',
    );
    expectCollisionPreservesTarget(
      {
        configVersion: '0.8.0',
        improve: { strategies: { nightly: { processes: {} } } },
        profiles: { improve: { nightly: { processes: {} } } },
      },
      'normalizes to existing strategy "nightly"',
    );
  });

  test('rejects colliding improve profile slugs without replacing the target', () => {
    expectCollisionPreservesTarget(
      {
        configVersion: '0.8.0',
        profiles: { improve: { 'Nightly Review': {}, nightly_review: {} } },
      },
      'both normalize to strategy "nightly-review"',
    );
  });

  test('atomically replaces a torn target with a mode-0600 complete file', () => {
    const { root, result, target, targetPath } = runMigration(
      { configVersion: '0.8.0', stashDir: '/stash' },
      '{',
    );

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(target.configVersion).toBe('0.9.0');
    expect(statSync(targetPath).mode & 0o777).toBe(0o600);
    expect(readdirSync(root).some((entry) => entry.endsWith('.tmp'))).toBe(false);
  });

  test('durably stamps a missing version without changing an exact old version', () => {
    const missing = stampMissingVersion({ stashDir: '/stash' });
    expect(missing.result.exitCode, missing.result.stderr.toString()).toBe(0);
    expect(JSON.parse(readFileSync(missing.sourcePath, 'utf8')).configVersion).toBe('0.8.0');
    expect(statSync(missing.sourcePath).mode & 0o777).toBe(0o600);
    expect(readdirSync(missing.root).some((entry) => entry.endsWith('.tmp'))).toBe(false);

    const exactSource = { configVersion: '0.8.0', stashDir: '/stash' };
    const exact = stampMissingVersion(exactSource);
    expect(exact.result.exitCode, exact.result.stderr.toString()).toBe(0);
    expect(readFileSync(exact.sourcePath, 'utf8')).toBe(JSON.stringify(exactSource));
  });

  test('refuses a forward source without replacing an existing target', () => {
    const { result, targetPath } = runMigration({ configVersion: '1.0.0' }, 'retained-target\n');

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain('unsupported AKM config version "1.0.0"');
    expect(readFileSync(targetPath, 'utf8')).toBe('retained-target\n');
  });

  test('fsyncs file content and the parent directory around atomic rename', () => {
    const implementation = readFileSync(script, 'utf8');

    expect(implementation).toContain('fsyncSync(descriptor)');
    expect(implementation).toContain("const directoryDescriptor = openSync(directory, 'r')");
    expect(implementation).toContain('fsyncSync(directoryDescriptor)');
    expect(implementation.indexOf('fsyncSync(descriptor)')).toBeLessThan(
      implementation.indexOf('renameSync(temporary, file)'),
    );
  });
});
