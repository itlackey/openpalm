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
  parseEnvFile,
  resolveClientAppPort,
  resolveClientBuildDir,
  resolveDataDir,
  resolveOpenPalmHome,
  writeClientRuntimeConfig,
} from '@openpalm/lib';

const STOP_TIMEOUT_MS = 5_000;
const RESPAWN_DELAY_MS = 1_000;

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
    return parseEnvFile(join(resolveOpenPalmHome(), 'knowledge', 'env', 'stack.env'));
  } catch {
    return {};
  }
}

export function resolveDefaultAssistantUrl(
  env: NodeJS.ProcessEnv = process.env,
  persistedEnv: Record<string, string> = readPersistedStackEnv(),
): string {
  const merged = { ...persistedEnv, ...env };
  return merged.OP_CLIENT_DEFAULT_ASSISTANT_URL || `http://127.0.0.1:${merged.OP_ASSISTANT_PORT || '3800'}`;
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
}

/**
 * Start (and supervise) the client static server. Resolves to a handle, or to
 * null when no client build is present — NON-FATAL by contract: this function
 * never throws and never exits; the UI supervisor keeps serving without the
 * client app.
 */
export async function startClientServer(deps: ClientServerDeps = {}): Promise<ClientServerHandle | null> {
  const persistedEnv = readPersistedStackEnv();
  const port = deps.port ?? resolveClientAppPort({ ...persistedEnv, ...process.env });
  const resolveBuildDir = deps.resolveBuildDir ?? resolveClientBuildDir;
  const exists = deps.existsSync ?? nodeExistsSync;
  const spawnFn = deps.spawnFn
    ?? ((cmd: string[], opts: { env: Record<string, string | undefined> }): ClientChildProc =>
      Bun.spawn(cmd, { env: opts.env, stdout: 'inherit', stderr: 'inherit' }));
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
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
  log(`Client app served at http://127.0.0.1:${port} (from ${buildDir})`);

  // Supervision loop: respawn on any unexpected exit; an intentional stop()
  // flips `stopping` first, which both breaks the loop and suppresses respawn.
  void (async () => {
    while (!stopping) {
      const code = await proc.exited;
      if (stopping) break;
      logError(`Client app server exited unexpectedly (code ${code}) — restarting.`);
      await sleep(RESPAWN_DELAY_MS);
      if (stopping) break;
      proc = spawnFn(cmd, { env });
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
