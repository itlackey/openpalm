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
  checkAndUpdateClientBuild, checkAndUpdateUiBuild, checkAndUpdateSkeleton, PLATFORM_VERSION,
  isRemoteSetupAllowed, restoreUiBackup, UiSupervisor, waitForReady,
} from '@openpalm/lib';
import { ensureValidState, resolveServeState } from './cli-state.ts';
import { openBrowser } from './browser.ts';
import { DEFAULT_UI_PORT } from './ports.ts';
import { startClientServer, resolveClientServeUrl } from './client-server.ts';

const logger = createLogger('cli:ui');
const STOP_TIMEOUT_MS  = 5_000;
const CLIENT_READY_TIMEOUT_MS = 5_000;
const CLIENT_READY_POLL_MS = 200;
/** Short probe timeout for the pre-spawn instance-identity check and the
 *  landing/setup-status probes below — these targets are on loopback and
 *  either answer near-instantly or aren't there at all. */
const PROBE_TIMEOUT_MS = 1_500;

/**
 * Resolve the UI server's listen port: an explicit --port always wins;
 * otherwise persisted stack.env (OP_HOST_UI_PORT, written at headless
 * install — see manual-headless-install.md) merged under process.env
 * (process.env wins), falling back to {@link DEFAULT_UI_PORT}. Before this
 * (review finding D3), the port default was computed from process.env ALONE
 * at module-load time, so a headless install's persisted OP_HOST_UI_PORT was
 * written but never read back by any host server.
 */
export function resolveUiServePort(
  portOpt: number | undefined,
  homeDir: string,
  env: NodeJS.ProcessEnv = process.env,
  persistedEnv: Record<string, string> = readStackEnv(homeDir),
): number {
  if (portOpt !== undefined) return portOpt;
  const merged = { ...persistedEnv, ...env };
  return Number(merged.OP_HOST_UI_PORT) || DEFAULT_UI_PORT;
}

/**
 * `openpalm admin` opens/prints the root URL, which the UI's own landing
 * guard resolves to `/chat` on a healthy install — not the admin dashboard
 * (review finding A3). When admin (host-ui) mode is active, both the printed
 * and opened URL should point at `/host` instead.
 */
export function resolveAdminUrl(uiUrl: string, adminHostUi: boolean): string {
  return adminHostUi ? `${uiUrl}/host` : uiUrl;
}

/**
 * The `OP_UI_HOST_MODE` a freshly-spawned UI child of THIS invocation would
 * report at `/api/runtime` (mirrors the adminEnv branch in {@link spawnUiChild}).
 * Used by {@link checkExistingUiInstance} (D1) to detect when something else
 * is already answering on the target port.
 */
export function resolveExpectedHostMode(adminHostUi: boolean): string {
  return adminHostUi ? 'host-ui' : 'pwa-static';
}

export interface UIServerOptions {
  port?: number;
  open?: boolean;
  openTarget?: 'ui' | 'client';
  /**
   * host-ui admin mode (`openpalm admin`, plan Phase 1.5): enable the admin
   * capability in the spawned UI child (OP_ENABLE_ADMIN=1 + OP_UI_HOST_MODE=
   * host-ui) and pin the bind to loopback ALWAYS — OP_ALLOW_REMOTE_SETUP is
   * ignored and neutralized in the child env, so no non-loopback bind is
   * possible in this mode (plan §8.3: host admin is never reachable remotely).
   */
  adminHostUi?: boolean;
}

export async function waitForClientApp(url: string, timeoutMs = CLIENT_READY_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return true;
    } catch {
      // Not ready yet.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, CLIENT_READY_POLL_MS));
  }
  return false;
}

/** Fetch and parse a JSON body; `null` on any failure (network error, non-2xx,
 *  non-JSON, timeout) — every caller below treats "couldn't confirm" the same
 *  as "not there", never as a hard failure. */
async function probeJson<T>(
  fetchFn: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<T | null> {
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Outcome of {@link checkExistingUiInstance}. */
export type UiInstanceCheck =
  | { status: 'absent' }
  | { status: 'match'; hostMode: string }
  | { status: 'mismatch'; hostMode: string };

/**
 * Pre-spawn instance-identity probe (review finding D1). Readiness was a bare
 * port poll (200 OR 401) with no check that whatever answered is even an
 * OpenPalm UI instance of the mode THIS invocation wants — with a bare
 * `openpalm` already on 3880, `openpalm admin` would poll-succeed, "reuse" it,
 * and open a UI with no admin capability while its own spawn attempt EADDRINUSEs
 * into a respawn loop.
 *
 * If port is silent → 'absent' (proceed with the normal spawn). If it answers
 * `/api/runtime` with the expected `hostMode` → 'match' (safe to treat as
 * already-running; skip spawning a second child). Any other hostMode →
 * 'mismatch' (a clear, actionable error — never a silent wrong-capability open).
 */
export async function checkExistingUiInstance(
  port: number,
  expectedHostMode: string,
  deps: { fetchFn?: typeof fetch; timeoutMs?: number } = {},
): Promise<UiInstanceCheck> {
  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const body = await probeJson<{ hostMode?: string }>(fetchFn, `http://127.0.0.1:${port}/api/runtime`, timeoutMs);
  if (body === null) return { status: 'absent' };
  const hostMode = body.hostMode ?? '';
  return hostMode === expectedHostMode ? { status: 'match', hostMode } : { status: 'mismatch', hostMode };
}

/** Result of {@link resolveClientOpenTarget}. */
export interface ClientOpenTargetResult {
  url: string;
  /** Set when falling back away from the client (never a hard failure — A4). */
  message?: string;
}

/** Injectable deps for {@link resolveClientOpenTarget} (real fetch/probe by default). */
export interface ClientOpenTargetDeps {
  fetchFn?: typeof fetch;
  /** Client reachability probe (defaults to {@link waitForClientApp} against clientUrl). */
  waitForClient?: () => Promise<boolean>;
  timeoutMs?: number;
}

/**
 * Resolve where `--open-target client` (`openpalm app`) should actually open
 * (review findings A4 + J1). Before this, an unreachable client app or an
 * interrupted install hard-exited(1) instead of falling back to the
 * voice-capable, setup-aware host UI.
 *
 * Probes the host UI's unauthenticated `GET /api/runtime/landing` (contract:
 * `200 { landing: string }`) first — a setup-incomplete/offline/broken install
 * routes through the SAME landing matrix Electron consults (J2), so `openpalm
 * app` stops being setup-unaware. If that route isn't deployed yet (404/absent
 * — the electron lane adds it in parallel), fall back to `GET
 * /api/setup/status` and land on `/setup` when incomplete. Only once the host
 * UI reports (or can't be asked and defaults to) a healthy `/chat` landing do
 * we attempt the client; if the client is unreachable, fall back to the host
 * UI chat with a clear message — NEVER `process.exit(1)` for this (A4).
 */
export async function resolveClientOpenTarget(
  uiUrl: string,
  clientUrl: string,
  hasClientHandle: boolean,
  deps: ClientOpenTargetDeps = {},
): Promise<ClientOpenTargetResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const waitForClient = deps.waitForClient ?? (() => waitForClientApp(clientUrl));

  const landing = await probeJson<{ landing?: string }>(fetchFn, `${uiUrl}/api/runtime/landing`, timeoutMs);
  if (landing !== null) {
    if (typeof landing.landing === 'string' && landing.landing !== '/chat') {
      return { url: `${uiUrl}${landing.landing}` };
    }
  } else {
    // /api/runtime/landing not deployed / not reachable — fall back to the
    // setup-status probe so an interrupted install still redirects (J1).
    const setup = await probeJson<{ setupComplete?: boolean }>(fetchFn, `${uiUrl}/api/setup/status`, timeoutMs);
    if (setup?.setupComplete === false) {
      return { url: `${uiUrl}/setup` };
    }
  }

  if (hasClientHandle && await waitForClient()) {
    return { url: clientUrl };
  }

  return {
    url: uiUrl,
    message:
      `Localhost client app is not reachable at ${clientUrl} — opening the host UI chat ` +
      `instead (${uiUrl}/chat).`,
  };
}

/**
 * Self-update the control plane (npm `@openpalm/ui` → data/ui) and skeleton
 * (npm `@openpalm/skeleton` → system/), then resolve and spawn the SvelteKit
 * Node child. Re-callable so a UI-build update can respawn the child against the
 * freshly downloaded data/ui without restarting the whole `openpalm ui serve`
 * supervisor (design §6.2).
 *
 * Non-fatal update: any network/registry error leaves the existing build/skeleton
 * in place. Resolution happens AFTER the update so a strictly-newer data/ui wins.
 * Returns the UI backup path so the supervisor can restore on restart failure (§4.4).
 */
async function spawnUiChild(
  port: number,
  homeDir: string,
  state: ReturnType<typeof ensureValidState>,
  adminHostUi = false,
): Promise<{ proc: Bun.Subprocess; uiBackupDir: string | undefined }> {
  // Hot-swap the skeleton (managed system/ tree) before spawning.
  console.log('Checking for skeleton update...');
  const skelResult = await checkAndUpdateSkeleton(PLATFORM_VERSION, homeDir, state.dataDir);
  if (skelResult.updated) {
    console.log(`Skeleton updated to v${skelResult.latestVersion}.`);
  } else if (skelResult.error) {
    console.warn(`Warning: skeleton update skipped — ${skelResult.error}. Existing skeleton still active.`);
  }

  // Self-update the control plane BEFORE spawning, matching the Electron harness
  // (main.ts: checkAndUpdateUiBuild before resolveUiBuildDir). `openpalm ui serve`
  // is a long-lived supervisor too, so without this the served UI/lib would only
  // ever update via the `openpalm update` command.
  console.log('Checking for UI build update...');
  const uiResult = await checkAndUpdateUiBuild(PLATFORM_VERSION, state.dataDir);
  if (uiResult.updated) {
    console.log(`UI build updated to v${uiResult.latestVersion}.`);
  } else if (uiResult.error) {
    console.warn(`Warning: UI build update skipped — ${uiResult.error}. Existing build still active.`);
  }

  // Resolve AFTER the update so a freshly downloaded, strictly-newer data/ui is
  // the build we spawn (resolveUiBuildDir re-reads data/ui's version stamp).
  const uiBuildDir = resolveUiBuildDir();
  if (!existsSync(join(uiBuildDir, 'index.js'))) {
    console.error(`UI build not found at ${uiBuildDir}`);
    console.error('Run: bun run ui:build');
    process.exit(1);
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
  // Default: bind loopback with a pinned ORIGIN. With OP_ALLOW_REMOTE_SETUP the
  // server binds all interfaces and lets adapter-node derive the origin from the
  // request Host header (HOST_HEADER), so it works under whatever LAN host/IP the
  // operator reaches it by. Admin (host-ui) mode is loopback ALWAYS: the
  // remote-setup escape hatch never applies to the host admin surface (§8.3).
  const remote = !adminHostUi && isRemoteSetupAllowed();
  const networkEnv = remote
    ? { HOST: '0.0.0.0', PORT: String(port), HOST_HEADER: 'host', PROTOCOL_HEADER: 'x-forwarded-proto' }
    : { HOST: '127.0.0.1', PORT: String(port), ORIGIN: `http://127.0.0.1:${port}` };
  // Admin (host-ui) mode: enable the admin capability in the UI child and
  // neutralize OP_ALLOW_REMOTE_SETUP (spread in from process.env below) so
  // neither the respawned `openpalm ui` child nor the UI server's own
  // remote-setup relaxations (Host/Origin allowlist, setup gate) can re-derive
  // a remote bind.
  const adminEnv = adminHostUi
    ? { OP_ENABLE_ADMIN: '1', OP_UI_HOST_MODE: 'host-ui', OP_ALLOW_REMOTE_SETUP: '0' }
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
        ...networkEnv,
        ...adminEnv,
        OP_UI_LOGIN_PASSWORD:   uiLoginPassword,
        // Tell the UI child it has a supervisor that can respawn it on demand
        // (design §6.2). The admin "install UI version" route signals SIGUSR2 to
        // its parent (this process) after seeding a newer data/ui.
        OP_UI_SUPERVISOR:       'cli',
      },
      stdout: 'inherit',
      stderr: 'inherit',
    }
  );
  return { proc, uiBackupDir: uiResult.backupDir };
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
  const port = opts.port
    ?? (process.env.PORT ? Number(process.env.PORT) : resolveUiServePort(undefined, resolveOpenPalmHome()));
  process.env.PORT = String(port);
  if (isRemoteSetupAllowed()) {
    // Bind all interfaces; let adapter-node derive the origin from the request
    // Host header rather than pinning it to loopback (do NOT set ORIGIN).
    process.env.HOST ??= '0.0.0.0';
    process.env.HOST_HEADER ??= 'host';
  } else {
    process.env.HOST ??= '127.0.0.1';
    process.env.ORIGIN ??= `http://127.0.0.1:${port}`;
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
  /** Spawn the UI child (self-updates data/ui, returns handle + backup path). */
  spawnChild: () => Promise<{ proc: Bun.Subprocess; uiBackupDir: string | undefined }>;
  /** Readiness poll (defaults to the shared lib waitForReady). */
  waitForReadyFn?: (port: number) => Promise<boolean>;
  /** Restore the previous data/ui after a post-restart ready-failure. */
  restoreBackup: (backupDir: string | undefined) => void;
  /** Process exit (defaults to process.exit) — the exit-based failure policy. */
  exit?: (code: number) => void;
  /** Structured restart-error logger (defaults to the cli:ui logger). */
  logRestartError?: (err: unknown) => void;
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
  const { port, spawnChild, restoreBackup } = deps;
  const baseWaitForReady = deps.waitForReadyFn ?? ((p: number) => waitForReady(p));
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const logRestartError = deps.logRestartError
    ?? ((err: unknown) => logger.error('Error restarting UI server', { error: String(err) }));
  const stopTimeoutMs = deps.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const logError = deps.logError ?? console.error;

  // Tracks the LAST spawn's backup path so a post-restart ready-failure restores
  // the build that just failed (spawnUiChild re-runs the update check on each
  // respawn, so this is reassigned per spawn — matching the pre-refactor flow).
  let lastUiBackupDir: string | undefined;
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

  // D1: race readiness against the just-spawned child's own exit. A bare port
  // poll (200/401) can't tell "our child is genuinely still starting" apart
  // from "our child died immediately (e.g. EADDRINUSE) and the poll happens
  // to be hitting some OTHER, unrelated process already on the port" — if the
  // child we just spawned exits before the poll would otherwise settle,
  // that's an immediate not-ready, not something worth waiting the full
  // timeout to discover.
  const waitForReadyFn = (p: number): Promise<boolean> => {
    const handle = lastHandle;
    if (!handle) return baseWaitForReady(p);
    return Promise.race([baseWaitForReady(p), handle.exited.then(() => false)]);
  };

  const supervisor = new UiSupervisor<Bun.Subprocess>({
    port,
    strategy: {
      spawn: async () => {
        const spawnResult = await spawnChild();
        lastUiBackupDir = spawnResult.uiBackupDir;
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
        logError('UI server did not become ready in time.');
        exit(1);
      },
      // Post-swap failure → restore the prior data/ui (§4.4 / §6) with a local
      // rename — no registry needed (shared lib routine)…
      restoreBackup: () => { restoreBackup(lastUiBackupDir); },
      // …then exit non-zero, as the pre-refactor CLI supervisor did.
      onRestartFailure: () => { exit(1); },
      onRestartError: logRestartError,
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
  // D3: read back a persisted (headless-install) OP_HOST_UI_PORT, not just
  // process.env — mirrors client-server.ts's stack.env merge.
  const port = resolveUiServePort(opts.port, homeDir);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    console.error(`Invalid port: ${port}`);
    process.exit(1);
  }

  // Admin (host-ui) mode serves even on a machine with no install — the UI's
  // existing setup guard lands on /setup (the CLI does not reimplement wizard
  // logic). The bare serve path keeps requiring a valid install.
  const state = opts.adminHostUi ? resolveServeState() : ensureValidState();
  const uiUrl = `http://localhost:${port}`;
  // D2: probe/open the client on the port it will ACTUALLY be spawned on
  // (persisted stack.env merged under process.env), not process.env alone.
  const clientUrl = resolveClientServeUrl();

  // D1: pre-spawn instance-identity probe. A bare port poll has no way to
  // tell an already-running OpenPalm instance of a DIFFERENT hostMode (e.g. a
  // bare `openpalm` already on this port when `openpalm admin` runs) apart
  // from a match — reuse only on a genuine match, refuse with a clear error
  // otherwise, and never silently attach to the wrong capability level.
  const expectedHostMode = resolveExpectedHostMode(opts.adminHostUi === true);
  const existing = await checkExistingUiInstance(port, expectedHostMode);
  if (existing.status === 'mismatch') {
    console.error(
      `A different OpenPalm UI instance (hostMode=${existing.hostMode}) is already listening ` +
      `on port ${port}, but this command expected hostMode=${expectedHostMode}. Refusing to ` +
      'attach — stop the other instance first, or choose a different --port.'
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
      `Reusing already-running UI server at ${resolveAdminUrl(uiUrl, opts.adminHostUi === true)} ` +
      `(hostMode=${existing.hostMode}).`
    );
    if (opts.open !== false) {
      if (opts.openTarget === 'client') {
        const target = await resolveClientOpenTarget(uiUrl, clientUrl, true);
        if (target.message) console.warn(target.message);
        await openBrowser(target.url);
      } else {
        await openBrowser(resolveAdminUrl(uiUrl, opts.adminHostUi === true));
      }
    }
    return;
  }

  const { supervisor, stop: stopUiProc } = createCliUiSupervisor({
    port,
    spawnChild: () => spawnUiChild(port, homeDir, state, opts.adminHostUi === true),
    restoreBackup: (backupDir) => restoreUiBackup(state.dataDir, backupDir),
  });

  if (!await supervisor.start()) return; // onStartFailure already exited

  // A3: point the printed URL at `/host` in admin mode too — before this fix
  // only the browser-open call below (via resolveAdminUrl) honored
  // opts.adminHostUi; this log line still printed the root URL, which the
  // UI's own landing guard resolves to `/chat` on a healthy install.
  console.log(`UI server running at ${resolveAdminUrl(uiUrl, opts.adminHostUi === true)}`);

  // Serve the @openpalm/client static app beside the UI on its stable loopback
  // port (P5c, #555; plan Phase 5 item 3). Both the default serve path and
  // `openpalm admin` come through here. Non-fatal: absent build → log + skip
  // (null handle), and the UI keeps serving.
  console.log('Checking for client app update...');
  const clientResult = await checkAndUpdateClientBuild(PLATFORM_VERSION, state.dataDir);
  if (clientResult.updated) {
    console.log(`Client app updated to v${clientResult.latestVersion}.`);
  } else if (clientResult.error) {
    console.warn(`Warning: client app update skipped — ${clientResult.error}. Existing build still active.`);
  }
  const clientHandle = await startClientServer();

  // D2 caution for future edits: "stop both children on every failure path"
  // is satisfied today only because there IS no failure path here anymore —
  // A4 removed the only early-return/exit(1) that used to orphan the UI child
  // after this point. If a future change reintroduces an early return (or a
  // process.exit) between here and the end of this function, it MUST also
  // tear down `stopUiProc`/`clientHandle` explicitly — don't assume this
  // block stays exit-free.
  if (opts.open !== false) {
    if (opts.openTarget === 'client') {
      // A4/J1: probe the host UI's landing (setup-incomplete/offline/broken →
      // its own recovery route) before honoring 'client'; an unreachable
      // client app falls back to the host UI chat with a message — NEVER
      // process.exit(1) (both children stay up and supervised either way).
      const target = await resolveClientOpenTarget(uiUrl, clientUrl, clientHandle !== null);
      if (target.message) console.warn(target.message);
      await openBrowser(target.url);
    } else {
      // A3: `openpalm admin` opens/prints `/host`, not the root (which the
      // landing guard resolves to `/chat`).
      await openBrowser(resolveAdminUrl(uiUrl, opts.adminHostUi === true));
    }
  }

  // Supervisor restart (§4.4): the UI child (admin "install UI version" route)
  // sends SIGUSR2/SIGHUP to this parent after seeding a newer data/ui. The
  // supervisor kills the current child and respawns against the freshly
  // downloaded build — the new @openpalm/lib only takes effect once the Node
  // child restarts (automatic, no "apply" click needed). On restart failure it
  // restores the backup and exits (§6).

  async function shutdown(signal: string): Promise<void> {
    supervisor.markShuttingDown();
    console.log(`\nReceived ${signal}. Shutting down...`);
    try {
      if (clientHandle) await clientHandle.stop();
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
  // SIGUSR2: sent by the UI child's admin/ui-version route after seeding a new build.
  // SIGHUP:  kept for backward compatibility / manual use.
  process.on('SIGUSR2', () => { void supervisor.restart(); });
  process.on('SIGHUP',  () => { void supervisor.restart(); });

  // Keep the process alive
  await new Promise<never>(() => {});
}
