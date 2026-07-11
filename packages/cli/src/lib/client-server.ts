/**
 * Client app static server — spawns and supervises the @openpalm/client
 * zero-dependency serve script (bin/serve.mjs) from the RESOLVED client build
 * on a stable loopback port (plan ui-runtime-modes-plan.md Phase 5 item 3,
 * #555). Runs beside the UI child under the same `openpalm` / `openpalm admin`
 * supervisor process.
 *
 * Policy pins (see client-server.test.ts — the tests are the contract):
 *   - Loopback-only ALWAYS: HOST is 127.0.0.1 unconditionally. The UI server's
 *     OP_ALLOW_REMOTE_SETUP relaxation NEVER applies here — remote access to
 *     the client app is the assistant container's job (#510), not this
 *     process's.
 *   - Non-fatal when absent: no client build on disk → log + skip (return
 *     null). The UI must keep serving.
 *   - Supervised: an unexpected child exit respawns it; stop() SIGTERMs and
 *     suppresses any further respawn.
 */
import { join, basename } from 'node:path';
import { existsSync as nodeExistsSync } from 'node:fs';
import {
  readStackEnv,
  resolveAssistantEndpoint,
  resolveClientAppPort,
  resolveClientBuildDir,
  resolveDataDir,
  resolveOpenPalmHome,
  writeClientRuntimeConfig,
} from '@openpalm/lib';

const STOP_TIMEOUT_MS = 5_000;
const RESPAWN_BASE_DELAY_MS = 1_000;
// D1: cap the respawn loop instead of retrying once a second forever — an
// EADDRINUSE or otherwise immediately-crashing child would otherwise log at
// 1/s indefinitely (the review's "leaves a respawn loop logging every
// second"). Backs off exponentially between attempts, capped, and gives up
// (leaving the UI to keep serving without the client) after the cap.
const MAX_RESPAWN_ATTEMPTS = 5;
const RESPAWN_MAX_DELAY_MS = 30_000;
// Advisory (review): respawnAttempt used to never reset once incremented, so a
// child that crashed MAX_RESPAWN_ATTEMPTS times cumulatively over the ENTIRE
// process lifetime — even hours apart, with long healthy stretches in
// between — permanently gave up. A sustained healthy run resets the counter,
// so only a PERSISTENTLY-broken child (repeated crashes with no healthy
// stretch between them) exhausts the cap.
const HEALTHY_UPTIME_MS = 60_000;

/** Minimal child-process surface the supervisor drives (injectable for tests). */
export type ClientChildProc = Pick<Bun.Subprocess, 'kill' | 'exited' | 'killed'>;

/**
 * Resolve the serve script that travels WITH the resolved client build:
 * `<package root>/bin/serve.mjs`, a sibling of the build dir. Holds for both
 * channels — OP_HOME/data/client/{build,bin} and
 * $OPENPALM_REPO_ROOT/packages/client/{build,bin}.
 */
export function resolveClientServeScript(buildDir: string): string {
  return join(buildDir, '..', 'bin', 'serve.mjs');
}

export function resolveHostClientRuntimeConfigPath(dataDir = resolveDataDir()): string {
  return join(dataDir, 'client', 'runtime-config.json');
}

function readPersistedStackEnv(): Record<string, string> {
  try {
    return readStackEnv(resolveOpenPalmHome());
  } catch {
    return {};
  }
}

/**
 * Resolve the port the client static server ACTUALLY serves on: persisted
 * stack.env merged under process.env (process.env wins), same precedence
 * `startClientServer` uses to build the spawned child's PORT. Exported so
 * OTHER callers building a client-reachability probe (ui-server.ts) target
 * the port the child was actually spawned on rather than re-deriving it from
 * process.env alone (review finding D2 — an install with a persisted
 * OP_HOST_CLIENT_PORT served on one port while the probe checked another,
 * timed out, and orphaned both children).
 */
export function resolveClientServePort(
  env: NodeJS.ProcessEnv = process.env,
  persistedEnv: Record<string, string> = readPersistedStackEnv(),
): number {
  return resolveClientAppPort({ ...persistedEnv, ...env });
}

/** The client app's chat URL, built from {@link resolveClientServePort} (D2). */
export function resolveClientServeUrl(
  env: NodeJS.ProcessEnv = process.env,
  persistedEnv: Record<string, string> = readPersistedStackEnv(),
): string {
  return `http://127.0.0.1:${resolveClientServePort(env, persistedEnv)}/chat`;
}

/**
 * Resolve the assistant (OpenCode) URL to seed into the client's
 * runtime-config.json. Delegates to @openpalm/lib's `resolveAssistantEndpoint`
 * (review finding E1) — before this, the CLI only honored
 * OP_CLIENT_DEFAULT_ASSISTANT_URL and silently ignored OP_OPENCODE_URL /
 * OP_ASSISTANT_URL, which the host UI DOES honor, producing "chat works in one
 * surface but not another" for operators who set the latter two.
 */
export function resolveDefaultAssistantUrl(
  env: NodeJS.ProcessEnv = process.env,
  homeDir: string = resolveOpenPalmHome(),
): string {
  return resolveAssistantEndpoint(homeDir, env);
}

/** Running client-server handle: stop() kills the child and ends supervision. */
export interface ClientServerHandle {
  stop: () => Promise<void>;
}

/** Injectable dependencies for {@link startClientServer} (real process/fs by default). */
export interface ClientServerDeps {
  /** Port to serve on (default: OP_HOST_CLIENT_PORT env or DEFAULT_CLIENT_PORT). */
  port?: number;
  /** Resolve the client build dir (defaults to the shared lib resolver). */
  resolveBuildDir?: () => string;
  /** Existence probe for the build gate + serve script (defaults to node:fs). */
  existsSync?: (path: string) => boolean;
  /** Spawn the serve child (defaults to Bun.spawn with inherited stdio). */
  spawnFn?: (cmd: string[], opts: { env: Record<string, string | undefined> }) => ClientChildProc;
  resolveRuntimeConfigPath?: () => string;
  resolveAssistantUrl?: () => string;
  writeRuntimeConfig?: (path: string, assistantUrl: string) => void;
  log?: (...args: unknown[]) => void;
  logError?: (...args: unknown[]) => void;
  /** Sleep for the respawn delay and the stop grace window. */
  sleep?: (ms: number) => Promise<void>;
  /** Force-kill grace window, ms (defaults to STOP_TIMEOUT_MS). */
  stopTimeoutMs?: number;
  /** Clock for the respawn-counter "sustained healthy run" reset (defaults to Date.now). */
  now?: () => number;
}

/**
 * Start (and supervise) the client static server. Resolves to a handle, or to
 * null when no client build is present — NON-FATAL by contract: this function
 * never throws and never exits; the UI supervisor keeps serving without the
 * client app.
 */
export async function startClientServer(deps: ClientServerDeps = {}): Promise<ClientServerHandle | null> {
  const port = deps.port ?? resolveClientServePort();
  const resolveBuildDir = deps.resolveBuildDir ?? resolveClientBuildDir;
  const exists = deps.existsSync ?? nodeExistsSync;
  const spawnFn = deps.spawnFn
    ?? ((cmd: string[], opts: { env: Record<string, string | undefined> }): ClientChildProc =>
      Bun.spawn(cmd, { env: opts.env, stdout: 'inherit', stderr: 'inherit' }));
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const stopTimeoutMs = deps.stopTimeoutMs ?? STOP_TIMEOUT_MS;
  const resolveRuntimeConfigPath = deps.resolveRuntimeConfigPath ?? (() => resolveHostClientRuntimeConfigPath());
  const resolveAssistantUrl = deps.resolveAssistantUrl ?? (() => resolveDefaultAssistantUrl(process.env));
  const writeRuntimeConfig = deps.writeRuntimeConfig ?? writeClientRuntimeConfig;

  const buildDir = resolveBuildDir();
  const serveScript = resolveClientServeScript(buildDir);
  if (!exists(join(buildDir, 'index.html')) || !exists(serveScript)) {
    log(`Client app build not found at ${buildDir} — skipping the client server (the UI keeps serving).`);
    return null;
  }

  const runtimeConfigPath = resolveRuntimeConfigPath();
  try {
    writeRuntimeConfig(runtimeConfigPath, resolveAssistantUrl());
  } catch (err) {
    logError(`Failed to write client runtime config at ${runtimeConfigPath}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // The child runs on THIS binary's embedded runtime (no system `node`
  // required — same rationale as the UI child in ui-server.ts):
  //   dev (bun)       → [bun, <serve.mjs>]           bun executes the script
  //   compiled binary → [binary, 'client-serve']     re-invoke `openpalm
  //                     client-serve`, which imports the resolved serve script
  //                     in-process (OP_CLIENT_DIR below pins the served dir).
  const execName = basename(process.execPath).toLowerCase();
  const runningAsBun = execName === 'bun' || execName === 'bun.exe';
  const cmd = runningAsBun ? [process.execPath, serveScript] : [process.execPath, 'client-serve'];
  // serve.mjs reads its config from the environment (PORT / HOST /
  // OP_CLIENT_DIR). HOST is pinned to loopback AFTER the process.env spread so
  // nothing — including OP_ALLOW_REMOTE_SETUP — can loosen the bind.
  const env: Record<string, string | undefined> = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    OP_CLIENT_DIR: buildDir,
    OP_CLIENT_RUNTIME_CONFIG: runtimeConfigPath,
  };

  let stopping = false;
  let proc = spawnFn(cmd, { env });
  let spawnedAt = now();
  log(`Client app served at http://127.0.0.1:${port} (from ${buildDir})`);

  // Supervision loop: respawn on any unexpected exit; an intentional stop()
  // flips `stopping` first, which both breaks the loop and suppresses respawn.
  // D1: capped + backed off — an immediately-crashing child (e.g. EADDRINUSE)
  // must not respawn at a flat 1/s forever; give up after MAX_RESPAWN_ATTEMPTS
  // and leave the UI serving without the client (non-fatal by contract).
  let respawnAttempt = 0;
  void (async () => {
    while (!stopping) {
      const code = await proc.exited;
      if (stopping) break;
      // Advisory: a child that ran HEALTHY_UPTIME_MS or longer before dying
      // resets the give-up counter — only a persistently-broken child (no
      // healthy stretch between crashes) should exhaust MAX_RESPAWN_ATTEMPTS,
      // not one that crashes rarely across the whole process lifetime.
      if (now() - spawnedAt >= HEALTHY_UPTIME_MS) respawnAttempt = 0;
      respawnAttempt += 1;
      if (respawnAttempt > MAX_RESPAWN_ATTEMPTS) {
        logError(
          `Client app server exited unexpectedly (code ${code}) — giving up after ` +
          `${MAX_RESPAWN_ATTEMPTS} respawn attempts (the UI keeps serving without it).`
        );
        break;
      }
      const delayMs = Math.min(RESPAWN_BASE_DELAY_MS * 2 ** (respawnAttempt - 1), RESPAWN_MAX_DELAY_MS);
      logError(
        `Client app server exited unexpectedly (code ${code}) — restarting in ${delayMs}ms ` +
        `(attempt ${respawnAttempt}/${MAX_RESPAWN_ATTEMPTS}).`
      );
      await sleep(delayMs);
      if (stopping) break;
      proc = spawnFn(cmd, { env });
      spawnedAt = now();
    }
  })();

  return {
    stop: async () => {
      stopping = true;
      proc.kill('SIGTERM');
      await Promise.race([proc.exited, sleep(stopTimeoutMs)]);
      if (!proc.killed) proc.kill('SIGKILL');
    },
  };
}
