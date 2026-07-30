// Run via vitest (Node), NOT bun test — bun executes the real electron module
// and cannot honor vi.mock() hoisting. Use: bun run --cwd packages/electron test
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const startupHarness = vi.hoisted(() => {
  let releaseReady = (): void => {};
  const ready = new Promise<void>((resolve) => {
    releaseReady = resolve;
  });
  return {
    ready,
    releaseReady: () => releaseReady(),
  };
});

// ── Mock node:fs before any imports ─────────────────────────────────────────
// Return true for the UI build index.js check so startUIServer's bundled-build
// guard passes and the spawn path is reached. We mock spawn separately via
// node:child_process.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      // Make the UI build appear present.
      if (String(p).endsWith('index.js')) return true;
      // Icon file does not exist — skip tray creation
      return false;
    }),
  };
});

// ── Mock node:child_process — prevent real spawning ──────────────────────────
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const fakeProcess = {
    on: vi.fn(),
    kill: vi.fn(),
  };
  return {
    ...actual,
    spawn: vi.fn(() => fakeProcess),
  };
});

// ── Mock electron before importing anything that imports it ──────────────────
// vi.mock() factories are hoisted above other top-level code, so the mock
// objects they close over must be created via vi.hoisted() to be reachable
// at hoist time.
const { mockBrowserWindow, ipcMainOnHandlers, ipcMainHandleHandlers, notificationInstances, mockSetAppUserModelId } = vi.hoisted(() => ({
  mockBrowserWindow: {
    loadURL: vi.fn(),
    webContents: { setWindowOpenHandler: vi.fn(), send: vi.fn() },
    on: vi.fn(),
    once: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    isFocused: vi.fn(() => false),
    hide: vi.fn(),
    close: vi.fn(),
    setTitle: vi.fn(),
    setSize: vi.fn(),
    isDestroyed: vi.fn(() => false),
    getAllWindows: vi.fn(() => []),
  },
  ipcMainOnHandlers: new Map<string, (...args: unknown[]) => void>(),
  ipcMainHandleHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  notificationInstances: [] as Array<{ show: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }>,
  mockSetAppUserModelId: vi.fn(),
}));

const { mockNotificationShow } = vi.hoisted(() => ({
  mockNotificationShow: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '0.11.0'),
    quit: vi.fn(),
    exit: vi.fn(),
    isQuitting: false,
    whenReady: vi.fn(() => startupHarness.ready),
    on: vi.fn(),
    getAppPath: vi.fn(() => '/mock/app'),
    // main.ts resolves a log path at import time via app.getPath('logs');
    // without this mock the unmocked call rejected at module load and made the
    // suite exit non-zero (an "unhandled rejection", not a true failure).
    getPath: vi.fn(() => '/mock/logs'),
    relaunch: vi.fn(),
    setAppUserModelId: mockSetAppUserModelId,
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
    setLoginItemSettings: vi.fn(),
  },
  // Regular function (not arrow) so `new BrowserWindow(...)` works as a
  // constructor; vitest 4 enforces this stricter than 3 did.
  BrowserWindow: Object.assign(
    vi.fn(function MockBrowserWindow() { return mockBrowserWindow; }),
    { getAllWindows: vi.fn(() => [mockBrowserWindow]) },
  ),
  contextBridge: { exposeInMainWorld: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
  Tray: function MockTray() {
    return {
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      on: vi.fn(),
    };
  },
  globalShortcut: {
    register: vi.fn(() => false),
    unregisterAll: vi.fn(),
  },
  nativeImage: {
    createFromPath: vi.fn(() => ({
      toBitmap: vi.fn(() => Buffer.from([])),
      getSize: vi.fn(() => ({ width: 16, height: 16 })),
    })),
    createFromBitmap: vi.fn(() => ({})),
  },
  Menu: { buildFromTemplate: vi.fn(() => ({})) },
  shell: { openExternal: vi.fn() },
  ipcMain: {
    handle: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      ipcMainHandleHandlers.set(event, handler);
    }),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      ipcMainOnHandlers.set(event, handler);
    }),
  },
  // Notification mock: constructor returns an object with a show() spy so we
  // can assert showNotification() calls it.
  Notification: Object.assign(
    function MockNotification() {
      const instance = { show: mockNotificationShow, on: vi.fn() };
      notificationInstances.push(instance);
      return instance;
    },
    { isSupported: vi.fn(() => true) },
  ),
  session: {
    defaultSession: {
      // configureMediaPermissions() runs during the main bootstrap; stub the
      // permission handlers so it doesn't throw an unhandled rejection that
      // fails the run (mirrors initial-url.test.ts).
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
    },
  },
}));

// ── Mock @openpalm/lib ───────────────────────────────────────────────────────
vi.mock('@openpalm/lib', () => ({
  resolveOpenPalmHome: vi.fn(() => '/home/user/.openpalm'),
  resolveDataDir: vi.fn(() => '/home/user/.openpalm/data'),
  resolveConfigDir: vi.fn(() => '/home/user/.openpalm/config'),
  resolveUiBuildDir: vi.fn(() => '/home/user/.openpalm/data/ui'),
  seedLegacyServedUiRuntimeConfig: vi.fn(),
  ensureHomeDirs: vi.fn(),
  checkDocker: vi.fn(),
  checkDockerCompose: vi.fn(),
  parseEnvFile: vi.fn(() => ({})),
  stackEnvFile: vi.fn((home: string) => `${home}/state/stack.env`),
  // E1: the shared assistant-endpoint resolver main.ts now delegates to
  // instead of re-deriving the OP_ASSISTANT_BIND_ADDRESS/PORT precedence
  // chain locally (which is how the http://0.0.0.0:3800 seed bug happened).
  resolveAssistantEndpoint: vi.fn(() => 'http://127.0.0.1:3800'),
  // Faithful reimplementation of lib's waitForReady (poll /health; 200 or 401 ==
  // ready) so the harness wrapper still exercises the real ready-poll contract
  // under the test's stubbed global fetch + fake timers.
  waitForReady: vi.fn(async (port: number, timeoutMs = 60_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok || res.status === 401) return true;
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  }),
  // The host-UI port contract (lib network-contract.ts): explicit arg, then
  // live env, then the home's persisted stack.env, then the default.
  // The admin listen contract (lib network-contract.ts). buildUIServerEnv spreads
  // it rather than baking HOST/PORT/ORIGIN by hand, so the mock must reproduce
  // the admin branch: loopback bind, origin pinned to it, no forwarded-header
  // trust. harness-parity.test.ts pins the real function's shape.
  resolveUiListenEnv: vi.fn((opts: { port: number }) => ({
    HOST: '127.0.0.1',
    PORT: String(opts.port),
    ORIGIN: `http://127.0.0.1:${opts.port}`,
    HOST_HEADER: undefined,
    PROTOCOL_HEADER: undefined,
  })),
  resolveHostUiPort: vi.fn(
    (
      explicit: number | undefined,
      env: Record<string, string | undefined>,
      persisted: Record<string, string | undefined> = {},
    ): number => {
      if (explicit !== undefined && Number.isFinite(explicit)) return explicit;
      const merged = { ...persisted, ...env };
      return Number(merged.OP_HOST_UI_PORT) || 3880;
    },
  ),
  // Faithful reimplementations of the two probe primitives the harness now
  // shares with the CLI. The identity probe hits /api/runtime; the test's
  // stubbed fetch only answers /health, so it reports 'absent' and the harness
  // takes the normal spawn path — which is what these tests exercise.
  checkExistingUiInstance: vi.fn(
    async (port: number, expectedAdmin: boolean): Promise<
      { status: 'absent' } | { status: 'match'; admin: boolean } | { status: 'mismatch'; admin: boolean }
    > => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/runtime`, {
          signal: AbortSignal.timeout(1000),
        });
        if (!res.ok) return { status: 'absent' };
        const body = (await res.json()) as { admin?: boolean };
        const admin = body.admin === true;
        return admin === expectedAdmin ? { status: 'match', admin } : { status: 'mismatch', admin };
      } catch {
        return { status: 'absent' };
      }
    },
  ),
  readyOrChildExit: vi.fn(
    (waitFn: () => Promise<boolean>, childExited: Promise<unknown> | undefined) =>
      childExited ? Promise.race([waitFn(), childExited.then(() => false)]) : waitFn(),
  ),
}));

vi.mock('../src/update-check.js', () => ({
  checkForElectronUpdate: vi.fn(async () => ({ updateAvailable: false })),
  getCachedUpdateInfo: vi.fn(() => null),
}));


import {
  buildUIServerEnv,
  getLaunchOnLoginStatus,
  handleWindowOpen,
  isAllowedInAppWindowUrl,
  openLocalApp,
  resolveAssistantUrl,
  setLaunchOnLogin,
  showNotification,
  supportsLaunchOnLogin,
  waitForReady,
} from '../src/main.js';
import { app, BrowserWindow, Notification, shell } from 'electron';
import * as lib from '@openpalm/lib';
import { TrayController } from '../src/tray.js';

// ── buildUIServerEnv ─────────────────────────────────────────────────────────

describe('buildUIServerEnv', () => {
  it('includes OP_HOME, HOST, PORT, and ORIGIN', () => {
    const env = buildUIServerEnv('/home/user/.openpalm', 3880);
    expect(env.OP_HOME).toBe('/home/user/.openpalm');
    expect(env.HOST).toBe('127.0.0.1');
    expect(env.PORT).toBe('3880');
    expect(env.ORIGIN).toBe('http://127.0.0.1:3880');
  });

  it('converts port number to string', () => {
    const env = buildUIServerEnv('/data/op', 9999);
    expect(env.PORT).toBe('9999');
    expect(typeof env.PORT).toBe('string');
  });

  it('ORIGIN matches HOST and PORT', () => {
    const env = buildUIServerEnv('/x', 4000);
    expect(env.ORIGIN).toBe(`http://127.0.0.1:${env.PORT}`);
  });

  it('neutralizes inherited remote-access configuration', () => {
    const previous = process.env.OP_ALLOW_REMOTE_SETUP;
    process.env.OP_ALLOW_REMOTE_SETUP = '1';
    try {
      expect(buildUIServerEnv('/x', 4000).OP_ALLOW_REMOTE_SETUP).toBe('0');
    } finally {
      if (previous === undefined) delete process.env.OP_ALLOW_REMOTE_SETUP;
      else process.env.OP_ALLOW_REMOTE_SETUP = previous;
    }
  });

  it('does NOT bake OP_OPENCODE_URL — the child resolves the assistant lazily', () => {
    // Freezing the URL at launch made the child unable to distinguish a
    // harness-generated value from an operator override, so it resorted to
    // reverse-engineering the URL's shape to decide whether to discard it. Any
    // change to how this side formatted the URL silently broke that detection
    // and stranded the /oc proxy on a dead port. Both sides now call the same
    // lib resolver, on demand.
    const env = buildUIServerEnv('/home/user/.openpalm', 3880);
    expect(env.OP_OPENCODE_URL).toBeUndefined();
  });
});

// ── resolveAssistantUrl (E1) ─────────────────────────────────────────────────
// E1: three divergent env-resolution chains (Electron process-env-only,
// CLI's persisted-stack merge, the container entrypoint's own inline logic)
// produced a browser-breaking http://0.0.0.0:3800 seed whenever the admin
// LAN-exposure toggle set OP_ASSISTANT_BIND_ADDRESS=0.0.0.0 — this exact test
// file used to PIN that broken 0.0.0.0 output (see git history). Electron now
// delegates to the ONE shared `resolveAssistantEndpoint(homeDir)` in
// @openpalm/lib (also used by the CLI/container writers), which always
// normalizes wildcard bind hosts to 127.0.0.1. The precedence chain itself is
// exhaustively tested in packages/lib/src/control-plane/assistant-endpoint.test.ts;
// this suite only pins the DELEGATION — main.ts must not re-derive the chain
// or re-introduce a raw wildcard host locally.
describe('resolveAssistantUrl', () => {
  afterEach(() => {
    vi.mocked(lib.resolveAssistantEndpoint).mockReset();
  });

  it('delegates to lib.resolveAssistantEndpoint(homeDir) instead of re-deriving the precedence chain', () => {
    vi.mocked(lib.resolveAssistantEndpoint).mockReturnValue('http://127.0.0.1:3800');
    expect(resolveAssistantUrl('/home/user/.openpalm')).toBe('http://127.0.0.1:3800');
    expect(lib.resolveAssistantEndpoint).toHaveBeenCalledWith('/home/user/.openpalm');
  });

  it('never re-wraps or mutates the resolver result — whatever lib returns is returned as-is (lib owns normalization)', () => {
    vi.mocked(lib.resolveAssistantEndpoint).mockReturnValue('http://example.test:9999');
    expect(resolveAssistantUrl('/home/user/.openpalm')).toBe('http://example.test:9999');
  });

  it('CANNOT produce the pre-fix http://0.0.0.0:PORT seed (E1) — the resolver is the only source of truth and it always normalizes', () => {
    // Even if the resolver were somehow asked to return a wildcard host, this
    // pins that main.ts performs no local bind-address-to-URL derivation that
    // could bypass lib's normalization (the pre-fix bug lived entirely in
    // main.ts's own stack.env-parsing logic, since removed).
    vi.mocked(lib.resolveAssistantEndpoint).mockReturnValue('http://127.0.0.1:4800');
    expect(resolveAssistantUrl('/home/user/.openpalm')).not.toContain('0.0.0.0');
  });
});

describe('set-tray-mic-recording IPC handler', () => {
  it('forwards the recording flag to trayController.setMicRecording', () => {
    const spy = vi.spyOn(TrayController.prototype, 'setMicRecording');
    const handler = ipcMainHandleHandlers.get('set-tray-mic-recording');
    expect(handler).toBeDefined();
    handler?.(null, true);
    expect(spy).toHaveBeenCalledWith(true);
    handler?.(null, false);
    expect(spy).toHaveBeenCalledWith(false);
    spy.mockRestore();
  });
});

// ── isAllowedInAppWindowUrl (security review hardening) ─────────────────────
// PRE-EXISTING (not introduced by this diff): setWindowOpenHandler used to
// gate in-app windows with `url.startsWith('http://127.0.0.1') ||
// url.startsWith('http://localhost')`. Prefix matching admits non-loopback
// hosts such as http://127.0.0.1.evil.com (subdomain) and
// http://127.0.0.1@evil.com (userinfo) — both would open attacker content in
// an in-app BrowserWindow instead of deferring to the external browser.
// isAllowedInAppWindowUrl replaces the prefix check with real URL parsing:
// only http: URLs whose HOSTNAME is exactly 127.0.0.1 or localhost (any
// port) are allowed.
describe('isAllowedInAppWindowUrl', () => {
  it('allows http://127.0.0.1 with any port', () => {
    expect(isAllowedInAppWindowUrl('http://127.0.0.1:3880/host')).toBe(true);
  });

  it('allows http://localhost with any port', () => {
    expect(isAllowedInAppWindowUrl('http://localhost:3890/chat')).toBe(true);
  });

  it('rejects a subdomain bypass (http://127.0.0.1.evil.com)', () => {
    expect(isAllowedInAppWindowUrl('http://127.0.0.1.evil.com')).toBe(false);
  });

  it('rejects a userinfo bypass (http://127.0.0.1@evil.com)', () => {
    expect(isAllowedInAppWindowUrl('http://127.0.0.1@evil.com')).toBe(false);
  });

  it('rejects https (protocol must be exactly http:)', () => {
    expect(isAllowedInAppWindowUrl('https://127.0.0.1:3880')).toBe(false);
  });

  it('rejects a non-loopback host', () => {
    expect(isAllowedInAppWindowUrl('http://example.com')).toBe(false);
  });

  it('rejects unparsable input', () => {
    expect(isAllowedInAppWindowUrl('not a url')).toBe(false);
  });
});

describe('popup handling', () => {
  beforeEach(() => {
    mockBrowserWindow.loadURL.mockClear();
    mockBrowserWindow.show.mockClear();
    mockBrowserWindow.focus.mockClear();
    vi.mocked(shell.openExternal).mockClear();
  });

  it('reuses the existing main window for allowed loopback URLs and denies the popup', () => {
    const windowCount = vi.mocked(BrowserWindow).mock.calls.length;
    const result = handleWindowOpen(
      mockBrowserWindow as unknown as InstanceType<typeof BrowserWindow>,
      'http://127.0.0.1:3880/chat/session-1',
    );

    expect(result).toEqual({ action: 'deny' });
    expect(mockBrowserWindow.loadURL).toHaveBeenCalledWith('http://127.0.0.1:3880/chat/session-1');
    expect(mockBrowserWindow.show).toHaveBeenCalledOnce();
    expect(mockBrowserWindow.focus).toHaveBeenCalledOnce();
    expect(shell.openExternal).not.toHaveBeenCalled();
    expect(vi.mocked(BrowserWindow)).toHaveBeenCalledTimes(windowCount);
  });

  it('opens external URLs in the system browser and denies the popup', () => {
    const windowCount = vi.mocked(BrowserWindow).mock.calls.length;
    const result = handleWindowOpen(
      mockBrowserWindow as unknown as InstanceType<typeof BrowserWindow>,
      'https://example.com/docs',
    );

    expect(result).toEqual({ action: 'deny' });
    expect(shell.openExternal).toHaveBeenCalledWith('https://example.com/docs');
    expect(mockBrowserWindow.loadURL).not.toHaveBeenCalled();
    expect(vi.mocked(BrowserWindow)).toHaveBeenCalledTimes(windowCount);
  });
});

// ── waitForReady ─────────────────────────────────────────────────────────────

describe('waitForReady', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('resolves true when server responds with 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    const result = await waitForReady(3880, 5000);
    expect(result).toBe(true);
  });

  it('resolves true when server responds with 401 (auth wall = server is up)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    const result = await waitForReady(3880, 5000);
    expect(result).toBe(true);
  });

  it('resolves false when server never responds within timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    // Run with a very short timeout so the loop exits quickly
    const promise = waitForReady(3880, 100);

    // Advance all timers so the retry delays flush
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result).toBe(false);
  });
});

// ── openLocalApp compatibility alias ─────────────────────────────────────────
describe('openLocalApp', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(shell.openExternal).mockClear();
  });

  it('opens the canonical UI chat without probing another server', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await openLocalApp();
    expect(shell.openExternal).toHaveBeenCalledWith('http://127.0.0.1:3880/chat');
    expect(shell.openExternal).not.toHaveBeenCalledWith('http://127.0.0.1:3890/chat');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('showNotification', () => {
  beforeEach(() => {
    mockNotificationShow.mockReset();
    notificationInstances.length = 0;
    vi.mocked(Notification.isSupported).mockReturnValue(true);
  });

  it('calls show() on the Notification instance', () => {
    showNotification('Test Title', 'Test body');
    expect(mockNotificationShow).toHaveBeenCalledTimes(1);
  });

  it('works with title only (no body argument)', () => {
    showNotification('Title only');
    expect(mockNotificationShow).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when Notification.isSupported() returns false', () => {
    vi.mocked(Notification.isSupported).mockReturnValue(false);
    showNotification('Should not fire');
    expect(mockNotificationShow).not.toHaveBeenCalled();
  });

  it('registers a renderer notification bridge that shows only when unfocused', () => {
    const handler = ipcMainOnHandlers.get('notify');
    expect(handler).toBeDefined();

    mockBrowserWindow.isFocused.mockReturnValue(false);
    handler?.({}, { title: 'OpenPalm', body: 'Assistant replied' });
    expect(notificationInstances).toHaveLength(1);
    expect(notificationInstances[0].show).toHaveBeenCalledTimes(1);
    expect(notificationInstances[0].on).toHaveBeenCalledWith('click', expect.any(Function));
  });

  it('suppresses renderer notifications while the main window is focused', () => {
    const handler = ipcMainOnHandlers.get('notify');
    mockBrowserWindow.isFocused.mockReturnValue(true);
    notificationInstances.length = 0;
    mockNotificationShow.mockClear();

    handler?.({}, { title: 'OpenPalm', body: 'Assistant replied' });
    expect(notificationInstances).toHaveLength(0);
    expect(mockNotificationShow).not.toHaveBeenCalled();
  });
});

describe('launch-on-login helpers', () => {
  beforeEach(() => {
    vi.mocked(app.getLoginItemSettings).mockClear();
    vi.mocked(app.getLoginItemSettings).mockReturnValue({ openAtLogin: false });
    vi.mocked(app.setLoginItemSettings).mockClear();
  });

  it('reports launch-on-login support only on macOS and Windows', () => {
    expect(supportsLaunchOnLogin('darwin')).toBe(true);
    expect(supportsLaunchOnLogin('win32')).toBe(true);
    expect(supportsLaunchOnLogin('linux')).toBe(false);
  });

  it('reads the current launch-on-login state on supported platforms', () => {
    vi.mocked(app.getLoginItemSettings).mockReturnValue({ openAtLogin: true });

    expect(getLaunchOnLoginStatus('darwin')).toEqual({ supported: true, enabled: true });
  });

  it('returns unsupported on Linux without touching Electron login settings', () => {
    expect(getLaunchOnLoginStatus('linux')).toEqual({ supported: false, enabled: false });
    expect(app.getLoginItemSettings).not.toHaveBeenCalled();
  });

  it('writes launch-on-login via Electron and returns the updated state', () => {
    vi.mocked(app.getLoginItemSettings).mockReturnValue({ openAtLogin: true });

    expect(setLaunchOnLogin(true, 'win32')).toEqual({ supported: true, enabled: true });
    expect(app.setLoginItemSettings).toHaveBeenCalledWith({ openAtLogin: true });
  });

  it('registers ipc handlers for launch-on-login reads and writes', () => {
    const statusHandler = ipcMainHandleHandlers.get('launch-on-login-status');
    const setHandler = ipcMainHandleHandlers.get('set-launch-on-login');
    expect(statusHandler).toBeDefined();
    expect(setHandler).toBeDefined();

    expect(statusHandler?.()).toEqual({ supported: false, enabled: false });
    expect(setHandler?.({}, true)).toEqual({ supported: false, enabled: false });
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });
});

describe('desktop bootstrap', () => {
  it('spawns the bundled UI and lands on /start', async () => {
    const { spawn } = await import('node:child_process');
    vi.mocked(spawn).mockClear();
    vi.mocked(lib.waitForReady).mockResolvedValue(true);
    vi.mocked(app.quit).mockClear();
    mockBrowserWindow.loadURL.mockClear();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/runtime/landing')) {
        return new Response(JSON.stringify({ landing: '/start' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(null, { status: 200 });
    }));

    startupHarness.releaseReady();

    await vi.waitFor(() => {
      expect(mockBrowserWindow.loadURL).toHaveBeenCalledWith('http://127.0.0.1:3880/start');
    });
    expect(spawn).toHaveBeenCalled();
    expect(lib.checkDocker).not.toHaveBeenCalled();
    expect(lib.checkDockerCompose).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    expect(mockSetAppUserModelId).toHaveBeenCalledWith('com.openpalm.app');
  });
});

// ── ensureHomeDirs is called before checking UI build ───────────────────────

describe('lib integration', () => {
  it('ensureHomeDirs is exported from @openpalm/lib and mocked', () => {
    expect(lib.ensureHomeDirs).toBeDefined();
    expect(vi.isMockFunction(lib.ensureHomeDirs)).toBe(true);
  });

  it('resolveOpenPalmHome returns the mocked home path', () => {
    expect(lib.resolveOpenPalmHome()).toBe('/home/user/.openpalm');
  });

  it('buildUIServerEnv uses OP_HOME from resolveOpenPalmHome', () => {
    const homeDir = lib.resolveOpenPalmHome();
    const env = buildUIServerEnv(homeDir, 3880);
    expect(env.OP_HOME).toBe('/home/user/.openpalm');
  });
});

describe('open-local-app compatibility IPC', () => {
  beforeEach(() => {
    vi.mocked(shell.openExternal).mockClear();
  });

  it('opens the canonical UI chat rather than port 3890', async () => {
    const handler = ipcMainHandleHandlers.get('open-local-app');
    expect(handler).toBeDefined();

    await handler?.();

    expect(shell.openExternal).toHaveBeenCalledWith('http://127.0.0.1:3880/chat');
    expect(shell.openExternal).not.toHaveBeenCalledWith('http://127.0.0.1:3890/chat');
  });
});

// ── before-quit handler (double-quit fix) ─────────────────────────────────────
// The handler must be synchronous — Electron doesn't await async event handlers.
// First call: preventDefault + cleanup + app.quit().
// Second call (re-entrant, cleanupStarted=true): returns immediately, no preventDefault.
// Without this fix a second manual Quit click was required.

describe('before-quit handler', () => {
  it('handler is synchronous', () => {
    const entry = vi.mocked(app.on).mock.calls.find(([e]) => e === 'before-quit');
    expect(entry, 'before-quit handler must be registered').toBeDefined();
    const handler = entry?.[1] as (...args: unknown[]) => unknown;
    expect(handler.constructor.name, 'handler must not be AsyncFunction').not.toBe('AsyncFunction');
  });

  it('first call: prevents default and calls app.exit(0); second call: passes through', () => {
    const entry = vi.mocked(app.on).mock.calls.find(([e]) => e === 'before-quit');
    const handler = entry?.[1] as (event: { preventDefault: () => void }) => void;

    vi.mocked(app.exit).mockClear();
    vi.mocked(app.quit).mockClear();

    // First call — should prevent default and trigger cleanup + exit.
    // NOTE: app.exit(0) is used (not app.quit) because calling app.quit()
    // re-entrantly from within before-quit is silently no-op'd by Electron on
    // some versions, leaving the app hanging (root cause of the double-quit bug).
    const event1 = { preventDefault: vi.fn() };
    handler(event1);
    expect(event1.preventDefault).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledWith(0);
    // app.quit must NOT be called — we use app.exit exclusively for the cleanup path
    expect(app.quit).not.toHaveBeenCalled();

    // Second call — simulates Electron re-firing before-quit after app.exit().
    // cleanupStarted is now true; must NOT call preventDefault (lets Electron proceed).
    const event2 = { preventDefault: vi.fn() };
    handler(event2);
    expect(event2.preventDefault).not.toHaveBeenCalled();
    // app.exit should not have been called again
    expect(app.exit).toHaveBeenCalledOnce();
  });
});

// ── quit flag is single-sourced (typed module var, not stuffed on `app`) ──────
// Pre-refactor the quit flag was written/read as `(app as any).isQuitting` — an
// any-cast escape hatch that mutated the shared Electron `app` object. It now
// lives in a typed module-scoped `isQuitting` var, so the quit handlers must NOT
// mutate the app object. This pins that boundary: firing before-quit (a write
// site) leaves the electron `app` object untouched. Placed AFTER the before-quit
// describe so that suite fires the "first call" with fresh cleanupStarted state.
describe('quit flag single-sourcing', () => {
  it('before-quit does not stuff isQuitting onto the electron app object', () => {
    const entry = vi.mocked(app.on).mock.calls.find(([e]) => e === 'before-quit');
    expect(entry, 'before-quit handler must be registered').toBeDefined();
    const handler = entry?.[1] as (event: { preventDefault: () => void }) => void;

    // Seed the mock app's field to false so any write by the handler is detected.
    // (Line 930's `isQuitting = true` runs BEFORE the cleanupStarted early-return,
    // so this catches the write regardless of prior before-quit firings.)
    (app as unknown as { isQuitting: boolean }).isQuitting = false;
    handler({ preventDefault: vi.fn() });

    // The typed module-scoped flag is the SSOT; the shared app object stays clean.
    expect((app as unknown as { isQuitting: boolean }).isQuitting).toBe(false);
  });
});
