import { app, BrowserWindow, Tray, Menu, shell, dialog, ipcMain } from 'electron';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';

// Compatibility shim — @openpalm/lib logger reads globalThis.Bun.env in some paths
if (!(globalThis as Record<string, unknown>).Bun) {
  (globalThis as Record<string, unknown>).Bun = { env: process.env };
}

import {
  resolveOpenPalmHome,
  resolveDataDir,
  resolveConfigDir,
  resolveUiBuildDir,
  seedUiBuild,
  seedOpenPalmDir,
  ensureHomeDirs,
  checkAndUpdateUiBuild,
  parseEnvFile,
} from '@openpalm/lib';
import { checkForElectronUpdate, getCachedUpdateInfo, type UpdateInfo } from './update-check.js';
import { startLocalOpenCode, killProcessTree, type LocalOpencodeHandle } from './local-opencode.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Resolve the admin-tools path. Priority:
 *   1. extraResources path (packaged Electron build)
 *   2. Workspace dist path (running from source in dev)
 *   3. npm package name (last-resort fallback)
 */
function resolveAdminToolsPluginPath(): string {
  // Production: electron-builder copies to resources/admin-tools/index.js
  const packed = join(process.resourcesPath ?? '', 'admin-tools', 'index.js');
  if (existsSync(packed)) return packed;
  // Dev: __dirname is packages/electron/dist/ → sibling admin-tools/dist/
  const dev = join(__dirname, '..', 'admin-tools', 'dist', 'index.js');
  if (existsSync(dev)) return dev;
  return '@openpalm/admin-tools-plugin';
}

const UI_PORT = Number(process.env.OP_HOST_UI_PORT) || 3880;
const READY_TIMEOUT_MS = 60_000;

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let uiProcess: ChildProcess | null = null;
let localOpencode: LocalOpencodeHandle | null = null;

// ── Stderr ring buffer (200 lines) ────────────────────────────────────────────
const STDERR_RING_SIZE = 200;
const stderrRing: string[] = [];

/** Append a line to the ring buffer, evicting the oldest entry when full. */
function appendStderrLine(line: string): void {
  if (stderrRing.length >= STDERR_RING_SIZE) stderrRing.shift();
  stderrRing.push(line);
}

/** Returns the most-recent `maxLines` lines of captured UI server stderr. */
export function getRecentStderr(maxLines = 40): string {
  return stderrRing.slice(-maxLines).join('\n');
}

// ── Pure helpers (exported for testing) ──────────────────────────────────────

/**
 * Resolve the assistant (OpenCode) URL the UI proxy should target.
 *
 * The Electron app launches a separate UI Node server that proxies
 * `/proxy/assistant/*` to the assistant container. Without OP_OPENCODE_URL set,
 * that proxy falls back to `http://localhost:4096` (the in-container port),
 * which doesn't exist on the host. Read the host port bound by docker compose
 * from `${OP_HOME}/knowledge/env/stack.env` so the UI hits the right address.
 */
export function resolveAssistantUrl(homeDir: string): string {
  const userOverride = process.env.OP_OPENCODE_URL ?? process.env.OP_ASSISTANT_URL;
  if (userOverride) return userOverride;
  const stackEnv = parseEnvFile(join(homeDir, 'knowledge', 'env', 'stack.env'));
  const bind = stackEnv.OP_ASSISTANT_BIND_ADDRESS || '127.0.0.1';
  const port = stackEnv.OP_ASSISTANT_PORT || '3800';
  return `http://${bind}:${port}`;
}

/**
 * Build the environment object to pass to the UI Node child process.
 * Exported as a pure function so tests can verify it without spawning anything.
 */
export function buildUIServerEnv(homeDir: string, port: number, update?: UpdateInfo | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OP_HOME: homeDir,
    HOST: '127.0.0.1',
    PORT: String(port),
    ORIGIN: `http://127.0.0.1:${port}`,
    OP_INSIDE_ELECTRON: '1',
    OP_ELECTRON_VERSION: app.getVersion?.() ?? '',
    OP_IMAGE_TAG: 'latest',
    OP_OPENCODE_URL: resolveAssistantUrl(homeDir),
  };
  // Pass the bundled skeleton path so the UI server can refresh the registry
  // on startup without needing the source repo or a network download.
  const skeletonDir = join(process.resourcesPath ?? '', 'openpalm-skeleton');
  if (existsSync(skeletonDir)) {
    env.OPENPALM_SKELETON_DIR = skeletonDir;
  }
  if (update?.updateAvailable && update.latestVersion) {
    env.OP_ELECTRON_LATEST_VERSION = update.latestVersion;
    if (update.latestUrl) env.OP_ELECTRON_LATEST_URL = update.latestUrl;
  }
  return env;
}

// ── UI server lifecycle ──────────────────────────────────────────────────────

/** Kill an orphaned UI server left by a previous crashed Electron instance. */
async function killStaleUIServer(pidFile: string): Promise<void> {
  let pid: number | null = null;
  try {
    const raw = readFileSync(pidFile, 'utf-8').trim();
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) pid = n;
  } catch {
    return; // no PID file — nothing to do
  }
  if (!pid) return;
  try { process.kill(pid, 0); } catch { return; } // already dead
  console.log(`Killing stale UI server (PID ${pid})…`);
  // Group-kill: the stale node server may have left an `opencode serve` child
  // (the setup wizard). killProcessTree reaps the whole subtree.
  killProcessTree(pid, 'SIGTERM');
  await new Promise(r => setTimeout(r, 2000));
  killProcessTree(pid, 'SIGKILL');
}

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
  const dataDir = resolveDataDir();

  // resolveConfigDir is imported but used implicitly via lib internals; calling
  // it here keeps the import live and makes the dependency explicit.
  resolveConfigDir();

  ensureHomeDirs();

  // Seed .openpalm skeleton (registry, default configs) from the bundled
  // extraResources. This refreshes the registry on every launch so addon
  // profiles stay current without requiring a source checkout or network fetch.
  const skeletonDir = join(process.resourcesPath ?? '', 'openpalm-skeleton');
  if (existsSync(skeletonDir)) {
    process.env.OPENPALM_SKELETON_DIR = skeletonDir;
    try {
      await seedOpenPalmDir(`v${app.getVersion()}`, homeDir, resolveConfigDir(), dataDir);
    } catch (err) {
      console.warn('Skeleton seed failed (non-fatal):', err instanceof Error ? err.message : String(err));
    }
  }

  const version = app.getVersion();

  // Check for a newer Electron app version on GitHub. Non-fatal; result is
  // surfaced to the UI as an env var so the in-app banner can offer a download.
  const appUpdate = await checkForElectronUpdate(version);
  if (appUpdate.updateAvailable) {
    console.log(`App update available: v${appUpdate.latestVersion}`);
  } else if (appUpdate.error) {
    console.log(`App update check skipped: ${appUpdate.error}`);
  }

  // Check for a newer UI build on GitHub before starting.
  // Non-fatal: if the check or download fails, we continue with what's on disk.
  const updateResult = await checkAndUpdateUiBuild(version, dataDir);
  if (updateResult.updated) {
    console.log(`UI updated to v${updateResult.latestVersion}`);
  } else if (updateResult.error) {
    console.log(`UI update check skipped: ${updateResult.error}`);
  }

  let uiBuildDir = resolveUiBuildDir();

  if (!existsSync(join(uiBuildDir, 'index.js'))) {
    console.log('UI build not found — seeding from release...');
    try {
      await seedUiBuild(`v${version}`, dataDir);
      uiBuildDir = resolveUiBuildDir();
    } catch (err) {
      console.error('Failed to seed UI build:', err instanceof Error ? err.message : String(err));
      app.quit();
      return;
    }
  }

  const uiPidFile = join(dataDir, '.ui-server.pid');
  await killStaleUIServer(uiPidFile);

  uiProcess = spawn('node', [join(uiBuildDir, 'index.js')], {
    cwd: uiBuildDir,
    env: buildUIServerEnv(homeDir, UI_PORT, appUpdate),
    // Own process group so shutdown can group-kill the UI server AND any
    // children it spawns (e.g. the wizard's `opencode serve` subprocess),
    // which a bare kill of the node pid would orphan.
    detached: process.platform !== 'win32',
    // stdout inherits so terminal users see it; stderr is piped for diagnostics
    stdio: ['ignore', 'inherit', 'pipe'],
  });
  if (uiProcess.pid) {
    try { writeFileSync(uiPidFile, String(uiProcess.pid)); } catch { /* best-effort */ }
  }

  // Tail UI server stderr into the ring buffer and re-emit to process.stderr
  // so terminal users still see the output.
  uiProcess.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    process.stderr.write(text);
    // Split on newlines; keep partial last line if chunk doesn't end with \n
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip the trailing empty string produced by a trailing newline
      if (i === lines.length - 1 && line === '') continue;
      appendStderrLine(line);
    }
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
    const recentLogs = getRecentStderr(40);
    const detail = [
      `The UI server on port ${UI_PORT} did not respond within ${READY_TIMEOUT_MS / 1000} seconds.`,
      '',
      recentLogs
        ? `Last output from UI server:\n${recentLogs}`
        : '(No UI server output was captured.)',
      '',
      'Check the terminal where you launched OpenPalm for full logs.',
    ].join('\n');
    console.error('UI server did not become ready in time');
    closeSplashWindow();
    dialog.showErrorBox('OpenPalm failed to start', detail);
    app.quit();
  }
}

function stopUIServer(): void {
  if (!uiProcess) return;
  const pid = uiProcess.pid;
  uiProcess = null;
  // Group-kill so the UI server's children (e.g. the wizard's `opencode serve`)
  // die with it instead of orphaning. SIGKILL the group immediately after as a
  // backstop — the process is exiting, so there is no graceful-drain window to
  // wait for, and a lingering timer would not survive app.quit() anyway.
  if (pid) {
    killProcessTree(pid, 'SIGTERM');
    killProcessTree(pid, 'SIGKILL');
  }
  try { rmSync(join(resolveDataDir(), '.ui-server.pid'), { force: true }); } catch { /* best-effort */ }
}

// ── Window management ────────────────────────────────────────────────────────

function createSplashWindow(): void {
  splashWindow = new BrowserWindow({
    width: 380,
    height: 200,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    show: true,
    backgroundColor: '#0f172a',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{height:100%;margin:0;background:#0f172a;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}
    body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
    .logo{font-size:22px;font-weight:600;letter-spacing:0.5px}
    .hint{font-size:13px;color:#94a3b8}
    .spinner{width:24px;height:24px;border:3px solid #1e293b;border-top-color:#60a5fa;border-radius:50%;animation:spin 0.8s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style></head><body>
    <div class="logo">OpenPalm</div>
    <div class="spinner"></div>
    <div class="hint" id="hint">Starting…</div>
    <script>
      setTimeout(function(){var h=document.getElementById('hint');if(h)h.textContent='Still starting (first launch may take a minute)…';},15000);
      setTimeout(function(){var h=document.getElementById('hint');if(h)h.textContent='Almost there…';},40000);
    </script>
  </body></html>`;
  void splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  splashWindow.on('closed', () => { splashWindow = null; });
}

function closeSplashWindow(): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
    splashWindow = null;
  }
}

async function resolveInitialUrl(): Promise<string> {
  // Try to read setup status so we can land directly on the right page.
  // Falls back to root (which itself redirects appropriately).
  try {
    const res = await fetch(`http://127.0.0.1:${UI_PORT}/api/setup/status`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json() as { setupComplete?: boolean };
      return `http://127.0.0.1:${UI_PORT}/${data.setupComplete ? 'chat' : 'setup'}`;
    }
  } catch {
    // ignore; fall through to root
  }
  return `http://127.0.0.1:${UI_PORT}`;
}

async function createWindow(): Promise<void> {
  const update = getCachedUpdateInfo();
  const title = update?.updateAvailable
    ? `OpenPalm — Update available (v${update.latestVersion})`
    : 'OpenPalm';

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    // Narrow enough for a mobile-shaped sidecar window (300×500-ish). The
    // chat + endpoint switcher layouts reflow cleanly below ~360px.
    minWidth: 300,
    minHeight: 400,
    title,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const initialUrl = await resolveInitialUrl();
  mainWindow.loadURL(initialUrl);

  mainWindow.once('ready-to-show', () => {
    closeSplashWindow();
    mainWindow?.show();
  });

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
    void createWindow();
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
  createSplashWindow();
  try {
    await startUIServer();
  } catch (err) {
    closeSplashWindow();
    console.error('Failed to start UI server:', err instanceof Error ? err.message : String(err));
    app.quit();
    return;
  }

  // Spawn the ephemeral local OpenCode (Phase 3). Non-fatal: if the binary
  // is missing or spawn fails, the UI shows a sentinel and remote endpoints
  // continue to work.
  try {
    const dataDir = `${resolveOpenPalmHome()}/data`;
    localOpencode = await startLocalOpenCode({ dataDir, pluginPath: resolveAdminToolsPluginPath() });
    if (localOpencode) {
      console.log(`Local OpenCode listening on ${localOpencode.url}`);
    }
  } catch (err) {
    console.warn(
      'Local OpenCode spawn raised; continuing without it:',
      err instanceof Error ? err.message : String(err),
    );
  }

  await createWindow();
  createTray();

  app.on('activate', () => {
    // macOS: re-open window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    else showWindow();
  });
});

app.on('window-all-closed', () => {
  // Keep running in tray on all platforms
});

ipcMain.handle('restart-app', () => {
  app.relaunch();
  app.quit();
});

let cleanupStarted = false;

// Single guarded shutdown. The first quit defers (preventDefault) just long
// enough to signal and reap both children — the UI server (group-killed in
// stopUIServer) and the admin OpenCode (handle.stop(), which now resolves as
// soon as the child is dead rather than after a fixed delay) — then re-quits.
// The re-entrant call hits the `cleanupStarted` guard and passes straight
// through. Doing all teardown in one handler (instead of splitting it across
// before-quit/will-quit with a silent multi-second wait) is what removes the
// "have to quit twice" behaviour.
app.on('before-quit', async (event) => {
  (app as unknown as Record<string, unknown>).isQuitting = true;
  if (cleanupStarted) return;
  cleanupStarted = true;
  event.preventDefault();
  stopUIServer();
  if (localOpencode) {
    const handle = localOpencode;
    localOpencode = null;
    try {
      await handle.stop();
    } catch (err) {
      console.warn(
        'Local OpenCode stop raised:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  app.quit();
});
