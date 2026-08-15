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
      // Make the extraResources skeleton appear present, so the startup path
      // that reseeds OP_HOME from THIS app version's bundled copy is exercised.
      if (String(p).endsWith('openpalm-skeleton')) return true;
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

// ── Mock ../src/settings.js — real defaults, spyable saveSettings ──────────
// Avoids touching the real filesystem at the mocked resolveDataDir() path
// (below) when the first-close notice (or the mic/prerelease toggles) persist
// a setting.
const { mockLoadSettings, mockSaveSettings } = vi.hoisted(() => ({
  mockLoadSettings: vi.fn(() => ({
    checkPrerelease: false,
    micShortcutEnabled: false,
    hideToTrayNoticeShown: false,
  })),
  mockSaveSettings: vi.fn(),
}));
vi.mock('../src/settings.js', () => ({
  loadSettings: mockLoadSettings,
  saveSettings: mockSaveSettings,
}));

// ── Mock process-tree — pin the UiSupervisor migration's kill strategy
// without shelling out a real SIGTERM/SIGKILL against whatever pid a test
// fixture happens to carry.
const { mockKillProcessTree } = vi.hoisted(() => ({ mockKillProcessTree: vi.fn() }));
vi.mock('../src/process-tree.js', () => ({ killProcessTree: mockKillProcessTree }));

// ── Mock electron before importing anything that imports it ──────────────────
// vi.mock() factories are hoisted above other top-level code, so the mock
// objects they close over must be created via vi.hoisted() to be reachable
// at hoist time.
const { mockBrowserWindow, ipcMainOnHandlers, ipcMainHandleHandlers, notificationInstances, mockSetAppUserModelId } = vi.hoisted(() => ({
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

// electron-updater builds its `autoUpdater` singleton at import time against a
// real Electron app (it reads app.getVersion()), so importing main.ts under the
// mocked 'electron' above would throw. The updater's own behaviour is covered
// directly in updater.test.ts against an injected fake; here it only needs to
// exist and stay inert.
vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    channel: null,
    allowPrerelease: false,
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn(),
    on: vi.fn(),
    // E6: createDesktopUpdater() now disposes the outgoing DesktopUpdater
    // (which calls this) before building a new one over this singleton.
    removeListener: vi.fn(),
  },
  // E3: createDesktopUpdater injects this so dispose() can cancel an in-flight
  // download on a channel toggle; the real class comes from builder-util-runtime.
  CancellationToken: class MockCancellationToken {
    cancel = vi.fn();
  },
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
    // E1: held throughout this suite so the primary-instance whenReady chain
    // runs as before. The "lock not held" branch is covered in its own
    // isolated test file (single-instance-lock.test.ts) — main.ts calls this
    // at MODULE LOAD TIME, so a single test file can only exercise one branch.
    requestSingleInstanceLock: vi.fn(() => true),
  },
  // Regular function (not arrow) so `new BrowserWindow(...)` works as a
  // constructor; vitest 4 enforces this stricter than 3 did.
  BrowserWindow: Object.assign(
    vi.fn(function MockBrowserWindow() { return mockBrowserWindow; }),
    { getAllWindows: vi.fn(() => [mockBrowserWindow]) },
  ),
  contextBridge: { exposeInMainWorld: vi.fn() },
  dialog: { showErrorBox: vi.fn(), showMessageBoxSync: vi.fn(() => 1) },
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
  applyHomeSeed: vi.fn(async () => ({ updated: [], backupDir: null })),
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
  // E5: the deploy-in-progress quit guard and completion notifier both read
  // the SAME journal via createState() → resolveDeployJournalPath() →
  // readDeployJournal(). Default to "no deploy in progress" so every
  // pre-existing before-quit test (which never touches deploy state) keeps
  // exercising the plain-quit path unchanged; individual tests override
  // readDeployJournal's return value.
  createState: vi.fn(() => ({ dataDir: '/home/user/.openpalm/data' })),
  resolveDeployJournalPath: vi.fn((state: { dataDir: string }) => `${state.dataDir}/setup/deploy-journal.json`),
  readDeployJournal: vi.fn(() => ({
    deploying: false,
    setupComplete: false,
    deployStatus: [],
    deployError: null,
    imageWarning: null,
    phase: 'writing-config' as const,
    startedAt: null,
    pid: null,
  })),
  // Faithful-enough fake of lib's UiSupervisor: adopt()/current match the real
  // class exactly (main.ts never calls start() — see its uiSupervisor
  // docblock — so start() isn't reproduced here).
  UiSupervisor: class {
    current: unknown = null;
    adopt(handle: unknown) {
      this.current = handle;
    }
  },
}));


import {
  buildUIServerEnv,
  deployCompletionNotification,
  getLaunchOnLoginStatus,
  handleQuitAndInstallRequest,
  handleWillNavigate,
  handleWindowOpen,
  isAllowedInAppWindowUrl,
  isFatalMainFrameLoadFailure,
  isOwnOriginUrl,
  openLocalApp,
  setLaunchOnLogin,
  shouldWarnBeforeQuitDuringDeploy,
  showNotification,
  stopUIServer,
  stopUiChild,
  supportsLaunchOnLogin,
  waitForReady,
} from '../src/main.js';
import { DesktopUpdater } from '../src/updater.js';
import { app, BrowserWindow, dialog, globalShortcut, Notification, shell } from 'electron';
import * as lib from '@openpalm/lib';
import { TrayController } from '../src/tray.js';

// Fake IPC sender-frame fixtures (E2 origin gating). Real Electron always
// supplies a real event with a real senderFrame; these stand in for "a page
// loaded from our own trusted UI origin" vs "a page loaded from anywhere
// else" (or no senderFrame at all — same as untrusted).
const TRUSTED_EVENT = { senderFrame: { url: 'http://127.0.0.1:3880/host/settings' } };
const UNTRUSTED_EVENT = { senderFrame: { url: 'https://evil.example.com/' } };

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

describe('set-tray-mic-recording IPC handler', () => {
  it('forwards the recording flag to trayController.setMicRecording', () => {
    const spy = vi.spyOn(TrayController.prototype, 'setMicRecording');
    const handler = ipcMainHandleHandlers.get('set-tray-mic-recording');
    expect(handler).toBeDefined();
    handler?.(TRUSTED_EVENT, true);
    expect(spy).toHaveBeenCalledWith(true);
    handler?.(TRUSTED_EVENT, false);
    expect(spy).toHaveBeenCalledWith(false);
    spy.mockRestore();
  });
});

// ── E2: IPC origin gating ────────────────────────────────────────────────────
// The updater IPC was already gated on the exact trusted UI origin
// (isTrustedUpdaterSender). These handlers used to accept ANY sender — a
// compromised or navigated-away renderer could toggle login-item
// persistence, forge OS notifications, or pop the mic permission prompt.
// Reuses the same origin check via assertTrustedSender/isTrustedRendererSender.
describe('IPC origin gating (E2)', () => {
  it('restart-app rejects an untrusted sender and does not relaunch', () => {
    const handler = ipcMainHandleHandlers.get('restart-app');
    expect(handler).toBeDefined();
    vi.mocked(app.relaunch).mockClear();
    expect(() => handler?.(UNTRUSTED_EVENT)).toThrow(/untrusted sender/i);
    expect(app.relaunch).not.toHaveBeenCalled();
  });

  it('restart-app accepts the trusted UI origin', () => {
    const handler = ipcMainHandleHandlers.get('restart-app');
    vi.mocked(app.relaunch).mockClear();
    expect(() => handler?.(TRUSTED_EVENT)).not.toThrow();
    expect(app.relaunch).toHaveBeenCalledOnce();
  });

  it('open-local-app rejects an untrusted sender and does not open anything', async () => {
    const handler = ipcMainHandleHandlers.get('open-local-app');
    vi.mocked(shell.openExternal).mockClear();
    await expect(handler?.(UNTRUSTED_EVENT)).rejects.toThrow(/untrusted sender/i);
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('launch-on-login-status rejects an untrusted sender', () => {
    const handler = ipcMainHandleHandlers.get('launch-on-login-status');
    expect(() => handler?.(UNTRUSTED_EVENT)).toThrow(/untrusted sender/i);
  });

  it('set-launch-on-login rejects an untrusted sender and does not write login-item settings', () => {
    const handler = ipcMainHandleHandlers.get('set-launch-on-login');
    vi.mocked(app.setLoginItemSettings).mockClear();
    expect(() => handler?.(UNTRUSTED_EVENT, true)).toThrow(/untrusted sender/i);
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });

  it('set-tray-mic-recording rejects an untrusted sender', () => {
    const spy = vi.spyOn(TrayController.prototype, 'setMicRecording');
    const handler = ipcMainHandleHandlers.get('set-tray-mic-recording');
    expect(() => handler?.(UNTRUSTED_EVENT, true)).toThrow(/untrusted sender/i);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('request-mic-permission rejects an untrusted sender', async () => {
    const handler = ipcMainHandleHandlers.get('request-mic-permission');
    await expect(handler?.(UNTRUSTED_EVENT)).rejects.toThrow(/untrusted sender/i);
  });

  it('notify (fire-and-forget) silently drops an untrusted sender instead of throwing', () => {
    const handler = ipcMainOnHandlers.get('notify');
    notificationInstances.length = 0;
    mockBrowserWindow.isFocused.mockReturnValue(false);
    // Must not throw — ipcMain.on has no promise to reject, and an uncaught
    // throw here would crash the whole main process over one bad message.
    expect(() => handler?.(UNTRUSTED_EVENT, { title: 'x', body: 'y' })).not.toThrow();
    expect(notificationInstances).toHaveLength(0);
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
// only http: URLs whose HOSTNAME is exactly 127.0.0.1 or localhost are
// allowed.
//
// E2 follow-up: this used to allow ANY port on those hosts — a link to some
// OTHER local service (a stray dev server, another app's loopback port) would
// load INSIDE the trusted window instead of deferring to the external
// browser. Pinned to UI_PORT (3880 in this suite — the mocked
// resolveHostUiPort's default with no OP_HOST_UI_PORT set).
describe('isAllowedInAppWindowUrl', () => {
  it('allows http://127.0.0.1 at the app\'s own UI port', () => {
    expect(isAllowedInAppWindowUrl('http://127.0.0.1:3880/host')).toBe(true);
  });

  it('allows http://localhost at the app\'s own UI port', () => {
    expect(isAllowedInAppWindowUrl('http://localhost:3880/chat')).toBe(true);
  });

  it('rejects a DIFFERENT loopback port — some other local service, not this app', () => {
    expect(isAllowedInAppWindowUrl('http://127.0.0.1:3890/chat')).toBe(false);
    expect(isAllowedInAppWindowUrl('http://localhost:9999/')).toBe(false);
  });

  it('rejects a subdomain bypass (http://127.0.0.1.evil.com)', () => {
    expect(isAllowedInAppWindowUrl('http://127.0.0.1.evil.com:3880')).toBe(false);
  });

  it('rejects a userinfo bypass (http://127.0.0.1@evil.com)', () => {
    expect(isAllowedInAppWindowUrl('http://127.0.0.1@evil.com')).toBe(false);
  });

  it('rejects https (protocol must be exactly http:)', () => {
    expect(isAllowedInAppWindowUrl('https://127.0.0.1:3880')).toBe(false);
  });

  it('rejects a non-loopback host', () => {
    expect(isAllowedInAppWindowUrl('http://example.com:3880')).toBe(false);
  });

  it('rejects unparsable input', () => {
    expect(isAllowedInAppWindowUrl('not a url')).toBe(false);
  });
});

// ── isOwnOriginUrl / handleWillNavigate (E2 — will-navigate guard) ──────────
// Narrower than isAllowedInAppWindowUrl on purpose: only the EXACT origin
// this app serves (127.0.0.1 at UI_PORT, over http) may navigate the main
// window's frame in place. See isOwnOriginUrl's docblock for why popups get a
// slightly wider allow-list but in-place navigation does not.
describe('isOwnOriginUrl', () => {
  it('allows exactly the app\'s own served origin', () => {
    expect(isOwnOriginUrl('http://127.0.0.1:3880/chat/session-1')).toBe(true);
  });

  it('rejects localhost — a different origin than the one this app serves, even at the right port', () => {
    expect(isOwnOriginUrl('http://localhost:3880/chat')).toBe(false);
  });

  it('rejects a different loopback port', () => {
    expect(isOwnOriginUrl('http://127.0.0.1:3890/chat')).toBe(false);
  });

  it('rejects an external origin', () => {
    expect(isOwnOriginUrl('https://example.com')).toBe(false);
  });

  it('rejects unparsable input', () => {
    expect(isOwnOriginUrl('not a url')).toBe(false);
  });
});

describe('handleWillNavigate', () => {
  it('lets own-origin navigation proceed untouched', () => {
    const event = { preventDefault: vi.fn() };
    handleWillNavigate(event, 'http://127.0.0.1:3880/host/settings');
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(shell.openExternal).not.toHaveBeenCalled();
  });

  it('blocks off-origin navigation in-window and defers to the external browser', () => {
    vi.mocked(shell.openExternal).mockClear();
    const event = { preventDefault: vi.fn() };
    handleWillNavigate(event, 'https://evil.example.com/');
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(shell.openExternal).toHaveBeenCalledWith('https://evil.example.com/');
  });

  it('blocks navigation to a DIFFERENT local service, not just external hosts', () => {
    vi.mocked(shell.openExternal).mockClear();
    const event = { preventDefault: vi.fn() };
    handleWillNavigate(event, 'http://127.0.0.1:9999/');
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(shell.openExternal).toHaveBeenCalledWith('http://127.0.0.1:9999/');
  });
});

// ── isFatalMainFrameLoadFailure (E4 — stuck-splash watchdog) ────────────────
describe('isFatalMainFrameLoadFailure', () => {
  it('is fatal for a main-frame failure that is not ERR_ABORTED', () => {
    expect(isFatalMainFrameLoadFailure(true, -102)).toBe(true); // ERR_CONNECTION_REFUSED
  });

  it('ignores ERR_ABORTED (-3) — routine superseded-navigation noise', () => {
    expect(isFatalMainFrameLoadFailure(true, -3)).toBe(false);
  });

  it('ignores a subframe failure — the shell page itself still rendered', () => {
    expect(isFatalMainFrameLoadFailure(false, -102)).toBe(false);
  });
});

// ── Deploy journal predicates (E5) ───────────────────────────────────────────
describe('shouldWarnBeforeQuitDuringDeploy', () => {
  it('warns when the journal reports an in-progress deploy', () => {
    expect(shouldWarnBeforeQuitDuringDeploy({ deploying: true })).toBe(true);
  });

  it('does not warn when nothing is deploying', () => {
    expect(shouldWarnBeforeQuitDuringDeploy({ deploying: false })).toBe(false);
  });

  it('does not warn when the journal could not be read', () => {
    expect(shouldWarnBeforeQuitDuringDeploy(null)).toBe(false);
  });
});

describe('deployCompletionNotification', () => {
  const settledOk = { deploying: false, deployError: null, setupComplete: true };
  const settledFailed = { deploying: false, deployError: 'compose up failed', setupComplete: false };
  const stillDeploying = { deploying: true, deployError: null, setupComplete: false };

  it('notifies success on the deploying→settled edge', () => {
    expect(deployCompletionNotification({ deploying: true }, settledOk)).toEqual({
      title: 'OpenPalm is ready',
      body: expect.stringContaining('ready to chat'),
    });
  });

  it('notifies failure on the deploying→settled edge when deployError is set', () => {
    expect(deployCompletionNotification({ deploying: true }, settledFailed)).toEqual({
      title: 'OpenPalm setup failed',
      body: 'compose up failed',
    });
  });

  it('does not notify while still deploying', () => {
    expect(deployCompletionNotification({ deploying: true }, stillDeploying)).toBeNull();
  });

  it('does not notify when nothing was previously observed deploying (no false completion on launch)', () => {
    expect(deployCompletionNotification(null, settledOk)).toBeNull();
    expect(deployCompletionNotification({ deploying: false }, settledOk)).toBeNull();
  });
});

// ── handleQuitAndInstallRequest (E2 — ask BEFORE the installer spawns) ───────
// electron-updater's quitAndInstall() launches the installer BEFORE its own
// internal app.quit(), so the before-quit deploy guard used to fire only after
// the installer was already running — "Keep Waiting" cancelled the quit but
// not the installer. The renderer's request now runs the SAME journal check +
// dialog first. (The confirm path — and its suppression of the before-quit
// re-prompt — lives in updater-quit-install-guard.test.ts: letting before-quit
// proceed sets the one-way module `cleanupStarted` flag, which this long-lived
// module instance's own before-quit suite still needs unset.)
describe('handleQuitAndInstallRequest (E2)', () => {
  const deployingJournal = {
    deploying: true,
    setupComplete: false,
    deployStatus: [],
    deployError: null,
    imageWarning: null,
    phase: 'starting' as const,
    startedAt: new Date().toISOString(),
    pid: 4321,
  };

  function makeDesktopUpdater() {
    const fake = {
      autoDownload: true,
      autoInstallOnAppQuit: false,
      channel: null as string | null,
      allowPrerelease: false,
      checkForUpdates: vi.fn(async () => ({ updateInfo: { version: '99.0.0' } })),
      downloadUpdate: vi.fn(async () => []),
      quitAndInstall: vi.fn(),
      install: vi.fn(() => true),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const updater = new DesktopUpdater({
      updater: fake,
      currentVersion: '1.0.0',
      platform: 'linux',
      isPackaged: true,
      windowsInstallerPresent: false,
      prerelease: false,
    });
    return { updater, fake };
  }

  beforeEach(() => {
    vi.mocked(dialog.showMessageBoxSync).mockClear();
  });

  it('refuses without prompting when nothing is staged', async () => {
    const { updater, fake } = makeDesktopUpdater();
    await updater.check(); // 'available' — not 'downloaded'

    expect(handleQuitAndInstallRequest(updater)).toBe(false);
    expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
  });

  it('installs without prompting when no deploy is in progress', async () => {
    const { updater, fake } = makeDesktopUpdater();
    await updater.check();
    await updater.download();

    expect(handleQuitAndInstallRequest(updater)).toBe(true);
    expect(dialog.showMessageBoxSync).not.toHaveBeenCalled();
    expect(fake.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('with a deploy in progress, "Keep Waiting" refuses BEFORE the installer is launched', async () => {
    const { updater, fake } = makeDesktopUpdater();
    await updater.check();
    await updater.download();
    vi.mocked(lib.readDeployJournal).mockReturnValueOnce(deployingJournal);
    vi.mocked(dialog.showMessageBoxSync).mockReturnValueOnce(1); // "Keep Waiting"

    expect(handleQuitAndInstallRequest(updater)).toBe(false);
    expect(dialog.showMessageBoxSync).toHaveBeenCalledOnce();
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
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

  // isAllowedInAppWindowUrl admits both loopback aliases, but the trusted
  // origin (isOwnOriginUrl, the IPC sender gate) is pinned to 127.0.0.1 —
  // loading a localhost URL as-is would strand the window on an origin where
  // every navigation bounces external and every window.openpalm call is
  // rejected until restart.
  it('normalizes an allowed localhost popup onto the canonical 127.0.0.1 origin', () => {
    const result = handleWindowOpen(
      mockBrowserWindow as unknown as InstanceType<typeof BrowserWindow>,
      'http://localhost:3880/chat/session-1?foo=1#frag',
    );

    expect(result).toEqual({ action: 'deny' });
    expect(mockBrowserWindow.loadURL).toHaveBeenCalledWith('http://127.0.0.1:3880/chat/session-1?foo=1#frag');
    expect(shell.openExternal).not.toHaveBeenCalled();
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

// ── stopUiChild (UiSupervisor migration — shared group-kill strategy) ──────
// The desktop harness now stores the UI child handle in lib's UiSupervisor
// (via adopt()/current) instead of a bare module-level variable, and drives
// teardown through this exported strategy function instead of inlining the
// kill sequence at each call site. Pure over its argument, so the sequence
// pins here without spawning a real child.
describe('stopUiChild', () => {
  beforeEach(() => {
    mockKillProcessTree.mockClear();
  });

  it('is a no-op for a null handle (nothing adopted)', async () => {
    await stopUiChild(null);
    expect(mockKillProcessTree).not.toHaveBeenCalled();
  });

  it('is a no-op for a handle with no pid', async () => {
    await stopUiChild({} as unknown as Parameters<typeof stopUiChild>[0]);
    expect(mockKillProcessTree).not.toHaveBeenCalled();
  });

  it('group-kills SIGTERM then SIGKILL for a handle with a pid', async () => {
    await stopUiChild({ pid: 4242 } as unknown as Parameters<typeof stopUiChild>[0]);
    expect(mockKillProcessTree).toHaveBeenNthCalledWith(1, 4242, 'SIGTERM');
    expect(mockKillProcessTree).toHaveBeenNthCalledWith(2, 4242, 'SIGKILL');
    expect(mockKillProcessTree).toHaveBeenCalledTimes(2);
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
    handler?.(TRUSTED_EVENT, { title: 'OpenPalm', body: 'Assistant replied' });
    expect(notificationInstances).toHaveLength(1);
    expect(notificationInstances[0].show).toHaveBeenCalledTimes(1);
    expect(notificationInstances[0].on).toHaveBeenCalledWith('click', expect.any(Function));
  });

  it('suppresses renderer notifications while the main window is focused', () => {
    const handler = ipcMainOnHandlers.get('notify');
    mockBrowserWindow.isFocused.mockReturnValue(true);
    notificationInstances.length = 0;
    mockNotificationShow.mockClear();

    handler?.(TRUSTED_EVENT, { title: 'OpenPalm', body: 'Assistant replied' });
    expect(notificationInstances).toHaveLength(0);
    expect(mockNotificationShow).not.toHaveBeenCalled();
  });

  it('is a no-op when Notification.isSupported() returns false, even from the trusted origin (E6)', () => {
    const handler = ipcMainOnHandlers.get('notify');
    mockBrowserWindow.isFocused.mockReturnValue(false);
    notificationInstances.length = 0;
    vi.mocked(Notification.isSupported).mockReturnValue(false);

    handler?.(TRUSTED_EVENT, { title: 'OpenPalm', body: 'Assistant replied' });
    expect(notificationInstances).toHaveLength(0);

    vi.mocked(Notification.isSupported).mockReturnValue(true);
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

    expect(statusHandler?.(TRUSTED_EVENT)).toEqual({ supported: false, enabled: false });
    expect(setHandler?.(TRUSTED_EVENT, true)).toEqual({ supported: false, enabled: false });
    expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  });
});

describe('desktop bootstrap', () => {
  // The window opens on the UI ROOT; the server's navigation guard resolves the
  // landing from there. Pre-resolving it in the main process meant asking from a
  // process with no cookie jar in common with the window, so the browser's own
  // state was invisible to the probe.
  it('spawns the bundled UI and opens the UI root', async () => {
    const { spawn } = await import('node:child_process');
    vi.mocked(spawn).mockClear();
    vi.mocked(lib.waitForReady).mockResolvedValue(true);
    vi.mocked(app.quit).mockClear();
    mockBrowserWindow.loadURL.mockClear();

    startupHarness.releaseReady();

    await vi.waitFor(() => {
      expect(mockBrowserWindow.loadURL).toHaveBeenCalledWith('http://127.0.0.1:3880');
    });
    expect(spawn).toHaveBeenCalled();
    expect(lib.checkDocker).not.toHaveBeenCalled();
    expect(lib.checkDockerCompose).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    expect(mockSetAppUserModelId).toHaveBeenCalledWith('com.openpalm.app');
  });

  // OP_HOME outlives an app update, so a new release that did not reseed would
  // serve the PREVIOUS release's managed system/ tree — stale Compose files and
  // managed instructions — until the user happened to run a lifecycle apply.
  // This is the Electron half of what the CLI supervisor does before every spawn.
  it('reseeds OP_HOME from the bundled skeleton before spawning the UI', async () => {
    const { spawn } = await import('node:child_process');
    const seedOrder = vi.mocked(lib.applyHomeSeed).mock.invocationCallOrder;
    const spawnOrder = vi.mocked(spawn).mock.invocationCallOrder;

    expect(lib.applyHomeSeed).toHaveBeenCalled();
    expect(vi.mocked(lib.applyHomeSeed).mock.calls[0]).toEqual(['/home/user/.openpalm']);
    // Seeded BEFORE the child starts, or the child reads the old tree.
    expect(seedOrder[0]).toBeLessThan(spawnOrder[0]);
  });
});

// ── UiSupervisor migration — adopt()/current handle lifecycle ──────────────
// 'desktop bootstrap' (above) already spawned and adopted the ONE UI child
// this suite ever spawns. This pins the other half of the migration: the
// child's own 'exit' handler un-adopts it (uiSupervisor.adopt(null)), so a
// later stopUIServer() call finds nothing to kill instead of re-targeting a
// pid that no longer belongs to a running process.
describe('UiSupervisor migration — UI child handle lifecycle', () => {
  it('un-adopts the UI child on exit, so a later stop is a no-op instead of re-killing a dead pid', async () => {
    const { spawn } = await import('node:child_process');
    const fakeProcess = vi.mocked(spawn).mock.results[0]?.value as {
      on: ReturnType<typeof vi.fn>;
      pid?: number;
    };
    expect(fakeProcess, 'the shared spawn() fixture from desktop bootstrap').toBeDefined();

    const exitHandler = fakeProcess.on.mock.calls.find(
      ([event]: [string]) => event === 'exit',
    )?.[1] as ((code: number | null) => void) | undefined;
    expect(exitHandler, "spawnUIServer must register an 'exit' handler").toBeDefined();

    // Give the fixture a pid so the no-op assertion below is meaningful (a
    // handle with no pid would no-op regardless of adopt state).
    fakeProcess.pid = 4242;
    exitHandler?.(0);

    mockKillProcessTree.mockClear();
    stopUIServer();
    expect(mockKillProcessTree).not.toHaveBeenCalled();
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

    await handler?.(TRUSTED_EVENT);

    expect(shell.openExternal).toHaveBeenCalledWith('http://127.0.0.1:3880/chat');
    expect(shell.openExternal).not.toHaveBeenCalledWith('http://127.0.0.1:3890/chat');
  });
});

// ── E3: the global mic shortcut is opt-in ───────────────────────────────────
// Placed after 'desktop bootstrap' (which already ran the full openWindow()
// flow) so this pins the END-TO-END default: even after a real boot,
// Ctrl/Cmd+Shift+M is never grabbed unless the user turned it on.
describe('global mic shortcut opt-in (E3)', () => {
  it('is not registered by default after the app has booted', () => {
    expect(globalShortcut.register).not.toHaveBeenCalled();
  });
});

// ── E1: tray-conditional hide-to-tray on window close ───────────────────────
// Placed BEFORE 'before-quit handler' (below) deliberately: that suite's first
// test flips the module-scoped `isQuitting` flag to true and nothing in this
// file ever flips it back, so these tests — which depend on isQuitting still
// being false — must run first for a correct read of "close" in isolation.
// ── First-close discoverability notice ──────────────────────────────────────
// Placed BEFORE 'window close handler' (below) deliberately: that block's
// first test also hides-to-tray, which would otherwise consume the one-time
// notice before these tests get to observe a genuine "first close".
describe('first-close discoverability notice', () => {
  function getCloseHandler(): (event: { preventDefault: () => void }) => void {
    const entry = mockBrowserWindow.on.mock.calls.find(([e]) => e === 'close');
    expect(entry, 'window close handler must be registered').toBeDefined();
    return entry?.[1] as (event: { preventDefault: () => void }) => void;
  }

  it('shows the one-time tray notice on the first hide-to-tray close and persists it', () => {
    const spy = vi.spyOn(TrayController.prototype, 'isActive').mockReturnValue(true);
    notificationInstances.length = 0;
    mockNotificationShow.mockClear();
    mockSaveSettings.mockClear();

    getCloseHandler()({ preventDefault: vi.fn() });

    expect(notificationInstances).toHaveLength(1);
    expect(mockNotificationShow).toHaveBeenCalledTimes(1);
    expect(mockSaveSettings).toHaveBeenCalledWith('/home/user/.openpalm/data', {
      hideToTrayNoticeShown: true,
    });
    spy.mockRestore();
  });

  it('does not show the notice again on a later hide-to-tray close', () => {
    const spy = vi.spyOn(TrayController.prototype, 'isActive').mockReturnValue(true);
    notificationInstances.length = 0;
    mockNotificationShow.mockClear();
    mockSaveSettings.mockClear();

    getCloseHandler()({ preventDefault: vi.fn() });

    expect(notificationInstances).toHaveLength(0);
    expect(mockSaveSettings).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('window close handler (E1 — hide-to-tray only when a tray exists)', () => {
  function getCloseHandler(): (event: { preventDefault: () => void }) => void {
    const entry = mockBrowserWindow.on.mock.calls.find(([e]) => e === 'close');
    expect(entry, 'window close handler must be registered').toBeDefined();
    return entry?.[1] as (event: { preventDefault: () => void }) => void;
  }

  it('hides instead of closing when the tray is active', () => {
    const spy = vi.spyOn(TrayController.prototype, 'isActive').mockReturnValue(true);
    mockBrowserWindow.hide.mockClear();
    const event = { preventDefault: vi.fn() };

    getCloseHandler()(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(mockBrowserWindow.hide).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('lets the close proceed when there is no tray to hide to (e.g. vanilla GNOME)', () => {
    const spy = vi.spyOn(TrayController.prototype, 'isActive').mockReturnValue(false);
    mockBrowserWindow.hide.mockClear();
    const event = { preventDefault: vi.fn() };

    getCloseHandler()(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(mockBrowserWindow.hide).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('window-all-closed (E1 — quit for real only when there is no tray)', () => {
  function getHandler(): () => void {
    const entry = vi.mocked(app.on).mock.calls.find(([e]) => e === 'window-all-closed');
    expect(entry, 'window-all-closed handler must be registered').toBeDefined();
    return entry?.[1] as () => void;
  }

  it('quits when there is no tray — otherwise the UI server would keep running unreachable', () => {
    const spy = vi.spyOn(TrayController.prototype, 'isActive').mockReturnValue(false);
    vi.mocked(app.quit).mockClear();

    getHandler()();

    expect(app.quit).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('does not quit when the tray is active — the app keeps running in the tray as before', () => {
    const spy = vi.spyOn(TrayController.prototype, 'isActive').mockReturnValue(true);
    vi.mocked(app.quit).mockClear();

    getHandler()();

    expect(app.quit).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ── E1: single-instance lock — 'second-instance' handoff ────────────────────
// The "lock not held" branch (a genuine second launch) is covered in its own
// isolated test file (single-instance-lock.test.ts) — requestSingleInstanceLock
// runs at module load time, so only one branch is reachable per test file.
// This suite mocks it `true` (see the electron mock above), so what's testable
// HERE is the primary instance's reaction to a second launch attempt.
describe("second-instance handler (E1)", () => {
  it('brings the existing window forward instead of leaving a second launch to fend for itself', () => {
    const entry = vi.mocked(app.on).mock.calls.find(([e]) => e === 'second-instance');
    expect(entry, 'second-instance handler must be registered').toBeDefined();
    const handler = entry?.[1] as (...args: unknown[]) => void;

    mockBrowserWindow.show.mockClear();
    mockBrowserWindow.focus.mockClear();
    const windowCount = vi.mocked(BrowserWindow).mock.calls.length;

    handler();

    expect(mockBrowserWindow.show).toHaveBeenCalled();
    expect(mockBrowserWindow.focus).toHaveBeenCalled();
    // Reuses the existing window rather than constructing a second one.
    expect(vi.mocked(BrowserWindow)).toHaveBeenCalledTimes(windowCount);
  });
});

// ── E4: did-fail-load / will-navigate wiring on the real main window ────────
describe('main window did-fail-load / will-navigate wiring (E4 / E2)', () => {
  function getWebContentsHandler(event: string): (...args: unknown[]) => void {
    const entry = mockBrowserWindow.webContents.on.mock.calls.find(([e]: [string]) => e === event);
    expect(entry, `${event} handler must be registered on the main window's webContents`).toBeDefined();
    return entry?.[1] as (...args: unknown[]) => void;
  }

  it('a fatal did-fail-load closes the splash and reveals the (possibly errored) window', () => {
    mockBrowserWindow.show.mockClear();
    mockBrowserWindow.close.mockClear();

    const handler = getWebContentsHandler('did-fail-load');
    // (event, errorCode, errorDescription, validatedURL, isMainFrame)
    handler({}, -102, 'ERR_CONNECTION_REFUSED', 'http://127.0.0.1:3880/chat', true);

    // splash.close() and window.show() both resolve to the same shared
    // BrowserWindow mock in this suite (one Tray/BrowserWindow constructor
    // mock for every `new BrowserWindow(...)` call) — asserting both were
    // called pins that the stuck-splash path actually fires.
    expect(mockBrowserWindow.close).toHaveBeenCalled();
    expect(mockBrowserWindow.show).toHaveBeenCalled();
  });

  it('will-navigate defers an off-origin destination to the external browser', () => {
    vi.mocked(shell.openExternal).mockClear();
    const handler = getWebContentsHandler('will-navigate');
    const event = { preventDefault: vi.fn() };

    handler(event, 'https://evil.example.com/');

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(shell.openExternal).toHaveBeenCalledWith('https://evil.example.com/');
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
