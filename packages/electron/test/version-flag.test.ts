// --version / --help (openpalm#673): a packaged AppImage/binary had no way to
// print its own version without running the app — `--version` launched a
// full second GUI instance instead. main.ts now checks process.argv
// synchronously, before app.requestSingleInstanceLock() or app.whenReady(),
// and app.exit() (unlike app.quit()) exits immediately without waiting for
// anything, so no window or UI server is ever reached for either flag.
//
// process.argv is inspected once, at main.ts's module-load time, so it must
// be set BEFORE that module body runs. A static `import '../src/main.js'`
// would be hoisted above any process.argv mutation in this same file (same
// reason undici-ping-shim.ts documents for `import * as undici`), so the SUT
// is imported dynamically, inside each test, after argv is set — paired with
// vi.resetModules() so each test's import actually re-runs the module body
// rather than returning the previous test's cached instance.
//
// Run via vitest (Node), NOT bun test — same reason as main.test.ts (bun
// executes the real electron module and cannot honor vi.mock() hoisting).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(() => false) };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

const { mockWhenReady, mockRequestSingleInstanceLock, mockExit, mockGetVersion } = vi.hoisted(() => ({
  // Must never be called for --version/--help — if whenReady WERE called,
  // this unresolved Promise would just sit there; requestSingleInstanceLock
  // is asserted directly instead.
  mockWhenReady: vi.fn(() => new Promise(() => {})),
  mockRequestSingleInstanceLock: vi.fn(() => true),
  mockExit: vi.fn(),
  mockGetVersion: vi.fn(() => '0.13.2'),
}));

vi.mock('electron', () => ({
  app: {
    getVersion: mockGetVersion,
    quit: vi.fn(),
    exit: mockExit,
    whenReady: mockWhenReady,
    on: vi.fn(),
    getAppPath: vi.fn(() => '/mock/app'),
    getPath: vi.fn(() => '/mock/logs'),
    relaunch: vi.fn(),
    setAppUserModelId: vi.fn(),
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
    setLoginItemSettings: vi.fn(),
    requestSingleInstanceLock: mockRequestSingleInstanceLock,
  },
  BrowserWindow: Object.assign(
    function MockBrowserWindow() { return {}; },
    { getAllWindows: vi.fn(() => []) },
  ),
  contextBridge: { exposeInMainWorld: vi.fn() },
  dialog: { showErrorBox: vi.fn(), showMessageBoxSync: vi.fn(() => 1) },
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
    removeListener: vi.fn(),
  },
  CancellationToken: class MockCancellationToken {
    cancel = vi.fn();
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
  resolveUiListenEnv: vi.fn(() => ({})),
  resolveHostUiPort: vi.fn(() => 3880),
  checkExistingUiInstance: vi.fn(async () => ({ status: 'absent' as const })),
  readyOrChildExit: vi.fn(),
  resolveAssistantEndpoint: vi.fn(() => 'http://127.0.0.1:3800'),
  waitForReady: vi.fn(async () => true),
  seedLegacyServedUiRuntimeConfig: vi.fn(),
  applyHomeAssets: vi.fn(async () => {}),
  createState: vi.fn(() => ({ dataDir: '/home/user/.openpalm/data' })),
  resolveDeployJournalPath: vi.fn(() => '/mock/deploy-journal.json'),
  readDeployJournal: vi.fn(() => ({ deploying: false })),
  UiSupervisor: class {
    current: unknown = null;
    adopt(handle: unknown) {
      this.current = handle;
    }
  },
}));

const ORIGINAL_ARGV = process.argv;

function withArgv<T>(flag: string, run: () => Promise<T>): Promise<T> {
  process.argv = [...ORIGINAL_ARGV, flag];
  return run();
}

beforeEach(() => {
  vi.resetModules();
  mockExit.mockClear();
  mockRequestSingleInstanceLock.mockClear();
  mockWhenReady.mockClear();
});

afterEach(() => {
  process.argv = ORIGINAL_ARGV;
});

// app.exit() is a spy here, not a real process termination, so — unlike the
// real Electron runtime — module evaluation continues past it and
// requestSingleInstanceLock() does still run later in this same test. What
// IS meaningfully verifiable under the mock, and what actually matters, is
// ORDER: the version/help branch has to run and call app.exit() before the
// single-instance lock is ever requested, proving the check sits ahead of
// it in the module body (in real Electron, app.exit()'s documented immediate
// termination then means nothing after it runs at all).
function expectExitedBeforeSingleInstanceLock(): void {
  expect(mockExit).toHaveBeenCalledWith(0);
  expect(mockRequestSingleInstanceLock).toHaveBeenCalled();
  const exitOrder = mockExit.mock.invocationCallOrder[0];
  const lockOrder = mockRequestSingleInstanceLock.mock.invocationCallOrder[0];
  expect(exitOrder).toBeLessThan(lockOrder);
}

describe.each(['--version', '-v'])('%s (openpalm#673)', (flag) => {
  it('prints the version and exits before the single-instance lock is ever requested', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await withArgv(flag, () => import('../src/main.js'));

    expect(logSpy).toHaveBeenCalledWith('0.13.2');
    expectExitedBeforeSingleInstanceLock();

    logSpy.mockRestore();
  });
});

describe.each(['--help', '-h'])('%s (openpalm#673)', (flag) => {
  it('prints usage (including the version) and exits before the single-instance lock is ever requested', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await withArgv(flag, () => import('../src/main.js'));

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('0.13.2'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('--version'));
    expectExitedBeforeSingleInstanceLock();

    logSpy.mockRestore();
  });
});
