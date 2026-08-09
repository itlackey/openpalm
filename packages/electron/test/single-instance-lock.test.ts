// Single-instance lock (E1 review): before this fix there was NO
// requestSingleInstanceLock anywhere — a second `openpalm` desktop launch
// attached to the FIRST instance's UI server (checkExistingUiInstance sees an
// admin UI already on the port and reuses it, by design) and opened its own
// window onto it. Quitting the first instance then SIGKILLs the shared UI
// server out from under the second instance's window, stranding it on a dead
// server with no recovery short of a relaunch.
//
// main.ts now calls app.requestSingleInstanceLock() at MODULE LOAD TIME and
// branches on the result — a single test file can only exercise the branch
// its mock resolves to (the decision isn't deferred to a function call this
// suite can invoke twice with different answers). main.test.ts's mock
// resolves `true` and exercises the primary-instance path throughout every
// other Electron unit test; THIS file resolves `false` in isolation and pins
// the loser's behavior: quit immediately, never reach app.whenReady(), never
// register a second-instance handler, never touch the UI server at all.
//
// Run via vitest (Node), NOT bun test — same reason as main.test.ts (bun
// executes the real 'electron' module and can't honor vi.mock() hoisting).
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

const { mockWhenReady } = vi.hoisted(() => ({
  // Must never be called in the denied branch — if it were, this Promise
  // would hang forever, which is itself a signal something regressed.
  mockWhenReady: vi.fn(() => new Promise(() => {})),
}));

const { mockReadDeployJournal, mockShowMessageBoxSync } = vi.hoisted(() => ({
  // Reports an in-flight deploy so the before-quit test below can prove the
  // loser NEVER consults the deploy guard — even when the primary instance's
  // journal says one is running.
  mockReadDeployJournal: vi.fn(() => ({ deploying: true })),
  mockShowMessageBoxSync: vi.fn(() => 1), // "Keep Waiting" (cancelId), if ever shown
}));

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '0.11.0'),
    quit: vi.fn(),
    exit: vi.fn(),
    whenReady: mockWhenReady,
    on: vi.fn(),
    getAppPath: vi.fn(() => '/mock/app'),
    getPath: vi.fn(() => '/mock/logs'),
    relaunch: vi.fn(),
    setAppUserModelId: vi.fn(),
    getLoginItemSettings: vi.fn(() => ({ openAtLogin: false })),
    setLoginItemSettings: vi.fn(),
    // The lock under test: this launch is the LOSER.
    requestSingleInstanceLock: vi.fn(() => false),
  },
  BrowserWindow: Object.assign(
    function MockBrowserWindow() { return {}; },
    { getAllWindows: vi.fn(() => []) },
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
  resolveUiListenEnv: vi.fn(() => ({})),
  resolveHostUiPort: vi.fn(() => 3880),
  checkExistingUiInstance: vi.fn(async () => ({ status: 'absent' as const })),
  readyOrChildExit: vi.fn(),
  resolveAssistantEndpoint: vi.fn(() => 'http://127.0.0.1:3800'),
  waitForReady: vi.fn(async () => true),
  seedLegacyServedUiRuntimeConfig: vi.fn(),
  applyHomeSeed: vi.fn(async () => ({ updated: [], backupDir: null })),
  createState: vi.fn(() => ({ dataDir: '/home/user/.openpalm/data' })),
  resolveDeployJournalPath: vi.fn(() => '/mock/deploy-journal.json'),
  readDeployJournal: mockReadDeployJournal,
  // Minimal fake of lib's UiSupervisor (adopt()/current only — main.ts never
  // calls start() here; see main.ts's uiSupervisor docblock). Constructed at
  // module load regardless of the single-instance-lock outcome.
  UiSupervisor: class {
    current: unknown = null;
    adopt(handle: unknown) {
      this.current = handle;
    }
  },
}));

// Importing for its module-scope side effect: the single-instance check runs
// unconditionally at import time, before this test body ever executes.
import '../src/main.js';
import { app } from 'electron';

describe('single-instance lock — denied (E1)', () => {
  it('checks the lock at module load time', () => {
    expect(app.requestSingleInstanceLock).toHaveBeenCalled();
  });

  it('quits immediately rather than starting a second UI server', () => {
    expect(app.quit).toHaveBeenCalled();
  });

  it('never reaches app.whenReady() — no window, no tray, no second UI server', () => {
    expect(mockWhenReady).not.toHaveBeenCalled();
  });

  // The deploy-in-progress quit guard is registered at module scope, so the
  // loser gets the handler too — but it must be inert here. Before the
  // gotSingleInstanceLock gate, the loser's own app.quit() popped the blocking
  // "deploy in progress" dialog and "Keep Waiting" cancelled the quit into a
  // permanent headless zombie (no window or tray was ever registered).
  it('before-quit lets the loser\'s quit proceed untouched, even mid-deploy', () => {
    const entry = vi.mocked(app.on).mock.calls.find(([e]) => e === 'before-quit');
    expect(entry, 'before-quit handler must be registered').toBeDefined();
    const handler = entry?.[1] as (event: { preventDefault: () => void }) => void;

    const event = { preventDefault: vi.fn() };
    handler(event);

    // The journal mock says a deploy IS running — the loser must not care:
    // no dialog, no cancelled quit, no cleanup/exit of its own.
    expect(mockShowMessageBoxSync).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(app.exit).not.toHaveBeenCalled();
  });
});
