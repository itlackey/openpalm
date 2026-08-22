import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverHomeBindMountSources } from './config-persistence.js';
import type { ComposeConfigJsonResult, ResolvedComposeVolume } from './docker.js';
import type { ControlPlaneState } from './types.js';

// These tests exercise the mutation-path bind-mount discovery AFTER it was
// rerouted through `docker compose config --format json`. The resolver is
// injected (a fake), so the tests prove the *consumption* of Docker's
// fully-resolved project view — the cases the deleted hand-rolled parsers
// (`normalizeVolume`'s split(':') and `expandEnvVars`'s ${VAR} subset) got
// wrong — without needing a real daemon.

let homeDir = '';

afterEach(() => {
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  homeDir = '';
});

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openpalm-discover-'));
  mkdirSync(join(dir, 'system', 'stack'), { recursive: true });
  mkdirSync(join(dir, 'knowledge', 'env'), { recursive: true });
  mkdirSync(join(dir, 'state'), { recursive: true });
  writeFileSync(join(dir, 'state', 'stack.env'), `OP_HOME=${dir}\n`);
  // discoverStackOverlays only looks for existing files; content is irrelevant
  // because the resolver is faked, but at least one compose file must exist.
  writeFileSync(join(dir, 'system', 'stack', 'core.compose.yml'), 'services: {}\n');
  return dir;
}

function makeState(dir: string): ControlPlaneState {
  return {
    homeDir: dir,
    configDir: join(dir, 'config'),
    stashDir: join(dir, 'knowledge'),
    workspaceDir: join(dir, 'workspace'),
    dataDir: join(dir, 'data'),
    stackDir: join(dir, 'system', 'stack'),
    services: {},
    artifacts: { compose: '' },
    artifactMeta: [],
  } as unknown as ControlPlaneState;
}

/** Build a fake resolver returning a Docker-resolved project view. */
function fakeResolver(
  services: Record<string, { volumes: ResolvedComposeVolume[] }>,
): () => ComposeConfigJsonResult {
  return () => ({ ok: true, config: { services }, stderr: '' });
}

describe('discoverHomeBindMountSources (compose config --format json)', () => {
  test('consumes Docker-resolved (env-interpolated) bind sources verbatim', async () => {
    homeDir = makeHome();
    const state = makeState(homeDir);

    // The real stack mounts `${OP_HOST_AKM_STASH:-${OP_HOME:?}/data/akm/empty-host-stash}`.
    // The deleted `expandEnvVars` regex mangled *nested* `${...:-${...}}` defaults
    // and dropped the mount entirely. Docker resolves it to an absolute path,
    // which discovery must consume directly.
    const emptyStash = join(homeDir, 'data', 'akm', 'empty-host-stash');
    const dataDir = join(homeDir, 'data', 'assistant');
    const resolve = fakeResolver({
      assistant: {
        volumes: [
          { type: 'bind', source: dataDir, target: '/home/opencode' },
          { type: 'bind', source: emptyStash, target: '/host-stash' },
        ],
      },
    });

    const mounts = discoverHomeBindMountSources(state, resolve);
    const paths = mounts.map((m) => m.path);
    expect(paths).toContain(dataDir);
    expect(paths).toContain(emptyStash);
  });

  test('classifies a resolved .json bind source as a file, dirs as directories', async () => {
    homeDir = makeHome();
    const state = makeState(homeDir);
    const authJson = join(homeDir, 'knowledge', 'secrets', 'auth.json');
    const cacheDir = join(homeDir, 'data', 'akm', 'cache');
    const resolve = fakeResolver({
      // A `:ro` short-form (`…/auth.json:/…:ro`) resolves to this long-form entry;
      // the mode never corrupts the source path.
      guardian: {
        volumes: [
          { type: 'bind', source: authJson, target: '/x/auth.json', read_only: true },
          { type: 'bind', source: cacheDir, target: '/opt/akm/cache' },
        ],
      },
    });

    const mounts = discoverHomeBindMountSources(state, resolve);
    expect(mounts.find((m) => m.path === authJson)?.isFile).toBe(true);
    expect(mounts.find((m) => m.path === cacheDir)?.isFile).toBe(false);
  });

  test('retains OP_HOME cache binds for directory precreation', async () => {
    homeDir = makeHome();
    const state = makeState(homeDir);
    const assistantCache = join(homeDir, 'cache', 'assistant');
    const guardianCache = join(homeDir, 'cache', 'guardian');
    const resolve = fakeResolver({
      assistant: {
        volumes: [{ type: 'bind', source: assistantCache, target: '/home/opencode/.cache' }],
      },
      guardian: {
        volumes: [{ type: 'bind', source: guardianCache, target: '/opt/openpalm/guardian/.cache' }],
      },
    });

    expect(discoverHomeBindMountSources(state, resolve).map((mount) => mount.path)).toEqual([
      assistantCache,
      guardianCache,
    ]);
  });

  test('excludes named volumes and out-of-home (e.g. Windows drive) sources', async () => {
    homeDir = makeHome();
    const state = makeState(homeDir);
    const dataDir = join(homeDir, 'data', 'ollama');
    const resolve = fakeResolver({
      svc: {
        volumes: [
          // Named volume: Docker reports type `volume`, source is the volume NAME.
          { type: 'volume', source: 'assistant-persistent', target: '/opt/persistent' },
          // A Windows drive path is read verbatim (NOT split at the drive colon
          // into `C`); it is simply not under this unix OP_HOME, so it is excluded.
          { type: 'bind', source: 'C:\\Users\\op\\data', target: '/data' },
          { type: 'bind', source: dataDir, target: '/home/ollama/.ollama' },
        ],
      },
    });

    const mounts = discoverHomeBindMountSources(state, resolve);
    const paths = mounts.map((m) => m.path);
    expect(paths).toEqual([dataDir]);
    // No truncated `/C` or bare `C` leaked from a naive split(':').
    expect(paths.some((p) => p === 'C' || p.endsWith('/C'))).toBe(false);
  });

  test('returns [] (best-effort) when Docker cannot resolve the project', async () => {
    homeDir = makeHome();
    const state = makeState(homeDir);
    const resolve = (): ComposeConfigJsonResult => ({
      ok: false,
      config: null,
      stderr: 'compose config failed',
    });
    const mounts = discoverHomeBindMountSources(state, resolve);
    expect(mounts).toEqual([]);
  });
});
