// Electron always resolves its initial page through the host UI's canonical
// /api/runtime/landing endpoint. No legacy setting or environment opt-in may
// select the removed port-3890 chat surface.
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
  },
  BrowserWindow: Object.assign(
    function MockBrowserWindow() { return mockBrowserWindow; },
    { getAllWindows: vi.fn(() => [mockBrowserWindow]) },
  ),
  contextBridge: { exposeInMainWorld: vi.fn() },
  dialog: { showErrorBox: vi.fn() },
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
  | (() => Promise<string>)
  | undefined;

async function callResolveInitialUrl(): Promise<string> {
  if (typeof resolveInitialUrl !== 'function') {
    throw new Error('resolveInitialUrl is not exported from src/main.ts yet (A1 test)');
  }
  return resolveInitialUrl();
}

/**
 * Stub the host UI landing endpoint. Everything else fails fast so a test also
 * detects any attempt to probe or route through another chat server.
 */
function stubFetch(landing: string | 'error') {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('127.0.0.1:3880/api/runtime/landing')) {
      if (landing === 'error') throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => ({ landing }) };
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }));
}

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

  it('loads the canonical UI chat', async () => {
    stubFetch('/chat');
    await expect(callResolveInitialUrl()).resolves.toBe('http://127.0.0.1:3880/chat');
  });

  it('loads the client-aware bootstrap page when the landing resolver says /start', async () => {
    stubFetch('/start');
    await expect(callResolveInitialUrl()).resolves.toBe('http://127.0.0.1:3880/start');
  });

  it('ignores a legacy preferClientChat setting and cannot select port 3890', async () => {
    mockLoadSettings.mockReturnValue({ checkPrerelease: false, preferClientChat: true });
    stubFetch('/chat');
    const url = await callResolveInitialUrl();
    expect(url).toBe('http://127.0.0.1:3880/chat');
    expect(url).not.toContain(':3890');
  });

  it('ignores OP_CLIENT_CHAT_OPT_IN and cannot select port 3890', async () => {
    process.env.OP_CLIENT_CHAT_OPT_IN = '1';
    stubFetch('/chat');
    const url = await callResolveInitialUrl();
    expect(url).toBe('http://127.0.0.1:3880/chat');
    expect(url).not.toContain(':3890');
  });

  it('lands on the UI setup wizard when the landing resolver says /setup', async () => {
    stubFetch('/setup');
    await expect(callResolveInitialUrl()).resolves.toBe('http://127.0.0.1:3880/setup');
  });

  it('lands on the UI admin dashboard when the landing resolver says /host', async () => {
    stubFetch('/host');
    await expect(callResolveInitialUrl()).resolves.toBe('http://127.0.0.1:3880/host');
  });

  it('lands on the UI diagnostics tab when requested', async () => {
    stubFetch('/host?tab=diagnostics');
    await expect(callResolveInitialUrl()).resolves.toBe('http://127.0.0.1:3880/host?tab=diagnostics');
  });

  it('lands on /attention when the landing resolver reports a pending migration gate', async () => {
    stubFetch('/attention');
    await expect(callResolveInitialUrl()).resolves.toBe('http://127.0.0.1:3880/attention');
  });

  it('falls back to the UI root when the landing probe fails', async () => {
    stubFetch('error');
    await expect(callResolveInitialUrl()).resolves.toBe('http://127.0.0.1:3880');
  });
});
