import { app, BrowserWindow, Tray, Menu, shell, dialog, ipcMain, globalShortcut, nativeImage, Notification, session, systemPreferences, type NativeImage } from 'electron';
import { join, dirname } from 'node:path';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
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
  uiUpdateChannel,
  parseEnvFile,
} from '@openpalm/lib';
import { checkForElectronUpdate, getCachedUpdateInfo, type UpdateInfo } from './update-check.js';
import { startLocalOpenCode, killProcessTree, type LocalOpencodeHandle } from './local-opencode.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── PATH augmentation (macOS Finder launch) ──────────────────────────────────
// GUI apps launched from the macOS Finder/Dock inherit only a minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin). Homebrew/nvm install dirs are absent, so
// later child processes resolved via the inherited env (e.g. `opencode`,
// `docker`) fail with ENOENT. Prepend the common install dirs once at startup
// so those children can be found. Harmless on Linux/Windows — entries that
// don't exist are simply never matched. The UI server itself no longer relies
// on a system `node` (it spawns with Electron's bundled Node, below).
function augmentPathForGuiLaunch(): void {
  if (process.platform !== 'darwin') return;
  const home = process.env.HOME ?? '';
  const candidates = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    home ? join(home, '.nvm', 'current', 'bin') : '',
  ].filter(Boolean);
  const current = (process.env.PATH ?? '').split(':').filter(Boolean);
  const missing = candidates.filter((dir) => !current.includes(dir));
  if (missing.length > 0) {
    process.env.PATH = [...missing, ...current].join(':');
  }
}
augmentPathForGuiLaunch();

// ── File logging (no extra deps) ─────────────────────────────────────────────
// Finder-launched apps have no attached terminal, so console output is lost.
// Tee the app's own console.* and the UI child's stdout/stderr to a log file
// under the OS logs dir (macOS → ~/Library/Logs/OpenPalm/main.log) so failures
// are diagnosable. Best-effort: any logging error must never crash the app.
let logStream: WriteStream | null = null;

function logFilePath(): string {
  return join(app.getPath('logs'), 'main.log');
}

function initFileLogger(): void {
  if (logStream) return;
  try {
    const logsDir = app.getPath('logs');
    mkdirSync(logsDir, { recursive: true });
    logStream = createWriteStream(logFilePath(), { flags: 'a' });

    const tee = (orig: (...args: unknown[]) => void, level: string) => {
      return (...args: unknown[]) => {
        orig(...args);
        try {
          const line = args
            .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack ?? a.message : String(a)))
            .join(' ');
          logStream?.write(`${new Date().toISOString()} [${level}] ${line}\n`);
        } catch { /* best-effort */ }
      };
    };
    console.log = tee(console.log.bind(console), 'info') as typeof console.log;
    console.warn = tee(console.warn.bind(console), 'warn') as typeof console.warn;
    console.error = tee(console.error.bind(console), 'error') as typeof console.error;
  } catch { /* best-effort: logging is non-fatal */ }
}

/** Write a raw chunk (UI child stdout/stderr) to the log file. */
function writeChildLog(text: string): void {
  try { logStream?.write(text); } catch { /* best-effort */ }
}

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
const MIC_SHORTCUT = 'CommandOrControl+Shift+M';
// Target menu-bar/tray icon size (points). The source asset is much larger;
// macOS otherwise renders it at full bitmap height (#455).
const TRAY_ICON_SIZE = 18;

let mainWindow: BrowserWindow | null = null;
let splashWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let uiProcess: ChildProcess | null = null;
let localOpencode: LocalOpencodeHandle | null = null;
let registeredMicShortcut: string | null = null;
let trayIcon: NativeImage | null = null;
let trayRecordingIcons: NativeImage[] = [];
let trayAnimationTimer: ReturnType<typeof setInterval> | null = null;
let trayAnimationFrame = 0;

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
  // Operator-managed stack config (knowledge/env/stack.env) holds settings the
  // host UI server's own routes read from process.env — notably the Voice
  // engine vars (OP_TTS_*/OP_STT_*/OP_VOICE_*) written by /admin/voice. Without
  // merging them here, /api/speak + /api/transcribe see empty OP_*_BASE_URL and
  // 503 ("Configure a TTS/STT engine"). Merge stack.env BUT skip OP_IMAGE_TAG:
  // the docker-compose deploy path reads it via --env-file and shell-env takes
  // precedence over --env-file, so injecting it here would override the
  // authoritative tag (see the OP_IMAGE_TAG note below).
  const stackEnv = parseEnvFile(join(homeDir, 'knowledge', 'env', 'stack.env'));
  const stackForUi: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(stackEnv)) {
    if (k === 'OP_IMAGE_TAG' || k === 'OP_HOME') continue;
    stackForUi[k] = v;
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...stackForUi,
    OP_HOME: homeDir,
    HOST: '127.0.0.1',
    PORT: String(port),
    ORIGIN: `http://127.0.0.1:${port}`,
    OP_INSIDE_ELECTRON: '1',
    OP_ELECTRON_VERSION: app.getVersion?.() ?? '',
    // Do NOT set OP_IMAGE_TAG here. Docker precedence is shell-env >
    // --env-file, so any value injected into the UI server's process.env
    // overrides the authoritative OP_IMAGE_TAG written to stack.env (e.g.
    // "dev" for local images, or a pinned "vX.Y.Z"). Forcing "latest" here
    // made every `docker compose config/pull` resolve `…:latest`/`voice:latest-*`
    // — and `latest`/`latest-*` are never published for prereleases, so the
    // deploy failed with "manifest unknown". The deploy reads the tag from
    // stack.env via --env-file; leave it untouched.
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

function resolveAssetPath(fileName: string): string | null {
  const assetPath = join(__dirname, '..', 'assets', fileName);
  return existsSync(assetPath) ? assetPath : null;
}

function createTrayIconVariant(icon: NativeImage, alpha = 1): NativeImage {
  // Rebuild the recording-animation frame at the menu-bar target size. Without
  // this resize the variant would reintroduce the oversized source bitmap and
  // undo the menu-bar sizing applied to the base icon (#455).
  const base = icon.resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
  const bitmap = base.toBitmap();
  const variant = Buffer.from(bitmap);

  for (let i = 3; i < variant.length; i += 4) {
    variant[i] = Math.round(variant[i] * alpha);
  }

  const size = base.getSize();
  const result = nativeImage.createFromBitmap(variant, {
    width: size.width,
    height: size.height,
    scaleFactor: 1,
  });
  if (process.platform === 'darwin') {
    result.setTemplateImage(true);
  }
  return result;
}

function stopTrayRecordingAnimation(): void {
  if (trayAnimationTimer) {
    clearInterval(trayAnimationTimer);
    trayAnimationTimer = null;
  }
  trayAnimationFrame = 0;
  if (tray && trayIcon) {
    tray.setImage(trayIcon);
    tray.setToolTip('OpenPalm');
  }
}

function startTrayRecordingAnimation(): void {
  if (!tray || trayRecordingIcons.length === 0) {
    return;
  }

  stopTrayRecordingAnimation();
  tray.setToolTip('OpenPalm — recording');
  tray.setImage(trayRecordingIcons[0]);
  trayAnimationTimer = setInterval(() => {
    if (!tray || trayRecordingIcons.length === 0) {
      stopTrayRecordingAnimation();
      return;
    }

    trayAnimationFrame = (trayAnimationFrame + 1) % trayRecordingIcons.length;
    tray.setImage(trayRecordingIcons[trayAnimationFrame]);
  }, 280);
}

function setTrayMicRecording(recording: boolean): void {
  if (recording) {
    startTrayRecordingAnimation();
    return;
  }
  stopTrayRecordingAnimation();
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
    console.log('UI build not found — seeding @openpalm/ui from npm...');
    try {
      // @openpalm/ui is independently versioned — seed the channel (latest/next)
      // for this app's release stream, not the app version.
      await seedUiBuild(uiUpdateChannel(version), dataDir);
      uiBuildDir = resolveUiBuildDir();
    } catch (err) {
      console.error('Failed to seed UI build:', err instanceof Error ? err.message : String(err));
      app.quit();
      return;
    }
  }

  const uiPidFile = join(dataDir, '.ui-server.pid');
  await killStaleUIServer(uiPidFile);

  // Spawn the UI Node server with Electron's OWN bundled Node (process.execPath
  // + ELECTRON_RUN_AS_NODE) rather than a bare `node` on PATH. Finder-launched
  // macOS apps don't get Homebrew/nvm on PATH, so `spawn('node', …)` failed
  // with ENOENT and silently hung the splash for 60s (#456). Using the bundled
  // runtime removes the system-Node dependency entirely.
  uiProcess = spawn(process.execPath, [join(uiBuildDir, 'index.js')], {
    cwd: uiBuildDir,
    env: { ...buildUIServerEnv(homeDir, UI_PORT, appUpdate), ELECTRON_RUN_AS_NODE: '1' },
    // Own process group so shutdown can group-kill the UI server AND any
    // children it spawns (e.g. the wizard's `opencode serve` subprocess),
    // which a bare kill of the node pid would orphan.
    detached: process.platform !== 'win32',
    // Capture both streams: under Finder there is no terminal, so 'inherit'
    // would lose all output. Tee stdout+stderr to the log file (and still
    // re-emit to the parent's streams for terminal users).
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (uiProcess.pid) {
    try { writeFileSync(uiPidFile, String(uiProcess.pid)); } catch { /* best-effort */ }
  }

  // Tail UI server stdout to the parent stdout + log file.
  uiProcess.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    process.stdout.write(text);
    writeChildLog(text);
  });

  // Tail UI server stderr into the ring buffer, the parent stderr, and the log.
  uiProcess.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    process.stderr.write(text);
    writeChildLog(text);
    // Split on newlines; keep partial last line if chunk doesn't end with \n
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Skip the trailing empty string produced by a trailing newline
      if (i === lines.length - 1 && line === '') continue;
      appendStderrLine(line);
    }
  });

  // A spawn failure (ENOENT etc.) must surface immediately — don't let the
  // ready-poll spin out its full 60s timeout with a useless splash (#456).
  uiProcess.on('error', (err) => {
    console.error('UI server process error:', err.message);
    closeSplashWindow();
    dialog.showErrorBox(
      'OpenPalm failed to start',
      [
        `The UI server could not be started: ${err.message}`,
        '',
        `See the log file for details:\n${logFilePath()}`,
      ].join('\n'),
    );
    app.quit();
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
      `See the log file for full logs:\n${logFilePath()}`,
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
  const icon = resolveAssetPath('icon.png') ?? undefined;
  splashWindow = new BrowserWindow({
    width: 380,
    height: 200,
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    show: true,
    icon,
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
  const icon = resolveAssetPath('icon.png') ?? undefined;

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    // Narrow enough for a mobile-shaped sidecar window (300×500-ish). The
    // chat + endpoint switcher layouts reflow cleanly below ~360px.
    minWidth: 300,
    minHeight: 400,
    title,
    show: false,
    icon,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
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

// The navbar mic records via getUserMedia in the renderer. Two layers must both
// grant access or the captured audio is SILENT (not an error) — and silence is
// what makes Whisper transcribe a phantom "You":
//   1. Electron's session permission layer must approve the `media` request from
//      our trusted local UI origin (127.0.0.1/localhost). We deny everything else.
//   2. macOS TCC must have granted the app mic access. That requires
//      NSMicrophoneUsageDescription in the app's Info.plist (set in
//      electron-builder.yml) AND askForMediaAccess() — BUT the OS only shows the
//      prompt in response to an actual user interaction (clicking the mic button),
//      not at app startup. We therefore expose this as an IPC call so the renderer
//      can request it precisely when the user first clicks the mic.
function isTrustedLocalOrigin(url: string): boolean {
  return url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost');
}

function configureMediaPermissions(): void {
  const ses = session.defaultSession;

  // Async grant (Chromium asks once per origin). Approve audio capture only for
  // our own UI; deny anything unexpected.
  ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
    if (permission === 'media' && isTrustedLocalOrigin(details.requestingUrl ?? '')) {
      callback(true);
      return;
    }
    callback(false);
  });

  // Some getUserMedia paths consult the synchronous check handler — grant media
  // there for the same trusted origin.
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    return permission === 'media' && isTrustedLocalOrigin(requestingOrigin ?? '');
  });
}

// Called from the renderer via IPC when the user clicks the mic button.
// Returns the access status ('granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown').
// On Windows/Linux the Electron permission handler above is sufficient; this
// is only a meaningful prompt on macOS (the OS ignores non-user-gesture calls).
async function requestMicrophoneAccess(): Promise<string> {
  if (process.platform !== 'darwin') return 'granted';
  try {
    const current = systemPreferences.getMediaAccessStatus('microphone');
    if (current === 'granted') return 'granted';
    const granted = await systemPreferences.askForMediaAccess('microphone');
    return granted ? 'granted' : 'denied';
  } catch (err) {
    console.warn('Microphone access request failed:', err instanceof Error ? err.message : String(err));
    return 'unknown';
  }
}

function triggerGlobalMicToggle(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('global-mic-toggle');
  }
}

function registerGlobalMicShortcut(): void {
  if (globalShortcut.register(MIC_SHORTCUT, triggerGlobalMicToggle)) {
    registeredMicShortcut = MIC_SHORTCUT;
    console.log('Registered global mic shortcut:', registeredMicShortcut);
    return;
  }

  console.warn('Failed to register a global mic shortcut.');
}

// ── Desktop notifications ─────────────────────────────────────────────────────
// On macOS and Windows, Electron's Notification API works without an explicit
// OS permission request — do NOT add a web-style requestPermission() flow here.
// On Linux, notifications go through libnotify; they work as long as a
// notification daemon is running (standard on any DE).

/**
 * Show a native desktop notification. Safe to call from the main process at
 * any time after `app.whenReady()`. No-ops if the platform reports that
 * notifications are not supported (unlikely in practice).
 */
export function showNotification(title: string, body?: string): void {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body: body ?? '' });
  n.show();
}

// ── Tray ─────────────────────────────────────────────────────────────────────

function createTray(): void {
  const iconPath = resolveAssetPath('tray-icon.png');
  if (!iconPath) {
    return;
  }

  // The source asset is 128×122 RGBA; passing it straight to Tray renders it
  // ~128pt tall in the macOS menu bar (#455). Resize to a menu-bar-appropriate
  // size, and on macOS mark it as a template image so it adopts the menu bar's
  // monochrome light/dark treatment. Follow-up polish: ship a dedicated
  // monochrome trayTemplate.png/@2x asset rather than recolouring this one.
  trayIcon = nativeImage.createFromPath(iconPath).resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE });
  if (process.platform === 'darwin') {
    trayIcon.setTemplateImage(true);
  }
  trayRecordingIcons = [1, 0.72, 0.42, 0.72].map((alpha) => createTrayIconVariant(trayIcon as NativeImage, alpha));
  tray = new Tray(trayIcon);

  const loginSettings = app.getLoginItemSettings();
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open OpenPalm', click: showWindow },
    { label: 'Show Logs', click: () => { void shell.openPath(app.getPath('logs')); } },
    { type: 'separator' },
    {
      // "Start at Login" checkbox — reads and writes Electron's cross-platform
      // login-item API (macOS LaunchAgent, Windows Run registry key).
      // Default OFF; the user's current setting drives the initial checked state.
      label: 'Start at Login',
      type: 'checkbox',
      checked: loginSettings.openAtLogin,
      click: (menuItem) => {
        app.setLoginItemSettings({ openAtLogin: menuItem.checked });
      },
    },
    // Developer convenience: prove that native notifications are wired up.
    // Remove this item (and the separator above it) once the first real
    // notification call-site is in place.
    {
      label: 'Test Notification',
      click: () => {
        showNotification('OpenPalm', 'Notifications are working.');
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        // Set isQuitting here so the window 'close' handler (which hides to
        // tray when !isQuitting) does not re-hide during teardown.
        // before-quit also sets this, but the tray handler fires before
        // before-quit, so the early set avoids a transient re-hide on macOS.
        (app as unknown as Record<string, unknown>).isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('OpenPalm');
  tray.setContextMenu(contextMenu);
  // NOTE: No tray.on('click', ...) handler — a plain tray-icon click should
  // NOT open/restore the window.  The window is always accessible via the
  // "Open OpenPalm" item in the context menu (right-click or left-click the
  // tray icon to see it, depending on the OS).  Removing the click handler
  // prevents the surprise "tray icon pops my window" behavior reported in #427.
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  initFileLogger();
  console.log(`OpenPalm starting (v${app.getVersion?.() ?? '?'}); logs at ${logFilePath()}`);
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

  await configureMediaPermissions();
  await createWindow();
  createTray();
  registerGlobalMicShortcut();

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

ipcMain.handle('set-tray-mic-recording', (_event, recording: boolean) => {
  setTrayMicRecording(recording);
});

// Request microphone access from the OS (macOS TCC). Called by the renderer
// when the user clicks the mic button — the OS only shows the permission dialog
// in response to a real user gesture, not at app startup.
ipcMain.handle('request-mic-permission', async (): Promise<string> => {
  return requestMicrophoneAccess();
});

let cleanupStarted = false;

// Guarded shutdown. `before-quit` is intentionally NOT async — Electron does
// not await async before-quit handlers: `event.preventDefault()` fires
// synchronously and the async continuation runs detached, so the original quit
// races ahead before cleanup finishes (root cause of the "quit twice" bug).
// Instead we:
//   1. preventDefault synchronously on the FIRST call (cleanupStarted=false).
//   2. Fire cleanup synchronously (stopUIServer SIGKILL, unregister shortcuts).
//   3. For the optional LocalOpenCode graceful stop, detach a best-effort
//      promise that calls app.quit() when done — the process exits either way
//      within the 500ms forceful timeout below.
//   4. As a safety net, schedule app.quit() 500ms out so a hung stop() can't
//      leave the app hanging (the user would have to force-quit).
//   5. The re-entrant call (cleanupStarted=true) does nothing — passes through
//      so Electron completes the quit.
app.on('before-quit', (event) => {
  (app as unknown as Record<string, unknown>).isQuitting = true;
  if (cleanupStarted) return;
  cleanupStarted = true;
  event.preventDefault();
  globalShortcut.unregisterAll();
  stopTrayRecordingAnimation();
  stopUIServer();
  const handle = localOpencode;
  localOpencode = null;
  // Safety net: if stop() hangs, force-quit after 500 ms.
  // Use app.exit(0), NOT app.quit() — calling app.quit() from within a
  // before-quit handler is re-entrant; Electron may silently no-op it on
  // some versions, leaving the app hanging. app.exit() exits the process
  // directly without re-firing before-quit.
  const forceQuitTimer = setTimeout(() => app.exit(0), 500);
  if (handle) {
    handle.stop()
      .catch((err: unknown) => {
        console.warn('Local OpenCode stop raised:', err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        clearTimeout(forceQuitTimer);
        app.exit(0);
      });
  } else {
    clearTimeout(forceQuitTimer);
    app.exit(0);
  }
});
