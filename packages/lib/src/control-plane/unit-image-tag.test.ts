/**
 * Per-unit image tag pinning tests.
 *
 * applyUnitImageTagChange pins a SINGLE deployable unit's image tag in
 * stack.env — it writes only that unit's OP_*_IMAGE_TAG, does NOT run release
 * migrations or refresh stack compose assets, and uses a per-unit downgrade
 * gate (compared against the unit's own tag, not the platform OP_IMAGE_TAG).
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { applyUnitImageTagChange, DowngradeConfirmationRequired } from './lifecycle.js';
import type { ControlPlaneState } from './types.js';

const realFetch = globalThis.fetch;

const lifecycleUrl = new URL('./lifecycle.ts', import.meta.url).href;
const moduleUrls = {
  composeArgs: new URL('./compose-args.js', import.meta.url).href,
  docker: new URL('./docker.js', import.meta.url).href,
  configPersistence: new URL('./config-persistence.js', import.meta.url).href,
  coreAssets: new URL('./core-assets.js', import.meta.url).href,
  installLock: new URL('./install-lock.js', import.meta.url).href,
  registry: new URL('./addons.js', import.meta.url).href,
  versioning: new URL('./versioning.js', import.meta.url).href,
};
const harnessDir = fileURLToPath(new URL('../../', import.meta.url));

afterEach(() => {
  globalThis.fetch = realFetch;
});

function makeState(stackEnv: string): ControlPlaneState {
  const home = mkdtempSync(join(tmpdir(), 'openpalm-unit-tag-'));
  mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
  mkdirSync(join(home, 'data'), { recursive: true });
  writeFileSync(join(home, 'knowledge', 'env', 'stack.env'), stackEnv);
  return {
    homeDir: home,
    configDir: join(home, 'config'),
    stashDir: join(home, 'knowledge'),
    workspaceDir: join(home, 'workspace'),
    dataDir: join(home, 'data'),
    stackDir: join(home, 'config', 'stack'),
    services: {},
    artifacts: { compose: '' },
    artifactMeta: [],
  };
}

// ── Direct tests (error thrown before compose calls — no subprocess needed) ──

describe('applyUnitImageTagChange input validation', () => {
  test('rejects an unknown deployable unit', async () => {
    const state = makeState('OP_IMAGE_NAMESPACE=openpalm\n');
    await expect(applyUnitImageTagChange(state, 'unknown', 'v0.12.5')).rejects.toThrow(
      /Unknown deployable unit/,
    );
  });
});

describe('applyUnitImageTagChange per-unit downgrade gate (#501)', () => {
  test('requires confirmation when the target is older than the unit current tag', async () => {
    const state = makeState('OP_IMAGE_NAMESPACE=openpalm\nOP_GUARDIAN_IMAGE_TAG=v0.12.7\n');
    let threw: unknown;
    try {
      await applyUnitImageTagChange(state, 'guardian', 'v0.12.5');
    } catch (e) { threw = e; }
    expect(threw).toBeInstanceOf(DowngradeConfirmationRequired);
    expect((threw as DowngradeConfirmationRequired).code).toBe('downgrade_confirmation_required');
    expect((threw as DowngradeConfirmationRequired).currentVersion).toBe('v0.12.7');
    expect((threw as DowngradeConfirmationRequired).targetVersion).toBe('v0.12.5');
  });

  test('does NOT throw the downgrade signal when confirmed', async () => {
    globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof fetch;
    const state = makeState('OP_IMAGE_NAMESPACE=openpalm\nOP_GUARDIAN_IMAGE_TAG=v0.12.7\n');
    let threw: unknown;
    try {
      await applyUnitImageTagChange(state, 'guardian', 'v0.12.5', { confirmDowngrade: true });
    } catch (e) { threw = e; }
    expect(threw).not.toBeInstanceOf(DowngradeConfirmationRequired);
  });

  test('compares against the unit own tag, not the platform OP_IMAGE_TAG', async () => {
    // Platform is at v0.12.0, guardian at v0.12.7. Pinning guardian to v0.12.6
    // is a downgrade for guardian (0.12.6 < 0.12.7) even though it is an upgrade
    // relative to the platform tag (0.12.6 > 0.12.0). The per-unit gate must fire.
    const state = makeState('OP_IMAGE_NAMESPACE=openpalm\nOP_IMAGE_TAG=v0.12.0\nOP_GUARDIAN_IMAGE_TAG=v0.12.7\n');
    let threw: unknown;
    try {
      await applyUnitImageTagChange(state, 'guardian', 'v0.12.6');
    } catch (e) { threw = e; }
    expect(threw).toBeInstanceOf(DowngradeConfirmationRequired);
    expect((threw as DowngradeConfirmationRequired).currentVersion).toBe('v0.12.7');
  });
});

describe('applyUnitImageTagChange publication check', () => {
  test('fails closed for an unpublished tag', async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/guardian/tags/v99.0.0')) {
        return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const state = makeState('OP_IMAGE_NAMESPACE=openpalm\nOP_GUARDIAN_IMAGE_TAG=v0.12.5\n');
    await expect(applyUnitImageTagChange(state, 'guardian', 'v99.0.0')).rejects.toThrow(
      /Refusing to pin openpalm\/guardian:v99\.0\.0: tag is not published/,
    );
  });
});

// ── Subprocess harness tests (need mocked compose/docker) ─────────────────────

type UnitTagScenario = {
  unit: string;
  tag: string;
  initialStackEnv: string;
  enabledAddons?: string[];
  /** Tags returned for tag-list calls (page_size queries) per image. */
  availableTagsByImage: Record<string, string[]>;
  /** Tags returned as published (200) for per-tag existence checks. */
  publishedTagsByImage: Record<string, string[]>;
  confirmDowngrade?: boolean;
};

function runUnitTagScenario(scenario: UnitTagScenario): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const tempDir = mkdtempSync(join(harnessDir, '.tmp-openpalm-unit-tag-'));
  const scriptPath = join(tempDir, 'unit-tag-scenario.ts');
  const runnerPath = join(tempDir, 'run-bun.sh');

  const script = `
import { mock } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const lifecycleUrl = ${JSON.stringify(lifecycleUrl)};
const scenario = ${JSON.stringify(scenario)};

function makeState() {
  const home = mkdtempSync(join(tmpdir(), 'openpalm-unit-tag-subproc-'));
  mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
  mkdirSync(join(home, 'config', 'stack'), { recursive: true });
  mkdirSync(join(home, 'data'), { recursive: true });
  writeFileSync(join(home, 'knowledge', 'env', 'stack.env'), scenario.initialStackEnv);
  process.env.OP_HOME = home;
  process.env.OP_SKIP_COMPOSE_PREFLIGHT = '1';
  return {
    homeDir: home,
    configDir: join(home, 'config'),
    stashDir: join(home, 'knowledge'),
    workspaceDir: join(home, 'workspace'),
    dataDir: join(home, 'data'),
    stackDir: join(home, 'config', 'stack'),
    services: {},
    artifacts: { compose: '' },
    artifactMeta: [],
  };
}

mock.module(${JSON.stringify(moduleUrls.composeArgs)}, () => ({
  buildComposeOptions: () => ({ files: [], envFiles: [], profiles: [] }),
}));
mock.module(${JSON.stringify(moduleUrls.docker)}, () => ({
  checkDocker: async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
  composePreflight: async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
  composePull: async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
  composeUp: async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
  composeConfigServices: async () => ({ ok: true, services: [] }),
  resolveComposeProjectName: () => 'openpalm',
  repairRootOwnedBindMounts: async () => {},
}));
mock.module(${JSON.stringify(moduleUrls.configPersistence)}, () => ({
  resolveRuntimeFiles: () => ({ compose: '' }),
  writeRuntimeFiles: () => {},
  discoverStackOverlays: () => [],
  ensureComposeVolumeTargets: () => {},
}));
mock.module(${JSON.stringify(moduleUrls.coreAssets)}, () => ({
  refreshCoreAssets: async () => ({ backupDir: null, updated: [] }),
}));
mock.module(${JSON.stringify(moduleUrls.installLock)}, () => ({
  acquireInstallLock: () => ({ path: 'test-lock' }),
  releaseInstallLock: () => {},
}));
mock.module(${JSON.stringify(moduleUrls.registry)}, () => ({
  getAddonServiceNames: () => [],
  listEnabledAddonIds: () => scenario.enabledAddons ?? [],
}));
{
  const realVersioning = await import(${JSON.stringify(moduleUrls.versioning)});
  mock.module(${JSON.stringify(moduleUrls.versioning)}, () => ({
    ...realVersioning,
    PLATFORM_VERSION: 'v99.0.0',
  }));
}

globalThis.fetch = async (input) => {
  const url = String(input);
  for (const [imageName, tags] of Object.entries(scenario.availableTagsByImage)) {
    if (url.includes('/' + imageName + '/tags?page_size=')) {
      return new Response(JSON.stringify({ results: tags.map((name) => ({ name })) }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  }
  for (const [imageName, tags] of Object.entries(scenario.publishedTagsByImage)) {
    const tagMatch = url.match(new RegExp('/' + imageName + '/tags/(v[^/?]+)'));
    if (tagMatch) {
      const tag = tagMatch[1];
      const status = tags.includes(tag) ? 200 : 404;
      return new Response('{}', { status, headers: { 'content-type': 'application/json' } });
    }
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};

async function main() {
  try {
    const state = makeState();
    const lifecycle = await import(lifecycleUrl + '?unit=' + Math.random());
    const result = await lifecycle.applyUnitImageTagChange(state, scenario.unit, scenario.tag, {
      confirmDowngrade: scenario.confirmDowngrade ?? false,
    });
    const finalStackEnv = readFileSync(join(state.stashDir, 'env', 'stack.env'), 'utf-8');
    console.log(JSON.stringify({ result, finalStackEnv }));
    process.exit(0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

await main();
`;

  const runner = '#!/usr/bin/env bash\nexec bun "$1"\n';

  try {
    writeFileSync(scriptPath, script);
    writeFileSync(runnerPath, runner);
    const proc = spawnSync('bash', [runnerPath, scriptPath], {
      cwd: harnessDir,
      encoding: 'utf8',
    });
    return {
      exitCode: proc.status ?? 1,
      stdout: proc.stdout ?? '',
      stderr: proc.stderr ?? '',
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function parseResult(output: string): { result: { imageTag: string }; finalStackEnv: string } {
  return JSON.parse(output.trim()) as { result: { imageTag: string }; finalStackEnv: string };
}

describe('applyUnitImageTagChange successful pin', () => {
  test('writes only the specified unit tag — other units untouched', () => {
    const result = runUnitTagScenario({
      unit: 'guardian',
      tag: 'v0.12.7',
      initialStackEnv: [
        'OP_IMAGE_NAMESPACE=openpalm',
        'OP_IMAGE_TAG=v0.12.0',
        'OP_ASSISTANT_IMAGE_TAG=v0.12.5',
        'OP_GUARDIAN_IMAGE_TAG=v0.12.5',
        '',
      ].join('\n'),
      enabledAddons: ['discord'],
      availableTagsByImage: { guardian: ['v0.12.7', 'v0.12.5'] },
      publishedTagsByImage: { guardian: ['v0.12.7'] },
    });

    expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    const { finalStackEnv } = parseResult(result.stdout);
    expect(finalStackEnv).toContain('OP_GUARDIAN_IMAGE_TAG=v0.12.7');
    // Assistant tag must NOT have changed.
    expect(finalStackEnv).toContain('OP_ASSISTANT_IMAGE_TAG=v0.12.5');
    expect(finalStackEnv).not.toMatch(/OP_ASSISTANT_IMAGE_TAG=v0\.12\.7/);
  });

  test('"latest" resolves to the concrete tag for the unit image', () => {
    const result = runUnitTagScenario({
      unit: 'guardian',
      tag: 'latest',
      initialStackEnv: [
        'OP_IMAGE_NAMESPACE=openpalm',
        'OP_ASSISTANT_IMAGE_TAG=v0.12.5',
        'OP_GUARDIAN_IMAGE_TAG=v0.12.5',
        '',
      ].join('\n'),
      enabledAddons: ['discord'],
      availableTagsByImage: { guardian: ['v0.12.7', 'v0.12.5'] },
      publishedTagsByImage: { guardian: ['v0.12.7', 'v0.12.5'] },
    });

    expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    const { result: res, finalStackEnv } = parseResult(result.stdout);
    expect(res.imageTag).toBe('v0.12.7');
    expect(finalStackEnv).toContain('OP_GUARDIAN_IMAGE_TAG=v0.12.7');
  });

  test('preserves commented-out user keys (non-destructive write)', () => {
    const result = runUnitTagScenario({
      unit: 'assistant',
      tag: 'v0.12.5',
      initialStackEnv: [
        '# OP_GUARDIAN_IMAGE_TAG=v0.9.0',
        'OP_IMAGE_NAMESPACE=openpalm',
        'OP_ASSISTANT_IMAGE_TAG=v0.12.0',
        '',
      ].join('\n'),
      availableTagsByImage: { assistant: ['v0.12.5', 'v0.12.0'] },
      publishedTagsByImage: { assistant: ['v0.12.5'] },
    });

    expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    const { finalStackEnv } = parseResult(result.stdout);
    expect(finalStackEnv).toContain('# OP_GUARDIAN_IMAGE_TAG=v0.9.0');
    expect(finalStackEnv).toContain('OP_ASSISTANT_IMAGE_TAG=v0.12.5');
  });

  test('does NOT stamp OP_RELEASE_VERSION (no migrations — unlike applyTagChange)', () => {
    const result = runUnitTagScenario({
      unit: 'assistant',
      tag: 'v0.12.5',
      initialStackEnv: [
        'OP_IMAGE_NAMESPACE=openpalm',
        'OP_ASSISTANT_IMAGE_TAG=v0.12.0',
        'OP_RELEASE_VERSION=v0.12.0',
        '',
      ].join('\n'),
      availableTagsByImage: { assistant: ['v0.12.5', 'v0.12.0'] },
      publishedTagsByImage: { assistant: ['v0.12.5'] },
    });

    expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    const { finalStackEnv } = parseResult(result.stdout);
    // OP_RELEASE_VERSION must stay at the old value — per-unit pinning runs no
    // release migrations (those are platform-level, via applyTagChange).
    expect(finalStackEnv).toContain('OP_RELEASE_VERSION=v0.12.0');
    expect(finalStackEnv).not.toMatch(/OP_RELEASE_VERSION=v0\.12\.5/);
  });

  test('unit-prefixed release tag (guardian-0.12.7) maps to Docker tag v0.12.7', () => {
    const result = runUnitTagScenario({
      unit: 'guardian',
      tag: 'guardian-0.12.7',
      initialStackEnv: [
        'OP_IMAGE_NAMESPACE=openpalm',
        'OP_GUARDIAN_IMAGE_TAG=v0.12.5',
        '',
      ].join('\n'),
      enabledAddons: ['discord'],
      availableTagsByImage: { guardian: ['v0.12.7', 'v0.12.5'] },
      publishedTagsByImage: { guardian: ['v0.12.7'] },
    });

    expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    const { result: res, finalStackEnv } = parseResult(result.stdout);
    expect(res.imageTag).toBe('v0.12.7');
    expect(finalStackEnv).toContain('OP_GUARDIAN_IMAGE_TAG=v0.12.7');
  });
});
