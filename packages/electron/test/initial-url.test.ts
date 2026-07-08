// ── P5c RED TESTS (#555) — Electron window prefers the client app ─────────────
//
// Plan Phase 5 item 3 / phase-5-completion-guide §4 P5c item 3: main.ts starts
// the @openpalm/client static server child after the UI server, and when setup
// is complete the window loads the CLIENT chat at http://127.0.0.1:3890/chat —
// FALLING BACK to the host app's chat on 3880 when the client child is not
// healthy (fallback stays dumb: probe, and on any failure use 3880).
//
// Pinned contract (these tests are the spec):
//   • `resolveInitialUrl` is EXPORTED from src/main.ts (it exists today as a
//     module-private function) so the preference/fallback decision is testable.
//   • Setup complete + client healthy      → http://127.0.0.1:3890/chat
//   • Setup complete + client unreachable  → http://127.0.0.1:3880/chat
//   • Setup incomplete                     → http://127.0.0.1:3880/setup
//     (ALWAYS the host app — the client artifact has no setup wizard.)
//   • Setup-status probe failure           → http://127.0.0.1:3880 (root; the
//     host app's own landing guard redirects — existing behavior, unchanged).
//   • Client health is probed over HTTP against 127.0.0.1:3890 (any path); the
//     probe must be short/bounded — a dead client must not stall window
//     creation (enforced here via the test timeout).
//   • HARNESS_CONTRACT_VERSION stays at 1: P5c is spawn-env/child work, not
//     bridge surface (characterization — already green; see the drift tests).
//
// Run via vitest (Node), NOT bun test — same reason as main.test.ts.
import { describe, it, expect, vi, afterEach } from 'vitest';
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
  resolveClientAppPort: vi.fn(() => 3890),
  resolveClientAppUrl: vi.fn(() => 'http://127.0.0.1:3890/chat'),
  writeClientRuntimeConfig: vi.fn(),
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
vi.mock('../src/settings.js', () => ({
  loadSettings: vi.fn(() => ({ checkPrerelease: false })),
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
    throw new Error('resolveInitialUrl is not exported from src/main.ts yet (P5c red test)');
  }
  return resolveInitialUrl();
}

/**
 * Stub global fetch by target:
 *  - 127.0.0.1:3880/api/setup/status → the host app's setup status
 *  - 127.0.0.1:3890 (any path)       → the client static server health
 * Everything else fails fast (irrelevant to these assertions).
 */
function stubFetch(opts: { setup: boolean | 'error'; clientUp: boolean }) {
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('127.0.0.1:3880/api/setup/status')) {
      if (opts.setup === 'error') throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => ({ setupComplete: opts.setup === true }) };
    }
    if (url.includes('127.0.0.1:3890')) {
      if (!opts.clientUp) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => ({}) };
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── resolveInitialUrl — client-first with dumb 3880 fallback (P5c) ────────────

describe('resolveInitialUrl — prefers the client app, falls back to the host app', () => {
  it('is exported from main.ts so the preference/fallback decision is testable', () => {
    expect(typeof resolveInitialUrl, 'export resolveInitialUrl from src/main.ts').toBe('function');
  });

  it('loads the CLIENT chat (127.0.0.1:3890/chat) when setup is complete and the client child is healthy', async () => {
    stubFetch({ setup: true, clientUp: true });
    await expect(callResolveInitialUrl()).resolves.toBe('http://127.0.0.1:3890/chat');
  });

  it('falls back to the HOST APP chat (127.0.0.1:3880/chat) when the client server is unreachable', { timeout: 15_000 }, async () => {
    // Resilience: the client child failed to start (e.g. no client build on
    // disk — the CLI/harness skip is non-fatal). The window must land on the
    // packages/ui chat, which is NOT deleted in P5c (parity follow-up).
    stubFetch({ setup: true, clientUp: false });
    await expect(callResolveInitialUrl()).resolves.toBe('http://127.0.0.1:3880/chat');
  });

  it('always lands on the HOST APP setup wizard when setup is incomplete (the client has no /setup)', async () => {
    // Even with a healthy client child: the client artifact structurally lacks
    // host capabilities (plan §8.10) — setup must stay on the host app.
    stubFetch({ setup: false, clientUp: true });
    await expect(callResolveInitialUrl()).resolves.toBe('http://127.0.0.1:3880/setup');
  });

  it('keeps the dumb root fallback (127.0.0.1:3880) when the setup-status probe fails', { timeout: 15_000 }, async () => {
    // Existing behavior, unchanged: the host app root re-routes via its own
    // landing guard. No cleverness on failure paths.
    stubFetch({ setup: 'error', clientUp: true });
    await expect(callResolveInitialUrl()).resolves.toBe('http://127.0.0.1:3880');
  });
});

// ── characterization: harness contract version ───────────────────────────────

describe('harness contract version', () => {
  it('HARNESS_CONTRACT_VERSION is 2 after adding the open-local-app bridge surface', () => {
    expect(HARNESS_CONTRACT_VERSION).toBe(2);
  });
});
