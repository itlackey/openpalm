// Electron opens the UI root and lets the server's navigation guard resolve the
// landing. No legacy setting or environment opt-in may select the removed
// port-3890 chat surface.
//
// Run via vitest (Node), NOT bun test — same reason as main.test.ts.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Mock node:fs (same shape as main.test.ts) ─────────────────────────────────
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      // Make the bundled UI build appear present so startUIServer doesn't bail.
      if (String(p).endsWith('index.js')) return true;
      return false;
    }),
  };
});

// ── Mock node:child_process — never spawn a real process ─────────────────────
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const fakeProcess = { on: vi.fn(), kill: vi.fn(), stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, pid: 4242 };
  return { ...actual, spawn: vi.fn(() => fakeProcess) };
});

// ── Mock electron (same shape as main.test.ts, plus session/systemPreferences) ─
const { mockBrowserWindow } = vi.hoisted(() => ({
  mockBrowserWindow: {
    loadURL: vi.fn(() => Promise.resolve()),
    webContents: { setWindowOpenHandler: vi.fn(), send: vi.fn(), on: vi.fn() },
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
  },
}));

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '0.12.0'),
    quit: vi.fn(),
    exit: vi.fn(),
    whenReady: vi.fn(() => new Promise(() => {})),
    on: vi.fn(),
    getAppPath: vi.fn(() => '/mock/app'),
    getPath: vi.fn(() => join(tmpdir(), 'openpalm-initial-url-test-logs')),
    relaunch: vi.fn(),
    setAppUserModelId: vi.fn(),
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
    setLoginItemSettings: vi.fn(),
    // E1: this suite never actually reaches whenReady (it stays pending
    // forever, by design — see the comment below), so the lock's return value
    // doesn't drive any behavior here; it only needs to exist so module load
    // doesn't throw.
    requestSingleInstanceLock: vi.fn(() => true),
  },
  BrowserWindow: Object.assign(
    function MockBrowserWindow() { return mockBrowserWindow; },
    { getAllWindows: vi.fn(() => [mockBrowserWindow]) },
  ),
  contextBridge: { exposeInMainWorld: vi.fn() },
  dialog: { showErrorBox: vi.fn(), showMessageBoxSync: vi.fn(() => 1) },
  Tray: function MockTray() {
    return { setToolTip: vi.fn(), setContextMenu: vi.fn(), on: vi.fn() };
  },
  globalShortcut: { register: vi.fn(() => false), unregisterAll: vi.fn() },
  nativeImage: {
    createFromPath: vi.fn(() => ({
      toBitmap: vi.fn(() => Buffer.from([])),
      getSize: vi.fn(() => ({ width: 16, height: 16 })),
    })),
    createFromBitmap: vi.fn(() => ({})),
  },
  Menu: { buildFromTemplate: vi.fn(() => ({})) },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  Notification: Object.assign(
    function MockNotification() { return { show: vi.fn(), on: vi.fn() }; },
    { isSupported: vi.fn(() => true) },
  ),
  session: {
    defaultSession: {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
    },
  },
  systemPreferences: {
    askForMediaAccess: vi.fn(async () => true),
    getMediaAccessStatus: vi.fn(() => 'granted'),
  },
}));

// ── Mock @openpalm/lib ────────────────────────────────────────────────────────
// Keep app.whenReady pending above so the module-scope boot flow cannot interfere
// with the pure resolveInitialUrl tests below.
vi.mock('@openpalm/lib', () => ({
  resolveOpenPalmHome: vi.fn(() => '/home/user/.openpalm'),
  resolveDataDir: vi.fn(() => '/home/user/.openpalm/data'),
  resolveConfigDir: vi.fn(() => '/home/user/.openpalm/config'),
  resolveUiBuildDir: vi.fn(() => '/home/user/.openpalm/data/ui'),
  ensureHomeDirs: vi.fn(),
  parseEnvFile: vi.fn(() => ({})),
  stackEnvFile: vi.fn((home: string) => `${home}/state/stack.env`),
  // Host-UI port contract (lib network-contract.ts) — resolved at main.ts
  // module scope, so it must exist even for tests that never start the server.
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
  checkExistingUiInstance: vi.fn(async () => ({ status: 'absent' as const })),
  readyOrChildExit: vi.fn(
    (waitFn: () => Promise<boolean>, childExited: Promise<unknown> | undefined) =>
      childExited ? Promise.race([waitFn(), childExited.then(() => false)]) : waitFn(),
  ),
  resolveAssistantEndpoint: vi.fn(() => 'http://127.0.0.1:3800'),
  // Faithful reimplementation of lib's waitForReady for the UI bootstrap path.
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
  // Minimal fake of lib's UiSupervisor (adopt()/current only — main.ts never
  // calls start() here; see main.ts's uiSupervisor docblock).
  UiSupervisor: class {
    current: unknown = null;
    adopt(handle: unknown) {
      this.current = handle;
    }
  },
}));

const { mockLoadSettings } = vi.hoisted(() => ({
  mockLoadSettings: vi.fn<() => { checkPrerelease: boolean; preferClientChat?: boolean }>(
    () => ({ checkPrerelease: false }),
  ),
}));
vi.mock('../src/settings.js', () => ({
  loadSettings: mockLoadSettings,
  saveSettings: vi.fn(),
}));

import * as main from '../src/main.js';

// Namespace access (not a named import) so THIS file loads even before the
// export exists — each test then fails with the precise missing-feature reason
// instead of the whole file dying on an import error.
const resolveInitialUrl = (main as unknown as Record<string, unknown>).resolveInitialUrl as
  | (() => string)
  | undefined;

beforeEach(() => {
  mockLoadSettings.mockReturnValue({ checkPrerelease: false });
  delete process.env.OP_CLIENT_CHAT_OPT_IN;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OP_CLIENT_CHAT_OPT_IN;
});

describe('resolveInitialUrl', () => {
  it('is exported from main.ts so the routing decision is testable', () => {
    expect(typeof resolveInitialUrl, 'export resolveInitialUrl from src/main.ts').toBe('function');
  });

  // The window opens on the UI ROOT and lets the server's navigation guard pick
  // the landing. Resolving it here instead meant asking from the main process,
  // which shares no cookie jar with the window — so the browser's own state was
  // invisible to the probe and had to be read off the session and forwarded by
  // hand. Asking from the window makes that mechanism unnecessary.
  it('opens the UI root so the server resolves the landing', () => {
    expect(resolveInitialUrl?.()).toBe('http://127.0.0.1:3880');
  });

  it('resolves without a landing probe at all', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    resolveInitialUrl?.();
    expect(fetchSpy, 'the window carries its own cookies; no probe is needed').not.toHaveBeenCalled();
  });

  it('is synchronous, so window creation never waits on a network round trip', () => {
    expect(resolveInitialUrl?.()).not.toBeInstanceOf(Promise);
  });
});
