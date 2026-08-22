// E2 review: the renderer's "Restart and update" used to go straight to
// electron-updater's quitAndInstall(), which spawns the installer BEFORE its
// own internal app.quit() — so the before-quit deploy guard fired only AFTER
// the installer was already running, and choosing "Keep Waiting" there
// cancelled the quit but not the installer (a half-updated app).
// handleQuitAndInstallRequest now runs the SAME journal check + dialog first,
// and suppresses the before-quit re-prompt once the user has confirmed.
//
// Its own file for the same reason as deploy-quit-guard.test.ts: the
// suppression case below lets before-quit proceed, which sets the
// module-scoped one-way `cleanupStarted` flag — only one test per module
// instance may do that, and main.test.ts's long-lived instance reserves it
// for its own before-quit suite.
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
    whenReady: vi.fn(() => new Promise(() => {})), // never resolves — the quit-and-install path is what's under test, not boot
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
  createState: vi.fn(() => ({ dataDir: '/home/user/.openpalm/data' })),
  resolveDeployJournalPath: vi.fn((state: { dataDir: string }) => `${state.dataDir}/setup/deploy-journal.json`),
  readDeployJournal: mockReadDeployJournal,
  UiSupervisor: class {
    current: unknown = null;
    adopt(handle: unknown) {
      this.current = handle;
    }
  },
}));

// Importing for its module-scope side effect: registers app.on('before-quit', ...).
import { handleQuitAndInstallRequest } from '../src/main.js';
import { DesktopUpdater } from '../src/updater.js';
import { app } from 'electron';

function getBeforeQuitHandler(): (event: { preventDefault: () => void }) => void {
  const entry = vi.mocked(app.on).mock.calls.find(([e]) => e === 'before-quit');
  expect(entry, 'before-quit handler must be registered').toBeDefined();
  return entry?.[1] as (event: { preventDefault: () => void }) => void;
}

/** A DesktopUpdater over a fake with a staged ('downloaded') update. */
async function makeDownloadedUpdater() {
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
  await updater.check();
  await updater.download();
  expect(updater.getState().status).toBe('downloaded');
  return { updater, fake };
}

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

beforeEach(() => {
  mockShowMessageBoxSync.mockClear();
  vi.mocked(app.quit).mockClear();
  vi.mocked(app.exit).mockClear();
});

// NOTE on ordering: the "Quit Anyway" case below lets before-quit proceed,
// setting the module's one-way `cleanupStarted` flag — it must run LAST.
describe('quit-and-install deploy guard (E2)', () => {
  it('"Keep Waiting" refuses BEFORE the installer is launched', async () => {
    const { updater, fake } = await makeDownloadedUpdater();
    mockReadDeployJournal.mockReturnValue(deployingJournal);
    mockShowMessageBoxSync.mockReturnValue(1); // "Keep Waiting" (cancelId)

    expect(handleQuitAndInstallRequest(updater)).toBe(false);

    expect(mockShowMessageBoxSync).toHaveBeenCalledOnce();
    // The whole point: the installer was never launched, so cancelling has
    // nothing irreversible behind it.
    expect(fake.quitAndInstall).not.toHaveBeenCalled();
    expect(app.exit).not.toHaveBeenCalled();
  });

  it('"Quit Anyway" launches the installer, and before-quit does not re-prompt', async () => {
    const { updater, fake } = await makeDownloadedUpdater();
    mockReadDeployJournal.mockReturnValue(deployingJournal);
    mockShowMessageBoxSync.mockReturnValue(0); // "Quit Anyway"

    expect(handleQuitAndInstallRequest(updater)).toBe(true);
    expect(mockShowMessageBoxSync).toHaveBeenCalledOnce();
    expect(fake.quitAndInstall).toHaveBeenCalledWith(false, true);

    // electron-updater's own app.quit() now fires before-quit while the
    // journal STILL says deploying. The user already answered above — a
    // second prompt would arrive after the installer spawned, when "Keep
    // Waiting" can no longer undo it. The quit must sail through cleanup.
    mockShowMessageBoxSync.mockClear();
    const handler = getBeforeQuitHandler();
    const event = { preventDefault: vi.fn() };
    handler(event);

    expect(mockShowMessageBoxSync).not.toHaveBeenCalled();
    expect(app.exit).toHaveBeenCalledWith(0);
  });
});
