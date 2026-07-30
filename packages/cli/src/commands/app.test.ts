import { afterEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand, type CommandDef } from 'citty';
import * as realLib from '../../../lib/src/index.ts';

describe('openpalm app', () => {
  it('routes through the UI supervisor so the localhost app is served before opening', async () => {
    const calls: UIServerOptions[] = [];
    const mod = await import('./app.ts');

    await mod.runAppCommand(async (options) => {
      calls.push(options);
    });

    expect(calls).toEqual([{ allowUninstalled: true }]);
  });

  it('registers the app subcommand in the main command map', async () => {
    const { mainCommand } = await import('../main.ts');
    const sub = (mainCommand.subCommands as Record<string, () => Promise<unknown>>).app;
    expect(typeof sub).toBe('function');
    const cmd = (await sub()) as { meta?: { name?: string } };
    expect(cmd.meta?.name).toBe('app');
  });
});

// ── #486 stack-less app entry — `openpalm app` on a not-installed OP_HOME ──
//
// D1: startUIServer's ensureValidState()/resolveServeState() ternary must
// tolerate the explicit uninstalled-app entry, not just `adminHostUi`. Harness
// mirrors packages/cli/src/commands/admin.test.ts's serve harness
// (seedServeHome / captureSpawns / captureLogs / waitFor / restoreOpenPalmLib)
// — the real @openpalm/lib + cli-state against a seeded temp OP_HOME, with
// Bun.spawn captured so no real process launches and fetch stubbed to answer
// /health only.

const appModuleUrl = new URL('./app.ts', import.meta.url).href;
const cliStateModuleUrl = new URL('../lib/cli-state.ts', import.meta.url).href;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

interface CapturedSpawn {
  argv: string[];
  cwd?: string;
  env: Record<string, string | undefined> | undefined;
}

const originalBunSpawn = Bun.spawn;
const originalFetch = globalThis.fetch;
const originalLog = console.log;
const originalWarn = console.warn;
const SAVED_ENV_KEYS = [
  'OP_HOME',
  'OP_ENABLE_ADMIN',
  'OP_ALLOW_REMOTE_SETUP',
  'OP_HOST_UI_PORT',
  'OPENPALM_REPO_ROOT',
  'OPENPALM_SKELETON_DIR',
  'OP_ASSISTANT_PORT',
] as const;
const savedEnv2: Record<string, string | undefined> = {};
for (const key of SAVED_ENV_KEYS) savedEnv2[key] = process.env[key];
const tmpDirs2: string[] = [];
const fetchedUrls: string[] = [];

afterEach(() => {
  mock.restore();
  restoreOpenPalmLib();
  Bun.spawn = originalBunSpawn;
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.warn = originalWarn;
  fetchedUrls.length = 0;
  for (const key of SAVED_ENV_KEYS) {
    if (savedEnv2[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv2[key];
  }
  for (const dir of tmpDirs2.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A not-installed OP_HOME (this file's fixtures) has no
 * `system/stack/core.compose.yml` and no `state/stack.env` — checking
 * compose-file existence directly (real node:fs, never mockable via
 * `mock.module('@openpalm/lib', ...)`) reproduces exactly the same verdict as
 * `classifyLocalInstall()`'s `not_installed` branch for these fixtures,
 * without going through the mockable `@openpalm/lib` surface at all. This
 * file's tests run `bun test` alongside other CLI test files that also call
 * `mock.module('@openpalm/lib', ...)` in the SAME shared process; a
 * fire-and-forget `runCommand()` call (tests 1–2 below, matching
 * admin.test.ts's own pattern) can still be resolving its background promise
 * chain when a LATER test file's mock registration is active, so
 * `realLib.classifyLocalInstall(...)` is not a safe signal to gate a
 * synchronous throw on here — a stale/foreign mock returning `'installed'`
 * would let `startUIServer` run past validation into its real (non-exiting)
 * serve loop instead of throwing, hanging the awaited assertion in the "bare
 * serve" test below.
 */
function isNotInstalled(stackDir: string): boolean {
  return !existsSync(join(stackDir, 'core.compose.yml'));
}

function restoreOpenPalmLib(): void {
  mock.restore();
  mock.module('@openpalm/lib', () => ({ ...realLib }));
  mock.module(cliStateModuleUrl, () => ({
    ensureValidState: () => {
      const state = realLib.createState();
      if (isNotInstalled(state.stackDir)) {
        throw new Error('OpenPalm is not installed in this OP_HOME yet. Run `openpalm install` first.');
      }
      state.artifacts = realLib.resolveRuntimeFiles();
      return state;
    },
    resolveServeState: () => {
      const state = realLib.createState();
      if (isNotInstalled(state.stackDir)) return state;
      state.artifacts = realLib.resolveRuntimeFiles();
      return state;
    },
  }));
}

/** Capture every Bun.spawn call; no real process is ever launched. */
function captureSpawns(): CapturedSpawn[] {
  const calls: CapturedSpawn[] = [];
  Bun.spawn = ((
    argv: readonly string[],
    opts?: { cwd?: string; env?: Record<string, string | undefined> }
  ) => {
    calls.push({ argv: [...argv], cwd: opts?.cwd, env: opts?.env });
    return {
      pid: 0,
      exited: new Promise<number>(() => {}), // stays "alive"
      exitCode: null,
      signalCode: null,
      killed: false,
      stdin: null,
      stdout: null,
      stderr: null,
      kill: () => {},
      ref: () => {},
      unref: () => {},
      [Symbol.asyncDispose]: async () => {},
      resourceUsage: () => undefined
    };
  }) as unknown as typeof Bun.spawn;
  return calls;
}

/** Capture console.log/console.warn lines. */
function captureLogs(): string[] {
  const lines: string[] = [];
  console.log = ((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  }) as typeof console.log;
  console.warn = ((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  }) as typeof console.warn;
  return lines;
}

/**
 * Seed a temp OP_HOME the real lib accepts. The default has only a runnable UI
 * artifact, so classifyLocalInstall() reports not_installed; installed=true
 * adds the minimum completed-stack markers. Mocks fetch to answer /health only.
 */
function seedServeHome(installed = false): string {
  const home = mkdtempSync(join(tmpdir(), 'openpalm-app-red-'));
  tmpDirs2.push(home);
  mkdirSync(join(home, 'data', 'ui'), { recursive: true });
  writeFileSync(join(home, 'data', 'ui', 'index.js'), '// stub adapter-node entry\n');
  writeFileSync(join(home, 'data', 'ui', '.openpalm-ui-version'), '999999.0.0\n');
  writeFileSync(join(home, 'data', 'ui', realLib.UI_RUNTIME_CONFIG_ENDPOINT_MARKER), '1\n');
  mkdirSync(join(home, 'data', 'ui', 'client'), { recursive: true });
  writeFileSync(
    join(home, 'data', 'ui', 'client', 'runtime-config.json'),
    '{"connections":[{"id":"stale-local-assistant"}]}\n',
  );
  if (installed) {
    mkdirSync(join(home, 'system', 'stack'), { recursive: true });
    writeFileSync(join(home, 'system', 'stack', 'core.compose.yml'), 'services: {}\n');
    mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(join(home, 'state', 'stack.env'), 'OP_SETUP_COMPLETE=true\n');
  }
  process.env.OP_HOME = home;
  delete process.env.OP_ENABLE_ADMIN;
  delete process.env.OP_ALLOW_REMOTE_SETUP;
  delete process.env.OPENPALM_SKELETON_DIR;
  delete process.env.OP_ASSISTANT_PORT;
  process.env.OPENPALM_REPO_ROOT = repoRoot;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    fetchedUrls.push(url);
    if (url.endsWith('/health')) return new Response('ok', { status: 200 });
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  return home;
}

async function waitFor<T>(
  get: () => T | undefined,
  what: string,
  failed?: () => unknown,
  timeoutMs = 5000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const err = failed?.();
    if (err !== undefined) {
      throw new Error(`${what}: command rejected first: ${String(err)}`);
    }
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The spawned UI child is the only capture that carries PORT in its env. */
function uiChildSpawn(calls: CapturedSpawn[], port: number): CapturedSpawn | undefined {
  return calls.find((c) => c.env?.PORT === String(port));
}

/**
 * The browser open is the only capture with no env. It targets the ONE loopback
 * spelling every entry point now uses — the literal IP, not `localhost`. See
 * resolveUiLoopbackHost: the two spellings are different cookie jars, so a
 * session established under one is simply not sent to the other, and switching
 * between `openpalm` and `openpalm admin` used to demand a second login.
 */
function browserSpawn(calls: CapturedSpawn[], port: number): CapturedSpawn | undefined {
  return calls.find((c) => c.env === undefined && c.argv.includes(`http://127.0.0.1:${port}`));
}

/**
 * Import src/commands/app.ts and run it through citty without awaiting — the
 * serve mode runs in the foreground until SIGINT/SIGTERM, so the returned
 * promise never resolves on success.
 */
async function runApp(): Promise<{ error?: unknown }> {
  restoreOpenPalmLib();
  const state: { error?: unknown } = {};
  const mod = (await import(`${appModuleUrl}?t=${Math.random()}`)) as { default: CommandDef };
  void runCommand(mod.default, { rawArgs: [] }).catch((e: unknown) => {
    state.error = e ?? new Error('app command rejected');
  });
  return state;
}

describe('openpalm app on a not-installed OP_HOME (#486 stack-less app entry)', () => {
  it(
    'serves an empty client UI on the canonical loopback spelling without changing its bind',
    async () => {
      seedServeHome();
      process.env.OP_HOST_UI_PORT = '4711';
      const calls = captureSpawns();
      captureLogs();

      const run = await runApp();

      const child = await waitFor(
        () => uiChildSpawn(calls, 4711),
        'stack-less app UI child spawn',
        () => run.error
      );
      expect(child.env?.PORT).toBe('4711');
      expect(child.env?.HOST).toBe('127.0.0.1');
      // ORIGIN is pinned to the ADDRESS the child bound, which is now also the
      // address the browser is sent to. SvelteKit compares ORIGIN against the
      // request's Origin header, so the bind, the printed URL and the browser
      // open all have to agree on one spelling — see resolveUiListenEnv in
      // network-contract.ts and resolveUiLoopbackHost in ui-server.ts.
      expect(child.env?.ORIGIN).toBe('http://127.0.0.1:4711');
      expect(child.env?.OP_ENABLE_ADMIN).toBeUndefined();
      expect(child.cwd).toBeDefined();
      const processConfig = realLib.parseUiRuntimeConfigJson(
        child.env?.[realLib.UI_RUNTIME_CONFIG_ENV],
      );
      expect(processConfig).toEqual({ status: 'valid', config: { connections: [] } });
      expect(
        JSON.parse(readFileSync(join(child.cwd as string, 'client', 'runtime-config.json'), 'utf8')),
      ).toEqual({ connections: [{ id: 'stale-local-assistant' }] });

      const browser = await waitFor(
        () => browserSpawn(calls, 4711),
        'canonical loopback browser open',
        () => run.error,
      );
      // One spelling, everywhere: `openpalm` opened `localhost` while `openpalm
      // admin` and Electron opened `127.0.0.1`, and because those are separate
      // cookie jars, switching commands silently demanded a second login. The
      // literal IP also can't resolve to ::1 while the listener is IPv4-only.
      expect(browser.argv).toContain('http://127.0.0.1:4711');
      expect(browser.argv.some((arg) => arg.includes('localhost'))).toBe(false);
      expect(fetchedUrls).toContain('http://127.0.0.1:4711/api/runtime');
      expect(fetchedUrls).toContain('http://127.0.0.1:4711/health');
      // The command promise must not have rejected — it stays running as a
      // foreground supervisor, same as `openpalm admin`/bare serve.
      expect(run.error).toBeUndefined();
    },
    15000
  );

  it(
    'does not materialize the managed skeleton on a stack-less app, and never touches the network',
    async () => {
      const home = seedServeHome();
      process.env.OP_HOST_UI_PORT = '4712';
      const calls = captureSpawns();
      captureLogs();

      const run = await runApp();

      await waitFor(
        () => uiChildSpawn(calls, 4712),
        'stack-less app UI child spawn',
        () => run.error
      );
      expect(calls.some((c) => c.argv.some((a) => a.includes('docker')))).toBe(false);
      expect(existsSync(join(home, 'system'))).toBe(false);
      expect(existsSync(join(home, '.skeleton-version'))).toBe(false);
      // Every artifact ships its own UI build + skeleton at build time now —
      // spawnUiChild materializes what's embedded/bundled locally and never
      // hits the network (the GitHub host-assets download transport is gone).
      expect(fetchedUrls.every((url) => url.startsWith('http://127.0.0.1:'))).toBe(true);
    },
    15000
  );

  it(
    'writes an empty static config when a nonfatal update leaves a legacy UI build active',
    async () => {
      const home = seedServeHome();
      rmSync(join(home, 'data', 'ui', realLib.UI_RUNTIME_CONFIG_ENDPOINT_MARKER));
      process.env.OP_HOST_UI_PORT = '4716';
      const calls = captureSpawns();
      captureLogs();

      const run = await runApp();
      const child = await waitFor(
        () => uiChildSpawn(calls, 4716),
        'legacy stack-less app UI child spawn',
        () => run.error,
      );
      expect(child.cwd).toBeDefined();
      expect(
        JSON.parse(readFileSync(join(child.cwd as string, 'client', 'runtime-config.json'), 'utf8')),
      ).toEqual({ connections: [] });
    },
    15000,
  );
});

describe('openpalm app on an installed OP_HOME', () => {
  it(
    'seeds the managed skeleton locally (no network) and keeps the locked local assistant seed',
    async () => {
      const home = seedServeHome(true);
      process.env.OP_HOST_UI_PORT = '4714';
      const calls = captureSpawns();
      captureLogs();

      const run = await runApp();
      const child = await waitFor(
        () => uiChildSpawn(calls, 4714),
        'installed app UI child spawn',
        () => run.error,
      );

      // Seeded from the repo checkout via OPENPALM_REPO_ROOT (this test's
      // stand-in for the CLI's embedded skeleton) — no network involved.
      expect(existsSync(join(home, 'system', 'stack'))).toBe(true);
      expect(fetchedUrls.every((url) => url.startsWith('http://127.0.0.1:'))).toBe(true);
      expect(child.cwd).toBeDefined();
      const runtimeConfig = realLib.parseUiRuntimeConfigJson(
        child.env?.[realLib.UI_RUNTIME_CONFIG_ENV],
      );
      expect(runtimeConfig.status).toBe('valid');
      expect(runtimeConfig.status === 'valid' ? runtimeConfig.config.connections : []).toEqual([
        expect.objectContaining({ id: realLib.ASSISTANT_LOCKED_CONNECTION_ID, locked: true }),
      ]);
      expect(
        JSON.parse(readFileSync(join(child.cwd as string, 'client', 'runtime-config.json'), 'utf8')),
      ).toEqual({ connections: [{ id: 'stale-local-assistant' }] });
    },
    15000,
  );
});

describe('bare serve keeps requiring an install (tolerance is scoped to the uninstalled app entry)', () => {
  it(
    'startUIServer({ open: false }) on an empty OP_HOME rejects/throws with the install-first error',
    async () => {
      seedServeHome();
      process.env.OP_HOST_UI_PORT = '4713';
      captureSpawns();
      captureLogs();
      restoreOpenPalmLib();

      const { startUIServer } = await import('../lib/ui-server.ts');
      await expect(startUIServer({ open: false })).rejects.toThrow(/not installed/i);
    },
    15000
  );
});
