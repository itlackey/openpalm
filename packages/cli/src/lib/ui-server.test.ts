import { describe, expect, it } from 'bun:test';
import {
  createCliUiSupervisor, type CliChildProc, waitForClientApp,
  resolveAdminUrl, resolveExpectedHostMode, checkExistingUiInstance,
  resolveClientOpenTarget, resolveUiServePort,
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

describe('waitForClientApp', () => {
  it('returns true once the localhost client app becomes reachable', async () => {
    let attempts = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      attempts += 1;
      if (attempts < 2) throw new Error('not ready');
      return new Response('<html></html>', { status: 200 });
    }) as typeof fetch;

    try {
      expect(await waitForClientApp('http://127.0.0.1:3890/chat', 1500)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns false when the localhost client app never becomes reachable', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('still down');
    }) as typeof fetch;

    try {
      expect(await waitForClientApp('http://127.0.0.1:3890/chat', 250)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ── A3: `openpalm admin` opens/prints /host, not the root ────────────────────

describe('resolveAdminUrl', () => {
  it('points at /host when admin (host-ui) mode is active', () => {
    expect(resolveAdminUrl('http://localhost:3880', true)).toBe('http://localhost:3880/host');
  });

  it('leaves the root URL alone otherwise', () => {
    expect(resolveAdminUrl('http://localhost:3880', false)).toBe('http://localhost:3880');
  });
});

describe('resolveExpectedHostMode', () => {
  it('is host-ui for admin mode, pwa-static otherwise (mirrors spawnUiChild adminEnv)', () => {
    expect(resolveExpectedHostMode(true)).toBe('host-ui');
    expect(resolveExpectedHostMode(false)).toBe('pwa-static');
  });
});

// F14: the spawned child's /api/runtime hostMode (packages/ui/src/lib/server/
// features.ts resolveHostMode) honors OP_UI_HOST_MODE / OP_ENABLE_ADMIN /
// OP_INSIDE_ELECTRON from its inherited env — for a NON-admin reuse
// (spawnUiChild's adminEnv override does not apply, so the child inherits
// process.env untouched), resolveExpectedHostMode must replicate that same
// precedence or a shell with e.g. OP_ENABLE_ADMIN=1 set makes a legitimate
// `openpalm` reuse compute 'pwa-static' while its own child reports
// 'host-ui' — a false 'mismatch' that refuses to attach and exits(1).
describe('resolveExpectedHostMode (F14: inherited OP_UI_HOST_MODE / OP_ENABLE_ADMIN / OP_INSIDE_ELECTRON)', () => {
  it('is host-ui for admin mode regardless of inherited env (spawnUiChild always overrides OP_UI_HOST_MODE in the child)', () => {
    expect(resolveExpectedHostMode(true, { OP_ENABLE_ADMIN: undefined, OP_UI_HOST_MODE: 'pwa-static' } as NodeJS.ProcessEnv))
      .toBe('host-ui');
  });

  it('honors an inherited OP_ENABLE_ADMIN=1 for non-admin reuse (the child inherits process.env untouched)', () => {
    expect(resolveExpectedHostMode(false, { OP_ENABLE_ADMIN: '1' } as NodeJS.ProcessEnv)).toBe('host-ui');
  });

  it('honors an inherited explicit OP_UI_HOST_MODE for non-admin reuse', () => {
    expect(resolveExpectedHostMode(false, { OP_UI_HOST_MODE: 'electron-host' } as NodeJS.ProcessEnv)).toBe('electron-host');
  });

  it('ignores an invalid/garbage explicit OP_UI_HOST_MODE and falls through the rest of the precedence', () => {
    expect(resolveExpectedHostMode(false, { OP_UI_HOST_MODE: 'bogus', OP_ENABLE_ADMIN: '1' } as NodeJS.ProcessEnv)).toBe('host-ui');
  });

  it('honors an inherited OP_INSIDE_ELECTRON=1 for non-admin reuse', () => {
    expect(resolveExpectedHostMode(false, { OP_INSIDE_ELECTRON: '1' } as NodeJS.ProcessEnv)).toBe('electron-host');
  });

  it('falls back to pwa-static when nothing is set', () => {
    expect(resolveExpectedHostMode(false, {})).toBe('pwa-static');
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
    const result = await checkExistingUiInstance(3880, 'host-ui', {
      fetchFn: routedFetch({}, ['http://127.0.0.1:3880/api/runtime']),
    });
    expect(result).toEqual({ status: 'absent' });
  });

  it('reports match when the running instance reports the expected hostMode', async () => {
    const result = await checkExistingUiInstance(3880, 'host-ui', {
      fetchFn: routedFetch({ 'http://127.0.0.1:3880/api/runtime': { hostMode: 'host-ui' } }),
    });
    expect(result).toEqual({ status: 'match', hostMode: 'host-ui' });
  });

  it('reports mismatch when a DIFFERENT hostMode is already listening (e.g. a bare openpalm under `openpalm admin`)', async () => {
    const result = await checkExistingUiInstance(3880, 'host-ui', {
      fetchFn: routedFetch({ 'http://127.0.0.1:3880/api/runtime': { hostMode: 'pwa-static' } }),
    });
    expect(result).toEqual({ status: 'mismatch', hostMode: 'pwa-static' });
  });
});

// ── A4/J1: `openpalm app` (`--open-target client`) target resolution ─────────

describe('resolveClientOpenTarget', () => {
  const uiUrl = 'http://localhost:3880';
  const clientUrl = 'http://127.0.0.1:3890/chat';

  it('opens the client when the landing probe reports /chat and the client is reachable', async () => {
    const result = await resolveClientOpenTarget(uiUrl, clientUrl, true, {
      fetchFn: routedFetch({ [`${uiUrl}/api/runtime/landing`]: { landing: '/chat' } }),
      waitForClient: async () => true,
    });
    expect(result).toEqual({ url: clientUrl });
  });

  it('routes to the host UI landing path when it is NOT /chat (setup-incomplete/offline/broken — J1/J2)', async () => {
    const result = await resolveClientOpenTarget(uiUrl, clientUrl, true, {
      fetchFn: routedFetch({ [`${uiUrl}/api/runtime/landing`]: { landing: '/host?tab=diagnostics' } }),
      waitForClient: async () => true,
    });
    expect(result).toEqual({ url: `${uiUrl}/host?tab=diagnostics` });
  });

  it('falls back to /api/setup/status when /api/runtime/landing is not deployed (404), and routes to /setup on an interrupted install (J1)', async () => {
    const result = await resolveClientOpenTarget(uiUrl, clientUrl, true, {
      fetchFn: routedFetch({ [`${uiUrl}/api/setup/status`]: { ok: true, setupComplete: false } }),
      waitForClient: async () => true,
    });
    expect(result).toEqual({ url: `${uiUrl}/setup` });
  });

  it('falls back to the host UI chat (never process.exit) when the client app is unreachable (A4)', async () => {
    const result = await resolveClientOpenTarget(uiUrl, clientUrl, true, {
      fetchFn: routedFetch({
        [`${uiUrl}/api/runtime/landing`]: { landing: '/chat' },
      }),
      waitForClient: async () => false,
    });
    expect(result.url).toBe(uiUrl);
    expect(result.message).toMatch(/host UI chat/i);
  });

  it('falls back to the host UI chat when there is no client handle at all (build absent)', async () => {
    const result = await resolveClientOpenTarget(uiUrl, clientUrl, false, {
      fetchFn: routedFetch({ [`${uiUrl}/api/runtime/landing`]: { landing: '/chat' } }),
      waitForClient: async () => { throw new Error('should not be called when hasClientHandle is false'); },
    });
    expect(result.url).toBe(uiUrl);
    expect(result.message).toBeDefined();
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
