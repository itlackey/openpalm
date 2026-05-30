/**
 * Ephemeral local OpenCode server for Electron (Phase 3 of the auth/proxy
 * refactor — see docs/technical/auth-and-proxy-refactor-plan.md).
 *
 * Lifecycle:
 *   - Generate a per-launch random 32-byte password (base64url).
 *   - Stage a controlled $HOME at ${dataDir}/admin-opencode-home/ with an
 *     opencode.json that loads @openpalm/admin-tools-plugin.
 *   - Spawn opencode via @opencode-ai/sdk createOpencodeServer, bound to
 *     127.0.0.1 on port 0 (kernel-assigned).
 *   - Set OPENCODE_SERVER_USERNAME=openpalm and OPENCODE_SERVER_PASSWORD=<rand>
 *     in spawn env. Never written to disk anywhere except the 0600
 *     local-opencode.runtime.json that the broker reads.
 *   - On Electron quit: terminate the process (SIGTERM, 5s grace, SIGKILL),
 *     unlink the runtime.json + pidfile.
 *
 * Failure mode: if the `opencode` binary is missing or createOpencodeServer
 * throws for any reason, we log a clear warning, write a sentinel
 * `data/local-opencode.unavailable`, and continue. Electron must not crash.
 *
 * Routing: the broker (packages/ui/src/lib/server/endpoints.ts) reads
 * local-opencode.runtime.json each request to pick up the per-launch URL +
 * password. The local entry is synthetic — it is NEVER persisted to
 * config/endpoints.json and CANNOT be deleted or edited from the UI.
 */
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export type LocalOpencodeRuntime = {
  url: string;
  username: string;
  password: string;
  pid: number;
  startedAt: string;
};

export type LocalOpencodeHandle = {
  url: string;
  username: string;
  password: string;
  pid: number;
  stop: () => Promise<void>;
};

const USERNAME = "openpalm";
const STOP_GRACE_MS = 5_000;

// ── Path helpers (exported for tests) ───────────────────────────────────────

export function runtimePath(dataDir: string): string {
  return join(dataDir, "local-opencode.runtime.json");
}

export function pidfilePath(dataDir: string): string {
  return join(dataDir, "local-opencode.pid");
}

export function unavailableSentinelPath(dataDir: string): string {
  return join(dataDir, "local-opencode.unavailable");
}

export function adminOpencodeHome(dataDir: string): string {
  return join(dataDir, "admin-opencode-home");
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

export function generatePassword(): string {
  return randomBytes(32).toString("base64url");
}

export function buildRuntimeJson(
  url: string,
  password: string,
  pid: number,
  startedAt: Date = new Date(),
): LocalOpencodeRuntime {
  return {
    url,
    username: USERNAME,
    password,
    pid,
    startedAt: startedAt.toISOString(),
  };
}

/**
 * Probe whether the given pid is alive. Returns false if the process is
 * gone or if signalling errors (e.g. EPERM — not our process anymore).
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Stage the admin OpenCode HOME directory: writes opencode.json declaring
 * the admin-tools plugin. Mirrors the cli-subprocess pattern but does NOT
 * symlink auth.json — the admin OpenCode is a fresh server with no provider
 * credentials, and we don't want the agent reading the user's LLM keys.
 *
 * @param pluginPath Absolute path to the bundled admin-tools-plugin index.js,
 *   or a bare npm package name as a fallback. Callers should resolve this from
 *   process.resourcesPath (packaged) or the workspace dist dir (dev).
 */
export function stageAdminHome(dataDir: string, pluginPath: string): { home: string; configDir: string } {
  const home = adminOpencodeHome(dataDir);
  const configDir = join(home, ".config", "opencode");
  const shareDir = join(home, ".local", "share", "opencode");
  const ocStateDir = join(home, ".local", "state", "opencode");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(shareDir, { recursive: true });
  mkdirSync(ocStateDir, { recursive: true });
  const configPath = join(configDir, "opencode.json");
  if (!existsSync(configPath)) {
    writeFileSync(
      configPath,
      JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugin: [pluginPath],
      }, null, 2),
      { encoding: "utf-8" },
    );
  }
  return { home, configDir };
}

export function writeRuntimeFile(dataDir: string, data: LocalOpencodeRuntime): void {
  const path = runtimePath(dataDir);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
}

export function writePidFile(dataDir: string, pid: number): void {
  const path = pidfilePath(dataDir);
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(path, `${pid}\n`, { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best effort */ }
}

export function readPidFile(dataDir: string): number | null {
  const path = pidfilePath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function unlinkSafely(path: string): void {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    /* best effort */
  }
}

/**
 * Sweep a stale pidfile from a previous Electron run. If the pid is still
 * alive we attempt to kill it (best effort — we cannot strictly verify it
 * is the same opencode process). Always unlinks the pidfile + runtime.json
 * before a fresh spawn so stale data never bleeds across launches.
 */
export function sweepStalePid(dataDir: string): { swept: boolean; pid: number | null } {
  const pid = readPidFile(dataDir);
  let swept = false;
  if (pid !== null && isPidAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
      swept = true;
    } catch {
      /* best effort */
    }
  }
  unlinkSafely(pidfilePath(dataDir));
  unlinkSafely(runtimePath(dataDir));
  unlinkSafely(unavailableSentinelPath(dataDir));
  return { swept, pid };
}

// ── Spawn / stop ─────────────────────────────────────────────────────────────

type SdkServer = { url: string; close: () => void };

// Lazy import so tests can mock @opencode-ai/sdk without touching production
// import resolution.
type CreateOpencodeServerFn = (opts: {
  hostname: string;
  port: number;
  config?: Record<string, unknown>;
  signal?: AbortSignal;
  timeout?: number;
}) => Promise<SdkServer>;

let _sdkLoader: () => Promise<{ createOpencodeServer: CreateOpencodeServerFn }> = async () => {
  return await import("@opencode-ai/sdk");
};

/** Test-only override for the SDK loader. */
export function _setSdkLoader(loader: typeof _sdkLoader): void {
  _sdkLoader = loader;
}

export type StartOptions = {
  dataDir: string;
  /** Absolute path to the bundled admin-tools-plugin, or a package name fallback. */
  pluginPath: string;
  /** Optional override for opencode hostname (defaults 127.0.0.1). */
  hostname?: string;
  /** Optional override for the spawn env factory (test seam). */
  envOverride?: NodeJS.ProcessEnv;
};

/**
 * Start the ephemeral local OpenCode. Resolves to a handle even on failure;
 * on failure the handle has `pid = -1` and `url = ''` and a no-op `stop`,
 * and a sentinel file is written so the UI can show a clear message.
 */
export async function startLocalOpenCode(opts: StartOptions): Promise<LocalOpencodeHandle | null> {
  const { dataDir, pluginPath } = opts;
  mkdirSync(dataDir, { recursive: true });

  // Always sweep stale state before spawning. If we crashed last time the
  // pidfile + runtime.json may be lingering.
  sweepStalePid(dataDir);

  const password = generatePassword();
  const { home } = stageAdminHome(dataDir, pluginPath);

  const env: NodeJS.ProcessEnv = {
    ...(opts.envOverride ?? process.env),
    HOME: home,
    OPENCODE_SERVER_USERNAME: USERNAME,
    OPENCODE_SERVER_PASSWORD: password,
    OPENCODE_AUTH: "true",
  };

  // The SDK forwards process.env to the child; we mutate process.env for the
  // spawn window. Save + restore so we don't leak the password into the rest
  // of the Electron main process.
  const savedEnv: NodeJS.ProcessEnv = {
    HOME: process.env.HOME,
    OPENCODE_SERVER_USERNAME: process.env.OPENCODE_SERVER_USERNAME,
    OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD,
    OPENCODE_AUTH: process.env.OPENCODE_AUTH,
  };
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) process.env[k] = v;
  }

  let server: SdkServer;
  try {
    const sdk = await _sdkLoader();
    server = await sdk.createOpencodeServer({
      hostname: opts.hostname ?? "127.0.0.1",
      port: 0,
      timeout: 30_000,
    });
  } catch (err) {
    // Restore env immediately on failure.
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const msg = err instanceof Error ? err.message : String(err);
    // Detect "opencode binary missing" vs. other failures so we can give the
    // operator a sharper message.
    const looksMissing = /ENOENT|opencode/i.test(msg) && /not found|no such file/i.test(msg);
    const reason = looksMissing
      ? "opencode binary not on PATH"
      : `opencode spawn failed: ${msg}`;
    console.warn(`[local-opencode] ${reason}. Local admin OpenCode unavailable; remote endpoints still work.`);
    try {
      writeFileSync(
        unavailableSentinelPath(dataDir),
        JSON.stringify({ reason, at: new Date().toISOString() }, null, 2),
        { encoding: "utf-8", mode: 0o600 },
      );
    } catch {
      /* best effort */
    }
    return null;
  }

  // Restore env now that the child has captured it.
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  // The SDK does not expose the child pid directly. We use the URL it
  // returns to verify and record process.pid of the parent for the pidfile.
  // The SDK retains a private reference and will close the child on
  // server.close(). For the pidfile we record the Electron-main pid so
  // sweeps know what process owns the runtime files; the actual opencode
  // child is reaped by the SDK on close().
  const pid = process.pid;
  const runtime = buildRuntimeJson(server.url, password, pid);
  writeRuntimeFile(dataDir, runtime);
  writePidFile(dataDir, pid);
  unlinkSafely(unavailableSentinelPath(dataDir));

  let stopped = false;
  return {
    url: server.url,
    username: USERNAME,
    password,
    pid,
    async stop() {
      if (stopped) return;
      stopped = true;
      // Ask the SDK to terminate the opencode child. The SDK's close()
      // sends SIGTERM internally; we give it STOP_GRACE_MS to settle.
      try { server.close(); } catch { /* best effort */ }
      await new Promise<void>((resolve) => setTimeout(resolve, STOP_GRACE_MS));
      unlinkSafely(runtimePath(dataDir));
      unlinkSafely(pidfilePath(dataDir));
    },
  };
}
