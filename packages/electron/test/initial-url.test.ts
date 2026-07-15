// ── A1 — Electron defaults to the HOST chat; client chat is opt-in ──────────
//
// Review finding A1 [HIGH, root cause]: resolveInitialUrl used to prefer the
// client SPA chat whenever its capability-blind health probe answered — but
// the client chat fails all six items of the plan's §12.2 chat-parity
// contract (docs/technical/ui-runtime-modes-plan.md §12.2): no voice, no
// streaming, no stop, no history, no markdown, no copy. This file used to PIN
// that broken "prefer the client" behavior (see git history / the review) —
// it is rewritten here to pin the FIXED contract instead:
//
//   • Default (no opt-in)                    → HOST chat, ALWAYS, even when
//                                                the client server is healthy.
//   • Opt-in (settings flag OR env var) AND
//     the client server is healthy           → the CLIENT chat.
//   • Opt-in but the client server is NOT
//     healthy                                → HOST chat (dumb fallback,
//                                                unchanged from before).
//   • The landing resolver says anything OTHER than /chat (setup incomplete,
//     installed_offline, installed_broken, a future migration gate, ...)
//     → the HOST APP at that landing path, UNCONDITIONALLY — this subsumes
//     the old /api/setup/status probe with one call to the shared
//     GET /api/runtime/landing endpoint (review J2), and ALWAYS wins over the
//     client-chat opt-in (the client artifact has no /setup, no /host, no
//     /attention — plan §8.10).
//   • Landing-probe failure (network error, non-2xx)  → the dumb root
//     fallback (http://127.0.0.1:3880), unchanged — the host app's own
//     landing guard redirects appropriately from there.
//
// Pinned contract:
//   • `resolveInitialUrl` stays EXPORTED from src/main.ts.
//   • The landing probe hits GET /api/runtime/landing (not the old
//     /api/setup/status) with a short/bounded (2s) timeout.
//   • The client-health probe (over HTTP against 127.0.0.1:3890, any path) is
//     short/bounded too — a dead client must not stall window creation.
//   • HARNESS_CONTRACT_VERSION stays at 2 (A1 is a routing-policy change, not
//     a bridge-surface change).
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
      // Make the UI build appear present so seedUiBuild is never called.
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
    whenReady: vi.fn(() => Promise.resolve()),
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
// checkDocker HANGS deliberately: the module-scope `app.whenReady().then(...)`
// boot flow awaits ensureDockerReady() forever, so no background UI-server
// start/health-poll loop can interfere with the per-test fetch stubs below.
// resolveInitialUrl is a pure exported helper — it needs none of the boot flow.
vi.mock('@openpalm/lib', () => ({
  resolveOpenPalmHome: vi.fn(() => '/home/user/.openpalm'),
  resolveDataDir: vi.fn(() => '/home/user/.openpalm/data'),
  resolveConfigDir: vi.fn(() => '/home/user/.openpalm/config'),
  resolveUiBuildDir: vi.fn(() => '/home/user/.openpalm/data/ui'),
  seedUiBuild: vi.fn(() => Promise.resolve()),
  ensureHomeDirs: vi.fn(),
  checkAndUpdateUiBuild: vi.fn(() => Promise.resolve({ updated: false, latestVersion: '0.12.0' })),
  checkAndUpdateClientBuild: vi.fn(() => Promise.resolve({ updated: false, latestVersion: '0.12.0' })),
  checkAndUpdateSkeleton: vi.fn(() => Promise.resolve({ updated: false, latestVersion: '0.12.0' })),
  uiUpdateChannel: vi.fn((v: string) => (v.includes('-') ? 'next' : 'latest')),
  parseEnvFile: vi.fn(() => ({})),
  PLATFORM_VERSION: 'v0.12.0',
  resolveClientAppPort: vi.fn((env: NodeJS.ProcessEnv = process.env) => Number(env.OP_HOST_CLIENT_PORT) || 3890),
  resolveClientAppUrl: vi.fn(() => 'http://127.0.0.1:3890/chat'),
  writeClientRuntimeConfig: vi.fn(),
  resolveAssistantEndpoint: vi.fn(() => 'http://127.0.0.1:3800'),
  checkDocker: vi.fn(() => new Promise(() => { /* hang: freeze the boot flow */ })),
  checkDockerCompose: vi.fn(() => Promise.resolve({ ok: true, stdout: '', stderr: '', code: 0 })),
  // Faithful reimplementation of lib's waitForReady (poll /health; 200 or 401 ==
  // ready) so a resolveInitialUrl implementation that probes the client child
  // through it still exercises the per-test global fetch stubs.
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
  restoreUiBackup: vi.fn(() => ({ status: 'no-backup' as const })),
  consumePendingUiBackup: vi.fn(() => null),
  // Faithful minimal UiSupervisor stub (main.ts constructs one at module scope).
  UiSupervisor: class {
    private handle: unknown = null;
    private restarting = false;
    // biome-ignore lint/suspicious/noExplicitAny: test-only faithful stub
    private readonly strategy: any;
    // biome-ignore lint/suspicious/noExplicitAny: test-only faithful stub
    private readonly cb: any;
    // biome-ignore lint/suspicious/noExplicitAny: test-only faithful stub
    constructor(opts: any) {
      this.strategy = opts.strategy;
      this.cb = opts.callbacks;
    }
    get current() { return this.handle; }
    get isRestarting() { return this.restarting; }
    adopt(handle: unknown) { this.handle = handle; }
    detachHandle() { this.handle = null; }
    markShuttingDown() { /* no-op */ }
    async start() { return true; }
    async restart() { return false; }
  },
}));

// Keep the boot flow's harness-scoped side quests inert and offline.
vi.mock('../src/update-check.js', () => ({
  checkForElectronUpdate: vi.fn(async () => ({ updateAvailable: false })),
  getCachedUpdateInfo: vi.fn(() => null),
}));
// Controllable per-test: the A1 opt-in can come from the desktop-settings
// flag (loadSettings) as well as the OP_CLIENT_CHAT_OPT_IN env var.
const { mockLoadSettings } = vi.hoisted(() => ({
  mockLoadSettings: vi.fn(() => ({ checkPrerelease: false, preferClientChat: false })),
}));
vi.mock('../src/settings.js', () => ({
  loadSettings: mockLoadSettings,
  saveSettings: vi.fn(),
}));
vi.mock('../src/local-opencode.js', () => ({
  startLocalOpenCode: vi.fn(() => Promise.resolve(null)),
  killProcessTree: vi.fn(),
}));

import * as main from '../src/main.js';
import { HARNESS_CONTRACT_VERSION } from '../src/harness-contract.js';

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
 * Stub global fetch by target:
 *  - 127.0.0.1:3880/api/runtime/landing → the host app's landing resolver
 *  - 127.0.0.1:3890 (any path)          → the client static server health
 * Everything else fails fast (irrelevant to these assertions).
 */
function stubFetch(opts: { landing: string | 'error'; clientUp: boolean }) {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('127.0.0.1:3880/api/runtime/landing')) {
      if (opts.landing === 'error') throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => ({ landing: opts.landing }) };
    }
    if (url.includes('127.0.0.1:3890')) {
      if (!opts.clientUp) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }));
}

beforeEach(() => {
  mockLoadSettings.mockReturnValue({ checkPrerelease: false, preferClientChat: false });
  delete process.env.OP_CLIENT_CHAT_OPT_IN;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OP_CLIENT_CHAT_OPT_IN;
});

describe('resolveInitialUrl — A1: host chat by default, client chat only opted in', () => {
  it('is exported from main.ts so the routing decision is testable', () => {
    expect(typeof resolveInitialUrl, 'export resolveInitialUrl from src/main.ts').toBe('function');
  });

  it('DEFAULT: loads the HOST chat (127.0.0.1:3880/chat) even when the client server is healthy and no opt-in is set', async () => {
    stubFetch({ landing: '/chat', clientUp: true });
    await expect(callResolveInitialUrl()).resolves.toBe('http://127.0.0.1:3880/chat');
  });

  it('OPT-IN (desktop settings flag): loads the CLIENT chat when preferClientChat is on and the client is healthy', async () => {
    mockLoadSettings.mockReturnValue({ checkPrerelease: false, preferClientChat: true });
    stubFetch({ landing: '/chat', clientUp: true });
    await expect(callResolveInitialUrl()).resolves.toBe('http://127.0.0.1:3890/chat');
  });

  it('OPT-IN (env var OP_CLIENT_CHAT_OPT_IN=1): loads the CLIENT chat when the client is healthy', async () => {
    process.env.OP_CLIENT_CHAT_OPT_IN = '1';
    stubFetch({ landing: '/chat', clientUp: true });
    await expect(callResolveInitialUrl()).resolves.toBe('http://127.0.0.1:3890/chat');
  });

  it('OPT-IN but the client server is unreachable: still falls back to the HOST chat (dumb fallback, unchanged)', { timeout: 15_000 }, async () => {
    mockLoadSettings.mockReturnValue({ checkPrerelease: false, preferClientChat: true });
    stubFetch({ landing: '/chat', clientUp: false });
    await expect(callResolveInitialUrl()).resolves.toBe('http://127.0.0.1:3880/chat');
  });

  it('lands on the HOST APP setup wizard when the landing resolver says /setup, opt-in or not (the client has no /setup)', async () => {
    mockLoadSettings.mockReturnValue({ checkPrerelease: false, preferClientChat: true });
    stubFetch({ landing: '/setup', clientUp: true });
    await expect(callResolveInitialUrl()).resolves.toBe('http://127.0.0.1:3880/setup');
  });

  it('lands on the HOST admin dashboard when the landing resolver says /host (installed_offline — J2)', async () => {
    stubFetch({ landing: '/host', clientUp: true });
    await expect(callResolveInitialUrl()).resolves.toBe('http://127.0.0.1:3880/host');
  });

  it('lands on the HOST diagnostics tab when the landing resolver says /host?tab=diagnostics (installed_broken — J2)', async () => {
    stubFetch({ landing: '/host?tab=diagnostics', clientUp: true });
    await expect(callResolveInitialUrl()).resolves.toBe('http://127.0.0.1:3880/host?tab=diagnostics');
  });

  it('lands on /attention when the landing resolver reports a pending migration gate (J3), even with the opt-in on', async () => {
    mockLoadSettings.mockReturnValue({ checkPrerelease: false, preferClientChat: true });
    stubFetch({ landing: '/attention', clientUp: true });
    await expect(callResolveInitialUrl()).resolves.toBe('http://127.0.0.1:3880/attention');
  });

  it('keeps the dumb root fallback (127.0.0.1:3880) when the landing probe fails', { timeout: 15_000 }, async () => {
    stubFetch({ landing: 'error', clientUp: true });
    await expect(callResolveInitialUrl()).resolves.toBe('http://127.0.0.1:3880');
  });
});

// ── characterization: harness contract version ───────────────────────────────

describe('harness contract version', () => {
  it('HARNESS_CONTRACT_VERSION is 2 — A1 is a routing-policy change, not a bridge-surface change', () => {
    expect(HARNESS_CONTRACT_VERSION).toBe(2);
  });
});
