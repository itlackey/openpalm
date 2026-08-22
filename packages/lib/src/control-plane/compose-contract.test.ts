/**
 * Behavioral assertions rescued from deleted text-assertion tests. These call
 * real functions and parse real config; string-grep assertions were dropped.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as yamlParse } from 'yaml';
import { checkDocker, composeConfigJsonSync, resolveComposeProjectName } from './docker.js';

const REPO_ROOT = resolve(import.meta.dir, '../../../..');
const STACK_DIR = join(REPO_ROOT, 'packages/skeleton/system/stack');
const CORE_COMPOSE_PATH = join(STACK_DIR, 'core.compose.yml');
const PORTALS_COMPOSE_PATH = join(STACK_DIR, 'portals.compose.yml');
const savedImageVersions = {
  assistant: process.env.OP_ASSISTANT_VERSION,
  guardian: process.env.OP_GUARDIAN_VERSION,
  portal: process.env.OP_PORTAL_VERSION,
};

beforeAll(() => {
  process.env.OP_ASSISTANT_VERSION = 'test';
  process.env.OP_GUARDIAN_VERSION = 'test';
  process.env.OP_PORTAL_VERSION = 'test';
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedImageVersions)) {
    const envKey = `OP_${key.toUpperCase()}_VERSION`;
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
});

/** Every shipped stack compose file (core, portals, services, voice overlays) — excludes README.md. */
function allStackComposeFiles(): string[] {
  return readdirSync(STACK_DIR)
    .filter((name) => /\.compose(\.\w+)?\.yml$/.test(name))
    .map((name) => join(STACK_DIR, name));
}

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
        let source: string | undefined;
        let target: string | undefined;
        if (typeof vol === 'string') {
          // Interpolations come out before the fields are split: the guarded
          // `${OP_HOME:?}` bind sources carry a colon of their own, and a bare
          // split(':') would read `?}/data/guardian` as the target — making
          // every assertion below vacuous for exactly the mounts it guards.
          [source, target] = vol.replace(/\$\{[^}]*\}/g, '').split(':');
        } else {
          // Long-form entry (`{ type, source, target }`). An explicit
          // non-'volume' type (bind, tmpfs) is never a named-volume mount
          // regardless of what `source` says; `type` omitted defaults to
          // 'volume' for a source that names a top-level volume.
          if (vol.type !== undefined && vol.type !== 'volume') continue;
          source = vol.source;
          target = vol.target;
        }
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
  // Covers EVERY shipped stack compose file (core, portals, services, the
  // voice.compose.cdi.yml/voice.compose.rootless.yml overlays), not just
  // core+portals — services.compose.yml and the voice overlays are also
  // applied at runtime (bring-up.ts) and are just as capable of
  // reintroducing a named-volume mount as the two files this test used to
  // check alone.
  test("no service in any packages/skeleton/system/stack/*.compose*.yml file mounts a named volume at /opt/openpalm or any subpath", () => {
    const files = allStackComposeFiles();
    expect(files.length).toBeGreaterThanOrEqual(5); // core, portals, services, voice.cdi, voice.rootless
    const parsed = files.map(
      (path) => [path.slice(STACK_DIR.length + 1), yamlParse(readFileSync(path, 'utf8')) as ComposeFile] as const,
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

  // Round-3 reviewer blocker: a LONG-FORM volumes entry (`{ type, source,
  // target }`) is valid compose YAML — `docker compose config` accepts it and
  // materializes the exact same named-volume mount as the short-form
  // "name:target" string — but the old check did `if (typeof vol !== 'string')
  // continue`, so any long-form entry walked straight through unchecked. This
  // proves the fix catches it.
  test('catches a LONG-FORM named-volume mount at /opt/openpalm (short-form-only bypass)', () => {
    const file: ComposeFile = {
      volumes: { 'assistant-artifacts': {} },
      services: {
        assistant: {
          volumes: [{ type: 'volume', source: 'assistant-artifacts', target: '/opt/openpalm' }],
        },
      },
    };
    expect(() => assertNoOpenPalmVolumeMounts([['core.compose.yml', file]])).toThrow();
  });

  // A long-form entry with an explicit `type: bind` (or `type: tmpfs`) is
  // never a named-volume mount, even if `source` happens to collide with a
  // top-level volume name — must not false-positive.
  test('does not false-positive on a long-form bind mount at /opt/openpalm', () => {
    const file: ComposeFile = {
      services: {
        assistant: {
          volumes: [{ type: 'bind', source: '/host/openpalm', target: '/opt/openpalm' }],
        },
      },
    };
    expect(() => assertNoOpenPalmVolumeMounts([['core.compose.yml', file]])).not.toThrow();
  });
});

describe('#585 — docker compose config parses managed files (requires Docker)', () => {
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

  test('all managed compose files and host overlays merge cleanly', async () => {
    const { checkDocker, composePreflight } = await import('./docker.js');
    const dockerCheck = await checkDocker();
    if (!dockerCheck.ok) {
      console.log('  [skip] Docker not available — compose config overlay test skipped');
      return;
    }

    const result = await composePreflight({ files: allStackComposeFiles() });
    expect(result.ok, result.stderr).toBe(true);
  });

  test('rootless Voice overlay restores each image default user', async () => {
    const dockerCheck = await checkDocker();
    if (!dockerCheck.ok) {
      console.log('  [skip] Docker not available — rootless Voice overlay test skipped');
      return;
    }

    const result = composeConfigJsonSync({
      files: [
        CORE_COMPOSE_PATH,
        join(STACK_DIR, 'services.compose.yml'),
        join(STACK_DIR, 'voice.compose.rootless.yml'),
      ],
      profiles: ['addon.voice.cpu', 'addon.voice.cuda', 'addon.voice.rocm'],
    });
    expect(result.ok, result.stderr).toBe(true);
    for (const service of ['voice', 'voice-cuda', 'voice-rocm']) {
      const resolved = result.config?.services?.[service];
      expect(resolved, `resolved Compose config omitted ${service}`).toBeTruthy();
      expect(resolved?.user ?? '').toBe('');
    }
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
