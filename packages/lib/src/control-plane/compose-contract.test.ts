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

/**
 * Fails (via `expect`) if any service across ANY of `files` mounts a named
 * volume at `/opt/openpalm` or a subpath of it. `files` are checked against
 * the UNION of top-level volume declarations across all of them — core.compose.yml
 * and portals.compose.yml are always merged at runtime (see CLAUDE.md's Stack
 * section), so a volume declared top-level in ONE file and mounted by a
 * service in the OTHER is still a real named-volume mount. Checking each
 * file only against its own top-level declarations would miss that case.
 */
function assertNoOpenPalmVolumeMounts(files: ReadonlyArray<readonly [string, ComposeFile]>): void {
  const topLevelVolumeNames = new Set<string>();
  for (const [, compose] of files) {
    for (const name of Object.keys(compose.volumes ?? {})) topLevelVolumeNames.add(name);
  }

  for (const [label, compose] of files) {
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
  }
}

describe('#585 — no service mounts a named volume at /opt/openpalm', () => {
  // #585: the three named volumes over /opt/openpalm (assistant-artifacts,
  // guardian-cache, portal-cache) are retired — nothing under /opt/openpalm
  // survives container recreation, and the volumes' only remaining purpose was
  // to feed the ownership-repair machinery that existed because they existed.
  // `assistant-persistent` at /opt/persistent is a DIFFERENT, deliberately kept
  // volume (genuine user content) and must never be flagged here.
  test("no service in core.compose.yml or portals.compose.yml mounts a named volume at /opt/openpalm or any subpath", () => {
    const files = [
      ['core.compose.yml', CORE_COMPOSE_PATH],
      ['portals.compose.yml', PORTALS_COMPOSE_PATH],
    ] as const;
    const parsed = files.map(
      ([label, path]) => [label, yamlParse(readFileSync(path, 'utf8')) as ComposeFile] as const,
    );
    assertNoOpenPalmVolumeMounts(parsed);
  });

  // Reviewer concern (round 2): a per-file-only check (each file's services
  // matched only against THAT file's own top-level `volumes:` map) would pass
  // even if a volume is declared top-level in one file and mounted by a
  // service in the OTHER — because the two files are always merged at
  // runtime, that split-declaration case is still a real named-volume mount.
  // Proves assertNoOpenPalmVolumeMounts's cross-file union catches it.
  test('catches a volume declared top-level in one file and mounted at /opt/openpalm by a service in the OTHER file', () => {
    const declaringFile: ComposeFile = {
      volumes: { 'shared-cache': {} },
    };
    const mountingFile: ComposeFile = {
      services: { someservice: { volumes: ['shared-cache:/opt/openpalm/tools'] } },
    };
    expect(() =>
      assertNoOpenPalmVolumeMounts([
        ['declaring.yml', declaringFile],
        ['mounting.yml', mountingFile],
      ]),
    ).toThrow();
  });

  test('does not false-positive on a bind mount or an unrelated named volume', () => {
    const fileA: ComposeFile = {
      volumes: { 'assistant-persistent': {} },
    };
    const fileB: ComposeFile = {
      services: {
        assistant: {
          volumes: [
            '/host/path:/opt/openpalm/tools', // bind mount, not a named volume — must not match
            'assistant-persistent:/opt/persistent', // real kept volume, different target — must not match
          ],
        },
      },
    };
    expect(() => assertNoOpenPalmVolumeMounts([['a.yml', fileA], ['b.yml', fileB]])).not.toThrow();
  });
});

describe('#585 — docker compose config parses both files (requires Docker)', () => {
  test('core.compose.yml + portals.compose.yml merge cleanly', async () => {
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
