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
  PLATFORM_VERSION,
  checkDocker,
  checkDockerCompose,
} from '@openpalm/lib';
import { HARNESS_CONTRACT_VERSION } from './harness-contract.js';
import { checkForElectronUpdate, getCachedUpdateInfo, type UpdateInfo } from './update-check.js';
import { loadSettings, saveSettings } from './settings.js';
import { startLocalOpenCode, killProcessTree, type LocalOpencodeHandle } from './local-opencode.js';

export type LaunchOnLoginStatus = {
  supported: boolean;
  enabled: boolean;
};

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
const APP_USER_MODEL_ID = 'com.openpalm.app';

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
// Whether the GitHub update check should surface prereleases (#504). Loaded from
// desktop settings at boot; toggled live from the tray. Notify-only.
let checkPrereleaseUpdates = false;

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
  // Per-image tag keys get the same treatment as OP_IMAGE_TAG: shell-env
  // beats --env-file in docker compose, so leaking them here would override
  // the authoritative tags in stack.env during deploys.
  const skippedKeys = new Set([
    'OP_HOME',
    'OP_IMAGE_TAG',
    'OP_ASSISTANT_IMAGE_TAG',
    'OP_GUARDIAN_IMAGE_TAG',
    'OP_PORTAL_IMAGE_TAG',
  ]);
  for (const [k, v] of Object.entries(stackEnv)) {
    if (skippedKeys.has(k)) continue;
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
    // The native contract version this harness provides. The control plane
    // feature-detects against it (design §5.3): UI code introduced after
    // contract N guards on this value and falls back otherwise. This is a
    // genuinely harness-scoped value (it describes the native shell, not the
    // platform/control-plane version).
    OP_HARNESS_CONTRACT_VERSION: String(HARNESS_CONTRACT_VERSION),
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
      // Stamp the skeleton with the PLATFORM (control-plane) version, not the
      // harness's marketing version. The skeleton + control plane travel with
      // @openpalm/lib (PLATFORM_VERSION), so a platform release must re-seed
      // without looking like it needs a new app (design §5.2).
      await seedOpenPalmDir(PLATFORM_VERSION, homeDir, resolveConfigDir(), dataDir);
    } catch (err) {
      console.warn('Skeleton seed failed (non-fatal):', err instanceof Error ? err.message : String(err));
    }
  }

  // app.getVersion() is the HARNESS marketing version — use it ONLY for the
  // genuinely harness-scoped Electron self-update check (which polls GitHub
  // releases for a new app binary). The control-plane / UI channel must key on
  // the PLATFORM version that travels with @openpalm/lib (design §5.2), so a
  // platform release on the `next` channel pulls a `next` UI without the harness
  // marketing version having to be a prerelease.
  const appVersion = app.getVersion();
  const platformVersion = PLATFORM_VERSION;

  // Load the desktop-local prerelease opt-in (#504) so the update check below
  // knows whether to surface rc's. Notify-only — never changes install behaviour.
  checkPrereleaseUpdates = loadSettings(dataDir).checkPrerelease;

  // Check for a newer Electron app version on GitHub. Non-fatal; result is
  // surfaced to the UI as an env var so the in-app banner can offer a download.
  // When the user has opted into prereleases, this polls the full releases list
  // and filters to the newest matching their channel.
  const appUpdate = await checkForElectronUpdate(appVersion, checkPrereleaseUpdates);
  if (appUpdate.updateAvailable) {
    console.log(`App update available: v${appUpdate.latestVersion}`);
  } else if (appUpdate.error) {
    console.log(`App update check skipped: ${appUpdate.error}`);
  }

  // Check for a newer UI build on npm before starting. Non-fatal: if the check
  // or download fails, we continue with what's on disk. Pass this harness's
  // native contract version so a UI build that needs a newer harness is NOT
  // silently installed (§5.3) — instead we keep the current build and the app's
  // GitHub update check surfaces the "re-download required" prompt.
  const updateResult = await checkAndUpdateUiBuild(
    platformVersion,
    dataDir,
    undefined,
    HARNESS_CONTRACT_VERSION,
  );
  if (updateResult.updated) {
    console.log(`UI updated to v${updateResult.latestVersion}`);
  } else if (updateResult.redownloadRequired) {
    console.log(
      `UI build v${updateResult.latestVersion} needs OpenPalm app harness ` +
      `v${updateResult.requiredHarnessContract} (this app provides v${HARNESS_CONTRACT_VERSION}) — ` +
      `keeping the current UI; re-download the app to update.`,
    );
  } else if (updateResult.error) {
    console.log(`UI update check skipped: ${updateResult.error}`);
  }

  let uiBuildDir = resolveUiBuildDir();

  if (!existsSync(join(uiBuildDir, 'index.js'))) {
    console.log('UI build not found — seeding @openpalm/ui from npm...');
    try {
      // @openpalm/ui is independently versioned — seed the channel (latest/next)
      // for the PLATFORM release stream, not the harness marketing version.
      await seedUiBuild(uiUpdateChannel(platformVersion), dataDir);
      uiBuildDir = resolveUiBuildDir();
    } catch (err) {
      console.error('Failed to seed UI build:', err instanceof Error ? err.message : String(err));
      app.quit();
      return;
    }
  }

  const uiPidFile = join(dataDir, '.ui-server.pid');
  await killStaleUIServer(uiPidFile);

  spawnUIServer(uiBuildDir, homeDir, dataDir, uiPidFile, appUpdate);

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

/**
 * Spawn the UI Node child against a resolved build dir. Factored out of
 * startUIServer so the supervisor can respawn it after a UI-build update
 * (design §6.2) without re-running the GitHub update checks.
 */
function spawnUIServer(
  uiBuildDir: string,
  homeDir: string,
  dataDir: string,
  uiPidFile: string,
  appUpdate?: UpdateInfo | null,
): void {
  // Spawn the UI Node server with Electron's OWN bundled Node (process.execPath
  // + ELECTRON_RUN_AS_NODE) rather than a bare `node` on PATH. Finder-launched
  // macOS apps don't get Homebrew/nvm on PATH, so `spawn('node', …)` failed
  // with ENOENT and silently hung the splash for 60s (#456). Using the bundled
  // runtime removes the system-Node dependency entirely.
  uiProcess = spawn(process.execPath, [join(uiBuildDir, 'index.js')], {
    cwd: uiBuildDir,
    env: {
      ...buildUIServerEnv(homeDir, UI_PORT, appUpdate),
      ELECTRON_RUN_AS_NODE: '1',
      // Tell the UI child it has a supervisor that can respawn it on demand
      // (design §6.2). The admin "install UI version" route signals the
      // supervisor (this main process) after seeding a newer data/ui.
      OP_UI_SUPERVISOR: 'electron',
    },
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
    // During a supervisor-driven UI restart we intentionally kill + respawn the
    // child; don't null out the handle the restart path just reassigned.
    if (uiServerRestarting) return;
    if (code !== 0 && code !== null) {
      console.error(`UI server exited with code ${code}`);
    }
    uiProcess = null;
  });
}

// ── UI server restart (post UI-build update) ──────────────────────────────────
// The admin "install UI version" route seeds a newer data/ui, then signals this
// supervisor to respawn the UI child so the new @openpalm/lib (and its
// RELEASE_MIGRATIONS) loads without a full app relaunch (design §6.2). The
// downloaded build does nothing until the Node child is respawned.
let uiServerRestarting = false;

async function restartUIServer(): Promise<boolean> {
  if (uiServerRestarting) return false;
  uiServerRestarting = true;
  console.log('UI update detected — restarting UI server...');
  try {
    const homeDir = resolveOpenPalmHome();
    const dataDir = resolveDataDir();
    const uiPidFile = join(dataDir, '.ui-server.pid');

    // Kill the current child (group-kill: it runs detached and may have its own
    // children). Then re-resolve data/ui so a freshly seeded, strictly-newer
    // build wins, and respawn.
    const prev = uiProcess;
    uiProcess = null;
    if (prev?.pid) {
      killProcessTree(prev.pid, 'SIGTERM');
      await new Promise(r => setTimeout(r, 1500));
      killProcessTree(prev.pid, 'SIGKILL');
    }

    const uiBuildDir = resolveUiBuildDir();
    if (!existsSync(join(uiBuildDir, 'index.js'))) {
      console.error('UI restart aborted: build not found at', uiBuildDir);
      return false;
    }
    spawnUIServer(uiBuildDir, homeDir, dataDir, uiPidFile, getCachedUpdateInfo());

    const ready = await waitForReady(UI_PORT);
    if (!ready) {
      console.error('UI server did not become ready after restart.');
      return false;
    }
    console.log('UI server restarted.');
    return true;
  } catch (err) {
    console.error('UI server restart failed:', err instanceof Error ? err.message : String(err));
    return false;
  } finally {
    uiServerRestarting = false;
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

// ── Docker preflight ──────────────────────────────────────────────────────────
// The desktop app drives the assistant via Docker Compose (the UI server's admin
// routes shell out to `docker compose`). Without a running Docker daemon the
// first thing a brand-new user would otherwise hit is an opaque `503
// docker_unavailable` ~60s into the splash spinner (deployment-review P0 #493).
// Run the SAME checks the CLI's requireDocker() uses (lib's checkDocker /
// checkDockerCompose — never duplicate the logic) BEFORE starting the UI, and
// replace the spinner with a friendly, actionable screen if Docker is absent.

const GET_DOCKER_URL = 'https://docs.docker.com/get-docker/';

type DockerPreflightResult = { ok: true } | { ok: false; title: string; message: string };

/**
 * Mirror the CLI's `requireDocker()` (install.ts:135-138) using lib's shared
 * Docker probes. Returns a friendly title/message on failure so the harness can
 * render it; never throws.
 */
async function dockerPreflight(): Promise<DockerPreflightResult> {
  const docker = await checkDocker();
  if (!docker.ok) {
    return {
      ok: false,
      title: 'OpenPalm needs Docker Desktop',
      message:
        'OpenPalm runs your assistant in Docker, but Docker isn’t running. ' +
        'Install Docker Desktop (or start it if it’s already installed), then retry.',
    };
  }
  const compose = await checkDockerCompose();
  if (!compose.ok) {
    return {
      ok: false,
      title: 'Docker Compose v2 is required',
      message:
        'Docker is running, but Docker Compose v2 isn’t available. ' +
        'Update Docker Desktop (it bundles Compose v2), then retry.',
    };
  }
  return { ok: true };
}

let dockerRetryResolve: (() => void) | null = null;

/**
 * Replace the splash spinner with a friendly Docker-missing screen. The screen
 * offers an "Install Docker" button (opens the official install page in the
 * system browser) and an "I've installed it — retry" button that re-runs the
 * preflight. Resolves when the user clicks retry.
 */
function showDockerErrorScreen(result: { title: string; message: string }): Promise<void> {
  // Reuse the splash window if it's still open; otherwise create one. Either
  // way we replace its contents with the Docker-error UI (no spinner).
  if (!splashWindow || splashWindow.isDestroyed()) {
    const icon = resolveAssetPath('icon.png') ?? undefined;
    splashWindow = new BrowserWindow({
      width: 460,
      height: 320,
      frame: false,
      resizable: false,
      movable: true,
      alwaysOnTop: true,
      show: true,
      icon,
      backgroundColor: '#0f172a',
      webPreferences: { nodeIntegration: false, contextIsolation: true, preload: join(__dirname, 'preload.cjs') },
    });
    splashWindow.on('closed', () => { splashWindow = null; });
  } else {
    splashWindow.setSize(460, 320);
  }

  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{height:100%;margin:0;background:#0f172a;color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}
    body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:28px;box-sizing:border-box;text-align:center}
    .title{font-size:18px;font-weight:600}
    .msg{font-size:13px;line-height:1.5;color:#cbd5e1;max-width:380px}
    .row{display:flex;gap:10px;margin-top:6px}
    button{font:inherit;font-size:13px;padding:9px 16px;border-radius:8px;border:1px solid #334155;cursor:pointer}
    .primary{background:#2563eb;border-color:#2563eb;color:#fff}
    .secondary{background:#1e293b;color:#e2e8f0}
    button:hover{filter:brightness(1.1)}
  </style></head><body>
    <div class="title">${esc(result.title)}</div>
    <div class="msg">${esc(result.message)}</div>
    <div class="row">
      <button class="primary" id="install">Install Docker</button>
      <button class="secondary" id="retry">I’ve installed it — retry</button>
    </div>
    <script>
      const op = window.openpalm;
      document.getElementById('install').addEventListener('click', function(){ op && op.openDockerInstall(); });
      document.getElementById('retry').addEventListener('click', function(){
        var b=document.getElementById('retry'); b.textContent='Checking…'; b.disabled=true;
        op && op.retryDockerPreflight();
      });
    </script>
  </body></html>`;
  void splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  return new Promise<void>((resolve) => { dockerRetryResolve = resolve; });
}

/**
 * Block until Docker is available, showing the friendly install/retry screen
 * whenever the preflight fails. Returns once Docker (and Compose v2) are ready.
 */
export async function ensureDockerReady(): Promise<void> {
  // eslint-disable-next-line no-constant-condition
  for (;;) {
    const result = await dockerPreflight();
    if (result.ok) return;
    console.warn(`Docker preflight failed: ${result.message}`);
    await showDockerErrorScreen(result);
    // loop: user clicked retry — re-run the preflight.
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
// Returns the access status ('granted' | 'denied' | 'restricted' | 'unknown').
// On Windows/Linux the Electron permission handler above is sufficient; this
// is only a meaningful prompt on macOS (the OS ignores non-user-gesture calls).
//
// IMPORTANT (the 0.11.3 "OpenPalm never appears in the Microphone list" bug):
// askForMediaAccess() can resolve false WITHOUT macOS ever showing a prompt or
// registering the app under Privacy & Security → Microphone. That happens when
// the app's code signature has the Hardened Runtime flag but is missing the
// com.apple.security.device.audio-input entitlement — the runtime denies the
// request before TCC is consulted. The entitlement is shipped via
// assets/entitlements.mac.plist (see electron-builder.yml). We detect the
// "denied without prompt" signature here (status was not-determined, ask
// resolved false) and report it distinctly so the UI doesn't send the user to
// a Settings list the app isn't in.
async function requestMicrophoneAccess(): Promise<string> {
  if (process.platform !== 'darwin') return 'granted';
  try {
    const before = systemPreferences.getMediaAccessStatus('microphone');
    console.log('Microphone TCC status before request:', before);
    if (before === 'granted') return 'granted';
    if (before === 'denied' || before === 'restricted') {
      // The app IS registered with TCC but switched off (or MDM-restricted).
      // Open the exact Settings pane so "enable OpenPalm" is one click away.
      void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone');
      return before;
    }
    // not-determined → this ask should trigger the OS prompt.
    const granted = await systemPreferences.askForMediaAccess('microphone');
    const after = systemPreferences.getMediaAccessStatus('microphone');
    console.log('Microphone TCC status after request:', after, '(askForMediaAccess →', granted, ')');
    if (granted) return 'granted';
    // Denied with no prompt and still not-determined afterwards = the OS never
    // consulted TCC (entitlement/signature problem) — Settings won't list us,
    // so don't tell the user to flip a toggle that doesn't exist.
    if (after === 'not-determined') return 'denied-no-prompt';
    return 'denied';
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

export function supportsLaunchOnLogin(platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

export function getLaunchOnLoginStatus(platform = process.platform): LaunchOnLoginStatus {
  if (!supportsLaunchOnLogin(platform)) {
    return { supported: false, enabled: false };
  }

  return {
    supported: true,
    enabled: !!app.getLoginItemSettings().openAtLogin,
  };
}

export function setLaunchOnLogin(enabled: boolean, platform = process.platform): LaunchOnLoginStatus {
  if (!supportsLaunchOnLogin(platform)) {
    return { supported: false, enabled: false };
  }

  app.setLoginItemSettings({ openAtLogin: enabled });
  return getLaunchOnLoginStatus(platform);
}

// ── Prerelease update opt-in (#504) ───────────────────────────────────────────
// Toggle the desktop-local "check for prerelease versions" setting, persist it,
// re-run the GitHub update check in the new mode, rebuild the tray (so the menu
// reflects the new state and an update-available label can appear), and notify
// the user if a newer prerelease is now visible. Notify-only — no auto-install.
async function setCheckPrerelease(enabled: boolean): Promise<void> {
  checkPrereleaseUpdates = enabled;
  const dataDir = resolveDataDir();
  saveSettings(dataDir, { checkPrerelease: enabled });

  try {
    const appVersion = app.getVersion();
    const update = await checkForElectronUpdate(appVersion, enabled);
    // Rebuild the tray menu so the checkbox state (and any update label) refresh.
    rebuildTrayMenu();
    if (enabled && update.updateAvailable && update.latestVersion) {
      const kind = update.isPrerelease ? 'prerelease' : 'version';
      showNotification(
        `OpenPalm ${kind} available`,
        `OpenPalm ${update.latestVersion} is available to download.`,
      );
    }
  } catch (err) {
    console.warn(
      'Prerelease update re-check failed (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  }
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
  // Reuse an existing Tray (e.g. a menu rebuild after a settings toggle) so we
  // never leak a duplicate menu-bar icon or reset the recording animation.
  if (!tray) {
    tray = new Tray(trayIcon);
  }

  rebuildTrayMenu();

  tray.setToolTip('OpenPalm');
  // NOTE: No tray.on('click', ...) handler — a plain tray-icon click should
  // NOT open/restore the window.  The window is always accessible via the
  // "Open OpenPalm" item in the context menu (right-click or left-click the
  // tray icon to see it, depending on the OS).  Removing the click handler
  // prevents the surprise "tray icon pops my window" behavior reported in #427.
}

/** (Re)build the tray context menu from current settings/state. */
function rebuildTrayMenu(): void {
  if (!tray) return;
  const loginSettings = getLaunchOnLoginStatus();
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
      checked: loginSettings.enabled,
      enabled: loginSettings.supported,
      click: (menuItem) => {
        setLaunchOnLogin(menuItem.checked);
      },
    },
    {
      // "Check for prerelease versions" opt-in (#504). When on, the GitHub
      // update check surfaces rc's matching the user's channel. Notify-only —
      // it never auto-installs. Persisted to desktop settings and re-checked
      // immediately so the user gets feedback without restarting.
      label: 'Check for prerelease versions',
      type: 'checkbox',
      checked: checkPrereleaseUpdates,
      click: (menuItem) => {
        void setCheckPrerelease(menuItem.checked);
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

  tray.setContextMenu(contextMenu);
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  initFileLogger();
  app.setAppUserModelId?.(APP_USER_MODEL_ID);
  console.log(`OpenPalm starting (v${app.getVersion?.() ?? '?'}); logs at ${logFilePath()}`);
  createSplashWindow();
  // Fail early and legibly if Docker isn't running (deployment-review P0 #493).
  // Blocks (showing a friendly install/retry screen) until Docker + Compose v2
  // are available, so the user never hits the opaque 60s `503 docker_unavailable`.
  await ensureDockerReady();
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

// Restart only the UI server child (NOT the whole app) after a UI-build update
// (design §6.2). Respawns against the freshly seeded data/ui so the new
// control-plane lib loads. Returns true once the new child is ready.
ipcMain.handle('restart-ui-server', async (): Promise<boolean> => {
  return restartUIServer();
});

// The UI child (admin "install UI version" route) sends SIGUSR2 to this parent
// after seeding a newer data/ui. Same effect as the IPC path: respawn the UI
// server child so the new lib loads (design §6.2).
process.on('SIGUSR2', () => { void restartUIServer(); });

// Open the official Docker install page (Docker-missing preflight screen).
ipcMain.on('open-docker-install', () => {
  void shell.openExternal(GET_DOCKER_URL);
});

// The Docker-missing screen's "retry" button resolves the pending preflight
// promise so ensureDockerReady() re-runs checkDocker/checkDockerCompose.
ipcMain.on('retry-docker-preflight', () => {
  const resolve = dockerRetryResolve;
  dockerRetryResolve = null;
  resolve?.();
});

ipcMain.handle('launch-on-login-status', (): LaunchOnLoginStatus => {
  return getLaunchOnLoginStatus();
});

ipcMain.handle('set-launch-on-login', (_event, enabled: boolean): LaunchOnLoginStatus => {
  return setLaunchOnLogin(!!enabled);
});

ipcMain.on('notify', (_event, payload: { title?: string; body?: string } | null) => {
  const focusedWindow = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
  if (focusedWindow?.isFocused()) return;
  const title = payload?.title?.trim();
  if (!title) return;
  const notification = new Notification({ title, body: payload?.body ?? '' });
  notification.on('click', showWindow);
  notification.show();
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
