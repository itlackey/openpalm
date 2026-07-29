import { app, BrowserWindow, shell, dialog, ipcMain, globalShortcut, Notification } from 'electron';
import { join, dirname } from 'node:path';
import { existsSync, mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

import {
  resolveOpenPalmHome,
  resolveDataDir,
  resolveUiBuildDir,
  seedUiBuild,
  ensureHomeDirs,
  checkAndUpdateUiBuild,
  checkAndUpdateSkeleton,
  parseEnvFile,
  stackEnvFile,
  PLATFORM_VERSION,
  waitForReady as libWaitForReady,
  checkExistingUiInstance,
  readyOrChildExit,
  resolveHostUiPort,
  consumePendingUiBackup,
  restoreUiBackup,
  UiSupervisor,
  resolveAssistantEndpoint,
  seedLegacyServedUiRuntimeConfig,
  hasMaterializedLocalInstall,
} from '@openpalm/lib';
import { HARNESS_CONTRACT_VERSION } from './harness-contract.js';
import { checkForElectronUpdate, getCachedUpdateInfo, type UpdateInfo } from './update-check.js';
import { loadSettings, saveSettings } from './settings.js';
import { startLocalOpenCode, killProcessTree, type LocalOpencodeHandle } from './local-opencode.js';
import { resolveAssetPath } from './assets.js';
import { SplashWindow } from './splash.js';
import { TrayController } from './tray.js';
import { configureMediaPermissions, requestMicrophoneAccess } from './permissions.js';
import {
  getLaunchOnLoginStatus,
  setLaunchOnLogin,
  supportsLaunchOnLogin,
  type LaunchOnLoginStatus,
} from './launch-on-login.js';

// Re-export the pure launch-on-login helpers so existing importers (and tests)
// keep resolving them from `main.ts` after the extraction.
export { getLaunchOnLoginStatus, setLaunchOnLogin, supportsLaunchOnLogin, type LaunchOnLoginStatus };

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
 */
function resolveAdminToolsPluginPath(): string {
  // Production: electron-builder copies to resources/admin-tools/index.js
  const packed = join(process.resourcesPath ?? '', 'admin-tools', 'index.js');
  if (existsSync(packed)) return packed;
  // Dev: __dirname is packages/electron/dist/ → sibling admin-tools/dist/
  const dev = join(__dirname, '..', 'admin-tools', 'dist', 'index.js');
  if (existsSync(dev)) return dev;
  throw new Error('Admin tools plugin is missing from both packaged resources and the workspace build');
}

// The host UI port, resolved through lib's network contract so this harness and
// the CLI cannot disagree. It previously read live env alone, ignoring the
// OP_HOST_UI_PORT a headless install persists to stack.env — so on the same home
// `openpalm` bound the persisted port while the desktop app bound 3880, and the
// mic-permission origin check keyed off Electron's wrong answer.
const UI_PORT = resolveHostUiPort(
  undefined,
  process.env,
  parseEnvFile(stackEnvFile(resolveOpenPalmHome())),
);

const READY_TIMEOUT_MS = 60_000;
const MIC_SHORTCUT = 'CommandOrControl+Shift+M';
const APP_USER_MODEL_ID = 'com.openpalm.app';

let mainWindow: BrowserWindow | null = null;
let uiProcess: ChildProcess | null = null;
let localOpencode: LocalOpencodeHandle | null = null;
let registeredMicShortcut: string | null = null;
// Whether the GitHub update check should surface prereleases (#504). Loaded from
// desktop settings at boot; toggled live from the tray. Notify-only.
let checkPrereleaseUpdates = false;
// True once the app is genuinely quitting (tray "Quit" or before-quit). The
// window 'close' handler consults it to hide-to-tray while false and let the
// close through while true. A typed module-scoped flag — the SSOT for quit
// state — replacing the prior `(app as any).isQuitting` cast that stuffed this
// onto the shared Electron app object.
let isQuitting = false;
// Owned handles for the extracted UI concerns.
const splash = new SplashWindow();
const trayController = new TrayController();

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
 * E1 fix: this used to re-derive its own precedence chain (env override,
 * else raw OP_ASSISTANT_BIND_ADDRESS/PORT from stack.env) and could produce
 * `http://0.0.0.0:3800` whenever the admin LAN-exposure toggle set
 * OP_ASSISTANT_BIND_ADDRESS=0.0.0.0 — a URL no browser can fetch. The CLI and
 * container entrypoint each had their own slightly different chain too
 * ("three divergent env/port resolution chains", review finding E1).
 * Delegate to the ONE shared resolver in @openpalm/lib instead, which merges
 * the persisted stack.env under process.env and ALWAYS normalizes a wildcard
 * bind host to 127.0.0.1 before returning.
 */
export function resolveAssistantUrl(homeDir: string): string {
  return resolveAssistantEndpoint(homeDir);
}

/**
 * Build the environment object to pass to the UI Node child process.
 * Exported as a pure function so tests can verify it without spawning anything.
 */
export function buildUIServerEnv(homeDir: string, port: number, update?: UpdateInfo | null): NodeJS.ProcessEnv {
  // Operator-managed stack config (state/stack.env) holds settings the
  // host UI server's own routes read from process.env — e.g. OP_VOICE_PORT_HOST,
  // which the /voice pass-through and the voice bring-up use to find the local
  // voice container. Merge stack.env BUT skip the per-unit
  // version vars: the docker-compose deploy path reads them via --env-file and
  // shell-env takes precedence over --env-file, so injecting them here would
  // override the authoritative versions (see the version-var note below).
  const stackEnv = parseEnvFile(stackEnvFile(homeDir));
  const stackForUi: NodeJS.ProcessEnv = {};
  // Per-unit version keys: shell-env beats --env-file in docker compose, so
  // leaking them here would override the authoritative versions in stack.env
  // during deploys.
  const skippedKeys = new Set([
    'OP_HOME',
    'OP_ASSISTANT_VERSION',
    'OP_GUARDIAN_VERSION',
    'OP_PORTAL_VERSION',
    'OP_VOICE_VERSION',
  ]);
  for (const [k, v] of Object.entries(stackEnv)) {
    if (skippedKeys.has(k)) continue;
    stackForUi[k] = v;
  }
  const env: NodeJS.ProcessEnv = {
    // Persisted stack.env UNDER live env: live-env-wins matches every other
    // resolver in the codebase (the UI's own startup promotion, lib's
    // resolveAssistantEndpoint, the CLI's port resolution). This spread was
    // inverted, so a value an operator exported before launching the desktop app
    // was silently clobbered by the file — while the identical launch through
    // `openpalm` honored it. Same home, two harnesses, opposite precedence.
    ...stackForUi,
    ...process.env,
    OP_HOME: homeDir,
    HOST: '127.0.0.1',
    PORT: String(port),
    ORIGIN: `http://127.0.0.1:${port}`,
    OP_ALLOW_REMOTE_SETUP: '0',
    OP_INSIDE_ELECTRON: '1',
    OP_ELECTRON_VERSION: app.getVersion?.() ?? '',
    // The native contract version this harness provides. The control plane
    // feature-detects against it (design §5.3): UI code introduced after
    // contract N guards on this value and falls back otherwise. This is a
    // genuinely harness-scoped value (it describes the native shell, not the
    // platform/control-plane version).
    OP_HARNESS_CONTRACT_VERSION: String(HARNESS_CONTRACT_VERSION),
    // Do NOT set the per-unit OP_*_VERSION vars here. Docker precedence is
    // shell-env > --env-file, so any value injected into the UI server's
    // process.env overrides the authoritative versions written to stack.env
    // (e.g. "dev" for local images, or a pinned "vX.Y.Z"). Forcing "latest"
    // here made every `docker compose config/pull` resolve `…:latest`/`voice:latest-*`
    // — and `latest`/`latest-*` are never published for prereleases, so the
    // deploy failed with "manifest unknown". The deploy reads the versions from
    // stack.env via --env-file; leave them untouched.
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
//
// There is deliberately no stale-pid sweep. It read `.ui-server.pid` and
// group-killed whatever process currently owned that pid, verifying only that
// the pid was alive — never that it was OUR server. After an unclean shutdown,
// or simply pid recycling on a busy machine, that pid can belong to an
// arbitrary user process, which every subsequent launch then SIGTERM/SIGKILLed
// along with its children. The identity probe in startUIServer supersedes it:
// an admin-capable OpenPalm UI on the port is attached to, anything else is
// reported, and nothing is killed on the strength of a recorded number.

/**
 * Poll the UI server's /health until ready. Thin re-export of the shared lib
 * supervisor primitive (SSOT); kept as an exported wrapper so the harness's own
 * READY_TIMEOUT_MS default applies and existing tests import it from here.
 */
export function waitForReady(port: number, timeoutMs = READY_TIMEOUT_MS): Promise<boolean> {
  return libWaitForReady(port, timeoutMs);
}

async function startUIServer(): Promise<void> {
  const homeDir = resolveOpenPalmHome();
  const dataDir = resolveDataDir();
  const localInstallWasMaterialized = hasMaterializedLocalInstall(homeDir);

  // Ensure the runtime dir tree exists so the harness can write its pid file and
  // the UI child can boot. The harness does NOT seed or apply OP_HOME — that is
  // the UI's job (install/update → applyHome): overwrite the managed system/ tree
  // and seed the user/data trees once. Serving the UI never mutates OP_HOME, so
  // the harness only ensures dirs here. The UI child locates the bundled skeleton
  // via OPENPALM_SKELETON_DIR (set in buildUIServerEnv).
  ensureHomeDirs();

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

  // A release refresh must not materialize core.compose.yml into an empty home:
  // that file means setup was user-started. Existing installs still refresh.
  if (localInstallWasMaterialized) {
    const skeletonResult = await checkAndUpdateSkeleton(platformVersion, homeDir, dataDir);
    if (skeletonResult.updated) {
      console.log(`Skeleton updated to v${skeletonResult.latestVersion}`);
    } else if (skeletonResult.error) {
      console.log(`Skeleton update check skipped: ${skeletonResult.error}`);
    }
  }

  // Check for a newer GitHub host-assets build before starting. Non-fatal: if the check
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

  // Stash the UI backup path so the supervisor can restore it if the new build
  // fails to start (§4.4 / §6). Cleared once the server confirms healthy.
  pendingUiBackupDir = updateResult.backupDir ?? null;

  let uiBuildDir = resolveUiBuildDir();

  if (!existsSync(join(uiBuildDir, 'index.js'))) {
    console.log('UI build not found — seeding the GitHub host-assets release...');
    try {
      // Fresh installs use the exact coordinated platform release, while the
      // bundled extraResources remain the offline fallback.
      // Thread this harness's contract version (§5.3) so a fresh install can't
      // silently seed a UI build this harness can't run (remediation 3.2) —
      // mirrors the checkAndUpdateUiBuild call above.
      await seedUiBuild(platformVersion, dataDir, undefined, HARNESS_CONTRACT_VERSION);
      uiBuildDir = resolveUiBuildDir();
    } catch (err) {
      console.error('Failed to seed UI build:', err instanceof Error ? err.message : String(err));
      app.quit();
      return;
    }
  }

  // Identity probe BEFORE spawning (shared with the CLI via lib). A bare
  // readiness poll cannot tell "our child is starting" from "our child died of
  // EADDRINUSE and something else owns the port": with a plain `openpalm`
  // already serving a non-admin UI on this port, the desktop app used to adopt
  // that foreign server and open its window onto a UI with no host capability,
  // /host silently redirecting to /chat. This replaces the pid-file kill, which
  // signalled whatever process currently held a recorded pid — after an unclean
  // shutdown and pid reuse, that could be any user process.
  const existing = await checkExistingUiInstance(UI_PORT, true);
  if (existing.status === 'mismatch') {
    splash.close();
    dialog.showErrorBox(
      'OpenPalm is already running',
      [
        `Another OpenPalm UI (admin=${existing.admin}) is already listening on port ${UI_PORT}.`,
        '',
        'The desktop app needs an admin-capable UI on that port. Stop the other',
        'instance (e.g. the `openpalm` you started in a terminal) and reopen this app.',
      ].join('\n'),
    );
    app.quit();
    return;
  }

  if (existing.status === 'absent') {
    spawnUIServer(uiBuildDir, homeDir, appUpdate);
    // Hand the bespoke initial child to the shared supervisor so a later
    // SIGUSR2/IPC restart knows which handle to stop (§6.2).
    if (uiProcess) uiSupervisor.adopt(uiProcess);
  } else {
    // An admin-capable instance already owns the port — attach to it rather
    // than racing it for the socket. It owns its own lifecycle.
    console.log(`Reusing already-running admin UI server on port ${UI_PORT}.`);
  }

  // Lose to the child's own death instead of waiting out the full timeout while
  // an unrelated process on the port answers for it.
  const ready = await readyOrChildExit(
    () => waitForReady(UI_PORT),
    uiProcess ? once(uiProcess, 'exit') : undefined,
  );
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
    splash.close();
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
  appUpdate?: UpdateInfo | null,
): void {
  seedLegacyServedUiRuntimeConfig(uiBuildDir, homeDir);

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
    splash.close();
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
    // child; don't null out the handle the restart path just reassigned. The
    // UiSupervisor owns the single restart guard — consult it directly rather
    // than mirroring it into a module-local flag.
    if (uiSupervisor.isRestarting) return;
    if (code !== 0 && code !== null) {
      console.error(`UI server exited with code ${code}`);
    }
    uiProcess = null;
    // Keep the supervisor's handle in sync: this child died UNSUPERVISED, so a
    // later restart must NOT stop() a dead handle (pid-reuse hazard + a needless
    // 1.5s SIGTERM→SIGKILL wait). Matches the pre-refactor `prev = uiProcess`
    // (null) → skip-kill behavior.
    uiSupervisor.detachHandle();
  });
}

// ── UI server restart (post UI-build update) ──────────────────────────────────
// The admin "install UI version" route seeds a newer data/ui, then signals this
// supervisor to respawn the UI child so the new @openpalm/lib loads without a
// full app relaunch (design §6.2). The downloaded build does nothing until the
// Node child is respawned.

/**
 * Marker thrown by the restart spawn strategy when the seeded build vanished.
 * The strategy logs the exact "UI restart aborted: build not found at …"
 * message itself; this marker just tells onRestartError to skip its generic
 * "restart failed" log. restart() still returns false and the app stays up.
 */
class UiRestartAbortError extends Error {}

// Backup of the previous data/ui set by checkAndUpdateUiBuild; used by the
// supervisor to restore on startup failure (§4.4 / §6). Null = no backup available.
let pendingUiBackupDir: string | null = null;
// The backup captured (and consumed) at the start of the in-flight restart — the
// UiSupervisor's restoreBackup hook reads it on a post-restart ready-failure.
let restartBackupDir: string | null = null;

// Thin Electron adapter over the shared UiSupervisor state machine (design §6.2 /
// §4.4). The bespoke INITIAL start (seed-or-quit + splash + stderr ring-buffer +
// dialog) stays in startUIServer, which then adopt()s the spawned child; the
// supervisor owns the RESTART state machine (kill → respawn → wait → restore /
// reload). Every harness-scoped effect is an adapter closure: the Node
// child_process + killProcessTree spawn/kill strategy, the renderer reload, and
// the restart-failure policy (Electron stays up — onRestartFailure is omitted).
const uiSupervisor = new UiSupervisor<ChildProcess>({
  port: UI_PORT,
  strategy: {
    // Respawn against the freshly-seeded data/ui (restart path). Aborts if the
    // build vanished — the throw routes to onRestartError, so restart() returns
    // false and the app stays up, matching the pre-refactor `return false` guard.
    spawn: () => {
      const homeDir = resolveOpenPalmHome();
      const uiBuildDir = resolveUiBuildDir();
      if (!existsSync(join(uiBuildDir, 'index.js'))) {
        // Log the EXACT pre-refactor message on stderr, then throw a marker the
        // catch path recognizes so it does NOT re-log a generic "restart failed".
        console.error('UI restart aborted: build not found at', uiBuildDir);
        throw new UiRestartAbortError();
      }
      spawnUIServer(uiBuildDir, homeDir, getCachedUpdateInfo());
      if (!uiProcess) throw new Error('UI server failed to spawn');
      return uiProcess;
    },
    // Group-kill the current child (it runs detached and may have its own
    // children, e.g. the wizard's `opencode serve`): SIGTERM → fixed 1.5s delay
    // → SIGKILL.
    stop: async (handle) => {
      uiProcess = null;
      if (handle.pid) {
        killProcessTree(handle.pid, 'SIGTERM');
        await new Promise(r => setTimeout(r, 1500));
        killProcessTree(handle.pid, 'SIGKILL');
      }
    },
  },
  callbacks: {
    waitForReady: (p) => waitForReady(p),
    // Consume the pending backup at the START of every restart, exactly-once and
    // UNCONDITIONALLY — before the conditional stop(). This must NOT live in
    // stop(): after an unsupervised crash the handle is detached (null) so stop()
    // is skipped, but the pending backup must still be captured so a failed
    // respawn restores the correct build (mirrors the pre-refactor capture-then-
    // clear at restartUIServer's top).
    beforeRestart: () => {
      restartBackupDir = consumePendingUiBackup(resolveDataDir()) ?? pendingUiBackupDir;
      pendingUiBackupDir = null;
    },
    // Post-swap failure → restore the prior data/ui with a local rename — no
    // registry needed (shared lib routine). onRestartFailure is omitted, so the
    // app stays running and restart() returns false (Electron never exits here).
    restoreBackup: () => { restoreUiBackup(resolveDataDir(), restartBackupDir); },
    // Reload the renderer onto the freshly-restarted control plane. Respawning the
    // server child is not enough on its own: the window keeps showing the OLD
    // build's page (and its stale "control plane vX" / cached state), so an update
    // looks like it did nothing. Load the root so the launch guard re-routes
    // (→ /splash to apply a pending home update, then onward; → /chat when healthy).
    // Covers both restart triggers: the IPC path and the SIGUSR2 supervisor path.
    onReloadRenderer: () => {
      const win = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
      if (win && !win.isDestroyed()) {
        void win.loadURL(`http://127.0.0.1:${UI_PORT}/`);
      }
    },
    onRestartError: (err) => {
      // The build-not-found abort already logged its exact message in spawn();
      // don't double-log a generic failure for it.
      if (err instanceof UiRestartAbortError) return;
      console.error('UI server restart failed:', err instanceof Error ? err.message : String(err));
    },
  },
});

// SIGUSR2/IPC restart trigger. Delegates to the shared supervisor, which owns
// the single restart guard: its `restarting` flag both no-ops re-entrant
// triggers (re-entrant calls return false) and gates the UI child's 'exit'
// handler (via uiSupervisor.isRestarting) so an intentional kill/respawn does
// NOT null out the handle the restart path just reassigned.
function restartUIServer(): Promise<boolean> {
  return uiSupervisor.restart();
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
}

// ── Window management ────────────────────────────────────────────────────────

/**
 * Resolve the canonical UI landing page. On probe failure, load the UI root so
 * its own navigation guard can perform the same landing decision.
 */
export async function resolveInitialUrl(): Promise<string> {
  try {
    const res = await fetch(`http://127.0.0.1:${UI_PORT}/api/runtime/landing`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json() as { landing?: string };
      const landing = data.landing ?? '/chat';
      return `http://127.0.0.1:${UI_PORT}${landing}`;
    }
  } catch {
    // ignore; fall through to root
  }
  return `http://127.0.0.1:${UI_PORT}`;
}

/**
 * Whether `url` may replace the current Electron window rather than being
 * deferred to the external system browser. SECURITY (review): a prior prefix check —
 * `url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')`
 * — admitted non-loopback hosts such as `http://127.0.0.1.evil.com`
 * (subdomain bypass) and `http://127.0.0.1@evil.com` (userinfo bypass),
 * either of which would open attacker content inside the trusted app's
 * in-app window instead of the external browser. Real URL parsing: only
 * http: URLs whose HOSTNAME is exactly `127.0.0.1` or `localhost` (any port)
 * are allowed.
 */
export function isAllowedInAppWindowUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
}

export function handleWindowOpen(window: BrowserWindow, url: string): { action: 'deny' } {
  if (isAllowedInAppWindowUrl(url)) {
    void window.loadURL(url);
    window.show();
    window.focus();
  } else {
    void shell.openExternal(url);
  }
  return { action: 'deny' };
}

async function createWindow(): Promise<void> {
  const update = getCachedUpdateInfo();
  const title = update?.updateAvailable
    ? `OpenPalm — Update available (v${update.latestVersion})`
    : 'OpenPalm';
  const icon = resolveAssetPath('icon.png') ?? undefined;

  const window = new BrowserWindow({
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
  mainWindow = window;

  const initialUrl = await resolveInitialUrl();
  window.loadURL(initialUrl);

  window.once('ready-to-show', () => {
    splash.close();
    window.show();
  });

  // Reuse the existing window for loopback links. Denying every popup prevents
  // Electron from creating a second BrowserWindow.
  window.webContents.setWindowOpenHandler(({ url }) => {
    return handleWindowOpen(window, url);
  });

  // Hide to tray instead of closing
  window.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      window.hide();
    }
  });

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
}

function showWindow(): void {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  } else {
    void openWindow();
  }
}

/** Compatibility alias that opens the canonical UI chat in the system browser. */
export async function openLocalApp(): Promise<void> {
  void shell.openExternal(`http://127.0.0.1:${UI_PORT}/chat`);
}

// ── Global mic shortcut ───────────────────────────────────────────────────────

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

async function openWindow(): Promise<void> {
  await createWindow();
  if (!registeredMicShortcut) {
    registerGlobalMicShortcut();
  }
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
    trayController.rebuildMenu();
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

/** Wire the tray context-menu callbacks to the app's window/settings actions. */
function createTray(): void {
  trayController.create({
    onOpen: showWindow,
    onOpenChatInBrowser: () => { void openLocalApp(); },
    // A2: always-available path to the host admin dashboard.
    onOpenAdmin: () => { void shell.openExternal(`http://127.0.0.1:${UI_PORT}/host`); },
    onShowLogs: () => { void shell.openPath(app.getPath('logs')); },
    getLaunchOnLoginStatus: () => getLaunchOnLoginStatus(),
    onSetLaunchOnLogin: (enabled) => { setLaunchOnLogin(enabled); },
    isPrereleaseEnabled: () => checkPrereleaseUpdates,
    onTogglePrerelease: (enabled) => { void setCheckPrerelease(enabled); },
    onQuit: () => {
      // Set isQuitting here so the window 'close' handler (which hides to
      // tray when !isQuitting) does not re-hide during teardown.
      // before-quit also sets this, but the tray handler fires before
      // before-quit, so the early set avoids a transient re-hide on macOS.
      isQuitting = true;
      app.quit();
    },
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  initFileLogger();
  app.setAppUserModelId?.(APP_USER_MODEL_ID);
  console.log(`OpenPalm starting (v${app.getVersion?.() ?? '?'}); logs at ${logFilePath()}`);
  splash.showStartup();
  try {
    await startUIServer();
  } catch (err) {
    splash.close();
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

  configureMediaPermissions();
  await openWindow();
  createTray();

  app.on('activate', () => {
    // macOS: re-open window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) void openWindow();
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

ipcMain.handle('open-local-app', async (): Promise<void> => {
  await openLocalApp();
});

// The UI child (admin "install UI version" route) sends SIGUSR2 to this parent
// after seeding a newer data/ui. Same effect as the IPC path: respawn the UI
// server child so the new lib loads (design §6.2).
process.on('SIGUSR2', () => { void restartUIServer(); });

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
  trayController.setMicRecording(recording);
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
  isQuitting = true;
  if (cleanupStarted) return;
  cleanupStarted = true;
  event.preventDefault();
  globalShortcut.unregisterAll();
  trayController.stopAnimation();
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
