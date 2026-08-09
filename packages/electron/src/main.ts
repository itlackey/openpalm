import {
  app,
  BrowserWindow,
  shell,
  dialog,
  ipcMain,
  globalShortcut,
  Notification,
  type IpcMainInvokeEvent,
  type IpcMainEvent,
} from 'electron';
import { basename, dirname, join } from 'node:path';
import { existsSync, mkdirSync, statSync, renameSync, createWriteStream, type WriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';

import {
  resolveOpenPalmHome,
  resolveDataDir,
  resolveUiBuildDir,
  ensureHomeDirs,
  parseEnvFile,
  stackEnvFile,
  waitForReady as libWaitForReady,
  checkExistingUiInstance,
  readyOrChildExit,
  resolveUiListenEnv,
  resolveAssistantEndpoint,
  seedLegacyServedUiRuntimeConfig,
  applyHomeSeed,
  createState,
  readDeployJournal,
  resolveDeployJournalPath,
  type DeployProgress,
  UiSupervisor,
} from '@openpalm/lib';
import { UI_PORT } from './ui-port.js';
import { autoUpdater, CancellationToken } from 'electron-updater';
import { DesktopUpdater, isTrustedUpdaterSender, type UpdaterState } from './updater.js';
import { loadSettings, saveSettings } from './settings.js';
import { killProcessTree } from './process-tree.js';
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

// E6: this is an always-on tray app whose log tees the FULL stdout/stderr of
// every UI-server child launch — with no cap, main.log grows without bound for
// as long as the user keeps the app running (which, by design, is "forever").
// Rotate it once it crosses a generous size instead. One rotated generation
// (main.log.1) is enough for a "what just happened" log, not a full history —
// this is a crash/failure diagnostic tool, not an audit log.
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const LOG_ROTATION_CHECK_MS = 5 * 60 * 1000;

/** If the current log file is oversized, rotate it out to `main.log.1` and reopen a fresh stream. */
function rotateLogIfOversized(): void {
  try {
    const path = logFilePath();
    if (!existsSync(path) || statSync(path).size <= MAX_LOG_BYTES) return;
    const reopen = (): void => {
      try {
        renameSync(path, `${path}.1`);
      } catch { /* best-effort: a locked/missing file just keeps growing until the next check */ }
      logStream = createWriteStream(path, { flags: 'a' });
    };
    if (logStream) {
      // Close the current handle before renaming its target out from under it;
      // `reopen` runs once the pending writes have flushed.
      const current = logStream;
      logStream = null;
      current.end(reopen);
    } else {
      reopen();
    }
  } catch { /* best-effort: rotation must never crash the app */ }
}

function logFilePath(): string {
  return join(app.getPath('logs'), 'main.log');
}

function initFileLogger(): void {
  if (logStream) return;
  try {
    const logsDir = app.getPath('logs');
    mkdirSync(logsDir, { recursive: true });
    // A previous, unrotated session may have already left an oversized file.
    // If it HAD to rotate, `rotateLogIfOversized` already opened a fresh
    // `logStream` itself (its cold-path `reopen()` branch, taken because
    // `logStream` is still null here) — `??=` avoids clobbering that handle
    // with a second, un-tracked stream to the same path that would then leak
    // its fd for the process lifetime.
    rotateLogIfOversized();
    logStream ??= createWriteStream(logFilePath(), { flags: 'a' });

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

    // Re-check periodically while the app keeps running — an always-on tray
    // app can log for weeks without ever restarting to pick up the
    // startup-only check above. unref() so this timer never keeps the process
    // alive on its own.
    setInterval(rotateLogIfOversized, LOG_ROTATION_CHECK_MS).unref?.();
  } catch { /* best-effort: logging is non-fatal */ }
}

/** Write a raw chunk (UI child stdout/stderr) to the log file. */
function writeChildLog(text: string): void {
  try { logStream?.write(text); } catch { /* best-effort */ }
}

// The host UI port lives in ./ui-port.ts so permissions.ts reads the SAME value
// this file serves on — see that module's header for why a second resolution
// silenced the microphone on custom-port installs.

const READY_TIMEOUT_MS = 60_000;
// E4 review: the splash-closing watchdog for the MAIN WINDOW's own page load,
// distinct from READY_TIMEOUT_MS above (which bounds the UI SERVER CHILD
// coming up before the window is even created). Generous — a cold Electron
// window on a loaded machine can take a few seconds — but bounded, so a hung
// load can't spin the splash forever.
const MAIN_WINDOW_LOAD_TIMEOUT_MS = 20_000;
const MIC_SHORTCUT = 'CommandOrControl+Shift+M';
const APP_USER_MODEL_ID = 'com.openpalm.app';

let mainWindow: BrowserWindow | null = null;
let registeredMicShortcut: string | null = null;
// Whether the desktop updater tracks the beta channel (#504 opt-in, mapped onto
// electron-updater's `beta` channel by updaterChannel). Loaded from desktop
// settings at boot; toggled live from the tray.
let checkPrereleaseUpdates = false;
// Opt-in (review E3): Ctrl/Cmd+Shift+M is Teams' global mute/unmute chord.
// Registering it system-wide unconditionally on first launch silently took it
// away from every other app on the machine, with no setting and no prompt.
// Default OFF; loaded from desktop settings at boot, toggled live from the
// tray. openWindow() only calls registerGlobalMicShortcut() when this is true.
let micShortcutEnabled = false;
// First-close discoverability: whether the one-time "OpenPalm is still
// running" tray notice has already fired. Hide-to-tray silently rescues an
// ordinary window close, but gives no OTHER indication the app is still
// alive — a user who hasn't spotted the tray icon reads the close as "the app
// quit". Loaded from desktop settings at boot; latched true (and persisted)
// the first time notifyFirstHideToTray runs, so it fires at most once ever.
let hideToTrayNoticeShown = false;
// Full-application updater (#572). Null until the app is ready.
let desktopUpdater: DesktopUpdater | null = null;
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
export function buildUIServerEnv(homeDir: string, port: number): NodeJS.ProcessEnv {
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
    // The shared listen contract, not a hand-baked copy of it. The desktop app
    // is unconditionally an admin host UI, so it always lands in the same branch
    // — but "always lands there" is a property of the CALLER, and baking the
    // branch's OUTPUT here made it a second implementation that only agreed by
    // coincidence. That is the exact shape of every bug this subsystem's rework
    // was chasing: same home, two harnesses, two answers. Spreading the resolver
    // also clears HOST_HEADER/PROTOCOL_HEADER, so an inherited forwarded-header
    // setting cannot reach an admin child that must never honour one.
    ...resolveUiListenEnv({ port, admin: true, allowRemote: false }),
    OP_ALLOW_REMOTE_SETUP: '0',
    OP_INSIDE_ELECTRON: '1',
    OP_ELECTRON_VERSION: app.getVersion?.() ?? '',
    // Do NOT set the per-unit OP_*_VERSION vars here. Docker precedence is
    // shell-env > --env-file, so any value injected into the UI server's
    // process.env overrides the authoritative versions written to stack.env
    // (e.g. "dev" for local images, or a pinned "vX.Y.Z"). Forcing "latest"
    // here made every `docker compose config/pull` resolve `…:latest`/`voice:latest-*`
    // — and `latest`/`latest-*` are never published for prereleases, so the
    // deploy failed with "manifest unknown". The deploy reads the versions from
    // stack.env via --env-file; leave them untouched.
    // Deliberately NOT baking OP_OPENCODE_URL. Freezing the assistant URL at
    // launch made the child unable to tell a harness-generated value from an
    // operator override, so it resorted to reverse-engineering the URL's shape
    // (loopback host, matching old port, empty path) to decide whether to
    // discard it — and any change to how this side formatted the URL silently
    // broke that detection and stranded the proxy on a dead port. The child
    // resolves it lazily through the same lib resolver instead.
  };
  // Pass the bundled skeleton path so the UI server can refresh the registry
  // on startup without needing the source repo or a network download.
  const skeletonDir = resolveBundledSkeletonDir();
  if (skeletonDir) {
    env.OPENPALM_SKELETON_DIR = skeletonDir;
  }
  return env;
}

/** The skeleton electron-builder ships in extraResources, or null in dev. */
function resolveBundledSkeletonDir(): string | null {
  const dir = join(process.resourcesPath ?? '', 'openpalm-skeleton');
  return existsSync(dir) ? dir : null;
}

/**
 * Materialize this app version's OWN skeleton into OP_HOME before the UI starts.
 *
 * An app update replaces the shell and its bundled UI atomically, but OP_HOME
 * outlives it — so without this the new release would start against the managed
 * `system/` tree written by the OLD one (stale Compose files and managed
 * instructions) until the user happened to run a lifecycle apply. That is
 * exactly the mixed-release state this artifact model exists to prevent, and it
 * is what Electron's removed `checkAndUpdateSkeleton` used to cover.
 *
 * The CLI supervisor already does this before every spawn
 * (seedSkeletonFromEmbedded in packages/cli/src/lib/ui-server.ts); this is the
 * Electron half, sourcing the same tree from extraResources instead of an
 * embedded archive. applyHomeSeed overwrites the managed tree and leaves user
 * data alone, which is what keeps repeat launches at the same version cheap.
 *
 * Nonfatal: a failure here must not stop the app from starting, since the
 * previous release's tree is still serviceable.
 */
async function seedBundledSkeleton(homeDir: string): Promise<void> {
  const skeletonDir = resolveBundledSkeletonDir();
  if (!skeletonDir) return;
  const previous = process.env.OPENPALM_SKELETON_DIR;
  try {
    // applyHomeSeed resolves its source through the same lib resolver the child
    // uses; point it at the bundled copy for the duration of the call.
    process.env.OPENPALM_SKELETON_DIR = skeletonDir;
    await applyHomeSeed(homeDir);
  } catch (err) {
    console.warn(
      'Bundled skeleton seed failed (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    if (previous === undefined) delete process.env.OPENPALM_SKELETON_DIR;
    else process.env.OPENPALM_SKELETON_DIR = previous;
  }
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

/**
 * Group-kill the UI child's process group (SIGTERM then immediate SIGKILL) —
 * the one implementation of "how the UI child dies", shared between
 * `uiSupervisor`'s stop strategy (below) and stopUIServer's direct call, so
 * they can't drift into two different kill sequences. No graceful-drain wait:
 * the app is exiting, there is no window left to wait out, and a lingering
 * timer would not survive `app.exit()` anyway — unlike the CLI's
 * SIGTERM→race-a-timeout→SIGKILL, which has a real shutdown window to wait
 * inside. Exported (pure over its argument) so the kill sequence is testable
 * without spawning Electron or a real child process.
 */
export function stopUiChild(handle: ChildProcess | null): Promise<void> {
  if (handle?.pid) {
    killProcessTree(handle.pid, 'SIGTERM');
    killProcessTree(handle.pid, 'SIGKILL');
  }
  return Promise.resolve();
}

/**
 * Shared UI-child-handle holder (lib's `UiSupervisor`, added specifically for
 * this harness's `adopt()` path). This used to be a bare module-level
 * `uiProcess` variable, hand-rolled independently of the CLI's fully-adopted
 * supervisor (packages/cli/src/lib/ui-server.ts's `createCliUiSupervisor`).
 *
 * `start()` is deliberately never called here — Electron's INITIAL spawn is
 * bespoke in ways `start()` can't express: an identity probe BEFORE spawning
 * that decides whether to spawn at ALL (attach to an already-running
 * admin-capable instance instead of racing it for the port — the 'match'
 * branch in startUIServer, below), and its own error-dialog + `app.quit()`
 * failure handling in place of the CLI's `process.exit`. `adopt()` exists in
 * the shared class precisely for this "bespoke prelude, then hand the
 * resulting handle to the supervisor" shape. What IS shared here: this is the
 * ONE place that holds "the child we own, if any" (`adopt`/`current`,
 * replacing the bare variable) and the group-kill teardown strategy above, in
 * the exact shape the CLI's own supervisor adapter uses.
 */
const uiSupervisor = new UiSupervisor<ChildProcess | null>({
  port: UI_PORT,
  strategy: {
    // Never invoked — see the class comment above; spawning stays bespoke in
    // spawnUIServer. Throw rather than silently no-op if that ever changes
    // without updating this.
    spawn: () => {
      throw new Error('uiSupervisor.start() is unused by the Electron harness; see startUIServer.');
    },
    stop: stopUiChild,
  },
  callbacks: {
    // Also never invoked (start() isn't called) — startUIServer drives its own
    // readyOrChildExit call directly so it can race the freshly-spawned
    // child's own exit, which this single-argument shape can't express.
    waitForReady: (port) => waitForReady(port),
  },
});

/**
 * Whether the UI child's own 'error' handler (spawnUIServer, below) already
 * surfaced a specific failure dialog and called app.quit() for THIS launch
 * attempt. E4 review: an ENOENT-class spawn failure fires 'error' (async,
 * next tick) AND — because Node still emits 'exit' after 'error' for a spawn
 * that never started — makes readyOrChildExit's race resolve to `ready:
 * false` too, so the generic "did not respond in time" branch below used to
 * ALSO show a dialog and ALSO call app.quit(): two error dialogs stacked for
 * one failure. Reset per attempt at the top of startUIServer.
 */
let uiServerFailureReported = false;

async function startUIServer(): Promise<boolean> {
  uiServerFailureReported = false;
  const homeDir = resolveOpenPalmHome();
  const dataDir = resolveDataDir();

  // Ensure the runtime dir tree exists so the harness can write its pid file and
  // the UI child can boot. The harness does NOT seed or apply OP_HOME — that is
  // the UI's job (install/update → applyHome): overwrite the managed system/ tree
  // and seed the user/data trees once. Serving the UI never mutates OP_HOME, so
  // the harness only ensures dirs here. The UI child locates the bundled skeleton
  // via OPENPALM_SKELETON_DIR (set in buildUIServerEnv).
  ensureHomeDirs();

  // Refresh the managed system/ tree from THIS app version's bundled skeleton,
  // so an updated shell never serves the previous release's managed files.
  await seedBundledSkeleton(homeDir);

  // NOTE: home migrations are deliberately NOT run here. Anything that mutates
  // control-plane state or runs a migration belongs to the UI control plane.
  // The UI child runs them at startup instead — packages/ui/src/hooks.server.ts
  // — which covers this harness and the CLI supervisor with one owner.

  // app.getVersion() is the HARNESS marketing version — the only version this
  // harness's own self-update check (the DesktopUpdater below) cares about.
  const appVersion = app.getVersion();

  // Load the desktop-local prerelease opt-in (#504) so the update check below
  // knows whether to surface rc's. Notify-only — never changes install behaviour.
  // Also load the mic-shortcut opt-in (#E3) — openWindow()'s first call reads
  // this to decide whether to grab the global shortcut at all — and whether
  // the first-close tray notice has already fired on a previous run.
  const desktopSettings = loadSettings(dataDir);
  checkPrereleaseUpdates = desktopSettings.checkPrerelease;
  micShortcutEnabled = desktopSettings.micShortcutEnabled;
  hideToTrayNoticeShown = desktopSettings.hideToTrayNoticeShown;

  // Full-application updates (#572). The check is deliberately NOT awaited:
  // startup must not wait on the network, and an offline launch must be
  // indistinguishable from an online one. Silent, so a failed check leaves no
  // banner behind — only a user-initiated check reports errors.
  desktopUpdater = createDesktopUpdater(appVersion);
  void desktopUpdater.check({ silent: true });

  // The UI build is bundled at build time (electron-builder extraResources →
  // process.resourcesPath/ui-build); resolveUiBuildDir() resolves it directly.
  // There is no runtime download or update path — a newer UI ships in a newer
  // app release (electron-updater, #572).
  const uiBuildDir = resolveUiBuildDir();

  if (!existsSync(join(uiBuildDir, 'index.js'))) {
    console.error(`Bundled UI build not found at ${uiBuildDir}`);
    splash.close();
    dialog.showErrorBox(
      'OpenPalm failed to start',
      `The bundled UI build is missing at:\n${uiBuildDir}\n\nReinstall the app.`,
    );
    app.quit();
    return false;
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
    return false;
  }

  if (existing.status === 'absent') {
    spawnUIServer(uiBuildDir, homeDir);
  } else {
    // An admin-capable instance already owns the port — attach to it rather
    // than racing it for the socket. It owns its own lifecycle.
    console.log(`Reusing already-running admin UI server on port ${UI_PORT}.`);
  }

  // Lose to the child's own death instead of waiting out the full timeout while
  // an unrelated process on the port answers for it.
  const ready = await readyOrChildExit(
    () => waitForReady(UI_PORT),
    uiSupervisor.current ? once(uiSupervisor.current, 'exit') : undefined,
  );
  if (!ready) {
    // The child's own 'error' handler (spawnUIServer) already showed a
    // specific dialog (e.g. ENOENT) and called app.quit() for this exact
    // failure — Node still emits 'exit' after 'error' for a spawn that never
    // started, which is what made readyOrChildExit's race resolve `false`
    // here too. Showing a second, generic "did not respond in time" dialog on
    // top would be redundant and confusing (E4 review).
    if (uiServerFailureReported) return false;
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
    return false;
  }
  return true;
}

/**
 * Spawn the UI Node child against a resolved build dir. Factored out of
 * startUIServer for testability.
 */
function spawnUIServer(uiBuildDir: string, homeDir: string): void {
  seedLegacyServedUiRuntimeConfig(uiBuildDir, homeDir);

  // Spawn the UI Node server with Electron's OWN bundled Node (process.execPath
  // + ELECTRON_RUN_AS_NODE) rather than a bare `node` on PATH. Finder-launched
  // macOS apps don't get Homebrew/nvm on PATH, so `spawn('node', …)` failed
  // with ENOENT and silently hung the splash for 60s (#456). Using the bundled
  // runtime removes the system-Node dependency entirely.
  const child = spawn(process.execPath, [join(uiBuildDir, 'index.js')], {
    cwd: uiBuildDir,
    env: {
      ...buildUIServerEnv(homeDir, UI_PORT),
      ELECTRON_RUN_AS_NODE: '1',
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
  // Hand the handle to the shared supervisor (adopt(), not start() — see its
  // docblock above) so stopUIServer and the ready-check race below have a
  // single source for "the child we own, if any".
  uiSupervisor.adopt(child);

  // Tail UI server stdout to the parent stdout + log file.
  child.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    process.stdout.write(text);
    writeChildLog(text);
  });

  // Tail UI server stderr into the ring buffer, the parent stderr, and the log.
  child.stderr?.on('data', (chunk: Buffer) => {
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
  child.on('error', (err) => {
    console.error('UI server process error:', err.message);
    // Node still emits 'exit' after 'error' for a spawn that never started,
    // which would otherwise also trip the generic "did not respond in time"
    // dialog in startUIServer for the SAME failure (E4 review — two dialogs
    // for one cause). Mark it handled so that branch stands down.
    uiServerFailureReported = true;
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

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`UI server exited with code ${code}`);
    }
    uiSupervisor.adopt(null);
  });
}

/** Exported so tests can pin the adopt(child)→exit→adopt(null) lifecycle without spawning Electron. */
export function stopUIServer(): void {
  const handle = uiSupervisor.current;
  if (!handle) return;
  uiSupervisor.adopt(null);
  // stopUiChild's kill calls are synchronous (killProcessTree wraps
  // spawnSync/process.kill); the returned promise is already settled by the
  // time this call returns, so before-quit's synchronous-cleanup guarantee
  // (see its docblock) holds without awaiting it here.
  void stopUiChild(handle);
}

// ── Window management ────────────────────────────────────────────────────────

/**
 * The URL the window opens on: the UI root, which the server's own navigation
 * guard redirects to the resolved landing.
 *
 * This used to probe /api/runtime/landing from the MAIN process and hand the
 * window a pre-resolved path. That process has no cookie jar in common with the
 * window, so the probe could not carry the browser's "this profile has
 * connections" hint and had to read it off the session and forward it by hand —
 * a whole mechanism that existed only to work around asking the question from
 * the wrong process. Loading the root asks it from the WINDOW, where cookies
 * are attached natively, for the cost of one redirect.
 */
export function resolveInitialUrl(): string {
  return `http://127.0.0.1:${UI_PORT}`;
}

/**
 * Whether `url` may replace the current Electron window rather than being
 * deferred to the external system browser. SECURITY (review): a prior prefix check —
 * `url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')`
 * — admitted non-loopback hosts such as `http://127.0.0.1.evil.com`
 * (subdomain bypass) and `http://127.0.0.1@evil.com` (userinfo bypass),
 * either of which would open attacker content inside the trusted app's
 * in-app window instead of the external browser. Real URL parsing fixed
 * that: only http: URLs whose HOSTNAME is exactly `127.0.0.1` or `localhost`
 * are allowed — that parsing (not a string check) is what makes the
 * subdomain/userinfo bypasses above fail (`new URL(...).hostname` never
 * includes the userinfo, and a subdomain is a different, longer hostname).
 *
 * E2 follow-up (review): this used to accept ANY port on those two hosts, so
 * a link to some OTHER local service (another app's loopback port, a stray
 * dev server) would load INSIDE this trusted window — with preload.cjs and
 * window.openpalm attached — instead of being deferred to the external
 * browser like every other non-OpenPalm destination. Pinned to the app's
 * actual UI_PORT: this is the one port OpenPalm itself ever serves on.
 */
export function isAllowedInAppWindowUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return false;
  const port = parsed.port ? Number(parsed.port) : 80;
  return port === UI_PORT;
}

export function handleWindowOpen(window: BrowserWindow, url: string): { action: 'deny' } {
  if (isAllowedInAppWindowUrl(url)) {
    // isAllowedInAppWindowUrl admits both loopback aliases, but everything
    // that trusts the renderer afterwards — isOwnOriginUrl's will-navigate
    // guard, isTrustedRendererSender's IPC gate — is pinned to the exact
    // origin the app serves: 127.0.0.1. Loading a `localhost` URL as-is would
    // strand the window on a different origin where every in-page navigation
    // bounces to the external browser and every window.openpalm call is
    // rejected until restart. Normalize the hostname to the canonical trusted
    // origin; port, path, query and hash are preserved.
    const normalized = new URL(url);
    normalized.hostname = '127.0.0.1';
    void window.loadURL(normalized.toString());
    window.show();
    window.focus();
  } else {
    void shell.openExternal(url);
  }
  return { action: 'deny' };
}

/**
 * Whether `url` is the app's OWN served origin — the only content allowed to
 * navigate the main window's frame in place. E2 (HIGH, security): there were
 * zero `will-navigate` handlers anywhere in this app. `setWindowOpenHandler`
 * (handleWindowOpen, above) only governs POPUPS (window.open / target=_blank);
 * plain in-page navigation — an `<a>` with no target, `location.href`, a
 * `<meta http-equiv=refresh>`, or script-driven navigation from ANY content
 * that achieves script execution in the loaded page (including
 * assistant-rendered chat output) — is not gated by it at all. Without a
 * `will-navigate` handler, that navigation could take the main window itself
 * — preload.cjs and window.openpalm still attached — to an arbitrary origin.
 *
 * Deliberately narrower than isAllowedInAppWindowUrl: that function decides
 * where an explicit, user-initiated POPUP destination should go (in-window vs
 * external browser) and is never a dead end either way, so a slightly wider
 * allow-list there (both 127.0.0.1 and localhost) is safe. An in-place
 * navigation is different — it silently replaces what the user is looking
 * at — so it is held to the exact origin this app actually serves
 * (resolveInitialUrl only ever produces `http://127.0.0.1:${UI_PORT}` URLs).
 */
export function isOwnOriginUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port === String(UI_PORT);
}

/**
 * `will-navigate` handler body, factored out as a pure(-ish) function over an
 * injected `{ preventDefault }` so it's testable without a real Electron
 * navigation event. Own-origin navigation is left alone; everything else is
 * blocked in-window and handed to the external system browser instead —
 * mirroring how off-origin popups are already handled, but for navigation
 * that never went through a popup at all.
 */
export function handleWillNavigate(event: { preventDefault: () => void }, url: string): void {
  if (isOwnOriginUrl(url)) return;
  event.preventDefault();
  void shell.openExternal(url);
}

/** net::ERR_ABORTED — a navigation superseded by another (e.g. the user clicked
 * a second link before the first finished), not a real load failure. Chromium
 * fires `did-fail-load` for this constantly; treating it as fatal would pop
 * an error/watchdog reveal on totally routine navigation. */
const ERR_ABORTED = -3;

/**
 * Whether a `did-fail-load` event represents a genuine "the page has nothing
 * to show" failure worth reacting to (E4 review). Only a MAIN-FRAME failure
 * that isn't ERR_ABORTED qualifies: a subframe failing (e.g. an embedded
 * iframe) doesn't leave the shell itself blank, and ERR_ABORTED is routine
 * Chromium noise, not a dead server.
 */
export function isFatalMainFrameLoadFailure(isMainFrame: boolean, errorCode: number): boolean {
  return isMainFrame && errorCode !== ERR_ABORTED;
}

async function createWindow(): Promise<void> {
  const title = 'OpenPalm';
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

  const initialUrl = resolveInitialUrl();

  // E4 review: this used to be a fire-and-forget `window.loadURL(initialUrl)`
  // — no `await`, no `.catch`, and the splash's ONLY close trigger was
  // 'ready-to-show'. If the UI child died between passing /health (which
  // startUIServer already confirmed) and this navigation finishing — or the
  // load simply hung — 'ready-to-show' would never fire, and the always-on-top
  // splash spun forever on top of an invisible, unreachable window with no
  // exit but a force-quit. Three independent nets now close the splash and
  // reveal the (possibly errored) window instead of hanging: a rejected
  // loadURL promise, a fatal `did-fail-load`, and a fixed watchdog timeout in
  // case neither fires. `settled` makes the first of the three win.
  let settled = false;
  const revealWindow = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    splash.close();
    if (!window.isDestroyed()) window.show();
  };
  const watchdog = setTimeout(() => {
    console.error(`Main window did not finish loading ${initialUrl} within ${MAIN_WINDOW_LOAD_TIMEOUT_MS / 1000}s.`);
    revealWindow();
  }, MAIN_WINDOW_LOAD_TIMEOUT_MS);

  void window.loadURL(initialUrl).catch((err) => {
    console.error('Main window failed to load initial URL:', err instanceof Error ? err.message : String(err));
  });

  window.once('ready-to-show', revealWindow);

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isFatalMainFrameLoadFailure(isMainFrame, errorCode)) return;
    console.error(`Main window failed to load ${validatedURL}: ${errorDescription} (${errorCode})`);
    revealWindow();
  });

  // E2 review: plain in-page navigation (no popup involved) was completely
  // unguarded — see isOwnOriginUrl's docblock. Anything that isn't this app's
  // own served origin is diverted to the external browser instead of
  // silently replacing what's in the trusted window.
  window.webContents.on('will-navigate', (event, url) => {
    handleWillNavigate(event, url);
  });

  // Reuse the existing window for loopback links. Denying every popup prevents
  // Electron from creating a second BrowserWindow.
  window.webContents.setWindowOpenHandler(({ url }) => {
    return handleWindowOpen(window, url);
  });

  // Coming back to the app is the natural moment to notice a new release, but
  // focus fires constantly — DesktopUpdater throttles this to at most one check
  // an hour, and keeps it silent so an offline machine stays quiet (#572).
  window.on('focus', () => {
    void desktopUpdater?.checkOnFocus();
  });

  // Hide to tray instead of closing — but only where hiding is actually
  // reachable again afterward. E1 review: TrayController.create() can leave
  // no tray behind (missing icon asset, or a Linux desktop with no
  // StatusNotifier host to hold the icon); hiding to a tray that doesn't
  // exist strands the window with no way to reopen or quit short of a
  // process manager. Where there is no tray, closing the window IS quitting —
  // ordinary desktop-app semantics — and window-all-closed (below) follows
  // through with the actual app.quit().
  window.on('close', (event) => {
    if (!isQuitting && trayController.isActive()) {
      event.preventDefault();
      window.hide();
      notifyFirstHideToTray();
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

function unregisterGlobalMicShortcut(): void {
  if (!registeredMicShortcut) return;
  globalShortcut.unregister(registeredMicShortcut);
  registeredMicShortcut = null;
}

async function openWindow(): Promise<void> {
  await createWindow();
  // E3 review: this used to grab Ctrl/Cmd+Shift+M — Teams' global mute chord —
  // system-wide, unconditionally, on first window open, with no opt-out. Only
  // register it when the user has explicitly turned it on via the tray menu.
  if (micShortcutEnabled && !registeredMicShortcut) {
    registerGlobalMicShortcut();
  }
}

/** Tray "Global Mic Shortcut" toggle (#E3): persist, then (un)register live. */
function setMicShortcutEnabled(enabled: boolean): void {
  micShortcutEnabled = enabled;
  saveSettings(resolveDataDir(), { micShortcutEnabled: enabled });

  if (enabled) {
    if (!registeredMicShortcut) registerGlobalMicShortcut();
  } else {
    unregisterGlobalMicShortcut();
  }

  trayController.rebuildMenu();
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

// ── First-close discoverability ───────────────────────────────────────────────
// Hide-to-tray (E1) silently rescues an ordinary window close, but that alone
// looks EXACTLY like the app quit: the window is gone and nothing says
// otherwise. The tray icon is the only way back, and a user who hasn't
// noticed it has no way to tell "closed" from "still running in the
// background". A one-time notice on the FIRST hide closes that gap without
// nagging on every subsequent close.
export const HIDE_TO_TRAY_NOTICE_TITLE = 'OpenPalm is still running';
export const HIDE_TO_TRAY_NOTICE_BODY =
  'It moved to the system tray instead of closing. Click its icon to reopen, or use its menu to quit.';

/**
 * Show the one-time tray-discoverability notice and persist that it has fired
 * (settings.ts — same mechanism as checkPrerelease/micShortcutEnabled), so it
 * never repeats, even across restarts. No-op if it already has.
 */
function notifyFirstHideToTray(): void {
  if (hideToTrayNoticeShown) return;
  hideToTrayNoticeShown = true;
  saveSettings(resolveDataDir(), { hideToTrayNoticeShown: true });
  showNotification(HIDE_TO_TRAY_NOTICE_TITLE, HIDE_TO_TRAY_NOTICE_BODY);
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
    // Rebuild on the new channel: electron-updater resolves a feed per channel,
    // and a half-switched updater would keep answering from the old one.
    desktopUpdater = createDesktopUpdater(app.getVersion());
    const update = await desktopUpdater.check({ silent: true });
    // Rebuild the tray menu so the checkbox state (and any update label) refresh.
    trayController.rebuildMenu();
    if (enabled && update.status === 'available' && update.availableVersion) {
      showNotification(
        'OpenPalm update available',
        `OpenPalm ${update.availableVersion} is available to download.`,
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
    isMicShortcutEnabled: () => micShortcutEnabled,
    onToggleMicShortcut: (enabled) => { setMicShortcutEnabled(enabled); },
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

// ── Single instance (E1) ─────────────────────────────────────────────────────
// A second `openpalm` desktop launch used to attach to the FIRST instance's UI
// server (checkExistingUiInstance sees an admin UI already on the port and
// reuses it, by design) and open its own window onto it — two windows, one
// server. Quitting the first instance then SIGKILLs the shared UI server out
// from under the second instance's window, stranding it on a dead server with
// no recovery (only a relaunch fixes it). Electron's own single-instance lock
// closes this: the loser quits immediately and hands off to the primary
// instance instead of ever reaching startUIServer/spawnUIServer.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  // Another OpenPalm instance holds the lock and owns the UI server — this
  // process has nothing useful left to do. Do not proceed to whenReady/IPC
  // registration; just exit and let the primary instance's 'second-instance'
  // handler (below) bring its window forward.
  app.quit();
} else {
  app.on('second-instance', () => {
    // A user double-clicked the app (or Dock/taskbar icon) again while we
    // already hold the lock — surface the existing window instead of a
    // second one fighting the first for the same UI server.
    showWindow();
  });

  // ── App lifecycle ───────────────────────────────────────────────────────────

  app.whenReady().then(async () => {
    initFileLogger();
    app.setAppUserModelId?.(APP_USER_MODEL_ID);
    console.log(`OpenPalm starting (v${app.getVersion?.() ?? '?'}); logs at ${logFilePath()}`);
    splash.showStartup();
    let uiServerStarted: boolean;
    try {
      uiServerStarted = await startUIServer();
    } catch (err) {
      splash.close();
      console.error('Failed to start UI server:', err instanceof Error ? err.message : String(err));
      app.quit();
      return;
    }
    // startUIServer already surfaced an error dialog and called app.quit() on
    // every failure path (E4 review) — app.quit() is asynchronous (it runs
    // through before-quit/window-all-closed/will-quit before the process
    // actually exits), so without this check the continuation below used to
    // race ahead and open a window and tray over a UI server that never
    // started, rather than let the pending quit win.
    if (!uiServerStarted) return;

    configureMediaPermissions();
    await openWindow();
    createTray();
    startDeployCompletionWatch();

    app.on('activate', () => {
      // macOS: re-open window when dock icon is clicked
      if (BrowserWindow.getAllWindows().length === 0) void openWindow();
      else showWindow();
    });
  });

  app.on('window-all-closed', () => {
    // Keep running in tray — UNLESS there is no tray to keep running IN. The
    // window 'close' handler below only hides (rather than lets close proceed)
    // when trayController.isActive() — so window-all-closed only fires here
    // in the no-tray case (tray-icon asset missing, or the platform's tray
    // protocol refused creation, e.g. vanilla GNOME with no StatusNotifier
    // host). Without this, a Linux user closing the window would strand the UI
    // server running with no window and no tray icon — unreachable, and
    // unkillable short of a process manager (E1 review).
    if (!trayController.isActive()) {
      isQuitting = true;
      app.quit();
    }
  });
}

// ── Full-application updates (#572) ──────────────────────────────────────────
//
// One update operation for the desktop: consent to download a complete tested
// release, then install it on restart (or on the next ordinary quit). The
// updater instance owns all policy — see src/updater.ts.

/**
 * Build the updater over electron-updater's singleton `autoUpdater`, wiring
 * state changes through to the renderer so download progress is live rather
 * than polled.
 */
function createDesktopUpdater(appVersion: string): DesktopUpdater {
  // E6 review: this rebuilds a FRESH DesktopUpdater over the SAME singleton
  // `autoUpdater` every time the prerelease-channel toggle fires — without
  // disposing the outgoing instance first, its 'download-progress' /
  // 'update-downloaded' listeners stay registered on the singleton forever.
  // N toggles used to leave N sets of listeners, each still patching a
  // `this.state` no one reads anymore but still pushing through its own
  // (stale) onStateChange closure to whatever window was current at
  // construction time.
  // Review E3: dispose() also cancels the outgoing instance's in-flight
  // download. A 'downloaded' artifact already staged from the old channel is
  // deliberately dropped with the instance — acceptable by design: the user
  // just switched away from the channel it came from.
  desktopUpdater?.dispose();
  return new DesktopUpdater({
    updater: autoUpdater as unknown as ConstructorParameters<typeof DesktopUpdater>[0]['updater'],
    currentVersion: appVersion,
    platform: process.platform,
    isPackaged: app.isPackaged,
    portableExecutableFile: process.env.PORTABLE_EXECUTABLE_FILE,
    windowsInstallerPresent: existsSync(
      join(dirname(process.execPath), `Uninstall ${basename(process.execPath)}`),
    ),
    prerelease: checkPrereleaseUpdates,
    // Review E3: lets DesktopUpdater.dispose() cancel a download the OUTGOING
    // instance started on the shared singleton, so a channel toggle can't
    // leave the old channel's download running (and staging an artifact quit
    // would install).
    createCancellationToken: () => new CancellationToken(),
    onStateChange: (state) => {
      // The window may be closed-to-tray or already destroyed; a state push is
      // advisory, never a reason to throw inside the updater.
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updater-state', state);
      }
    },
  });
}

/**
 * Whether an IPC message came from THIS app's own trusted UI origin — not
 * merely "some page in our own window", but the EXACT scheme+host+port
 * OpenPalm itself serves on. Originally written for the updater IPC (which
 * can download and execute an installer) but now the one shared gate for
 * every privileged main-process action reachable from the renderer: login-item
 * persistence, native notifications, the mic-permission TCC prompt, tray
 * recording state, and app restart/relaunch (E2 review — these all used to
 * accept ANY sender, so off-origin content that achieved script execution in
 * the loaded page could toggle login-item persistence, forge OS
 * notifications, or pop the mic permission prompt).
 */
function isTrustedRendererSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  return isTrustedUpdaterSender(event.senderFrame?.url ?? '', UI_PORT);
}

/**
 * Throwing variant for `ipcMain.handle` (invoke) callbacks: Electron turns a
 * thrown error into a rejected promise on the renderer's `invoke()` call, so
 * the caller sees a failed action rather than a silent no-op it could mistake
 * for success.
 */
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!isTrustedRendererSender(event)) {
    throw new Error('IPC rejected: untrusted sender origin');
  }
}

function requireUpdater(event: IpcMainInvokeEvent): DesktopUpdater {
  assertTrustedSender(event);
  if (!desktopUpdater) throw new Error('Updater is not ready yet');
  return desktopUpdater;
}

ipcMain.handle('updater-state', (event): UpdaterState => requireUpdater(event).getState());

// Explicit, user-initiated check: reports why it failed, unlike the silent
// startup and focus checks.
ipcMain.handle('updater-check', async (event): Promise<UpdaterState> =>
  requireUpdater(event).check({ silent: false }));

// The consent step. Discovery never downloads; this is the only path that does.
ipcMain.handle('updater-download', async (event): Promise<UpdaterState> =>
  requireUpdater(event).download());

/**
 * Body of the renderer's quit-and-install request, exported for tests (review
 * E2). electron-updater's quitAndInstall() spawns the installer BEFORE its own
 * internal app.quit(), so the before-quit deploy guard used to fire only AFTER
 * the installer was already running — choosing "Keep Waiting" there cancelled
 * the quit but not the installer, leaving a half-updated app. Ask about an
 * in-progress deploy FIRST, before anything irreversible, and stand the
 * before-quit prompt down for the quit that follows a confirmation.
 */
export function handleQuitAndInstallRequest(updater: DesktopUpdater): boolean {
  // Nothing staged → quitAndInstall() below would refuse anyway; never prompt
  // about a deploy for a no-op.
  if (updater.getState().status !== 'downloaded') return false;
  if (shouldWarnBeforeQuitDuringDeploy(readCurrentDeployJournal())) {
    if (!confirmQuitDuringDeploy()) return false;
    deployQuitConfirmed = true;
  }
  // The confirmation covers exactly one installer launch. If the launch fails
  // (throw, or a false return without the internal app.quit()), un-latch so a
  // later quit during the still-running deploy warns again instead of
  // silently proceeding for the rest of the session.
  let launched = false;
  try {
    launched = updater.quitAndInstall();
  } finally {
    if (!launched) deployQuitConfirmed = false;
  }
  return launched;
}

ipcMain.handle('updater-quit-and-install', (event): boolean =>
  handleQuitAndInstallRequest(requireUpdater(event)));

ipcMain.handle('restart-app', (event) => {
  assertTrustedSender(event);
  app.relaunch();
  app.quit();
});

ipcMain.handle('open-local-app', async (event): Promise<void> => {
  assertTrustedSender(event);
  await openLocalApp();
});

ipcMain.handle('launch-on-login-status', (event): LaunchOnLoginStatus => {
  assertTrustedSender(event);
  return getLaunchOnLoginStatus();
});

ipcMain.handle('set-launch-on-login', (event, enabled: boolean): LaunchOnLoginStatus => {
  assertTrustedSender(event);
  return setLaunchOnLogin(!!enabled);
});

ipcMain.on('notify', (event, payload: { title?: string; body?: string } | null) => {
  // `ipcMain.on` is fire-and-forget (renderer uses `send`, not `invoke`), so
  // there is no promise to reject — silently drop untrusted senders instead
  // of throwing (an uncaught throw here would crash the whole main process,
  // not just fail one call).
  if (!isTrustedRendererSender(event)) return;
  const focusedWindow = mainWindow ?? BrowserWindow.getAllWindows()[0] ?? null;
  if (focusedWindow?.isFocused()) return;
  const title = payload?.title?.trim();
  if (!title) return;
  // E6 review: showNotification() already guards on Notification.isSupported()
  // before constructing one; this second call site (built before that helper
  // existed) had drifted to construct unconditionally.
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body: payload?.body ?? '' });
  notification.on('click', showWindow);
  notification.show();
});

ipcMain.handle('set-tray-mic-recording', (event, recording: boolean) => {
  assertTrustedSender(event);
  trayController.setMicRecording(recording);
});

// Request microphone access from the OS (macOS TCC). Called by the renderer
// when the user clicks the mic button — the OS only shows the permission dialog
// in response to a real user gesture, not at app startup.
ipcMain.handle('request-mic-permission', async (event): Promise<string> => {
  assertTrustedSender(event);
  return requestMicrophoneAccess();
});

// ── Deploy-in-progress quit guard & completion notify (E5) ──────────────────
//
// Quit used to SIGTERM+SIGKILL the UI server's whole process group
// immediately and unconditionally — killing an in-flight `docker compose`
// with zero warning, even though the deploy journal (the same one the setup
// wizard polls) already records whether one is running. Read it here instead
// of guessing, and warn before doing something destructive to it.
//
// Separately, DeployStep.svelte's wizard promises "You can leave this window —
// we'll let you know when it's ready", but no code path ever sent that
// notification (window.openpalm.notify is wired only to chat replies/errors).
// Rather than wait on a UI-side hook that doesn't exist, watch the SAME
// journal for the deploying→settled transition and notify from ground truth.

/**
 * Best-effort read of the current deploy journal for this OP_HOME. `null` on
 * any error (unresolved home, corrupt/missing journal) — both callers below
 * treat "couldn't read it" the same as "nothing to report", never a crash.
 */
function readCurrentDeployJournal(): DeployProgress | null {
  try {
    return readDeployJournal(resolveDeployJournalPath(createState()));
  } catch {
    return null;
  }
}

/**
 * Whether quitting right now should first warn that a deploy is still
 * running. Exported pure predicate over the journal shape alone so it's
 * testable without touching the filesystem or Electron.
 */
export function shouldWarnBeforeQuitDuringDeploy(journal: Pick<DeployProgress, 'deploying'> | null): boolean {
  return journal?.deploying === true;
}

export type DeployCompletionNotification = { title: string; body: string } | null;

/**
 * Decide whether transitioning from `previous` to `current` deploy-journal
 * snapshots warrants a "your backgrounded deploy is done" notification. Fires
 * exactly once per deploying→settled edge — a previous snapshot of `null`
 * (nothing observed yet, e.g. right after app launch) or a `current` that is
 * STILL deploying never notifies, only the transition does.
 */
export function deployCompletionNotification(
  previous: Pick<DeployProgress, 'deploying'> | null,
  current: Pick<DeployProgress, 'deploying' | 'deployError' | 'setupComplete'>,
): DeployCompletionNotification {
  if (!previous?.deploying || current.deploying) return null;
  if (current.deployError) {
    return { title: 'OpenPalm setup failed', body: current.deployError };
  }
  if (current.setupComplete) {
    return { title: 'OpenPalm is ready', body: "Setup finished — your assistant is ready to chat." };
  }
  return null;
}

const DEPLOY_JOURNAL_POLL_MS = 3_000;
let lastDeployJournalSnapshot: Pick<DeployProgress, 'deploying'> | null = null;
let deployCompletionWatchTimer: ReturnType<typeof setInterval> | null = null;

function pollDeployJournalForCompletion(): void {
  const journal = readCurrentDeployJournal();
  if (!journal) return;
  const decision = deployCompletionNotification(lastDeployJournalSnapshot, journal);
  // Only when the window isn't the thing the user is already looking at —
  // matching the same "don't notify what's already visible" rule the `notify`
  // IPC handler applies to chat replies.
  if (decision && !mainWindow?.isFocused()) {
    showNotification(decision.title, decision.body);
  }
  lastDeployJournalSnapshot = { deploying: journal.deploying };
}

/** Start watching the deploy journal for a backgrounded deploy's completion. Idempotent. */
function startDeployCompletionWatch(): void {
  if (deployCompletionWatchTimer) return;
  deployCompletionWatchTimer = setInterval(pollDeployJournalForCompletion, DEPLOY_JOURNAL_POLL_MS);
  deployCompletionWatchTimer.unref?.();
}

function stopDeployCompletionWatch(): void {
  if (!deployCompletionWatchTimer) return;
  clearInterval(deployCompletionWatchTimer);
  deployCompletionWatchTimer = null;
}

let cleanupStarted = false;

// Review E2: set by handleQuitAndInstallRequest once the user has ALREADY
// answered the deploy-in-progress warning there. electron-updater's
// quitAndInstall() fires its own app.quit() after spawning the installer, so
// prompting again in before-quit would be a double prompt — and its "Keep
// Waiting" could no longer undo the already-running installer.
let deployQuitConfirmed = false;

/**
 * Blocking deploy-in-progress confirmation. Synchronous by necessity —
 * before-quit cannot await an async dialog (see its docblock below);
 * dialog.showMessageBoxSync is Electron's sync-modal API for exactly this.
 * Shared between before-quit and the renderer's quit-and-install request
 * (review E2), which must ask BEFORE the installer spawns. Returns true when
 * quitting may proceed.
 */
function confirmQuitDuringDeploy(): boolean {
  const CANCEL_ID = 1;
  const dialogOptions = {
    type: 'warning' as const,
    title: 'Setup is still running',
    message: 'OpenPalm is still deploying your stack.',
    detail:
      'Quitting now stops the in-progress deploy mid-flight. Reopening the ' +
      'app will resume where it left off, but anything currently ' +
      'downloading or starting will be interrupted.',
    buttons: ['Quit Anyway', 'Keep Waiting'],
    defaultId: CANCEL_ID,
    cancelId: CANCEL_ID,
  };
  // Attach to the main window when it's still around so the warning reads
  // as modal rather than a floating dialog with no obvious owner.
  const choice =
    mainWindow && !mainWindow.isDestroyed()
      ? dialog.showMessageBoxSync(mainWindow, dialogOptions)
      : dialog.showMessageBoxSync(dialogOptions);
  return choice !== CANCEL_ID;
}

// Guarded shutdown. `before-quit` is intentionally NOT async — Electron does
// not await async before-quit handlers: `event.preventDefault()` fires
// synchronously and the async continuation runs detached, so the original quit
// races ahead before cleanup finishes (root cause of the "quit twice" bug).
//
// What actually happens, in order (this comment used to describe a five-step
// plan — detached graceful stop, 500ms safety net — that the code below has
// never implemented; corrected to match reality):
//   1. On the FIRST call (cleanupStarted=false): if a deploy is in progress
//      (per the journal), show a blocking confirmation. Choosing to wait
//      un-sets isQuitting, calls preventDefault, and returns — the quit never
//      proceeds, and a later quit attempt re-checks the journal from scratch.
//   2. Otherwise, preventDefault synchronously, then run cleanup SYNCHRONOUSLY
//      (stopUIServer SIGTERM+SIGKILLs the UI server's process group, shortcuts
//      are unregistered, the tray animation stops) and call app.exit(0)
//      directly — there is no detached async step and no timer here.
//   3. The re-entrant call (cleanupStarted=true) does nothing — passes through
//      so Electron completes the quit.
app.on('before-quit', (event) => {
  // Only the instance that holds the single-instance lock has a window, tray,
  // UI server or deploy to guard. The LOSING second instance quits via its own
  // app.quit() (see the lock branch above); without this gate it would pop the
  // blocking deploy-in-progress dialog below, and "Keep Waiting" would cancel
  // its quit into a permanent headless zombie — no window or tray code was
  // ever registered to reach it again.
  if (!gotSingleInstanceLock) return;
  isQuitting = true;
  if (cleanupStarted) return;

  // deployQuitConfirmed: the user already answered this exact warning in the
  // quit-and-install path (review E2) — asking again here would double-prompt
  // after the installer has already spawned. Consumed one-shot: the answer
  // covers only the quit the installer triggers, never a later unrelated one.
  const skipDeployWarning = deployQuitConfirmed;
  deployQuitConfirmed = false;
  if (!skipDeployWarning && shouldWarnBeforeQuitDuringDeploy(readCurrentDeployJournal())) {
    if (!confirmQuitDuringDeploy()) {
      isQuitting = false;
      event.preventDefault();
      // Review E4: in the no-tray case the window is already destroyed by the
      // time before-quit fires (close → window-all-closed → app.quit), so
      // cancelling the quit would otherwise leave the app running with NO
      // window and no tray — invisible and unreachable short of a process
      // manager. Reopen the window so "Keep Waiting" leaves a way back in.
      if (!mainWindow && !trayController.isActive()) {
        void openWindow();
      }
      return;
    }
  }

  cleanupStarted = true;
  event.preventDefault();
  globalShortcut.unregisterAll();
  trayController.stopAnimation();
  stopDeployCompletionWatch();
  stopUIServer();
  // A staged update installs now instead of silently waiting for the user to
  // notice "Restart and update". Best-effort: install() already catches
  // internally (see electron-updater's BaseUpdater), but nothing on this
  // shutdown path may throw its way past app.exit(0) below.
  try {
    desktopUpdater?.installOnQuit();
  } catch (err) {
    console.error(
      'Failed to install staged update on quit (non-fatal):',
      err instanceof Error ? err.message : String(err),
    );
  }
  // Use app.exit(0), NOT app.quit() — calling app.quit() from within a
  // before-quit handler is re-entrant; Electron may silently no-op it on some
  // versions, leaving the app hanging. app.exit() exits the process directly
  // without re-firing before-quit.
  app.exit(0);
});
