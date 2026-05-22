import { app, BrowserWindow, Tray, Menu, shell } from 'electron';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

// Compatibility shim — @openpalm/lib logger reads globalThis.Bun.env in some paths
if (!(globalThis as Record<string, unknown>).Bun) {
  (globalThis as Record<string, unknown>).Bun = { env: process.env };
}

import {
  resolveOpenPalmHome,
  resolveStateDir,
  resolveConfigDir,
  resolveUiBuildDir,
  seedUiBuild,
  ensureHomeDirs,
  checkAndUpdateUiBuild,
} from '@openpalm/lib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const UI_PORT = Number(process.env.OP_HOST_UI_PORT) || 3880;
const READY_TIMEOUT_MS = 20_000;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let uiProcess: ChildProcess | null = null;

// ── Pure helpers (exported for testing) ──────────────────────────────────────

/**
 * Build the environment object to pass to the UI Node child process.
 * Exported as a pure function so tests can verify it without spawning anything.
 */
export function buildUIServerEnv(homeDir: string, port: number): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OP_HOME: homeDir,
    HOST: '127.0.0.1',
    PORT: String(port),
    ORIGIN: `http://127.0.0.1:${port}`,
  };
}

// ── UI server lifecycle ──────────────────────────────────────────────────────

export async function waitForReady(port: number, timeoutMs = READY_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok || res.status === 401) return true;
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 300));
  }
  return false;
}

async function startUIServer(): Promise<void> {
  const homeDir = resolveOpenPalmHome();
  const stateDir = resolveStateDir();

  // resolveConfigDir is imported but used implicitly via lib internals; calling
  // it here keeps the import live and makes the dependency explicit.
  resolveConfigDir();

  ensureHomeDirs();

  const version = app.getVersion();

  // Check for a newer UI build on GitHub before starting.
  // Non-fatal: if the check or download fails, we continue with what's on disk.
  const updateResult = await checkAndUpdateUiBuild(version, stateDir);
  if (updateResult.updated) {
    console.log(`UI updated to v${updateResult.latestVersion}`);
  } else if (updateResult.error) {
    console.log(`UI update check skipped: ${updateResult.error}`);
  }

  let uiBuildDir = resolveUiBuildDir();

  if (!existsSync(join(uiBuildDir, 'index.js'))) {
    console.log('UI build not found — seeding from release...');
    try {
      await seedUiBuild(`v${version}`, stateDir);
      uiBuildDir = resolveUiBuildDir();
    } catch (err) {
      console.error('Failed to seed UI build:', err instanceof Error ? err.message : String(err));
      app.quit();
      return;
    }
  }

  uiProcess = spawn('node', [join(uiBuildDir, 'index.js')], {
    cwd: uiBuildDir,
    env: buildUIServerEnv(homeDir, UI_PORT),
    stdio: 'inherit',
  });

  uiProcess.on('error', (err) => {
    console.error('UI server process error:', err.message);
  });

  uiProcess.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`UI server exited with code ${code}`);
    }
    uiProcess = null;
  });

  const ready = await waitForReady(UI_PORT);
  if (!ready) {
    console.error('UI server did not become ready in time');
    app.quit();
  }
}

function stopUIServer(): void {
  if (uiProcess) {
    uiProcess.kill('SIGTERM');
    uiProcess = null;
  }
}

// ── Window management ────────────────────────────────────────────────────────

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'OpenPalm',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${UI_PORT}`);

  // Open external links in the system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Hide to tray instead of closing
  mainWindow.on('close', (event) => {
    if (!(app as unknown as Record<string, unknown>).isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function showWindow(): void {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

// ── Tray ─────────────────────────────────────────────────────────────────────

function createTray(): void {
  const iconPath = join(__dirname, '..', 'assets', 'tray-icon.png');
  if (!existsSync(iconPath)) {
    return;
  }

  tray = new Tray(iconPath);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open OpenPalm', click: showWindow },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        (app as unknown as Record<string, unknown>).isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('OpenPalm');
  tray.setContextMenu(contextMenu);
  tray.on('click', showWindow);
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  await startUIServer();
  createWindow();
  createTray();

  app.on('activate', () => {
    // macOS: re-open window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

app.on('window-all-closed', () => {
  // Keep running in tray on all platforms
});

app.on('before-quit', () => {
  (app as unknown as Record<string, unknown>).isQuitting = true;
  stopUIServer();
});
