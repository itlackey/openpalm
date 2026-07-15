/**
 * Phase 1.5 (#556) — `openpalm admin` (host-ui mode).
 *
 * TDD red suite written BEFORE the implementation. Contract under test
 * (docs/technical/ui-runtime-modes-plan.md §7 Phase 1.5, §4.1 host-ui row):
 *
 *  - `admin` is registered in src/main.ts's subCommands map (new
 *    src/commands/admin.ts) and shows up in `openpalm --help`.
 *  - The command serves the existing UI through the existing startUIServer
 *    path, with the admin capability enabled in the SPAWNED UI child env:
 *    OP_ENABLE_ADMIN=1.
 *  - host-ui mode is loopback-only ALWAYS: a non-loopback bind config
 *    (OP_ALLOW_REMOTE_SETUP) is refused/ignored for this command — the child
 *    binds 127.0.0.1 with a pinned loopback ORIGIN, and the flag is
 *    neutralized in the child env so the respawned `openpalm ui` child and
 *    the UI's own remote-setup relaxations cannot re-derive a remote bind
 *    (plan §8.3: host admin remains loopback-only, never weakened).
 *  - It prints the URL and opens the browser (reusing the existing
 *    open-browser helper via startUIServer); --no-open suppresses that.
 *  - On a machine with no install it still serves — the UI's existing setup
 *    guard lands on /setup; the CLI does NOT reimplement wizard logic.
 *
 * Harness: real @openpalm/lib + cli-state against a seeded temp OP_HOME;
 * global fetch answers /health (ready) and fails registry fetches
 * (checkAndUpdate* degrade non-fatally by design); Bun.spawn is captured so no
 * real process is launched. The serve promise intentionally never resolves
 * (foreground supervisor) — tests poll the spawn capture. The package import is
 * explicitly restored before dynamic imports because other aggregate CLI tests
 * use mock.module('@openpalm/lib') and Bun module mocks can leak across files.
 *
 * The two "parity" tests at the bottom are CHARACTERIZATION tests: they pass
 * before the Phase 1.5 change and pin the existing bare-serve spawn env so
 * loopback-always is scoped to admin mode only.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderUsage, runCommand, type CommandDef } from 'citty';
import * as realLib from '../../../lib/src/index.ts';
import type { UIServerOptions } from '../lib/ui-server.ts';

// Resolved as a plain string so the red state fails at runtime ("Cannot find
// module") instead of at typecheck time — src/commands/admin.ts does not
// exist until the implementation lands.
const adminModuleUrl = new URL('./admin.ts', import.meta.url).href;
const mainModuleUrl = new URL('../main.ts', import.meta.url).href;
const uiServerModuleUrl = new URL('../lib/ui-server.ts', import.meta.url).href;
const cliStateModuleUrl = new URL('../lib/cli-state.ts', import.meta.url).href;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const ESC = String.fromCharCode(27);
/** Strip ANSI color codes from citty usage output. */
function stripAnsi(s: string): string {
  return s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '');
}

// ── Serve harness ────────────────────────────────────────────────────────────

interface CapturedSpawn {
  argv: string[];
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
  'OP_CLIENT_PORT',
  'OP_HOST_CLIENT_PORT',
  'OP_CLIENT_DEFAULT_ASSISTANT_URL',
  'OP_ASSISTANT_PORT'
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const key of SAVED_ENV_KEYS) savedEnv[key] = process.env[key];
const tmpDirs: string[] = [];

afterEach(() => {
  mock.restore();
  restoreOpenPalmLib();
  Bun.spawn = originalBunSpawn;
  globalThis.fetch = originalFetch;
  console.log = originalLog;
  console.warn = originalWarn;
  for (const key of SAVED_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function restoreOpenPalmLib(): void {
  mock.restore();
  mock.module('@openpalm/lib', () => ({ ...realLib }));
  mock.module(cliStateModuleUrl, () => ({
    ensureValidState: () => {
      const state = realLib.createState();
      if (realLib.classifyLocalInstall(state.stackDir, state.homeDir) === 'not_installed') {
        throw new Error('OpenPalm is not installed in this OP_HOME yet. Run `openpalm install` first.');
      }
      state.artifacts = realLib.resolveRuntimeFiles();
      return state;
    },
    resolveServeState: () => {
      const state = realLib.createState();
      if (realLib.classifyLocalInstall(state.stackDir, state.homeDir) === 'not_installed') return state;
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
    opts?: { env?: Record<string, string | undefined> }
  ) => {
    calls.push({ argv: [...argv], env: opts?.env });
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

/** Capture console.log/console.warn lines (startUIServer prints the URL there). */
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
 * Seed a temp OP_HOME the REAL lib accepts and point the serve path at it:
 *  - data/ui/index.js so resolveUiBuildDir() always finds a runnable build
 *    (never executed — Bun.spawn is captured);
 *  - installed=true additionally seeds core.compose.yml + OP_SETUP_COMPLETE
 *    so ensureValidState() passes; installed=false leaves OP_HOME empty so
 *    classifyLocalInstall() reports not_installed (the /setup scenario).
 * Also mocks fetch: UI /health is ready; registry fetches fail, which the
 * checkAndUpdate* self-update helpers absorb non-fatally by design.
 */
function seedServeHome(opts: { installed: boolean }): string {
  const home = mkdtempSync(join(tmpdir(), 'openpalm-admin-red-'));
  tmpDirs.push(home);
  mkdirSync(join(home, 'data', 'ui'), { recursive: true });
  writeFileSync(join(home, 'data', 'ui', 'index.js'), '// stub adapter-node entry\n');
  if (opts.installed) {
    mkdirSync(join(home, 'system', 'stack'), { recursive: true });
    writeFileSync(join(home, 'system', 'stack', 'core.compose.yml'), 'services: {}\n');
    mkdirSync(join(home, 'state'), { recursive: true });
    writeFileSync(join(home, 'state', 'stack.state.env'), 'OP_SETUP_COMPLETE=true\n');
  }
  process.env.OP_HOME = home;
  // Make sure nothing ambient can fake an admin-mode pass (spawnUiChild
  // spreads process.env into the child env).
  delete process.env.OP_ENABLE_ADMIN;
  delete process.env.OP_ALLOW_REMOTE_SETUP;
  delete process.env.OP_HOST_UI_PORT;
  delete process.env.OPENPALM_SKELETON_DIR;
  delete process.env.OP_CLIENT_PORT;
  delete process.env.OP_HOST_CLIENT_PORT;
  delete process.env.OP_CLIENT_DEFAULT_ASSISTANT_URL;
  delete process.env.OP_ASSISTANT_PORT;
  process.env.OPENPALM_REPO_ROOT = repoRoot;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/health')) return new Response('ok', { status: 200 });
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  return home;
}

/**
 * Poll until `get` yields a value. `failed` surfaces an async command
 * rejection instead of a misleading timeout.
 */
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

/** openBrowser spawns the platform opener with the URL and NO env option. */
function browserSpawn(calls: CapturedSpawn[], port: number): CapturedSpawn | undefined {
  return calls.find((c) => c.env === undefined && c.argv.some((a) => a.includes(`:${port}`)));
}

/**
 * Import src/commands/admin.ts (RED: module does not exist yet) and run it
 * through citty without awaiting — the serve mode runs in the foreground
 * until SIGINT/SIGTERM, so the returned promise never resolves on success.
 */
async function runAdmin(rawArgs: string[]): Promise<{ error?: unknown }> {
  restoreOpenPalmLib();
  const state: { error?: unknown } = {};
  const mod = (await import(`${adminModuleUrl}?t=${Math.random()}`)) as { default: CommandDef };
  void runCommand(mod.default, { rawArgs }).catch((e: unknown) => {
    state.error = e ?? new Error('admin command rejected');
  });
  return state;
}

// ── Registration + help (#556) ───────────────────────────────────────────────

describe('admin subcommand registration (#556)', () => {
  it('registers `admin` in the main subCommands map', async () => {
    restoreOpenPalmLib();
    const { mainCommand } = await import(`${mainModuleUrl}?t=${Math.random()}`) as { mainCommand: CommandDef };
    const sub = (mainCommand.subCommands as Record<string, () => Promise<unknown>>).admin;
    expect(typeof sub).toBe('function');
    const cmd = (await sub()) as { meta?: { name?: string; description?: string } };
    expect(cmd.meta?.name).toBe('admin');
    // A non-empty description so `openpalm --help` renders a useful COMMANDS row.
    expect(cmd.meta?.description ?? '').not.toBe('');
  });

  it('lists `admin` in the CLI help output', async () => {
    restoreOpenPalmLib();
    const { mainCommand } = await import(`${mainModuleUrl}?t=${Math.random()}`) as { mainCommand: CommandDef };
    const usage = stripAnsi(await renderUsage(mainCommand));
    // The COMMANDS table renders each entry as "  <name>  <description>".
    expect(usage).toMatch(/^\s*admin\b/m);
  });
});

// ── Serve mode: admin env + loopback enforcement (#556) ─────────────────────

describe('openpalm admin serve mode (#556)', () => {
  it(
    'spawns the UI child with the admin capability + host-ui mode env, prints the URL, opens the browser',
    async () => {
      seedServeHome({ installed: true });
      const calls = captureSpawns();
      const logs = captureLogs();

      const run = await runAdmin(['--port', '4611']);

      const child = await waitFor(
        () => uiChildSpawn(calls, 4611),
        'admin UI child spawn',
        () => run.error
      );
      // Admin capability enabled in the spawned UI server env (plan Phase 1.5).
      expect(child.env?.OP_ENABLE_ADMIN).toBe('1');
      // Loopback-only bind with a pinned loopback origin.
      expect(child.env?.HOST).toBe('127.0.0.1');
      expect(child.env?.PORT).toBe('4611');
      expect(child.env?.ORIGIN).toBe('http://127.0.0.1:4611');
      expect(child.env?.HOST_HEADER).toBeUndefined();
      expect(child.env?.PROTOCOL_HEADER).toBeUndefined();

      // Prints the URL…
      await waitFor(
        () => (logs.some((l) => /http:\/\/(localhost|127\.0\.0\.1):4611/.test(l)) ? true : undefined),
        'admin URL printed',
        () => run.error
      );
      // …and it must be the `/host` URL, not the root (which the landing guard
      // resolves to `/chat` on a healthy install) — A3. The "UI server running
      // at ..." log (ui-server.ts) previously printed the root URL even in
      // admin mode; only the browser-open call was fixed.
      expect(
        logs.some((l) => /UI server running at http:\/\/(localhost|127\.0\.0\.1):4611\/host\b/.test(l))
      ).toBe(true);
      // …and opens the browser by default (existing open-browser helper).
      await waitFor(
        () => browserSpawn(calls, 4611),
        'browser opener spawn',
        () => run.error
      );
    },
    15000
  );

  it(
    'prints the /host URL on the reuse path too, when a matching instance is already running (A3 reuse)',
    async () => {
      seedServeHome({ installed: true });
      // A different (or a previous) `openpalm admin` invocation is already
      // listening on this port and reports admin=true — checkExistingUiInstance
      // should call this a 'match' and skip spawning a second UI child.
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.endsWith('/api/runtime')) {
          return new Response(JSON.stringify({ admin: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.endsWith('/health')) return new Response('ok', { status: 200 });
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch;
      const calls = captureSpawns();
      const logs = captureLogs();

      const run = await runAdmin(['--port', '4616']);

      await waitFor(
        () => (logs.some((l) => l.startsWith('Reusing already-running UI server at')) ? true : undefined),
        'reuse-path log line',
        () => run.error
      );
      const reuseLine = logs.find((l) => l.startsWith('Reusing already-running UI server at'));
      expect(reuseLine).toContain('http://localhost:4616/host');

      // Reuse means no second UI child is spawned for this port.
      expect(uiChildSpawn(calls, 4616)).toBeUndefined();

      await waitFor(
        () => browserSpawn(calls, 4616),
        'browser opener spawn (reuse path)',
        () => run.error
      );
    },
    15000
  );

  it(
    'refuses a non-loopback bind config: OP_ALLOW_REMOTE_SETUP is ignored and neutralized',
    async () => {
      seedServeHome({ installed: true });
      // Operator has the remote-setup escape hatch enabled — admin mode must
      // stay loopback-only anyway (plan §8.3, Phase 1.5 "refuse non-loopback binds").
      process.env.OP_ALLOW_REMOTE_SETUP = '1';
      const calls = captureSpawns();
      const logs = captureLogs();

      const run = await runAdmin(['--port', '4612', '--no-open']);

      const child = await waitFor(
        () => uiChildSpawn(calls, 4612),
        'admin UI child spawn',
        () => run.error
      );
      expect(child.env?.OP_ENABLE_ADMIN).toBe('1');
      // NOT the remote bind (0.0.0.0 + Host-header origin) — loopback, pinned.
      expect(child.env?.HOST).toBe('127.0.0.1');
      expect(child.env?.ORIGIN).toBe('http://127.0.0.1:4612');
      expect(child.env?.HOST_HEADER).toBeUndefined();
      expect(child.env?.PROTOCOL_HEADER).toBeUndefined();
      // The flag itself must be neutralized in the child env: the `openpalm ui`
      // respawn and the UI server's own OP_ALLOW_REMOTE_SETUP relaxations
      // (Host/Origin allowlist, setup gate) must not see it enabled.
      expect(realLib.isRemoteSetupAllowed(child.env ?? {})).toBe(false);

      // --no-open: URL is printed but no browser opener is spawned.
      await waitFor(
        () => (logs.some((l) => /http:\/\/(localhost|127\.0\.0\.1):4612/.test(l)) ? true : undefined),
        'admin URL printed',
        () => run.error
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(browserSpawn(calls, 4612)).toBeUndefined();
    },
    15000
  );

  it(
    'serves without an install — the UI setup guard lands on /setup, no wizard logic in the CLI',
    async () => {
      // Empty OP_HOME: classifyLocalInstall() → not_installed. The command must
      // still bring the UI up (admin-enabled, loopback) instead of demanding
      // `openpalm install` — the UI's existing guard redirects to /setup.
      seedServeHome({ installed: false });
      const calls = captureSpawns();
      captureLogs();

      const run = await runAdmin(['--port', '4613', '--no-open']);

      const child = await waitFor(
        () => uiChildSpawn(calls, 4613),
        'admin UI child spawn (no install)',
        () => run.error
      );
      expect(child.env?.OP_ENABLE_ADMIN).toBe('1');
      expect(child.env?.HOST).toBe('127.0.0.1');
      expect(child.env?.ORIGIN).toBe('http://127.0.0.1:4613');
    },
    15000
  );
});

// ── Spawn-env parity for the existing bare serve path ────────────────────────
// CHARACTERIZATION: these pass BEFORE the Phase 1.5 change and must stay
// green after it — loopback-always and the admin env are scoped to the admin
// command; the bare `openpalm` serve path keeps its current behavior.

describe('bare serve path spawn env (characterization — green pre-change)', () => {
  it(
    'binds loopback with a pinned ORIGIN and does NOT enable admin',
    async () => {
      seedServeHome({ installed: true });
      const calls = captureSpawns();
      captureLogs();

      const failure: { error?: unknown } = {};
      restoreOpenPalmLib();
      const { startUIServer } = await import(`${uiServerModuleUrl}?t=${Math.random()}`) as {
        startUIServer: (opts?: UIServerOptions) => Promise<void>;
      };
      void startUIServer({ port: 4614, open: false } satisfies UIServerOptions).catch(
        (e: unknown) => {
          failure.error = e ?? new Error('startUIServer rejected');
        }
      );

      const child = await waitFor(
        () => uiChildSpawn(calls, 4614),
        'bare-serve UI child spawn',
        () => failure.error
      );
      expect(child.env?.HOST).toBe('127.0.0.1');
      expect(child.env?.ORIGIN).toBe('http://127.0.0.1:4614');
      expect(child.env?.HOST_HEADER).toBeUndefined();
      // Bare serve is NOT the admin surface: no admin env is introduced.
      expect(child.env?.OP_ENABLE_ADMIN).toBeUndefined();
    },
    15000
  );

  it(
    'still honors OP_ALLOW_REMOTE_SETUP (the remote bind is refused only in admin mode)',
    async () => {
      seedServeHome({ installed: true });
      process.env.OP_ALLOW_REMOTE_SETUP = '1';
      const calls = captureSpawns();
      captureLogs();

      const failure: { error?: unknown } = {};
      restoreOpenPalmLib();
      const { startUIServer } = await import(`${uiServerModuleUrl}?t=${Math.random()}`) as {
        startUIServer: (opts?: UIServerOptions) => Promise<void>;
      };
      void startUIServer({ port: 4615, open: false } satisfies UIServerOptions).catch(
        (e: unknown) => {
          failure.error = e ?? new Error('startUIServer rejected');
        }
      );

      const child = await waitFor(
        () => uiChildSpawn(calls, 4615),
        'bare-serve remote UI child spawn',
        () => failure.error
      );
      expect(child.env?.HOST).toBe('0.0.0.0');
      expect(child.env?.HOST_HEADER).toBe('host');
      expect(child.env?.PROTOCOL_HEADER).toBe('x-forwarded-proto');
      expect(child.env?.ORIGIN).toBeUndefined();
    },
    15000
  );
});
