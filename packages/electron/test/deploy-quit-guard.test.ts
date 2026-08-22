// Deploy-in-progress quit guard (E5 review): Quit used to SIGTERM+SIGKILL the
// UI server's whole process group immediately and unconditionally — killing
// an in-flight `docker compose` with zero warning, even on a first-run
// desktop wizard's deploy. before-quit now reads the SAME deploy journal the
// setup wizard itself polls and, if a deploy is in progress, shows a blocking
// confirmation before doing anything destructive.
//
// This is its own file (rather than cases inside main.test.ts) because
// `cleanupStarted` — the flag that makes a SECOND before-quit call a no-op —
// is module-scoped and, once set true by "Quit Anyway", never resets for the
// rest of that module instance's life. Testing both "keep waiting" (which
// must NOT set it) and "quit anyway" (which must) in the same run requires a
// dedicated, single-purpose module instance rather than sharing
// main.test.ts's long-lived one.
//
// Run via vitest (Node), NOT bun test — same reason as main.test.ts.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((p: string) => String(p).endsWith('index.js')),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const fakeProcess = { on: vi.fn(), kill: vi.fn(), stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, pid: 4321 };
  return { ...actual, spawn: vi.fn(() => fakeProcess) };
});

const { mockBrowserWindow, mockShowMessageBoxSync } = vi.hoisted(() => ({
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
    isDestroyed: vi.fn(() => false),
  },
  mockShowMessageBoxSync: vi.fn(() => 1), // default: "Keep Waiting" (cancelId)
}));

const { mockReadDeployJournal } = vi.hoisted(() => ({
  mockReadDeployJournal: vi.fn(() => ({
    deploying: false,
    setupComplete: false,
    deployStatus: [],
    deployError: null,
    imageWarning: null,
    phase: 'writing-config' as const,
    startedAt: null,
    pid: null,
  })),
}));

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '0.11.0'),
    quit: vi.fn(),
    exit: vi.fn(),
    whenReady: vi.fn(() => new Promise(() => {})), // never resolves — before-quit is what's under test, not boot
    on: vi.fn(),
    getAppPath: vi.fn(() => '/mock/app'),
    getPath: vi.fn(() => '/mock/logs'),
    relaunch: vi.fn(),
    setAppUserModelId: vi.fn(),
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
    setLoginItemSettings: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
  },
  BrowserWindow: Object.assign(
    vi.fn(function MockBrowserWindow() { return mockBrowserWindow; }),
    { getAllWindows: vi.fn(() => [mockBrowserWindow]) },
  ),
  contextBridge: { exposeInMainWorld: vi.fn() },
  dialog: { showErrorBox: vi.fn(), showMessageBoxSync: mockShowMessageBoxSync },
  Tray: function MockTray() {
    return { setToolTip: vi.fn(), setContextMenu: vi.fn(), on: vi.fn() };
  },
  globalShortcut: { register: vi.fn(() => false), unregister: vi.fn(), unregisterAll: vi.fn() },
  nativeImage: {
    createFromPath: vi.fn(() => ({
      resize: vi.fn(() => ({
        toBitmap: vi.fn(() => Buffer.from([])),
        getSize: vi.fn(() => ({ width: 16, height: 16 })),
        setTemplateImage: vi.fn(),
      })),
      toBitmap: vi.fn(() => Buffer.from([])),
      getSize: vi.fn(() => ({ width: 16, height: 16 })),
      setTemplateImage: vi.fn(),
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
    defaultSession: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
  },
  systemPreferences: {
    askForMediaAccess: vi.fn(async () => true),
    getMediaAccessStatus: vi.fn(() => 'granted'),
  },
}));

vi.mock('@openpalm/lib', () => ({
  resolveOpenPalmHome: vi.fn(() => '/home/user/.openpalm'),
  resolveDataDir: vi.fn(() => '/home/user/.openpalm/data'),
  resolveConfigDir: vi.fn(() => '/home/user/.openpalm/config'),
  resolveUiBuildDir: vi.fn(() => '/home/user/.openpalm/data/ui'),
  ensureHomeDirs: vi.fn(),
  parseEnvFile: vi.fn(() => ({})),
  stackEnvFile: vi.fn((home: string) => `${home}/state/stack.env`),
  resolveUiListenEnv: vi.fn((opts: { port: number }) => ({
    HOST: '127.0.0.1',
    PORT: String(opts.port),
    ORIGIN: `http://127.0.0.1:${opts.port}`,
  })),
  resolveHostUiPort: vi.fn(() => 3880),
  checkExistingUiInstance: vi.fn(async () => ({ status: 'absent' as const })),
  readyOrChildExit: vi.fn(async () => true),
  resolveAssistantEndpoint: vi.fn(() => 'http://127.0.0.1:3800'),
  waitForReady: vi.fn(async () => true),
  seedLegacyServedUiRuntimeConfig: vi.fn(),
  applyHomeAssets: vi.fn(async () => {}),
  // The journal both the quit-guard and the completion-notifier read.
  createState: vi.fn(() => ({ dataDir: '/home/user/.openpalm/data' })),
  resolveDeployJournalPath: vi.fn((state: { dataDir: string }) => `${state.dataDir}/setup/deploy-journal.json`),
  readDeployJournal: mockReadDeployJournal,
  // Minimal fake of lib's UiSupervisor (adopt()/current only — main.ts never
  // calls start() here; see main.ts's uiSupervisor docblock).
  UiSupervisor: class {
    current: unknown = null;
    adopt(handle: unknown) {
      this.current = handle;
    }
  },
}));

// Importing for its module-scope side effect: registers app.on('before-quit', ...).
import '../src/main.js';
import { app, BrowserWindow } from 'electron';

function getBeforeQuitHandler(): (event: { preventDefault: () => void }) => void {
  const entry = vi.mocked(app.on).mock.calls.find(([e]) => e === 'before-quit');
  expect(entry, 'before-quit handler must be registered').toBeDefined();
  return entry?.[1] as (event: { preventDefault: () => void }) => void;
}

beforeEach(() => {
  mockShowMessageBoxSync.mockClear();
  vi.mocked(app.quit).mockClear();
  vi.mocked(app.exit).mockClear();
});

// NOTE on ordering: `cleanupStarted` (main.ts's re-entrancy guard) is
// module-scoped and, once a quit is allowed to proceed, never resets for the
// rest of this module instance's life — by design (see main.ts's before-quit
// docblock). The "keep waiting" case below deliberately never proceeds, so it
// can run (and re-run) safely; it MUST run before the "quit anyway" case,
// which does proceed and would make every later call in this file a no-op.
// The plain "nothing deploying → quits normally" case is already covered by
// main.test.ts's long-lived module instance; it is not repeated here.
describe('before-quit deploy-in-progress guard (E5)', () => {
  it('warns and CANCELS the quit when a deploy is in progress and the user chooses to keep waiting', () => {
    mockReadDeployJournal.mockReturnValue({
      deploying: true,
      setupComplete: false,
      deployStatus: [],
      deployError: null,
      imageWarning: null,
      phase: 'starting',
      startedAt: new Date().toISOString(),
      pid: 4321,
    });
    mockShowMessageBoxSync.mockReturnValue(1); // "Keep Waiting" (cancelId)

    const handler = getBeforeQuitHandler();
    const event = { preventDefault: vi.fn() };
    handler(event);

    expect(mockShowMessageBoxSync).toHaveBeenCalledOnce();
    const options = mockShowMessageBoxSync.mock.calls[0]?.[0] as { message?: string; buttons?: string[] };
    expect(options.message).toMatch(/still deploying/i);
    expect(options.buttons).toEqual(expect.arrayContaining([expect.stringMatching(/quit/i), expect.stringMatching(/wait/i)]));
    // The quit must NOT proceed: no cleanup, no exit.
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(app.exit).not.toHaveBeenCalled();

    // E4 review: in this module no window was ever opened (whenReady never
    // resolves — same as the real no-tray case, where close →
    // window-all-closed → app.quit destroyed it) and no tray exists.
    // Cancelling the quit must REOPEN the window, or the app would keep
    // running invisibly with no way back in short of a process manager.
    expect(vi.mocked(BrowserWindow)).toHaveBeenCalledTimes(1);

    // A second quit attempt re-checks the journal from scratch (cleanupStarted
    // was never set) rather than being silently swallowed as a "second call".
    mockShowMessageBoxSync.mockClear();
    const event2 = { preventDefault: vi.fn() };
    handler(event2);
    expect(mockShowMessageBoxSync).toHaveBeenCalledOnce();
    expect(event2.preventDefault).toHaveBeenCalledOnce();
    expect(app.exit).not.toHaveBeenCalled();
    // The window reopened above still exists — no duplicate is created.
    expect(vi.mocked(BrowserWindow)).toHaveBeenCalledTimes(1);
  });

  it('warns and PROCEEDS with the quit when the user chooses "Quit Anyway"', () => {
    mockReadDeployJournal.mockReturnValue({
      deploying: true,
      setupComplete: false,
      deployStatus: [],
      deployError: null,
      imageWarning: null,
      phase: 'starting',
      startedAt: new Date().toISOString(),
      pid: 4321,
    });
    mockShowMessageBoxSync.mockReturnValue(0); // "Quit Anyway"

    const handler = getBeforeQuitHandler();
    const event = { preventDefault: vi.fn() };
    handler(event);

    expect(mockShowMessageBoxSync).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledWith(0);

    // Re-entrant call (Electron re-firing before-quit after app.exit()) must
    // now be a no-op, same as the plain-quit path.
    mockShowMessageBoxSync.mockClear();
    vi.mocked(app.exit).mockClear();
    const event2 = { preventDefault: vi.fn() };
    handler(event2);
    expect(event2.preventDefault).not.toHaveBeenCalled();
    expect(app.exit).not.toHaveBeenCalled();
  });
});
