import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUiRuntimeConfigJson } from '@openpalm/lib';
import {
  createCliUiSupervisor, type CliChildProc,
  resolveAdminUrl, resolveExpectedAdmin, checkExistingUiInstance,
  resolveUiChildLaunch, resolveUiLoopbackHost, resolveUiNetworkEnv, resolveUiServePort,
} from './ui-server.ts';

// Behavioral coverage for the CLI's thin UiSupervisor adapter, driven through
// injected fakes (no real processes). Locks the exit-based failure policy
// (process.exit(1) on BOTH start- and restart-ready-failure) and the
// SIGTERM → grace-window → conditional-SIGKILL stop sequence.

interface FakeProc extends CliChildProc {
  signals: string[];
}

// `exited` resolves once kill() is invoked (when opts.exits) — matching real
// Bun.Subprocess semantics (a process only "exits" after being signaled, or on
// its own; it never exits before it's even started polling). This realism
// matters once waitForReadyFn races the handle's `exited` promise (D1): a
// pre-resolved-regardless-of-kill fake would make every start() look like an
// immediate crash.
function fakeProc(opts: { killed: boolean; exits: boolean }): FakeProc {
  const signals: string[] = [];
  let resolveExited: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => { resolveExited = r; });
  return {
    signals,
    kill: ((sig?: number | NodeJS.Signals) => {
      signals.push(String(sig));
      if (opts.exits) resolveExited(0);
    }) as CliChildProc['kill'],
    exited,
    killed: opts.killed,
  };
}

function harness(opts: {
  readyQueue: boolean[];
  proc?: FakeProc;
  uiBackupDir?: string | undefined;
  pendingBackupDir?: string | null;
  /** Bypass the readyQueue entirely (D1 race test needs a fn under its own control). */
  waitForReadyFn?: () => Promise<boolean>;
}) {
  const proc = opts.proc ?? fakeProc({ killed: false, exits: true });
  const exits: number[] = [];
  const restores: Array<string | undefined> = [];
  const errs: unknown[][] = [];
  const readyQueue = [...opts.readyQueue];
  const { supervisor, stop } = createCliUiSupervisor({
    port: 3880,
    spawnChild: async () => ({
      proc: proc as unknown as Bun.Subprocess,
      uiBackupDir: opts.uiBackupDir,
    }),
    waitForReadyFn: opts.waitForReadyFn ?? (async () => readyQueue.shift() ?? false),
    restoreBackup: (b) => restores.push(b),
    consumePendingBackup: () => opts.pendingBackupDir ?? null,
    exit: (c) => { exits.push(c); },
    logRestartError: (...a) => errs.push(a),
    stopTimeoutMs: 5,
    sleep: () => Promise.resolve(),
    logError: () => {},
  });
  return { supervisor, stop, proc, exits, restores, errs };
}

describe('createCliUiSupervisor stop sequence', () => {
  it('SIGTERMs, then SIGKILLs when the child has not died before the grace window', async () => {
    const proc = fakeProc({ killed: false, exits: false }); // never exits; not killed
    const { stop } = harness({ readyQueue: [true] });
    await stop(proc);
    expect(proc.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('SIGTERMs only when the child exits (killed) before the grace window', async () => {
    const proc = fakeProc({ killed: true, exits: true }); // exited + killed → no force-kill
    const { stop } = harness({ readyQueue: [true] });
    await stop(proc);
    expect(proc.signals).toEqual(['SIGTERM']);
  });
});

describe('createCliUiSupervisor exit policy', () => {
  it('start ready-timeout kills the child and exits(1)', async () => {
    const proc = fakeProc({ killed: false, exits: true });
    const { supervisor, exits } = harness({ readyQueue: [false], proc });
    expect(await supervisor.start()).toBe(false);
    expect(proc.signals).toContain('SIGTERM');
    expect(exits).toEqual([1]);
  });

  it('restart ready-failure restores the backup then exits(1)', async () => {
    // start ready, restart NOT ready → restoreBackup(last spawn's backup) → exit(1).
    const { supervisor, exits, restores } = harness({
      readyQueue: [true, false],
      uiBackupDir: '/data/.ui-backup',
    });
    expect(await supervisor.start()).toBe(true);
    expect(await supervisor.restart()).toBe(false);
    expect(restores).toEqual(['/data/.ui-backup']);
    expect(exits).toEqual([1]);
  });

  it('prefers the on-demand backup handed off by the UI child', async () => {
    const { supervisor, restores } = harness({
      readyQueue: [true, false],
      uiBackupDir: '/data/old-startup-backup',
      pendingBackupDir: '/data/on-demand-backup',
    });
    expect(await supervisor.start()).toBe(true);
    expect(await supervisor.restart()).toBe(false);
    expect(restores).toEqual(['/data/on-demand-backup']);
  });

  it('a successful restart neither restores a backup nor exits', async () => {
    const { supervisor, exits, restores } = harness({ readyQueue: [true, true] });
    expect(await supervisor.start()).toBe(true);
    expect(await supervisor.restart()).toBe(true);
    expect(restores).toEqual([]);
    expect(exits).toEqual([]);
  });

  // D1: readiness must not be a bare port poll indifferent to whether the
  // CHILD WE JUST SPAWNED is even still alive — a spawn that crashes
  // immediately (e.g. EADDRINUSE from a bare `openpalm` already on the port)
  // must fail fast, not wait out the full readiness timeout polling
  // whatever's actually answering the port.
  it('races child exit against waitForReady so an immediately-crashing spawn does not wait out the full timeout', async () => {
    let resolveExited!: (code: number) => void;
    const exited = new Promise<number>((r) => { resolveExited = r; });
    const proc: FakeProc = {
      signals: [],
      kill: ((sig?: number | NodeJS.Signals) => { proc.signals.push(String(sig)); }) as CliChildProc['kill'],
      exited,
      killed: false,
    };
    const { supervisor, exits } = harness({
      readyQueue: [],
      proc,
      // Never resolves on its own — stands in for polling a port that never
      // answers (or answers an unrelated, already-dead listener) for the
      // full timeout window.
      waitForReadyFn: () => new Promise<boolean>(() => {}),
    });

    const startPromise = supervisor.start();
    resolveExited(1); // the spawned child dies immediately (e.g. EADDRINUSE)

    expect(await startPromise).toBe(false);
    expect(exits).toEqual([1]);
  });
});


// ── A3: `openpalm admin` opens/prints /host, not the root ────────────────────

describe('resolveAdminUrl', () => {
  it('points at /host when admin mode is active', () => {
    expect(resolveAdminUrl('http://127.0.0.1:3880', true)).toBe('http://127.0.0.1:3880/host');
  });

  it('leaves the root URL alone otherwise', () => {
    expect(resolveAdminUrl('http://127.0.0.1:3880', false)).toBe('http://127.0.0.1:3880');
  });

  it('leaves a fresh admin home on root so the bootstrap resolver runs', () => {
    expect(resolveAdminUrl('http://127.0.0.1:3880', true, 'not_installed')).toBe(
      'http://127.0.0.1:3880',
    );
  });
});

describe('resolveExpectedAdmin', () => {
  it('is true for admin mode, false otherwise (mirrors spawnUiChild adminEnv)', () => {
    expect(resolveExpectedAdmin(true)).toBe(true);
    expect(resolveExpectedAdmin(false)).toBe(false);
  });
});

describe('resolveUiLoopbackHost', () => {
  it('uses localhost for normal user-facing UI and IPv4 loopback for admin', () => {
    expect(resolveUiLoopbackHost(false)).toBe('localhost');
    expect(resolveUiLoopbackHost(true)).toBe('127.0.0.1');
  });
});

describe('resolveUiNetworkEnv', () => {
  it('uses canonical localhost by default for non-admin UI processes', () => {
    expect(resolveUiNetworkEnv(3880, false, {})).toEqual({
      HOST: '127.0.0.1',
      PORT: '3880',
      ORIGIN: 'http://localhost:3880',
      HOST_HEADER: undefined,
      PROTOCOL_HEADER: undefined,
    });
  });

  it('keeps admin on IPv4 loopback and refuses the remote opt-in', () => {
    expect(resolveUiNetworkEnv(3880, true, { OP_ALLOW_REMOTE_SETUP: '1' })).toEqual({
      HOST: '127.0.0.1',
      PORT: '3880',
      ORIGIN: 'http://127.0.0.1:3880',
      HOST_HEADER: undefined,
      PROTOCOL_HEADER: undefined,
    });
  });

  it('restores wildcard bind and forwarded headers only for explicit non-admin opt-in', () => {
    expect(resolveUiNetworkEnv(3880, false, { OP_ALLOW_REMOTE_SETUP: '1' }, 'installed')).toEqual({
      HOST: '0.0.0.0',
      PORT: '3880',
      ORIGIN: undefined,
      HOST_HEADER: 'host',
      PROTOCOL_HEADER: 'x-forwarded-proto',
    });
  });

  it('keeps an uninstalled app on loopback despite the remote opt-in', () => {
    expect(resolveUiNetworkEnv(3880, false, { OP_ALLOW_REMOTE_SETUP: '1' }, 'not_installed')).toEqual({
      HOST: '127.0.0.1',
      PORT: '3880',
      ORIGIN: 'http://localhost:3880',
      HOST_HEADER: undefined,
      PROTOCOL_HEADER: undefined,
    });
  });

  it('keeps setup-incomplete app on loopback despite the remote opt-in', () => {
    expect(resolveUiNetworkEnv(3880, false, { OP_ALLOW_REMOTE_SETUP: '1' }, 'setup_incomplete')).toEqual({
      HOST: '127.0.0.1',
      PORT: '3880',
      ORIGIN: 'http://localhost:3880',
      HOST_HEADER: undefined,
      PROTOCOL_HEADER: undefined,
    });
  });

  it('keeps inherited admin capability on IPv4 loopback despite the remote opt-in', () => {
    expect(resolveUiNetworkEnv(3880, false, {
      OP_ENABLE_ADMIN: '1',
      OP_ALLOW_REMOTE_SETUP: '1',
    })).toEqual({
      HOST: '127.0.0.1',
      PORT: '3880',
      ORIGIN: 'http://127.0.0.1:3880',
      HOST_HEADER: undefined,
      PROTOCOL_HEADER: undefined,
    });
  });
});

// F14: the spawned child's /api/runtime admin flag (packages/ui/src/lib/server/
// features.ts isAdminCapable) honors OP_ENABLE_ADMIN / OP_INSIDE_ELECTRON from
// its inherited env — for a NON-admin reuse (spawnUiChild's adminEnv override
// does not apply, so the child inherits process.env untouched),
// resolveExpectedAdmin must replicate that same logic or a shell with e.g.
// OP_ENABLE_ADMIN=1 set makes a legitimate `openpalm` reuse compute admin=false
// while its own child reports admin=true — a false 'mismatch' that refuses to
// attach and exits(1).
describe('resolveExpectedAdmin (F14: inherited OP_ENABLE_ADMIN / OP_INSIDE_ELECTRON)', () => {
  it('is true for admin mode regardless of inherited env (spawnUiChild always sets OP_ENABLE_ADMIN in the child)', () => {
    expect(resolveExpectedAdmin(true, { OP_ENABLE_ADMIN: undefined } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('honors an inherited OP_ENABLE_ADMIN=1 for non-admin reuse (the child inherits process.env untouched)', () => {
    expect(resolveExpectedAdmin(false, { OP_ENABLE_ADMIN: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('honors an inherited OP_INSIDE_ELECTRON=1 for non-admin reuse', () => {
    expect(resolveExpectedAdmin(false, { OP_INSIDE_ELECTRON: '1' } as NodeJS.ProcessEnv)).toBe(true);
  });

  it('is false when nothing is set', () => {
    expect(resolveExpectedAdmin(false, {})).toBe(false);
  });
});

// ── D1: pre-spawn instance-identity probe ─────────────────────────────────────

/** Build a fetch stub that maps exact URLs to JSON bodies (200) — anything
 *  else 404s, and a URL in `unreachable` throws (simulating no listener). */
function routedFetch(routes: Record<string, unknown>, unreachable: string[] = []): typeof fetch {
  return (async (input: string | URL) => {
    const url = String(input);
    if (unreachable.includes(url)) throw new Error('connection refused');
    if (url in routes) return new Response(JSON.stringify(routes[url]), { status: 200 });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('checkExistingUiInstance', () => {
  it('reports absent when nothing answers the port', async () => {
    const result = await checkExistingUiInstance(3880, true, {
      fetchFn: routedFetch({}, ['http://127.0.0.1:3880/api/runtime']),
    });
    expect(result).toEqual({ status: 'absent' });
  });

  it('reports match when the running instance reports the expected admin flag', async () => {
    const result = await checkExistingUiInstance(3880, true, {
      fetchFn: routedFetch({ 'http://127.0.0.1:3880/api/runtime': { admin: true } }),
    });
    expect(result).toEqual({ status: 'match', admin: true });
  });

  it('reports mismatch when a DIFFERENT admin level is already listening (e.g. a bare openpalm under `openpalm admin`)', async () => {
    const result = await checkExistingUiInstance(3880, true, {
      fetchFn: routedFetch({ 'http://127.0.0.1:3880/api/runtime': { admin: false } }),
    });
    expect(result).toEqual({ status: 'mismatch', admin: false });
  });

  it('targets localhost when selected for the openpalm app identity check', async () => {
    const result = await checkExistingUiInstance(3880, false, {
      host: 'localhost',
      fetchFn: routedFetch({ 'http://localhost:3880/api/runtime': { admin: false } }),
    });
    expect(result).toEqual({ status: 'match', admin: false });
  });
});

describe('resolveUiChildLaunch', () => {
  it('recomputes a not-installed to installed transition for each spawn', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-ui-child-launch-'));
    const stackDir = join(homeDir, 'system', 'stack');
    try {
      const before = resolveUiChildLaunch({ homeDir, stackDir }, true, {});
      expect(before.stacklessApp).toBe(true);
      expect(parseUiRuntimeConfigJson(before.runtimeConfigJson)).toEqual({
        status: 'valid',
        config: { connections: [] },
      });

      mkdirSync(stackDir, { recursive: true });
      writeFileSync(join(stackDir, 'core.compose.yml'), 'services: {}\n');
      mkdirSync(join(homeDir, 'state'), { recursive: true });
      writeFileSync(join(homeDir, 'state', 'stack.state.env'), 'OP_SETUP_COMPLETE=true\n');

      const after = resolveUiChildLaunch({ homeDir, stackDir }, true, {});
      expect(after.stacklessApp).toBe(false);
      const parsed = parseUiRuntimeConfigJson(after.runtimeConfigJson);
      expect(parsed.status).toBe('valid');
      expect(parsed.status === 'valid' ? parsed.config.connections : []).toEqual([
        expect.objectContaining({ id: 'openpalm-assistant-opencode', locked: true }),
      ]);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('seeds no locked local connection for an uninstalled admin launch', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-ui-admin-launch-'));
    const stackDir = join(homeDir, 'system', 'stack');
    try {
      const launch = resolveUiChildLaunch({ homeDir, stackDir }, false, {
        OP_UI_DEFAULT_ASSISTANT_URL: 'http://127.0.0.1:3810',
      });
      expect(launch.stacklessApp).toBe(true);
      expect(parseUiRuntimeConfigJson(launch.runtimeConfigJson)).toEqual({
        status: 'valid',
        config: { connections: [] },
      });
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('preserves true setup-incomplete and hand-built install detection', () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'openpalm-ui-existing-launch-'));
    const stackDir = join(homeDir, 'system', 'stack');
    try {
      mkdirSync(stackDir, { recursive: true });
      writeFileSync(join(stackDir, 'core.compose.yml'), 'services: {}\n');

      expect(resolveUiChildLaunch({ homeDir, stackDir }, false, {}).stacklessApp).toBe(false);

      mkdirSync(join(homeDir, 'knowledge', 'secrets'), { recursive: true });
      writeFileSync(join(homeDir, 'knowledge', 'secrets', 'op_guardian_admin_token'), 'admin\n');
      writeFileSync(join(homeDir, 'knowledge', 'secrets', 'op_guardian_mcp_token'), 'mcp\n');
      expect(resolveUiChildLaunch({ homeDir, stackDir }, false, {}).stacklessApp).toBe(false);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});


// ── D3: persisted OP_HOST_UI_PORT is read back ────────────────────────────────

describe('resolveUiServePort', () => {
  it('an explicit port option always wins', () => {
    expect(resolveUiServePort(9999, '/op-home', {}, { OP_HOST_UI_PORT: '9000' })).toBe(9999);
  });

  it('falls back to persisted stack.env OP_HOST_UI_PORT (headless-install flow) when process.env has none', () => {
    expect(resolveUiServePort(undefined, '/op-home', {}, { OP_HOST_UI_PORT: '9302' })).toBe(9302);
  });

  it('lets process.env override the persisted value', () => {
    expect(resolveUiServePort(
      undefined,
      '/op-home',
      { OP_HOST_UI_PORT: '9400' } as NodeJS.ProcessEnv,
      { OP_HOST_UI_PORT: '9302' },
    )).toBe(9400);
  });

  it('falls back to DEFAULT_UI_PORT (3880) when nothing is set', () => {
    expect(resolveUiServePort(undefined, '/op-home', {}, {})).toBe(3880);
  });
});
