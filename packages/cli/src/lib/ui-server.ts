/**
 * UI host server — the SvelteKit adapter-node build that serves the
 * OpenPalm web UI + admin API. Runs as a host process (not a container)
 * starting in v0.11.0.
 *
 * The build artifact lives at packages/ui/build/ relative to the repo root
 * and is resolved at compile time.
 */
import { join, basename } from 'node:path';
import { existsSync } from 'node:fs';
import {
  resolveOpenPalmHome, resolveUiBuildDir, createLogger, readSecret, readStackEnv,
  applyHomeAssets,
  isRemoteSetupAllowed, isTrustedProxyEnabled, readyOrChildExit, UiSupervisor, waitForReady,
  checkExistingUiInstance, type UiInstanceCheck, checkPortAvailable,
  resolveHostUiPort, resolveUiListenEnv, UI_LOOPBACK_HOST, type UiListenEnv,
  buildEmptyUiRuntimeConfig, buildServedUiRuntimeConfig, classifyLocalInstall, stackDirFor,
  serializeUiRuntimeConfig, uiBuildSupportsProcessRuntimeConfig,
  writeLegacyServedUiRuntimeConfig, UI_RUNTIME_CONFIG_ENV,
  type ControlPlaneState, type UiRuntimeConfig,
} from '@openpalm/lib';
import { ensureValidState, resolveServeState } from './cli-state.ts';
import { openBrowser } from './browser.ts';
import { materializeEmbeddedSkeleton, materializeEmbeddedUi, seedSkeletonFromEmbedded } from './embedded-assets.ts';

const logger = createLogger('cli:ui');
const STOP_TIMEOUT_MS  = 5_000;

/**
 * Resolve the UI server's listen port: an explicit --port always wins;
 * otherwise persisted stack.env (OP_HOST_UI_PORT, written at headless
 * install — see manual-headless-install.md) merged under process.env
 * (process.env wins), falling back to the shared default. Before this (review
 * finding D3), the port default was computed from process.env ALONE at
 * module-load time, so a headless install's persisted OP_HOST_UI_PORT was
 * written but never read back by any host server.
 *
 * The precedence itself is lib's `resolveHostUiPort` — this wrapper exists only
 * to default `persistedEnv` to the home's stack.env, which lib cannot do
 * without taking a filesystem dependency.
 */
export function resolveUiServePort(
  portOpt: number | undefined,
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
  persistedEnv: Record<string, string> = readStackEnv(homeDir),
): number {
  return resolveHostUiPort(portOpt, env, persistedEnv);
}

/**
 * Open a URL and print an outcome that matches reality (C5) — `openBrowser`
 * can fail at runtime (no DISPLAY, no configured opener on a headless/SSH
 * host) even though spawning the opener succeeded, so this no longer claims
 * "Opening ... in your browser..." unconditionally regardless of what
 * actually happened.
 */
async function openBrowserAndReport(url: string): Promise<void> {
  if (await openBrowser(url)) {
    console.log(`Opened ${url} in your browser.`);
  } else {
    console.log(`Could not open a browser automatically. Open ${url} manually.`);
  }
}

/**
 * Installed admin launches open the host dashboard directly. A fresh admin
 * home stays at root so the UI's landing resolver can route to setup or
 * onboarding (see packages/ui/src/lib/resolve-landing.ts).
 */
export function resolveAdminUrl(
  uiUrl: string,
  adminHostUi: boolean,
  localInstallState: ReturnType<typeof classifyLocalInstall> = 'installed',
): string {
  return adminHostUi && localInstallState !== 'not_installed' ? `${uiUrl}/host` : uiUrl;
}

/**
 * Whether a freshly-spawned UI child of THIS invocation would report itself as
 * admin-capable at `/api/runtime` (`body.admin`). Used by
 * {@link checkExistingUiInstance} (D1) to detect when something else is already
 * answering on the target port with a DIFFERENT capability level.
 *
 * Admin capability is an Electron-or-CLI-only boundary — a single boolean, not
 * a mode matrix. In admin mode, {@link spawnUiChild}'s `adminEnv` ALWAYS forces
 * `OP_ENABLE_ADMIN=1` in the child regardless of inherited env, so the child is
 * unconditionally admin-capable. Otherwise `adminEnv` is `{}` — the child
 * inherits `env` (defaults to `process.env`) UNTOUCHED, and
 * packages/ui/src/lib/server/features.ts's `isAdminCapable()` honors
 * `OP_INSIDE_ELECTRON=1` / `OP_ENABLE_ADMIN=1` from that inherited env. F14: a
 * shell with `OP_ENABLE_ADMIN=1` set must make a legitimate non-admin reuse
 * expect admin=true (matching what the child reports), not a false 'mismatch'
 * that refuses to attach and exits(1).
 */
export function resolveExpectedAdmin(adminHostUi: boolean, env: NodeJS.ProcessEnv = process.env): boolean {
  if (adminHostUi) return true;
  return env.OP_INSIDE_ELECTRON === '1' || env.OP_ENABLE_ADMIN === '1';
}

/**
 * ONE loopback spelling for the browser-facing URL, regardless of mode.
 *
 * `openpalm` used to print `localhost` while `openpalm admin` and Electron
 * printed `127.0.0.1`, which split the cookie jar: a session established on
 * `localhost:3880` is simply not sent to `127.0.0.1:3880`, so switching
 * commands silently demanded a second login. Pinning the literal IP also avoids
 * the case where `localhost` resolves to `::1` while the listener — always
 * `HOST=127.0.0.1` — is IPv4-only.
 */
export function resolveUiLoopbackHost(): typeof UI_LOOPBACK_HOST {
  return UI_LOOPBACK_HOST;
}

export function resolveUiNetworkEnv(
  port: number,
  adminHostUi: boolean,
  env: Record<string, string | undefined> = process.env,
  // Fail closed: an omitted install state must never widen the bind to 0.0.0.0.
  // Only an explicit 'installed' (below) unlocks the remote-setup wildcard bind.
  localInstallState: ReturnType<typeof classifyLocalInstall> = 'not_installed',
): UiListenEnv {
  const effectiveAdmin = resolveExpectedAdmin(adminHostUi, env);
  return resolveUiListenEnv({
    port,
    admin: effectiveAdmin,
    allowRemote: localInstallState === 'installed' && isRemoteSetupAllowed(env),
    trustProxy: isTrustedProxyEnabled(env),
  });
}

export interface UIServerOptions {
  port?: number;
  open?: boolean;
  /** Allow the UI landing resolver to handle a not-yet-installed OP_HOME. */
  allowUninstalled?: boolean;
  /**
   * Admin mode (`openpalm admin`, plan Phase 1.5): enable the admin capability
   * in the spawned UI child (OP_ENABLE_ADMIN=1) and pin the bind to loopback
   * ALWAYS — OP_ALLOW_REMOTE_SETUP is ignored and neutralized in the child env,
   * so no non-loopback bind is possible in this mode (host admin is
   * never reachable remotely).
   */
  adminHostUi?: boolean;
}

// The instance-identity probe (review finding D1) and the readiness-vs-child-exit
// race now live in @openpalm/lib beside UiSupervisor, so Electron gets both
// instead of re-deriving them — it had neither, and opened its window onto
// whatever foreign server happened to own the port. Re-exported here because
// the CLI tests and commands import them from this module. Imported into scope
// (not `export … from`) because startUIServer below calls it directly.
export { checkExistingUiInstance, type UiInstanceCheck };

export function resolveUiChildLaunch(
  state: Pick<ControlPlaneState, 'homeDir' | 'stackDir'>,
  env: Record<string, string | undefined> = process.env,
): {
  config: UiRuntimeConfig;
  runtimeConfigJson: string;
  stacklessApp: boolean;
  installState: ReturnType<typeof classifyLocalInstall>;
} {
  const installState = classifyLocalInstall(state.stackDir, state.homeDir);
  const stacklessApp = installState === 'not_installed';
  const config = stacklessApp
    ? buildEmptyUiRuntimeConfig()
    : buildServedUiRuntimeConfig(state.homeDir, env);
  return { config, runtimeConfigJson: serializeUiRuntimeConfig(config), stacklessApp, installState };
}

/**
 * Materialize this binary's embedded UI build + skeleton (no network, no
 * backup/rollback — the embedded copy wins unconditionally once its stamp
 * differs from what's on disk), then resolve and spawn the SvelteKit Node
 * child.
 */
async function spawnUiChild(
  port: number,
  homeDir: string,
  state: ReturnType<typeof ensureValidState>,
  adminHostUi = false,
): Promise<{ proc: Bun.Subprocess }> {
  // Installation may complete while this long-lived supervisor is running.
  // Re-read it for every initial spawn rather than freezing it in
  // startUIServer.
  const { config, runtimeConfigJson, stacklessApp, installState } = resolveUiChildLaunch(state);
  // Materialize the embedded skeleton (managed system/ tree) before spawning.
  // Stackless (not-yet-installed) homes get the materialization WITHOUT the
  // apply: nothing to re-apply yet, but the wizard the child serves is about to
  // install, and its performSetup needs a skeleton source inside the child.
  //
  // applyHomeAssets and not the bare applyHomeSeed, for the same reason the
  // Electron harness uses it (see lib's applyHomeAssets): writing
  // `system/skills/` is half of shipping a skill, and the akm config that makes
  // the `:ro` /system-stash mount readable is pinned only by install/update. A
  // launch that seeds without the heal leaves the skills mounted and unindexed.
  const skeletonDir = stacklessApp
    ? await materializeEmbeddedSkeleton(state.dataDir)
    : await seedSkeletonFromEmbedded(() => applyHomeAssets(state), homeDir, state.dataDir);

  // Materialize the embedded UI build into data/ui BEFORE spawning, matching
  // the Electron harness's own bundled-build resolution. A no-op once data/ui
  // is already stamped with this binary's PLATFORM_VERSION.
  await materializeEmbeddedUi(state.dataDir);

  const uiBuildDir = resolveUiBuildDir();
  if (!existsSync(join(uiBuildDir, 'index.js'))) {
    console.error(`UI build not found at ${uiBuildDir}`);
    console.error('Run: bun run ui:build');
    process.exit(1);
  }

  // New builds read process-scoped config from /api/runtime-config. If a
  // nonfatal update left us on an older build, preserve that build's static
  // runtime-config contract instead of reviving a stale local connection.
  if (!uiBuildSupportsProcessRuntimeConfig(uiBuildDir)) {
    writeLegacyServedUiRuntimeConfig(uiBuildDir, config);
  }

  // OP_UI_LOGIN_PASSWORD is unset during first-run install — the SvelteKit
  // hooks detect that and redirect /* to /setup, where the wizard sets
  // it. Don't short-circuit here, or the install wizard can never come up.
  const uiLoginPassword =
    process.env.OP_UI_LOGIN_PASSWORD
      ?? readSecret(state.homeDir, 'op_ui_login_password')?.trimEnd()
      ?? '';

  console.log('Starting UI server...');
  // Spawn the UI child on THIS binary's embedded runtime (no system `node`
  // required): re-invoke `openpalm ui`, which imports the adapter-node build
  // in-process via runUiBuild(). Mirrors the Electron harness, which spawns its
  // UI child with Electron's own Node rather than a system one.
  //   compiled binary → [binary, 'ui']
  //   dev (bun src/main.ts) → [bun, <entry>, 'ui']
  const execName = basename(process.execPath).toLowerCase();
  const runningAsBun = execName === 'bun' || execName === 'bun.exe';
  const childArgs = runningAsBun ? [Bun.main, 'ui'] : ['ui'];
  const effectiveAdmin = resolveExpectedAdmin(adminHostUi);
  const networkEnv = resolveUiNetworkEnv(port, effectiveAdmin, process.env, installState);
  // Admin mode: enable the admin capability in the UI child and neutralize
  // OP_ALLOW_REMOTE_SETUP (spread in from process.env below) so neither the
  // respawned `openpalm ui` child nor the UI server's own remote-setup
  // relaxations (Host/Origin allowlist, setup gate) can re-derive a remote bind.
  const adminEnv = effectiveAdmin
    ? { OP_ENABLE_ADMIN: '1', OP_ALLOW_REMOTE_SETUP: '0' }
    : {};
  // A compiled binary's UI child must be able to seed the managed system/
  // tree itself — UI-driven install and update run performSetup/performUpgrade
  // INSIDE the child, where nothing embedded resolves. Point it at the
  // persistent materialized skeleton unless the operator already provided an
  // override (which `...process.env` below forwards as-is, and which
  // lib's resolveLocalOpenpalmDir would let win regardless via
  // OPENPALM_REPO_ROOT's higher precedence).
  const skeletonEnv = skeletonDir && !process.env.OPENPALM_SKELETON_DIR
    ? { OPENPALM_SKELETON_DIR: skeletonDir }
    : {};
  const proc = Bun.spawn(
    [process.execPath, ...childArgs],
    {
      cwd: uiBuildDir,
      env: {
        ...process.env,
        // Pass resolved absolute OP_HOME so the child doesn't re-resolve a
        // relative value (e.g. `.dev` from a repo-root .env) against its
        // own cwd (packages/ui/build/).
        OP_HOME:                homeDir,
        ...skeletonEnv,
        ...networkEnv,
        // Explicit "the listen contract is already resolved" marker, consumed by
        // runUiBuild below. It must be a marker WE set and not an inference from
        // HOST being present: an ambient HOST in the operator's shell is not
        // evidence that a supervisor derived the policy, and treating it as such
        // let `HOST=0.0.0.0` in the environment bind every interface without the
        // OP_ALLOW_REMOTE_SETUP opt-in.
        OP_UI_LISTEN_RESOLVED:  '1',
        ...adminEnv,
        OP_UI_LOGIN_PASSWORD:   uiLoginPassword,
        [UI_RUNTIME_CONFIG_ENV]: runtimeConfigJson,
      },
      stdout: 'inherit',
      stderr: 'inherit',
    }
  );
  return { proc };
}

/**
 * Run the SvelteKit adapter-node build in THIS process. Backs the `openpalm ui`
 * command: the supervisor (startUIServer) spawns `openpalm ui` as its killable/
 * respawnable child, and a user can run it directly to serve the UI standalone
 * (no auto-update). Importing the build runs it on the embedded Bun runtime, so
 * no system `node` is required. The adapter-node entry reads HOST/PORT/ORIGIN
 * from the environment and self-starts; the listening socket keeps us alive.
 */
export async function runUiBuild(opts: { port?: number } = {}): Promise<void> {
  const uiBuildDir = resolveUiBuildDir();
  const indexPath = join(uiBuildDir, 'index.js');
  if (!existsSync(indexPath)) {
    console.error(`UI build not found at ${uiBuildDir}`);
    console.error('Run: bun run ui:build');
    process.exit(1);
  }
  const homeDir = resolveOpenPalmHome();
  const port = opts.port
    ?? (process.env.PORT ? Number(process.env.PORT) : resolveUiServePort(undefined, homeDir));
  // Derive the listen env ONLY when nobody already did.
  //
  // `openpalm ui` runs both as the supervisor's child — where spawnUiChild has
  // already resolved HOST/ORIGIN and injected them — and standalone, where
  // nothing has. It used to recompute unconditionally and overwrite, so the
  // parent's carefully-derived values were dead on arrival and the same inputs
  // were read at two different times by two call sites that had to agree by
  // coincidence. Whoever is first now owns the answer.
  //
  // The test is our OWN marker, not `HOST` being set. Reading an ambient HOST as
  // proof that a supervisor configured the listener meant `HOST=0.0.0.0` from a
  // shell or process manager skipped this resolver entirely — including its
  // loopback default and its ORIGIN pin — so a bare `openpalm ui` published the
  // UI on every interface with no OP_ALLOW_REMOTE_SETUP opt-in and no origin
  // check. An env var an operator happens to export is not a capability grant.
  if (process.env.OP_UI_LISTEN_RESOLVED !== '1') {
    const installState = classifyLocalInstall(stackDirFor(homeDir), homeDir);
    const networkEnv = resolveUiNetworkEnv(port, resolveExpectedAdmin(false), process.env, installState);
    for (const [key, value] of Object.entries(networkEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  process.chdir(uiBuildDir);
  await import(indexPath);
}

/** Minimal Bun.Subprocess surface the CLI supervisor adapter drives (injectable for tests). */
export type CliChildProc = Pick<Bun.Subprocess, 'kill' | 'exited' | 'killed'>;

/** Injectable dependencies for {@link createCliUiSupervisor} (real process/fs/exit by default). */
export interface CliUiSupervisorDeps {
  /** UI-server port the readiness poll targets. */
  port: number;
  /** Hostname the readiness poll targets (defaults to IPv4 loopback). */
  host?: string;
  /** Spawn the UI child (materializes the embedded UI/skeleton, returns its handle). */
  spawnChild: () => Promise<{ proc: Bun.Subprocess }>;
  /** Readiness poll (defaults to the shared lib waitForReady). */
  waitForReadyFn?: (port: number) => Promise<boolean>;
  /** Process exit (defaults to process.exit) — the exit-based failure policy. */
  exit?: (code: number) => void;
  /** Force-kill grace window, ms (defaults to STOP_TIMEOUT_MS). */
  stopTimeoutMs?: number;
  /** Sleep for the stop race (defaults to a real setTimeout-backed delay). */
  sleep?: (ms: number) => Promise<void>;
  /** Stderr sink for the "did not become ready in time." line (defaults to console.error). */
  logError?: (...args: unknown[]) => void;
}

/**
 * Build the CLI's thin adapter over the shared {@link UiSupervisor}. The CLI
 * supplies the Bun.Subprocess spawn/kill strategy and its exit-based failure
 * policy (process.exit(1) on BOTH start- and restart-ready-failure); it has no
 * renderer, so onReloadRenderer is omitted. Exported (with injectable deps) so
 * the stop sequence and exit policy are testable without spawning real processes.
 *
 * @returns the supervisor plus the shared `stop` (reused by the signal-shutdown handler).
 */
export function createCliUiSupervisor(deps: CliUiSupervisorDeps): {
  supervisor: UiSupervisor<Bun.Subprocess>;
  stop: (proc: CliChildProc) => Promise<void>;
} {
  const { port, spawnChild } = deps;
  const baseWaitForReady = deps.waitForReadyFn
    ?? ((p: number) => waitForReady(p, undefined, { host: deps.host }));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const stopTimeoutMs = deps.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const logError = deps.logError ?? console.error;

  // Tracks the LAST spawned handle so waitForReadyFn (below) can race it (D1).
  let lastHandle: Bun.Subprocess | null = null;

  // Graceful-then-force stop of a Bun.Subprocess UI child: SIGTERM, race its
  // exit against the grace window, then SIGKILL only if it hasn't died. Shared by
  // the supervisor's restart path and the signal-shutdown handler.
  const stop = async (proc: CliChildProc): Promise<void> => {
    proc.kill('SIGTERM');
    await Promise.race([proc.exited, sleep(stopTimeoutMs)]);
    if (!proc.killed) proc.kill('SIGKILL');
  };

  // D1: race readiness against the just-spawned child's own exit (shared with
  // Electron via lib's readyOrChildExit). A bare port poll (200/401) can't tell
  // "our child is genuinely still starting" apart from "our child died
  // immediately (e.g. EADDRINUSE) and the poll happens to be hitting some
  // OTHER, unrelated process already on the port".
  const waitForReadyFn = (p: number): Promise<boolean> =>
    readyOrChildExit(() => baseWaitForReady(p), lastHandle?.exited);

  const supervisor = new UiSupervisor<Bun.Subprocess>({
    port,
    strategy: {
      spawn: async () => {
        const spawnResult = await spawnChild();
        lastHandle = spawnResult.proc;
        return spawnResult.proc;
      },
      stop,
    },
    callbacks: {
      waitForReady: waitForReadyFn,
      // Ready-timeout on first start → kill the child and exit non-zero (the lib
      // never exits; this policy hook does).
      onStartFailure: (proc) => {
        proc.kill('SIGTERM');
        // C4: name the port — a bare "did not become ready" left a port
        // conflict (foreign process on 3880, EADDRINUSE) with no clue what to
        // check next.
        logError(`UI server did not become ready in time (port ${port}).`);
        exit(1);
      },
    },
  });

  return { supervisor, stop };
}

/**
 * Start the UI host server. Blocks until shutdown (SIGINT/SIGTERM).
 * Exits the process on error.
 */
export async function startUIServer(opts: UIServerOptions = {}): Promise<void> {
  const homeDir = resolveOpenPalmHome();
  // NOTE: home migrations are NOT run here. They run once in the UI child, at
  // packages/ui/src/hooks.server.ts module load, which every serve path spawns —
  // so the migration ships with the schema it implements instead of being
  // duplicated across two launchers (one of which, the Electron harness, is
  // frozen and forbidden from running migrations at all).
  // D3: read back a persisted (headless-install) OP_HOST_UI_PORT, not just
  // process.env (resolveUiServePort merges persisted stack.env under process.env).
  const port = resolveUiServePort(opts.port, homeDir);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${port}`);
    process.exit(1);
  }

  // Admin mode and `openpalm app` may serve before installation; the full
  // UI's landing resolver owns setup/recovery routing in both cases.
  const state = (opts.adminHostUi === true || opts.allowUninstalled === true)
    ? resolveServeState()
    : ensureValidState();
  const localInstallState = classifyLocalInstall(state.stackDir, state.homeDir);
  const expectedAdmin = resolveExpectedAdmin(opts.adminHostUi === true);
  const browserHost = resolveUiLoopbackHost();
  // ONE loopback spelling for both the printed/browser URL and the identity
  // probe below — a second literal here is exactly the class of drift this
  // module's own comments (see resolveUiLoopbackHost) exist to prevent.
  const probeHost = browserHost;
  const uiUrl = `http://${browserHost}:${port}`;

  // D1: pre-spawn instance-identity probe. A bare port poll has no way to
  // tell an already-running OpenPalm instance of a DIFFERENT capability level
  // (e.g. a bare `openpalm` already on this port when `openpalm admin` runs)
  // apart from a match — reuse only on a genuine match, refuse with a clear
  // error otherwise, and never silently attach to the wrong capability level.
  const existing = await checkExistingUiInstance(port, expectedAdmin, { host: probeHost });
  if (existing.status === 'mismatch') {
    console.error(
      `A different OpenPalm UI instance (admin=${existing.admin}) is already listening ` +
      `on port ${port}, but this command expected admin=${expectedAdmin}. Refusing to ` +
      `attach — stop the other instance first, or set OP_HOST_UI_PORT to a different port and retry.`
    );
    process.exit(1);
  }

  // C4: nothing OpenPalm-shaped answered the identity probe above, but that
  // does not mean the port is free — a foreign process there makes the
  // instance probe read `absent` too, and previously the child would then be
  // spawned anyway, die of EADDRINUSE, and surface 60 seconds later as an
  // opaque "did not become ready" with no port mentioned. Check up front with
  // the same probe `doctor` already uses, and fail fast with an actionable
  // message naming the port and the real remedy.
  if (existing.status === 'absent' && !(await checkPortAvailable(port))) {
    console.error(
      `Port ${port} is already in use by another program (not an OpenPalm UI). ` +
      'Free it, or set OP_HOST_UI_PORT to a different port and retry.'
    );
    process.exit(1);
  }

  // Reuse (D1 'match'): something already running with the right capability
  // level answers this port — skip spawning a second child/client entirely,
  // just open the browser and return (nothing of ours to keep alive or shut
  // down; the OTHER process owns the lifecycle).
  if (existing.status === 'match') {
    // A3: the printed reuse-path URL must point at `/host` in admin mode too
    // (not just the browser-open call below) — mirrors the fix at the
    // non-reuse "UI server running at" log further down.
    console.log(
      `Reusing already-running UI server at ${resolveAdminUrl(uiUrl, opts.adminHostUi === true, localInstallState)} ` +
      `(admin=${existing.admin}).`
    );
    if (opts.open !== false) {
      await openBrowserAndReport(resolveAdminUrl(uiUrl, opts.adminHostUi === true, localInstallState));
    }
    return;
  }

  const { supervisor, stop: stopUiProc } = createCliUiSupervisor({
    port,
    host: probeHost,
    spawnChild: () => spawnUiChild(port, homeDir, state, opts.adminHostUi === true),
  });

  if (!await supervisor.start()) return; // onStartFailure already exited

  // A3: point the printed URL at `/host` in admin mode too — before this fix
  // only the browser-open call below (via resolveAdminUrl) honored
  // opts.adminHostUi; this log line still printed the root URL, which the
  // UI's own landing guard resolves to `/chat` on a healthy install.
  console.log(`UI server running at ${resolveAdminUrl(uiUrl, opts.adminHostUi === true, localInstallState)}`);

  if (opts.open !== false) {
    // `openpalm admin` opens `/host`; every other entry uses the full UI's
    // own landing resolver from the root URL.
    await openBrowserAndReport(resolveAdminUrl(uiUrl, opts.adminHostUi === true, localInstallState));
  }

  async function shutdown(signal: string): Promise<void> {
    console.log(`\nReceived ${signal}. Shutting down...`);
    try {
      const proc = supervisor.current;
      if (proc) await stopUiProc(proc);
      console.log('Shutdown complete.');
    } catch (err) {
      logger.error('Error during shutdown', { error: String(err) });
    }
    process.exit(0);
  }

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep the process alive
  await new Promise<never>(() => {});
}
