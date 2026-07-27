/**
 * Behavioral assertions rescued from deleted text-assertion test files
 * (see bullshit-claude-wrote.md §4). These call real functions and parse real
 * config; the string-grep assertions around them were dropped.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as yamlParse } from 'yaml';
import { resolveComposeProjectName } from './docker.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const CORE_COMPOSE_PATH = join(REPO_ROOT, 'packages/skeleton/system/stack/core.compose.yml');
const PORTALS_COMPOSE_PATH = join(REPO_ROOT, 'packages/skeleton/system/stack/portals.compose.yml');

describe('assistant runs as the operator, not root', () => {
  test('core.compose.yml pins the assistant to OP_UID:OP_GID', () => {
    const compose = yamlParse(
      readFileSync(join(REPO_ROOT, 'packages/skeleton/system/stack/core.compose.yml'), 'utf8'),
    ) as { services?: Record<string, { user?: string }> };
    expect(compose.services?.assistant?.user).toBe('${OP_UID:-1000}:${OP_GID:-1000}');
  });
});

type ComposeFile = {
  services?: Record<string, { volumes?: Array<string | { type?: string; target?: string; source?: string }> }>;
  volumes?: Record<string, unknown> | null;
};

describe('#585 — no service mounts a named volume at /opt/openpalm', () => {
  // #585: the three named volumes over /opt/openpalm (assistant-artifacts,
  // guardian-cache, portal-cache) are retired — nothing under /opt/openpalm
  // survives container recreation, and the volumes' only remaining purpose was
  // to feed the ownership-repair machinery that existed because they existed.
  // `assistant-persistent` at /opt/persistent is a DIFFERENT, deliberately kept
  // volume (genuine user content) and must never be flagged here.
  for (const [label, path] of [
    ['core.compose.yml', CORE_COMPOSE_PATH],
    ['portals.compose.yml', PORTALS_COMPOSE_PATH],
  ] as const) {
    test(`${label}: no service's volumes list a named volume targeting /opt/openpalm or any subpath`, () => {
      const compose = yamlParse(readFileSync(path, 'utf8')) as ComposeFile;
      const topLevelVolumeNames = new Set(Object.keys(compose.volumes ?? {}));

      for (const [serviceName, service] of Object.entries(compose.services ?? {})) {
        for (const vol of service.volumes ?? []) {
          if (typeof vol !== 'string') continue; // long-form entries aren't used in these files today
          const [source, target] = vol.split(':');
          // Subpath check catches a re-introduced mount like
          // guardian-cache:/opt/openpalm/tools, not just the exact bare path.
          if (target !== '/opt/openpalm' && !target?.startsWith('/opt/openpalm/')) continue;
          const isNamedVolume = source !== undefined && topLevelVolumeNames.has(source);
          expect(isNamedVolume, `${label} service "${serviceName}" mounts named volume "${source}" at ${target}`).toBe(false);
        }
      }
    });
  }
});

describe('#585 — docker compose config parses both files (requires Docker)', () => {
  const skipDockerAssertions = process.env.CI === 'true';

  test.skipIf(skipDockerAssertions)('core.compose.yml + portals.compose.yml merge cleanly', async () => {
    const { checkDocker, composePreflight } = await import('./docker.js');
    const dockerCheck = await checkDocker();
    if (!dockerCheck.ok) {
      console.log('  [skip] Docker not available — compose config preflight test skipped');
      return;
    }

    const result = await composePreflight({ files: [CORE_COMPOSE_PATH, PORTALS_COMPOSE_PATH] });
    expect(result.ok, result.stderr).toBe(true);
  });
});

describe('resolveComposeProjectName', () => {
  const saved = process.env.OP_PROJECT_NAME;
  const restore = () => {
    if (saved === undefined) delete process.env.OP_PROJECT_NAME;
    else process.env.OP_PROJECT_NAME = saved;
  };

  test('respects OP_PROJECT_NAME', () => {
    process.env.OP_PROJECT_NAME = 'custom-project';
    try { expect(resolveComposeProjectName()).toBe('custom-project'); } finally { restore(); }
  });

  test('defaults to openpalm', () => {
    delete process.env.OP_PROJECT_NAME;
    try { expect(resolveComposeProjectName()).toBe('openpalm'); } finally { restore(); }
  });
});
