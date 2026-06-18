/**
 * Upgrade-path regression tests.
 *
 * #449 — `latest` must resolve to a concrete published platform tag before any
 * asset fetch.
 * #450 / #474 — upgrade flows must drive the real lifecycle behavior: release
 * stamping, force-recreate, and guardian gating.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveLatestPlatformTag, resolveLatestPlatformTagForCurrentMajor, applyTagChange, DowngradeConfirmationRequired } from './lifecycle.js';
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

// Pin PLATFORM_VERSION high in the subprocess so the #492 host-vs-target guard
// doesn't block these upgrade-mechanics scenarios (they target a stable v0.12.0
// while the running lib version is an rc). The guard has its own dedicated tests.
const PIN_PLATFORM_VERSION_SNIPPET = `
{
  const realVersioning = await import(${JSON.stringify(new URL('./versioning.js', import.meta.url).href)});
  mock.module(${JSON.stringify(new URL('./versioning.js', import.meta.url).href)}, () => ({
    ...realVersioning,
    PLATFORM_VERSION: 'v99.0.0',
  }));
}
`;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function dockerTagsResponse(names: string[]): Response {
  return new Response(
    JSON.stringify({ results: names.map((name) => ({ name })) }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

type UpgradeScenario = {
  mode: 'performUpgrade' | 'applyTagChange';
  enabledAddons?: string[];
  initialStackEnv: string;
};

function runUpgradeScenario(scenario: UpgradeScenario): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const tempDir = mkdtempSync(join(harnessDir, '.tmp-openpalm-upgrade-path-'));
  const scriptPath = join(tempDir, 'upgrade-scenario.ts');
  const runnerPath = join(tempDir, 'run-bun.sh');
  const script = `
import { mock } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const lifecycleUrl = ${JSON.stringify(lifecycleUrl)};
const scenario = ${JSON.stringify(scenario)};
let composeUpOptions = null;

function makeState() {
  const home = mkdtempSync(join(tmpdir(), 'openpalm-upgrade-path-'));
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
  composeUp: async (options) => {
    composeUpOptions = options;
    return { ok: true, stdout: '', stderr: '', code: 0 };
  },
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
${PIN_PLATFORM_VERSION_SNIPPET}

globalThis.fetch = async (input) => {
  const url = String(input);
  if (url.includes('/assistant/tags?page_size=')) {
    return new Response(JSON.stringify({ results: [{ name: 'v0.12.0' }, { name: 'v0.11.5' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('/assistant/tags/v0.12.0')) {
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
      if (url.includes('/guardian/tags/v0.12.0') || url.includes('/portal/tags/v0.12.0')) {
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }
      if (url.includes('/guardian/tags?page_size=') || url.includes('/portal/tags?page_size=')) {
    return new Response(JSON.stringify({ results: [{ name: 'v0.12.0' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};

async function main() {
  try {
    const state = makeState();
    const lifecycle = await import(lifecycleUrl + '?scenario=' + Math.random());
    const result = scenario.mode === 'performUpgrade'
      ? await lifecycle.performUpgrade(state)
      : await lifecycle.applyTagChange(state, 'v0.12.0');
    const finalStackEnv = readFileSync(join(state.stashDir, 'env', 'stack.env'), 'utf-8');
    console.log(JSON.stringify({ result, composeUpOptions, finalStackEnv }));
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

function parseScenarioResult(output: string): { result: { imageTag: string }; composeUpOptions: { services: string[]; forceRecreate: boolean; removeOrphans: boolean }; finalStackEnv: string } {
  return JSON.parse(output.trim()) as { result: { imageTag: string }; composeUpOptions: { services: string[]; forceRecreate: boolean; removeOrphans: boolean }; finalStackEnv: string };
}

describe('resolveLatestPlatformTag (#449)', () => {
  test('returns the newest semver tag from the Docker registry', async () => {
    globalThis.fetch = (async () =>
      dockerTagsResponse(['latest', 'v0.11.0', 'edge'])) as typeof fetch;

    const tag = await resolveLatestPlatformTag('openpalm');
    expect(tag).toBe('v0.11.0');
  });

  test('throws when the registry yields no usable tag', async () => {
    globalThis.fetch = (async () => dockerTagsResponse(['latest'])) as typeof fetch;
    await expect(resolveLatestPlatformTag('openpalm')).rejects.toThrow(
      /No usable Docker image tag/,
    );
  });

  test('returns the newest tag within the current major version', async () => {
    globalThis.fetch = (async () =>
      dockerTagsResponse(['v1.0.0', 'v0.12.1', 'v0.12.0', 'latest'])) as typeof fetch;

    const tag = await resolveLatestPlatformTagForCurrentMajor('openpalm', 'v0.11.4');
    expect(tag).toBe('v0.12.1');
  });

  // #494: a STABLE base must not auto-jump onto a prerelease.
  test('skips prerelease tags when the base is a stable release (#494)', async () => {
    globalThis.fetch = (async () =>
      dockerTagsResponse(['v0.12.0-rc.2', 'v0.12.0-rc.1', 'v0.11.5', 'latest'])) as typeof fetch;

    const tag = await resolveLatestPlatformTagForCurrentMajor('openpalm', 'v0.11.5');
    expect(tag).toBe('v0.11.5');
  });

  // #494: a PRERELEASE base stays on the prerelease channel (already opted in).
  test('keeps prerelease tags when the base is itself a prerelease (#494)', async () => {
    globalThis.fetch = (async () =>
      dockerTagsResponse(['v0.12.0-rc.2', 'v0.12.0-rc.1', 'v0.11.5', 'latest'])) as typeof fetch;

    const tag = await resolveLatestPlatformTagForCurrentMajor('openpalm', 'v0.12.0-rc.1');
    expect(tag).toBe('v0.12.0-rc.2');
  });

  // #494: `--pre` opt-in lets a stable base reach a prerelease deliberately.
  test('allowPrerelease lets a stable base reach a prerelease (#494)', async () => {
    globalThis.fetch = (async () =>
      dockerTagsResponse(['v0.12.0-rc.2', 'v0.11.5', 'latest'])) as typeof fetch;

    const tag = await resolveLatestPlatformTagForCurrentMajor('openpalm', 'v0.11.5', {
      allowPrerelease: true,
    });
    expect(tag).toBe('v0.12.0-rc.2');
  });

  test('times out hung Docker tag queries with a friendly error', async () => {
    const originalTimeout = AbortSignal.timeout;
    Object.defineProperty(AbortSignal, 'timeout', {
      configurable: true,
      value: () => {
        const controller = new AbortController();
        controller.abort(new Error('timed out'));
        return controller.signal;
      },
    });
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      throw (init?.signal as AbortSignal | undefined)?.reason ?? new Error('missing abort signal');
    }) as typeof fetch;

    try {
      await expect(resolveLatestPlatformTag('openpalm')).rejects.toThrow(/Failed to query Docker tags: timed out/);
    } finally {
      Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: originalTimeout });
    }
  });
});

describe('applyTagChange latest resolution (#449)', () => {
  function makeState(): ControlPlaneState {
    const home = mkdtempSync(join(tmpdir(), 'openpalm-upgrade-test-'));
    mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
    writeFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'OP_IMAGE_NAMESPACE=openpalm\n');
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

  test('a "latest" selection that cannot be resolved fails with a clear validation error, not a raw download error', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;

    const state = makeState();
    await expect(applyTagChange(state, 'latest')).rejects.toThrow(
      /Cannot resolve "latest" to a concrete release/,
    );
  });

  test('an empty selection is treated like "latest" and resolved (not passed through as a blank ref)', async () => {
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;

    const state = makeState();
    await expect(applyTagChange(state, '   ')).rejects.toThrow(
      /Cannot resolve "latest" to a concrete release/,
    );
  });

  // With independently versioned units, the "target must not exceed control
  // plane" guard has been removed — Docker images can be at a higher version
  // than the npm platform unit without blocking. A v99.0.0 tag is still
  // rejected, but because it is not published on Docker Hub, not because of a
  // version comparison against PLATFORM_VERSION.
  test('applyTagChange with unpublished tag fails at publication probe (not version guard)', async () => {
    const state = makeState();
    await expect(applyTagChange(state, 'v99.0.0')).rejects.toThrow(
      /Refusing to update to openpalm\/assistant:v99\.0\.0: tag is not published/,
    );
  });

  // extractDockerTagFromReleaseTag: unit-prefixed git release tags must map to Docker image tags.
  // Verify all four unit prefixes and a bare v* tag are handled correctly.
  test.each([
    ['platform-0.12.6', 'v99.0.0', /assistant:v0\.12\.6.*not published/],
    ['portals-0.12.6',  'v99.0.0', /assistant:v0\.12\.6.*not published/],
    ['assistant-0.12.6','v99.0.0', /assistant:v0\.12\.6.*not published/],
    ['guardian-0.12.6', 'v99.0.0', /assistant:v0\.12\.6.*not published/],
  ])('unit-prefixed release tag %s resolves to Docker image tag v0.12.6 and is probed', async (releaseTag) => {
    const state = makeState();
    await expect(applyTagChange(state, releaseTag)).rejects.toThrow(
      /assistant:v0\.12\.6.*not published/,
    );
  });

  // #501: a target OLDER than the running version is a downgrade — require an
  // explicit confirmation before writing anything.
  test('applyTagChange requires confirmation for a downgrade (#501)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'openpalm-upgrade-test-'));
    mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
    writeFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'OP_IMAGE_NAMESPACE=openpalm\nOP_IMAGE_TAG=v0.12.0\n');
    const state: ControlPlaneState = {
      homeDir: home, configDir: join(home, 'config'), stashDir: join(home, 'knowledge'),
      workspaceDir: join(home, 'workspace'), dataDir: join(home, 'data'),
      stackDir: join(home, 'config', 'stack'), services: {}, artifacts: { compose: '' }, artifactMeta: [],
    };
    let threw: unknown;
    try {
      await applyTagChange(state, 'v0.11.0');
    } catch (e) { threw = e; }
    expect(threw).toBeInstanceOf(DowngradeConfirmationRequired);
    expect((threw as DowngradeConfirmationRequired).code).toBe('downgrade_confirmation_required');
    expect((threw as DowngradeConfirmationRequired).targetVersion).toBe('v0.11.0');
    expect((threw as DowngradeConfirmationRequired).currentVersion).toBe('v0.12.0');
  });

  test('applyTagChange does NOT throw the downgrade signal when confirmed (#501)', async () => {
    // Network is down, so the downstream resolution fails — but the point is the
    // confirmed call gets PAST the downgrade gate (different error than the signal).
    globalThis.fetch = (async () => { throw new Error('network down'); }) as typeof fetch;
    const home = mkdtempSync(join(tmpdir(), 'openpalm-upgrade-test-'));
    mkdirSync(join(home, 'knowledge', 'env'), { recursive: true });
    writeFileSync(join(home, 'knowledge', 'env', 'stack.env'), 'OP_IMAGE_NAMESPACE=openpalm\nOP_IMAGE_TAG=v0.12.0\n');
    const state: ControlPlaneState = {
      homeDir: home, configDir: join(home, 'config'), stashDir: join(home, 'knowledge'),
      workspaceDir: join(home, 'workspace'), dataDir: join(home, 'data'),
      stackDir: join(home, 'config', 'stack'), services: {}, artifacts: { compose: '' }, artifactMeta: [],
    };
    let threw: unknown;
    try {
      await applyTagChange(state, 'v0.11.0', { confirmDowngrade: true });
    } catch (e) { threw = e; }
    expect(threw).not.toBeInstanceOf(DowngradeConfirmationRequired);
  });
});

describe('upgrade lifecycle behavior (#450, #474)', () => {
  test('performUpgrade force-recreates managed services and keeps guardian when a channel addon is enabled', () => {
    const scenario = runUpgradeScenario({
      mode: 'performUpgrade',
      enabledAddons: ['discord'],
      initialStackEnv: 'OP_IMAGE_NAMESPACE=openpalm\nOP_IMAGE_TAG=v0.11.0\nOP_RELEASE_VERSION=v0.11.0\nOP_ENABLED_ADDONS=discord\n',
    });

    expect(scenario.exitCode, `${scenario.stdout}\n${scenario.stderr}`).toBe(0);
    const result = parseScenarioResult(scenario.stdout);
    expect(result.composeUpOptions.forceRecreate).toBe(true);
    expect(result.composeUpOptions.removeOrphans).toBe(true);
    expect(result.composeUpOptions.services).toContain('assistant');
    expect(result.composeUpOptions.services).toContain('guardian');
    expect(result.finalStackEnv).toContain('OP_RELEASE_VERSION=v0.12.0');
    expect(result.result.imageTag).toBe('v0.12.0');
  });

  test('performUpgrade manages assistant without guardian when no channel addon is enabled', () => {
    const scenario = runUpgradeScenario({
      mode: 'performUpgrade',
      initialStackEnv: 'OP_IMAGE_NAMESPACE=openpalm\nOP_IMAGE_TAG=v0.11.0\n',
    });

    expect(scenario.exitCode, `${scenario.stdout}\n${scenario.stderr}`).toBe(0);
    const result = parseScenarioResult(scenario.stdout);
    expect(result.composeUpOptions.services).toContain('assistant');
    expect(result.composeUpOptions.services).not.toContain('guardian');
  });

  test('applyTagChange writes the resolved release stamp and preserves commented-out user keys', () => {
    const scenario = runUpgradeScenario({
      mode: 'applyTagChange',
      initialStackEnv: [
        '# OP_ASSISTANT_IMAGE_TAG=v0.9.0',
        'OP_IMAGE_NAMESPACE=openpalm',
        'OP_IMAGE_TAG=v0.11.0',
        'OP_RELEASE_VERSION=v0.11.0',
        '',
      ].join('\n'),
    });

    expect(scenario.exitCode, `${scenario.stdout}\n${scenario.stderr}`).toBe(0);
    const result = parseScenarioResult(scenario.stdout);
    expect(result.finalStackEnv).toContain('# OP_ASSISTANT_IMAGE_TAG=v0.9.0');
    expect(result.finalStackEnv).toContain('OP_ASSISTANT_IMAGE_TAG=v0.12.0');
    expect(result.finalStackEnv).toContain('OP_RELEASE_VERSION=v0.12.0');
    expect(result.result.imageTag).toBe('v0.12.0');
  });
});
