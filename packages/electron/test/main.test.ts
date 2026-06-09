// Run via vitest (Node), NOT bun test — bun executes the real electron module
// and cannot honor vi.mock() hoisting. Use: bun run --cwd packages/electron test
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock node:fs before any imports ─────────────────────────────────────────
// Return true for the UI build index.js check so startUIServer skips seeding
// and the spawn path is reached. We mock spawn separately via node:child_process.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      // Make the UI build appear present so seedUiBuild is never called
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
const { mockBrowserWindow } = vi.hoisted(() => ({
  mockBrowserWindow: {
    loadURL: vi.fn(),
    webContents: { setWindowOpenHandler: vi.fn(), send: vi.fn() },
    on: vi.fn(),
    once: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    hide: vi.fn(),
    close: vi.fn(),
    setTitle: vi.fn(),
    isDestroyed: vi.fn(() => false),
    getAllWindows: vi.fn(() => []),
  },
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
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    getAppPath: vi.fn(() => '/mock/app'),
    // main.ts resolves a log path at import time via app.getPath('logs');
    // without this mock the unmocked call rejected at module load and made the
    // suite exit non-zero (an "unhandled rejection", not a true failure).
    getPath: vi.fn(() => '/mock/logs'),
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
    setLoginItemSettings: vi.fn(),
  },
  // Regular function (not arrow) so `new BrowserWindow(...)` works as a
  // constructor; vitest 4 enforces this stricter than 3 did.
  BrowserWindow: Object.assign(
    function MockBrowserWindow() { return mockBrowserWindow; },
    { getAllWindows: vi.fn(() => []) },
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
  ipcMain: { handle: vi.fn() },
  // Notification mock: constructor returns an object with a show() spy so we
  // can assert showNotification() calls it.
  Notification: Object.assign(
    function MockNotification() { return { show: mockNotificationShow }; },
    { isSupported: vi.fn(() => true) },
  ),
}));

// ── Mock @openpalm/lib ───────────────────────────────────────────────────────
vi.mock('@openpalm/lib', () => ({
  resolveOpenPalmHome: vi.fn(() => '/home/user/.openpalm'),
  resolveDataDir: vi.fn(() => '/home/user/.openpalm/data'),
  resolveConfigDir: vi.fn(() => '/home/user/.openpalm/config'),
  resolveUiBuildDir: vi.fn(() => '/home/user/.openpalm/data/ui'),
  seedUiBuild: vi.fn(() => Promise.resolve()),
  ensureHomeDirs: vi.fn(),
  checkAndUpdateUiBuild: vi.fn(() => Promise.resolve({ updated: false, latestVersion: '0.11.0' })),
  uiUpdateChannel: vi.fn((v: string) => (v.includes('-') ? 'next' : 'latest')),
  parseEnvFile: vi.fn(() => ({})),
}));

vi.mock('../src/local-opencode.js', () => ({
  startLocalOpenCode: vi.fn(() => Promise.resolve(null)),
  killProcessTree: vi.fn(),
}));

import { buildUIServerEnv, resolveAssistantUrl, waitForReady, showNotification } from '../src/main.js';
import { app } from 'electron';
import * as lib from '@openpalm/lib';

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

  it('sets OP_OPENCODE_URL so the UI proxy can reach the assistant', () => {
    const env = buildUIServerEnv('/home/user/.openpalm', 3880);
    expect(env.OP_OPENCODE_URL).toBe('http://127.0.0.1:3800');
  });
});

// ── resolveAssistantUrl ──────────────────────────────────────────────────────

describe('resolveAssistantUrl', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.mocked(lib.parseEnvFile).mockReset();
  });

  it('defaults to 127.0.0.1:3800 when stack.env is empty', () => {
    vi.mocked(lib.parseEnvFile).mockReturnValue({});
    delete process.env.OP_OPENCODE_URL;
    delete process.env.OP_ASSISTANT_URL;
    expect(resolveAssistantUrl('/home/user/.openpalm')).toBe('http://127.0.0.1:3800');
  });

  it('uses OP_ASSISTANT_PORT and OP_ASSISTANT_BIND_ADDRESS from stack.env', () => {
    vi.mocked(lib.parseEnvFile).mockReturnValue({
      OP_ASSISTANT_PORT: '4800',
      OP_ASSISTANT_BIND_ADDRESS: '0.0.0.0',
    });
    delete process.env.OP_OPENCODE_URL;
    delete process.env.OP_ASSISTANT_URL;
    expect(resolveAssistantUrl('/home/user/.openpalm')).toBe('http://0.0.0.0:4800');
  });

  it('respects OP_OPENCODE_URL from the shell environment', () => {
    process.env.OP_OPENCODE_URL = 'http://example.test:9999';
    expect(resolveAssistantUrl('/home/user/.openpalm')).toBe('http://example.test:9999');
  });

  it('falls back to OP_ASSISTANT_URL when OP_OPENCODE_URL is unset', () => {
    delete process.env.OP_OPENCODE_URL;
    process.env.OP_ASSISTANT_URL = 'http://example.test:1234';
    expect(resolveAssistantUrl('/home/user/.openpalm')).toBe('http://example.test:1234');
  });

  it('reads stack.env from ${homeDir}/knowledge/env/stack.env', () => {
    vi.mocked(lib.parseEnvFile).mockReturnValue({});
    delete process.env.OP_OPENCODE_URL;
    delete process.env.OP_ASSISTANT_URL;
    resolveAssistantUrl('/some/home');
    expect(lib.parseEnvFile).toHaveBeenCalledWith('/some/home/knowledge/env/stack.env');
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

// ── showNotification ──────────────────────────────────────────────────────────

import { Notification } from 'electron';

describe('showNotification', () => {
  beforeEach(() => {
    mockNotificationShow.mockReset();
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

// ── before-quit handler (double-quit fix) ─────────────────────────────────────
// The handler must be synchronous — Electron doesn't await async event handlers.
// First call: preventDefault + cleanup + app.quit().
// Second call (re-entrant, cleanupStarted=true): returns immediately, no preventDefault.
// Without this fix a second manual Quit click was required.

describe('before-quit handler', () => {
  it('handler is synchronous', () => {
    const entry = vi.mocked(app.on).mock.calls.find(([e]) => e === 'before-quit');
    expect(entry, 'before-quit handler must be registered').toBeDefined();
    const handler = entry![1] as (...args: unknown[]) => unknown;
    expect(handler.constructor.name, 'handler must not be AsyncFunction').not.toBe('AsyncFunction');
  });

  it('first call: prevents default and calls app.exit(0); second call: passes through', () => {
    const entry = vi.mocked(app.on).mock.calls.find(([e]) => e === 'before-quit');
    const handler = entry![1] as (event: { preventDefault: () => void }) => void;

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
