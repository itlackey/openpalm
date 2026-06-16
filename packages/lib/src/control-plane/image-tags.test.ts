/**
 * B3 AC tests — per-image pinning behaviour.
 *
 * (a) A pinned key in OP_PINNED_IMAGES survives performUpgrade:
 *     buildPlatformImageTagEnv skips it; the existing per-image tag is preserved.
 * (b) Removing a pin from OP_PINNED_IMAGES restores auto-resolution:
 *     the image tag is updated on the next upgrade.
 * (c) A cross-boundary pin (portal/guardian < 0.12.0 while platform >= 0.12.0)
 *     produces the 'unsupported-cross-boundary-pin' warning.
 * (d) Release migration is unaffected by pins: ensureReleaseMigrated stamps
 *     OP_RELEASE_VERSION independently of OP_PINNED_IMAGES.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  buildPlatformImageTagEnv,
  buildPinnedImageTagEnv,
  parsePinnedImages,
  resolveEffectivePlatformImageTag,
} from './image-tags.js';

// ---------------------------------------------------------------------------
// (a) Unit: buildPlatformImageTagEnv skips pinned images
// ---------------------------------------------------------------------------

describe('buildPlatformImageTagEnv — pinned images are skipped', () => {
  test('skips guardian when it is pinned', () => {
    const env = buildPlatformImageTagEnv('v0.12.0', undefined, ['guardian']);
    expect(env.OP_IMAGE_TAG).toBe('v0.12.0');
    expect(env.OP_ASSISTANT_IMAGE_TAG).toBe('v0.12.0');
    // Guardian key must be absent when pinned.
    expect('OP_GUARDIAN_IMAGE_TAG' in env).toBe(false);
    // Portal is not pinned — it should be present.
    expect(env.OP_PORTAL_IMAGE_TAG).toBe('v0.12.0');
  });

  test('skips portal when it is pinned', () => {
    const env = buildPlatformImageTagEnv('v0.12.0', undefined, ['portal']);
    expect('OP_PORTAL_IMAGE_TAG' in env).toBe(false);
    expect(env.OP_GUARDIAN_IMAGE_TAG).toBe('v0.12.0');
  });

  test('skips both guardian and portal when both are pinned', () => {
    const env = buildPlatformImageTagEnv('v0.12.0', undefined, ['guardian', 'portal']);
    expect('OP_GUARDIAN_IMAGE_TAG' in env).toBe(false);
    expect('OP_PORTAL_IMAGE_TAG' in env).toBe(false);
    // Assistant and fallback tag are never pinnable.
    expect(env.OP_ASSISTANT_IMAGE_TAG).toBe('v0.12.0');
    expect(env.OP_IMAGE_TAG).toBe('v0.12.0');
  });

  test('buildPinnedImageTagEnv reads existing per-image tag from env', () => {
    const existingEnv: Record<string, string> = {
      OP_IMAGE_TAG: 'v0.12.0',
      OP_GUARDIAN_IMAGE_TAG: 'v0.11.5',
      OP_PORTAL_IMAGE_TAG: 'v0.11.3',
    };
    const pins = parsePinnedImages('guardian,portal');
    const kept = buildPinnedImageTagEnv(existingEnv, pins);
    // The pinned tag should be frozen at the old value.
    expect(kept.OP_GUARDIAN_IMAGE_TAG).toBe('v0.11.5');
    expect(kept.OP_PORTAL_IMAGE_TAG).toBe('v0.11.3');
  });

  test('merge: pinnedImageEnv + imageTagEnv preserves pinned value', () => {
    // Simulate the merge in updateStackEnvToLatestImageTag:
    // { ...pinnedImageEnv, ...imageTagEnv }
    // imageTagEnv from buildPlatformImageTagEnv omits pinned keys, so the
    // pinned value from pinnedImageEnv is the final value.
    const existingEnv: Record<string, string> = {
      OP_IMAGE_TAG: 'v0.11.5',
      OP_GUARDIAN_IMAGE_TAG: 'v0.11.5',
    };
    const pins = parsePinnedImages('guardian');
    const pinnedImageEnv = buildPinnedImageTagEnv(existingEnv, pins);
    const imageTagEnv = buildPlatformImageTagEnv('v0.12.0', undefined, pins);

    const merged = { ...pinnedImageEnv, ...imageTagEnv };
    // Guardian must stay at the old pinned value.
    expect(merged.OP_GUARDIAN_IMAGE_TAG).toBe('v0.11.5');
    // Platform-level tag and assistant advance.
    expect(merged.OP_IMAGE_TAG).toBe('v0.12.0');
    expect(merged.OP_ASSISTANT_IMAGE_TAG).toBe('v0.12.0');
  });
});

// ---------------------------------------------------------------------------
// (b) Unit: removing a pin restores auto-resolution
// ---------------------------------------------------------------------------

describe('removing a pin restores auto-resolution', () => {
  test('parsePinnedImages returns empty array when OP_PINNED_IMAGES is absent', () => {
    expect(parsePinnedImages(undefined)).toEqual([]);
    expect(parsePinnedImages('')).toEqual([]);
  });

  test('once pin is removed, buildPlatformImageTagEnv includes the key', () => {
    // With the pin present the key is absent.
    const withPin = buildPlatformImageTagEnv('v0.12.0', undefined, ['guardian']);
    expect('OP_GUARDIAN_IMAGE_TAG' in withPin).toBe(false);

    // After the pin is cleared the key is present and updated.
    const withoutPin = buildPlatformImageTagEnv('v0.12.0', undefined, []);
    expect(withoutPin.OP_GUARDIAN_IMAGE_TAG).toBe('v0.12.0');
  });

  test('resolveEffectivePlatformImageTag falls back to OP_IMAGE_TAG when per-image key absent', () => {
    const env: Record<string, string> = { OP_IMAGE_TAG: 'v0.12.0' };
    // Portal has a legacy alias too — ensure the final fallback path works.
    expect(resolveEffectivePlatformImageTag(env, 'guardian')).toBe('v0.12.0');
    expect(resolveEffectivePlatformImageTag(env, 'portal')).toBe('v0.12.0');
  });
});

// ---------------------------------------------------------------------------
// Subprocess harness helpers — mirrors lifecycle.rollback.test.ts pattern
// ---------------------------------------------------------------------------

const lifecycleUrl = new URL('./lifecycle.ts', import.meta.url).href;
const migrationsUrl = new URL('./migrations.ts', import.meta.url).href;
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

type PinScenario = {
  initialStackEnv: string;
  /** Tags returned for ALL image-specific tag-list calls (page_size queries). */
  availableTags: string[];
  /** Tags returned for individual tag-existence checks (200 = published, 404 = not found). */
  publishedTags: string[];
  enabledAddons: string[];
  mode: 'performUpgrade' | 'updateStackEnvToLatestImageTag';
  resolvedTag?: string;
};

function runPinScenario(scenario: PinScenario): { exitCode: number; stdout: string; stderr: string } {
  const tempDir = mkdtempSync(join(harnessDir, '.tmp-openpalm-pin-'));
  const scriptPath = join(tempDir, 'pin-scenario.ts');
  const runnerPath = join(tempDir, 'run-bun.sh');

  const script = `
import { mock } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const lifecycleUrl = ${JSON.stringify(lifecycleUrl)};
const scenario = ${JSON.stringify(scenario)};

function makeState() {
  const home = mkdtempSync(join(tmpdir(), 'openpalm-pin-'));
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
  listEnabledAddonIds: () => scenario.enabledAddons,
}));
// These scenarios exercise pin/upgrade MECHANICS, not the #492 host-vs-target
// guard. The guard keys on PLATFORM_VERSION (= this lib's package version, an
// rc), which would otherwise block upgrading to a stable v0.12.0 target. Pin
// PLATFORM_VERSION high here so the mechanics run; the guard has its own tests.
{
  const realVersioning = await import(${JSON.stringify(moduleUrls.versioning)});
  mock.module(${JSON.stringify(moduleUrls.versioning)}, () => ({
    ...realVersioning,
    PLATFORM_VERSION: 'v99.0.0',
  }));
}

const publishedSet = new Set(scenario.publishedTags);
const tagListResponse = JSON.stringify({
  results: scenario.availableTags.map((name) => ({ name })),
});

globalThis.fetch = async (input) => {
  const url = String(input);
  // Tag-list endpoint (page_size queries)
  if (url.includes('page_size=')) {
    return new Response(tagListResponse, { status: 200, headers: { 'content-type': 'application/json' } });
  }
  // Per-tag existence check
  const tagMatch = url.match(/\\/tags\\/(v[^/?]+)(?:\\?|$)/);
  if (tagMatch) {
    const tag = tagMatch[1];
    const status = publishedSet.has(tag) ? 200 : 404;
    return new Response('{}', { status, headers: { 'content-type': 'application/json' } });
  }
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};

async function main() {
  try {
    const state = makeState();
    const lifecycle = await import(lifecycleUrl + '?pin=' + Math.random());

    let result;
    if (scenario.mode === 'performUpgrade') {
      result = await lifecycle.performUpgrade(state);
    } else {
      result = await lifecycle.updateStackEnvToLatestImageTag(state, scenario.resolvedTag);
    }

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

// ---------------------------------------------------------------------------
// (a) Integration: pinned image survives performUpgrade
// ---------------------------------------------------------------------------

describe('(a) pinned image tag survives performUpgrade', () => {
  test('guardian pinned at v0.11.5 is not updated when platform upgrades to v0.12.0', () => {
    const result = runPinScenario({
      initialStackEnv: [
        'OP_IMAGE_NAMESPACE=openpalm',
        'OP_IMAGE_TAG=v0.11.5',
        'OP_GUARDIAN_IMAGE_TAG=v0.11.5',
        'OP_PINNED_IMAGES=guardian',
      ].join('\n') + '\n',
      availableTags: ['v0.12.0', 'v0.11.5'],
      publishedTags: ['v0.12.0', 'v0.11.5'],
      enabledAddons: ['discord'],
      mode: 'performUpgrade',
    });

    expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);

    const { result: upgradeResult, finalStackEnv } = JSON.parse(result.stdout.trim()) as {
      result: { imageTag: string; warnings: string[] };
      finalStackEnv: string;
    };

    // Platform advanced.
    expect(upgradeResult.imageTag).toBe('v0.12.0');
    expect(finalStackEnv).toContain('OP_IMAGE_TAG=v0.12.0');
    expect(finalStackEnv).toContain('OP_ASSISTANT_IMAGE_TAG=v0.12.0');

    // Pinned guardian must NOT have been updated.
    expect(finalStackEnv).toContain('OP_GUARDIAN_IMAGE_TAG=v0.11.5');
    expect(finalStackEnv).not.toMatch(/OP_GUARDIAN_IMAGE_TAG=v0\.12\.0/);
  });
});

// ---------------------------------------------------------------------------
// (b) Integration: removing pin restores auto-resolution
// ---------------------------------------------------------------------------

describe('(b) removing OP_PINNED_IMAGES restores auto-resolution', () => {
  test('guardian is updated when pin is cleared', () => {
    const result = runPinScenario({
      // No OP_PINNED_IMAGES — pin was cleared by the user.
      initialStackEnv: [
        'OP_IMAGE_NAMESPACE=openpalm',
        'OP_IMAGE_TAG=v0.11.5',
        'OP_GUARDIAN_IMAGE_TAG=v0.11.5',
      ].join('\n') + '\n',
      availableTags: ['v0.12.0', 'v0.11.5'],
      publishedTags: ['v0.12.0', 'v0.11.5'],
      enabledAddons: ['discord'],
      mode: 'performUpgrade',
    });

    expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);

    const { finalStackEnv } = JSON.parse(result.stdout.trim()) as { finalStackEnv: string };

    // Without the pin the guardian tag must advance with the platform.
    expect(finalStackEnv).toContain('OP_GUARDIAN_IMAGE_TAG=v0.12.0');
  });
});

// ---------------------------------------------------------------------------
// (c) Integration: cross-boundary pin produces warning
// ---------------------------------------------------------------------------

describe('(c) cross-boundary pin warning via updateStackEnvToLatestImageTag', () => {
  test('guardian pinned at v0.11.5 with platform at v0.12.0 emits unsupported-cross-boundary-pin', () => {
    const result = runPinScenario({
      initialStackEnv: [
        'OP_IMAGE_NAMESPACE=openpalm',
        'OP_IMAGE_TAG=v0.11.5',
        'OP_GUARDIAN_IMAGE_TAG=v0.11.5',
        'OP_PINNED_IMAGES=guardian',
      ].join('\n') + '\n',
      availableTags: ['v0.12.0', 'v0.11.5'],
      publishedTags: ['v0.12.0'],
      enabledAddons: [],
      mode: 'updateStackEnvToLatestImageTag',
      resolvedTag: 'v0.12.0',
    });

    expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);

    const { result: tagResult } = JSON.parse(result.stdout.trim()) as {
      result: { warnings: string[] };
    };

    expect(tagResult.warnings.length).toBeGreaterThan(0);
    const warningObj = JSON.parse(tagResult.warnings[0]!);
    expect(warningObj.event).toBe('unsupported-cross-boundary-pin');
    expect(warningObj.service).toBe('guardian');
    expect(warningObj.pinnedTag).toBe('v0.11.5');
    expect(warningObj.platformTag).toBe('v0.12.0');
  });

  test('portal pinned at v0.11.5 with platform at v0.12.0 emits unsupported-cross-boundary-pin', () => {
    const result = runPinScenario({
      initialStackEnv: [
        'OP_IMAGE_NAMESPACE=openpalm',
        'OP_IMAGE_TAG=v0.11.5',
        'OP_PORTAL_IMAGE_TAG=v0.11.5',
        'OP_PINNED_IMAGES=portal',
      ].join('\n') + '\n',
      availableTags: ['v0.12.0', 'v0.11.5'],
      publishedTags: ['v0.12.0'],
      enabledAddons: [],
      mode: 'updateStackEnvToLatestImageTag',
      resolvedTag: 'v0.12.0',
    });

    expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);

    const { result: tagResult } = JSON.parse(result.stdout.trim()) as {
      result: { warnings: string[] };
    };

    expect(tagResult.warnings.length).toBeGreaterThan(0);
    const warningObj = JSON.parse(tagResult.warnings[0]!);
    expect(warningObj.event).toBe('unsupported-cross-boundary-pin');
    expect(warningObj.service).toBe('portal');
  });

  test('no warning when pinned tag is already at or above the boundary (v0.12.0 >= v0.12.0)', () => {
    const result = runPinScenario({
      initialStackEnv: [
        'OP_IMAGE_NAMESPACE=openpalm',
        'OP_IMAGE_TAG=v0.12.0',
        'OP_GUARDIAN_IMAGE_TAG=v0.12.0',
        'OP_PINNED_IMAGES=guardian',
      ].join('\n') + '\n',
      availableTags: ['v0.12.1', 'v0.12.0'],
      publishedTags: ['v0.12.1', 'v0.12.0'],
      enabledAddons: [],
      mode: 'updateStackEnvToLatestImageTag',
      resolvedTag: 'v0.12.1',
    });

    expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);

    const { result: tagResult } = JSON.parse(result.stdout.trim()) as {
      result: { warnings: string[] };
    };

    // Both platform and pinned tag are >= v0.12.0 — no cross-boundary warning.
    expect(tagResult.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (d) Integration: release migration (OP_RELEASE_VERSION) is unaffected by pins
// ---------------------------------------------------------------------------

describe('(d) release migration unaffected by pins', () => {
  test('OP_RELEASE_VERSION is stamped correctly regardless of OP_PINNED_IMAGES', () => {
    const result = runPinScenario({
      initialStackEnv: [
        'OP_IMAGE_NAMESPACE=openpalm',
        'OP_IMAGE_TAG=v0.11.5',
        'OP_GUARDIAN_IMAGE_TAG=v0.11.5',
        'OP_RELEASE_VERSION=v0.11.5',
        'OP_PINNED_IMAGES=guardian',
      ].join('\n') + '\n',
      availableTags: ['v0.12.0', 'v0.11.5'],
      publishedTags: ['v0.12.0', 'v0.11.5'],
      enabledAddons: ['discord'],
      mode: 'performUpgrade',
    });

    expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);

    const { finalStackEnv } = JSON.parse(result.stdout.trim()) as { finalStackEnv: string };

    // Migration stamps the new version regardless of the guardian pin.
    expect(finalStackEnv).toContain('OP_RELEASE_VERSION=v0.12.0');
    // Guardian pin survives at old tag.
    expect(finalStackEnv).toContain('OP_GUARDIAN_IMAGE_TAG=v0.11.5');
  });
});
