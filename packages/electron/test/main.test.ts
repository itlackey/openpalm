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

const { mockClearStorageData } = vi.hoisted(() => ({
  mockClearStorageData: vi.fn(() => Promise.resolve()),
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
    relaunch: vi.fn(),
    setAppUserModelId: mockSetAppUserModelId,
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
    setLoginItemSettings: vi.fn(),
  },
  // Regular function (not arrow) so `new BrowserWindow(...)` works as a
  // constructor; vitest 4 enforces this stricter than 3 did.
  BrowserWindow: Object.assign(
    function MockBrowserWindow() { return mockBrowserWindow; },
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
      clearStorageData: mockClearStorageData,
    },
  },
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
  checkAndUpdateClientBuild: vi.fn(() => Promise.resolve({ updated: false, latestVersion: '0.11.0' })),
  checkAndUpdateSkeleton: vi.fn(() => Promise.resolve({ updated: false, latestVersion: '0.11.0' })),
  uiUpdateChannel: vi.fn((v: string) => (v.includes('-') ? 'next' : 'latest')),
  parseEnvFile: vi.fn(() => ({})),
  PLATFORM_VERSION: 'v0.11.0',
  // Faithful reimplementation of lib's resolveClientAppPort (reads
  // OP_HOST_CLIENT_PORT from the given env) so resolveElectronClientPort's
  // (E2) env-merge is actually exercised under test, not masked by a stub
  // that ignores its argument.
  resolveClientAppPort: vi.fn((env: NodeJS.ProcessEnv = process.env) => Number(env.OP_HOST_CLIENT_PORT) || 3890),
  resolveClientAppUrl: vi.fn(() => 'http://127.0.0.1:3890/chat'),
  writeClientRuntimeConfig: vi.fn(),
  // E1: the shared assistant-endpoint resolver main.ts now delegates to
  // instead of re-deriving the OP_ASSISTANT_BIND_ADDRESS/PORT precedence
  // chain locally (which is how the http://0.0.0.0:3800 seed bug happened).
  resolveAssistantEndpoint: vi.fn(() => 'http://127.0.0.1:3800'),
  checkDocker: vi.fn(() => Promise.resolve({ ok: true, stdout: '', stderr: '', code: 0 })),
  checkDockerCompose: vi.fn(() => Promise.resolve({ ok: true, stdout: '', stderr: '', code: 0 })),
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
  restoreUiBackup: vi.fn(() => ({ status: 'no-backup' as const })),
  // Faithful reimplementation of lib's UiSupervisor state machine (same style as
  // the waitForReady mock above) so the restart path the harness drives — stop →
  // respawn → wait-for-ready → restoreBackup/onReloadRenderer — actually runs its
  // injected strategy + callbacks under the test.
  UiSupervisor: class {
    private handle: unknown = null;
    private restarting = false;
    private shuttingDown = false;
    private readonly port: number;
    // biome-ignore lint/suspicious/noExplicitAny: test-only faithful stub
    private readonly strategy: any;
    // biome-ignore lint/suspicious/noExplicitAny: test-only faithful stub
    private readonly cb: any;
    // biome-ignore lint/suspicious/noExplicitAny: test-only faithful stub
    constructor(opts: any) {
      this.port = opts.port;
      this.strategy = opts.strategy;
      this.cb = opts.callbacks;
    }
    get current() { return this.handle; }
    get isRestarting() { return this.restarting; }
    adopt(handle: unknown) { this.handle = handle; }
    detachHandle() { this.handle = null; }
    async start() {
      this.handle = await this.strategy.spawn();
      if (!(await this.cb.waitForReady(this.port))) {
        await this.cb.onStartFailure?.(this.handle);
        return false;
      }
      return true;
    }
    async restart() {
      if (this.shuttingDown || this.restarting) return false;
      this.restarting = true;
      try {
        this.cb.beforeRestart?.();
        if (this.handle) await this.strategy.stop(this.handle);
        this.handle = await this.strategy.spawn();
        if (!(await this.cb.waitForReady(this.port))) {
          this.cb.restoreBackup?.();
          await this.cb.onRestartFailure?.();
          return false;
        }
        this.cb.onReloadRenderer?.();
        return true;
      } catch (err) {
        this.cb.onRestartError?.(err);
        return false;
      } finally {
        this.restarting = false;
      }
    }
    markShuttingDown() { this.shuttingDown = true; }
  },
}));

vi.mock('../src/local-opencode.js', () => ({
  startLocalOpenCode: vi.fn(() => Promise.resolve(null)),
  killProcessTree: vi.fn(),
}));

import {
  buildClientRuntimeConfigOptions,
  buildUIServerEnv,
  ensureClientAppBuild,
  ensureDockerReady,
  getLaunchOnLoginStatus,
  isAllowedInAppWindowUrl,
  isClientAppUrl,
  openLocalApp,
  resolveAssistantUrl,
  resolveElectronClientPort,
  setLaunchOnLogin,
  showNotification,
  supportsLaunchOnLogin,
  waitForReady,
} from '../src/main.js';
import { app, Notification, shell } from 'electron';
import * as lib from '@openpalm/lib';
import { HARNESS_CONTRACT_VERSION, HARNESS_CONTRACT } from '../src/harness-contract.js';
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

  it('sets OP_OPENCODE_URL so the UI proxy can reach the assistant', () => {
    const env = buildUIServerEnv('/home/user/.openpalm', 3880);
    expect(env.OP_OPENCODE_URL).toBe('http://127.0.0.1:3800');
  });

  it('emits the harness contract version so the control plane can feature-detect', () => {
    const env = buildUIServerEnv('/home/user/.openpalm', 3880);
    expect(env.OP_HARNESS_CONTRACT_VERSION).toBe(String(HARNESS_CONTRACT_VERSION));
  });
});

// ── harness contract surface (design §5.1) ──────────────────────────────────
// Snapshot the contract surface so any change to the native boundary forces a
// deliberate HARNESS_CONTRACT_VERSION bump (design §6.6 / §8.8).

describe('harness contract', () => {
  it('is at the expected version', () => {
    expect(HARNESS_CONTRACT_VERSION).toBe(2);
    expect(HARNESS_CONTRACT.version).toBe(HARNESS_CONTRACT_VERSION);
  });

  it('enumerates the v1 native surface (bump the version when this changes)', () => {
    expect(HARNESS_CONTRACT.ipc.sync).toEqual(['updateStatus']);
    expect(HARNESS_CONTRACT.ipc.send).toEqual(['notify']);
    expect(HARNESS_CONTRACT.ipc.invoke).toEqual([
      'restart',
      'restartUiServer',
      'openLocalApp',
      'launchOnLoginStatus',
      'setLaunchOnLogin',
      'setTrayMicRecording',
      'requestMicPermission',
    ]);
    expect(HARNESS_CONTRACT.ipc.push).toEqual([
      { channel: 'global-mic-toggle', subscribe: 'onGlobalMicToggle' },
    ]);
    expect(HARNESS_CONTRACT.env.required).toEqual([
      'OP_HOME',
      'HOST',
      'PORT',
      'ORIGIN',
      'OP_INSIDE_ELECTRON',
      'OP_ELECTRON_VERSION',
      'OP_HARNESS_CONTRACT_VERSION',
      'OP_OPENCODE_URL',
      'ELECTRON_RUN_AS_NODE',
    ]);
    expect(HARNESS_CONTRACT.env.optional).toEqual([
      'OPENPALM_SKELETON_DIR',
      'OP_ELECTRON_LATEST_VERSION',
      'OP_ELECTRON_LATEST_URL',
    ]);
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

// ── resolveElectronClientPort (E2) ──────────────────────────────────────────
// E2: Electron used to resolve the client port from process.env ONLY, while
// the CLI merges the persisted stack.env (OP_HOME/knowledge/env/stack.env)
// under process.env first (client-server.ts). A Finder-launched Electron has
// a minimal env, so a persisted OP_HOST_CLIENT_PORT override (the only
// realistic override channel for it) was silently ignored — the client
// server bound the DEFAULT port while OpenCode's CORS allowlist (set up via
// the CLI/container path) only trusted the CUSTOM one, breaking every chat
// request's preflight. Mirror the CLI's merge here.
describe('resolveElectronClientPort', () => {
  afterEach(() => {
    vi.mocked(lib.parseEnvFile).mockReset();
  });

  it('falls back to the default client port with no persisted stack.env and no process env override', () => {
    vi.mocked(lib.parseEnvFile).mockReturnValue({});
    expect(resolveElectronClientPort('/home/user/.openpalm', {})).toBe(3890);
  });

  it('honors OP_HOST_CLIENT_PORT persisted in stack.env when process.env has none', () => {
    vi.mocked(lib.parseEnvFile).mockReturnValue({ OP_HOST_CLIENT_PORT: '9392' });
    expect(resolveElectronClientPort('/home/user/.openpalm', {})).toBe(9392);
  });

  it('process.env OP_HOST_CLIENT_PORT wins over the persisted stack.env value', () => {
    vi.mocked(lib.parseEnvFile).mockReturnValue({ OP_HOST_CLIENT_PORT: '9392' });
    expect(resolveElectronClientPort('/home/user/.openpalm', { OP_HOST_CLIENT_PORT: '4444' })).toBe(4444);
  });

  it('reads stack.env from ${homeDir}/knowledge/env/stack.env', () => {
    vi.mocked(lib.parseEnvFile).mockReturnValue({});
    resolveElectronClientPort('/some/home', {});
    expect(lib.parseEnvFile).toHaveBeenCalledWith('/some/home/knowledge/env/stack.env');
  });

  it('never throws when the persisted stack.env is unreadable (parseEnvFile itself is best-effort)', () => {
    vi.mocked(lib.parseEnvFile).mockImplementation(() => {
      throw new Error('ENOENT');
    });
    expect(() => resolveElectronClientPort('/home/user/.openpalm', {})).not.toThrow();
    expect(resolveElectronClientPort('/home/user/.openpalm', {})).toBe(3890);
  });
});

// ── buildClientRuntimeConfigOptions (A2) ────────────────────────────────────
// A2: the client SPA had no way back to the admin dashboard — no tray entry,
// no in-app link, nothing. The lib foundation (writeClientRuntimeConfig's
// optional `hostUrl` field) lets Electron seed a link back to the host UI's
// /host admin surface into the client's runtime-config.json; the client SPA
// lane renders it. Pin that Electron actually passes it, pointed at /host on
// the UI_PORT (not /chat, not bare root).
describe('buildClientRuntimeConfigOptions', () => {
  it('points hostUrl at the host UI /host admin dashboard on UI_PORT', () => {
    expect(buildClientRuntimeConfigOptions()).toEqual({ hostUrl: 'http://127.0.0.1:3880/host' });
  });
});

// ── isClientAppUrl (B11) ─────────────────────────────────────────────────────
// B11: the global mic shortcut (Ctrl/Cmd+Shift+M) was registered SYSTEM-WIDE
// unconditionally but the only consumer of the mic IPC surface
// (global-mic-toggle / set-tray-mic-recording / request-mic-permission) is
// packages/ui's VoiceControl — when the resolved window fronts the client
// SPA (which has no voice UI at all, plan §12.2), the shortcut silently
// no-ops while still stealing the chord from other apps. main.ts now checks
// this predicate against the resolved initial URL before registering it.
describe('isClientAppUrl', () => {
  it('is true for a URL on the client port', () => {
    expect(isClientAppUrl('http://127.0.0.1:3890/chat', 3890)).toBe(true);
  });

  it('is true regardless of path, as long as the port matches', () => {
    expect(isClientAppUrl('http://127.0.0.1:3890/connections', 3890)).toBe(true);
  });

  it('is false for a host UI URL on a different port', () => {
    expect(isClientAppUrl('http://127.0.0.1:3880/chat', 3890)).toBe(false);
  });

  it('is false for the host UI /setup, /host, and root URLs', () => {
    expect(isClientAppUrl('http://127.0.0.1:3880/setup', 3890)).toBe(false);
    expect(isClientAppUrl('http://127.0.0.1:3880/host?tab=diagnostics', 3890)).toBe(false);
    expect(isClientAppUrl('http://127.0.0.1:3880', 3890)).toBe(false);
  });

  it('is false for a host UI port that merely shares the client port as a prefix (Codex review of PR #562)', () => {
    // A prefix startsWith('http://127.0.0.1:3890') matched 38900 too, so a
    // host UI on OP_HOST_UI_PORT=38900 was mistaken for the client SPA and had
    // its voice hotkey disabled. Exact port comparison, not prefix.
    expect(isClientAppUrl('http://127.0.0.1:38900/chat', 3890)).toBe(false);
    expect(isClientAppUrl('http://127.0.0.1:38901', 3890)).toBe(false);
  });

  it('is false for a look-alike host that only starts with the loopback prefix', () => {
    // Same subdomain/userinfo bypass class the in-app window gate was hardened
    // against — a prefix check would admit these.
    expect(isClientAppUrl('http://127.0.0.1:3890.evil.com/chat', 3890)).toBe(false);
    expect(isClientAppUrl('http://127.0.0.1:3890@evil.com/chat', 3890)).toBe(false);
  });
});

// ── set-tray-mic-recording IPC handler (E5) ─────────────────────────────────
// E5: the handler used to `if (frontsClientChat) return;` before forwarding to
// trayController.setMicRecording — a defense-in-depth guard that can never
// actually fire: the sole emitter of this IPC (packages/ui's VoiceControl)
// never loads under the client window in the first place (same B11 fact the
// isClientAppUrl suite above documents), so there is no real caller this
// guard could ever intercept. Removed the dead branch; the handler now always
// forwards. Pinned two ways: (1) the handler still does its one real job
// (forwards to the tray controller) — a spy-based behavior test that would
// pass with or without the dead guard present, since frontsClientChat is
// false in this harness by default; and (2) a source-shape pin that the
// handler body no longer references frontsClientChat at all, which DOES
// discriminate the fix (red with the guard in place, green once removed).
describe('set-tray-mic-recording IPC handler (E5)', () => {
  it('forwards the recording flag to trayController.setMicRecording', () => {
    const spy = vi.spyOn(TrayController.prototype, 'setMicRecording');
    const handler = ipcMainHandleHandlers.get('set-tray-mic-recording');
    expect(handler).toBeDefined();
    handler!(null, true);
    expect(spy).toHaveBeenCalledWith(true);
    handler!(null, false);
    expect(spy).toHaveBeenCalledWith(false);
    spy.mockRestore();
  });

  it('no longer guards on frontsClientChat — the dead defense-in-depth branch is gone', () => {
    const handler = ipcMainHandleHandlers.get('set-tray-mic-recording');
    expect(handler).toBeDefined();
    expect(handler!.toString()).not.toContain('frontsClientChat');
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

// ── ensureClientAppBuild — clear stale SW/cache on a build swap (H3) ────────
// H3: nothing anywhere reset the client origin's service-worker/cache when a
// newer @openpalm/client build swapped in — a stale SW could keep pinning a
// dead build indefinitely (extends C3). checkAndUpdateClientBuild reports
// `updated: true` exactly when a new build was installed; clear the client's
// own loopback origin (scoped — never the host UI's or any other site's data)
// whenever that happens. Best-effort: a clear failure must not be fatal.
describe('ensureClientAppBuild — clears the client origin on a build swap (H3)', () => {
  afterEach(() => {
    mockClearStorageData.mockClear();
    vi.mocked(lib.checkAndUpdateClientBuild).mockReset();
  });

  it('clears the client origin service-worker/cache storage when a newer build was installed', async () => {
    vi.mocked(lib.checkAndUpdateClientBuild).mockResolvedValue({ updated: true, latestVersion: '0.13.0' });
    await ensureClientAppBuild();
    expect(mockClearStorageData).toHaveBeenCalledWith({
      origin: 'http://127.0.0.1:3890',
      storages: ['serviceworkers', 'cachestorage'],
    });
  });

  it('does NOT clear anything when the build was already up to date', async () => {
    vi.mocked(lib.checkAndUpdateClientBuild).mockResolvedValue({ updated: false, latestVersion: '0.12.0' });
    await ensureClientAppBuild();
    expect(mockClearStorageData).not.toHaveBeenCalled();
  });

  it('is best-effort: a clearStorageData failure does not throw', async () => {
    vi.mocked(lib.checkAndUpdateClientBuild).mockResolvedValue({ updated: true, latestVersion: '0.13.0' });
    mockClearStorageData.mockRejectedValueOnce(new Error('boom'));
    await expect(ensureClientAppBuild()).resolves.toBeUndefined();
  });
});

// ── openLocalApp (E4) ────────────────────────────────────────────────────────
// E4: the tray's "Open Local App" (and its IPC twin) opened a hardcoded
// client URL with NO health check — a missing build or a crashed
// (non-respawned) client child produced a bare ERR_CONNECTION_REFUSED
// browser tab. Guard the open with a quick probe and fall back to the host
// UI chat (always running) instead of a dead link.
describe('openLocalApp', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(shell.openExternal).mockClear();
  });

  it('opens the client app URL when the client server responds healthy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    await openLocalApp();
    expect(shell.openExternal).toHaveBeenCalledWith('http://127.0.0.1:3890/chat');
  });

  it('falls back to the host UI chat when the client server does not respond (E4)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await openLocalApp();
    expect(shell.openExternal).toHaveBeenCalledWith('http://127.0.0.1:3880/chat');
    expect(shell.openExternal).not.toHaveBeenCalledWith('http://127.0.0.1:3890/chat');
  });
});

// ── restart-ui-server: must reload the window onto the new control plane ──────
// Regression guard: respawning the UI server child is not enough — without a
// window reload the renderer keeps showing the OLD build, so an in-app update
// looks like it did nothing (the recurring "the restart doesn't work" report).
describe('restart-ui-server reloads the renderer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads the root URL after the UI server becomes ready', async () => {
    // /health responds 200 → the restart "succeeds" and the reload runs.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    mockBrowserWindow.loadURL.mockClear();
    mockBrowserWindow.isDestroyed.mockReturnValue(false);

    const handler = ipcMainHandleHandlers.get('restart-ui-server');
    expect(handler).toBeTypeOf('function');

    const ok = await handler?.();

    expect(ok).toBe(true);
    expect(mockBrowserWindow.loadURL).toHaveBeenCalledWith('http://127.0.0.1:3880/');
  });

  it('restart ready-FAILURE keeps the app up, restores the backup, and does NOT reload', async () => {
    // Locks the Electron divergence: unlike the CLI (which process.exit(1)s on a
    // failed restart), Electron stays running — it restores the prior data/ui and
    // leaves the window on the old page (no reload). onRestartFailure is omitted.
    vi.mocked(lib.waitForReady).mockResolvedValueOnce(false); // respawn never becomes ready
    vi.mocked(lib.restoreUiBackup).mockClear();
    mockBrowserWindow.loadURL.mockClear();
    vi.mocked(app.quit).mockClear();

    const handler = ipcMainHandleHandlers.get('restart-ui-server');
    const ok = await handler?.();

    expect(ok).toBe(false);
    expect(lib.restoreUiBackup).toHaveBeenCalled();            // §4.4 backup restored
    expect(mockBrowserWindow.loadURL).not.toHaveBeenCalled();  // renderer NOT reloaded on failure
    expect(app.quit).not.toHaveBeenCalled();                   // app STAYS UP (no exit/quit)
  });

  it('re-entrant restart is guarded (uiServerRestarting): the second trigger no-ops with a single respawn', async () => {
    // The IPC/SIGUSR2 wrapper sets uiServerRestarting for the whole restart so a
    // concurrent trigger is dropped — preserving the pre-refactor guard and the
    // exit-handler coupling. Prove only ONE respawn happens across two triggers.
    vi.mocked(lib.waitForReady).mockResolvedValue(true);
    mockBrowserWindow.isDestroyed.mockReturnValue(false);
    const { spawn } = await import('node:child_process');
    vi.mocked(spawn).mockClear();

    const handler = ipcMainHandleHandlers.get('restart-ui-server');
    const inFlight = handler?.();       // sets uiServerRestarting = true before its first await
    const second = await handler?.();   // guarded out immediately
    const first = await inFlight;

    expect(second).toBe(false);
    expect(first).toBe(true);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1); // only the first trigger respawned
    vi.mocked(lib.waitForReady).mockReset();
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
  it('sets the App User Model ID on startup', async () => {
    await Promise.resolve();
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

// ── Docker preflight (deployment-review P0 #493) ────────────────────────────
// The harness must fail early and legibly when Docker isn't running, reusing
// lib's checkDocker / checkDockerCompose (the CLI's requireDocker probes) rather
// than duplicating the logic. ensureDockerReady() returns immediately when
// Docker is available and otherwise blocks on the install/retry screen.

describe('Docker preflight', () => {
  beforeEach(() => {
    vi.mocked(lib.checkDocker).mockReset();
    vi.mocked(lib.checkDockerCompose).mockReset();
  });

  it('reuses lib.checkDocker / lib.checkDockerCompose (no duplicated logic)', () => {
    expect(vi.isMockFunction(lib.checkDocker)).toBe(true);
    expect(vi.isMockFunction(lib.checkDockerCompose)).toBe(true);
  });

  it('resolves immediately when Docker and Compose v2 are available', async () => {
    vi.mocked(lib.checkDocker).mockResolvedValue({ ok: true, stdout: '', stderr: '', code: 0 });
    vi.mocked(lib.checkDockerCompose).mockResolvedValue({ ok: true, stdout: '', stderr: '', code: 0 });

    await expect(ensureDockerReady()).resolves.toBeUndefined();
    expect(lib.checkDocker).toHaveBeenCalledTimes(1);
    expect(lib.checkDockerCompose).toHaveBeenCalledTimes(1);
  });

  it('blocks on the install/retry screen until Docker becomes available', async () => {
    // First probe: Docker down. After the user clicks retry, Docker is up.
    vi.mocked(lib.checkDocker)
      .mockResolvedValueOnce({ ok: false, stdout: '', stderr: '', code: 1 })
      .mockResolvedValue({ ok: true, stdout: '', stderr: '', code: 0 });
    vi.mocked(lib.checkDockerCompose).mockResolvedValue({ ok: true, stdout: '', stderr: '', code: 0 });

    let resolved = false;
    const pending = ensureDockerReady().then(() => { resolved = true; });

    // Let the first (failing) preflight + screen render settle.
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);

    // Simulate the renderer's "I've installed it — retry" click.
    const retry = ipcMainOnHandlers.get('retry-docker-preflight');
    expect(retry, 'retry-docker-preflight handler must be registered').toBeDefined();
    retry?.();

    await pending;
    expect(resolved).toBe(true);
    // checkDocker ran twice (initial failure + post-retry success).
    expect(vi.mocked(lib.checkDocker).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('registers an open-docker-install handler that opens the install page', () => {
    const open = ipcMainOnHandlers.get('open-docker-install');
    expect(open, 'open-docker-install handler must be registered').toBeDefined();
    vi.mocked(shell.openExternal).mockClear();
    open?.();
    expect(shell.openExternal).toHaveBeenCalledWith('https://docs.docker.com/get-docker/');
  });
});

describe('localhost client app affordance', () => {
  beforeEach(() => {
    vi.mocked(shell.openExternal).mockClear();
  });

  it('registers an open-local-app handler that opens the stable loopback client origin', async () => {
    const handler = ipcMainHandleHandlers.get('open-local-app');
    expect(handler).toBeDefined();

    await handler?.();

    expect(shell.openExternal).toHaveBeenCalledWith('http://127.0.0.1:3890/chat');
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
