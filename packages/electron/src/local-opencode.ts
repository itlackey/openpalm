/**
 * Ephemeral local OpenCode server for Electron (Phase 3 of the auth/proxy
 * refactor).
 *
 * Lifecycle:
 *   - Stage a controlled $HOME at ${dataDir}/admin-opencode-home/ with an
 *     opencode.json that loads @openpalm/admin-tools-plugin.
 *   - Spawn `opencode serve` directly (detached, own process group), bound to
 *     127.0.0.1 on port 0 (kernel-assigned), and parse its listening URL from
 *     stdout. We spawn it ourselves rather than via the SDK so we own the real
 *     child pid (the SDK hides it) — that pid drives the pidfile, stop(), and
 *     the next-launch stale sweep, so opencode and its descendants are reliably
 *     reaped instead of orphaned.
 *   - Spawn with OPENCODE_AUTH=false (no Basic auth), mirroring the assistant.
 *     The admin OpenCode is loopback-only; an authed instance 401s the
 *     cross-origin Advanced-mode iframe (which cannot pass credentials), so it is
 *     served without auth — the same posture as the no-auth local assistant — and
 *     a local process already has Docker socket access regardless.
 *   - On Electron quit: terminate the process (SIGTERM, 5s grace, SIGKILL),
 *     unlink the runtime.json + pidfile.
 *
 * Failure mode: if the `opencode` binary is missing or the spawn fails / exits
 * before listening for any reason, we log a clear warning, write a sentinel
 * `data/local-opencode.unavailable`, and continue. Electron must not crash.
 *
 * Routing: the broker (packages/ui/src/lib/server/endpoints.ts) reads
 * local-opencode.runtime.json each request to pick up the per-launch URL. The
 * local entry is synthetic — it is NEVER persisted to config/endpoints.json and
 * CANNOT be deleted or edited from the UI.
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
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
import { normalizeLoopbackUrl } from "@openpalm/lib";

export type LocalOpencodeRuntime = {
  url: string;
  username: string;
  pid: number;
  startedAt: string;
};

export type LocalOpencodeHandle = {
  url: string;
  username: string;
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

export function buildRuntimeJson(
  url: string,
  pid: number,
  startedAt: Date = new Date(),
): LocalOpencodeRuntime {
  return {
    url,
    username: USERNAME,
    pid,
    startedAt: startedAt.toISOString(),
  };
}

/**
 * OpenCode prints its listening URL using the bind address, which can be
 * `0.0.0.0` (IPv4 any) or `[::]` / `::` (IPv6 any) even though we pass
 * `--hostname=127.0.0.1`. A browser cannot connect to — or frame — a wildcard
 * address, so rewrite the host to loopback for the CLIENT-facing URL (the UI
 * embeds it in an iframe and the broker proxies to it). The server is reachable
 * on 127.0.0.1 regardless of the printed bind address.
 *
 * Re-exported from @openpalm/lib (review finding E4): this used to be a
 * byte-for-byte local copy of packages/lib/src/control-plane/url-normalize.ts,
 * which the same migration relocated FROM this file — re-export the shared
 * helper instead of maintaining two copies of the same regex.
 */
export { normalizeLoopbackUrl };

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
    // The pidfile records the opencode process-group leader, so this reaps the
    // orphaned opencode AND any descendants it spawned.
    killProcessTree(pid, "SIGTERM");
    swept = true;
  }
  unlinkSafely(pidfilePath(dataDir));
  unlinkSafely(runtimePath(dataDir));
  unlinkSafely(unavailableSentinelPath(dataDir));
  return { swept, pid };
}

// ── Spawn / stop ─────────────────────────────────────────────────────────────

const URL_WAIT_MS = 30_000;

/**
 * Terminate a process group (POSIX) or process tree (Windows). opencode is
 * spawned `detached` so it leads its own process group; signalling the negative
 * pid reaps opencode AND every descendant it spawned (language servers, model
 * runners), which a bare `process.kill(pid)` would orphan.
 */
export function killProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } catch { /* best effort */ }
    return;
  }
  // Negative pid → the whole process group (opencode is the group leader).
  try { process.kill(-pid, signal); return; } catch { /* group gone or not a leader */ }
  try { process.kill(pid, signal); } catch { /* already gone */ }
}

// Test seam: a spawn-like factory so unit tests can inject a fake child without
// launching a real opencode binary.
type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;
let _spawn: SpawnFn = spawn;

/** Test-only override for the process spawner. */
export function _setSpawn(fn: SpawnFn): void {
  _spawn = fn;
}

/** Reset the spawner to the real node:child_process spawn (test cleanup). */
export function _resetSpawn(): void {
  _spawn = spawn;
}

export type StartOptions = {
  dataDir: string;
  /** Absolute path to the bundled admin-tools-plugin, or a package name fallback. */
  pluginPath: string;
  /** Optional override for opencode hostname (defaults 127.0.0.1). */
  hostname?: string;
  /** Optional override for the spawn env (test seam). */
  envOverride?: NodeJS.ProcessEnv;
};

/** Write the unavailable sentinel and return null. Shared failure path. */
function failUnavailable(dataDir: string, err: unknown): null {
  const msg = err instanceof Error ? err.message : String(err);
  const looksMissing = /ENOENT/i.test(msg) || (/opencode/i.test(msg) && /not found|no such file/i.test(msg));
  const reason = looksMissing ? "opencode binary not on PATH" : `opencode spawn failed: ${msg}`;
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

/**
 * Start the ephemeral local OpenCode. Spawns `opencode serve` directly (rather
 * than via the SDK, which hides the child pid) so we own the real pid: the
 * pidfile records the opencode process-group leader, letting both stop() and the
 * next launch's sweepStalePid() reap it and its descendants. Resolves to null on
 * failure (binary missing / early exit / timeout), writing a sentinel file so the
 * UI can show a clear message. Electron must not crash.
 */
export async function startLocalOpenCode(opts: StartOptions): Promise<LocalOpencodeHandle | null> {
  const { dataDir, pluginPath } = opts;
  mkdirSync(dataDir, { recursive: true });

  // Always sweep stale state before spawning. If we crashed last time the
  // pidfile + runtime.json may be lingering.
  sweepStalePid(dataDir);

  const { home } = stageAdminHome(dataDir, pluginPath);

  // No Basic auth — mirror the assistant (OPENCODE_AUTH=false), bound to 127.0.0.1
  // only. The admin OpenCode is loopback-only; a local process already has Docker
  // socket access, so a per-origin password adds little, and an authed instance
  // 401s the cross-origin Advanced-mode iframe (which can't pass credentials). This
  // makes Advanced work consistently for both the assistant and the admin endpoint.
  const env: NodeJS.ProcessEnv = {
    ...(opts.envOverride ?? process.env),
    HOME: home,
    OPENCODE_AUTH: "false",
  };

  let proc: ChildProcess;
  try {
    proc = _spawn("opencode", ["serve", `--hostname=${opts.hostname ?? "127.0.0.1"}`, "--port=0"], {
      env,
      // Own process group so stop()/sweep can group-kill the whole subtree.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    return failUnavailable(dataDir, err);
  }

  // Wait for the listening URL on stdout, or fail on early exit / timeout.
  let url: string;
  try {
    url = await new Promise<string>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(
        () => reject(new Error(`Timeout waiting for opencode to start after ${URL_WAIT_MS}ms`)),
        URL_WAIT_MS,
      );
      proc.stdout?.on("data", (chunk: Buffer) => {
        out += chunk.toString();
        for (const line of out.split("\n")) {
          if (line.includes("server listening")) {
            const m = line.match(/on\s+(https?:\/\/[^\s]+)/);
            if (m) { clearTimeout(timer); resolve(normalizeLoopbackUrl(m[1])); return; }
          }
        }
      });
      proc.stderr?.on("data", (chunk: Buffer) => { out += chunk.toString(); });
      proc.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`opencode exited with code ${code}${out.trim() ? `\n${out}` : ""}`));
      });
      proc.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
  } catch (err) {
    if (proc.pid) killProcessTree(proc.pid, "SIGKILL");
    return failUnavailable(dataDir, err);
  }

  const pid = proc.pid ?? -1;
  const runtime = buildRuntimeJson(url, pid);
  writeRuntimeFile(dataDir, runtime);
  writePidFile(dataDir, pid);
  unlinkSafely(unavailableSentinelPath(dataDir));

  let stopped = false;
  return {
    url,
    username: USERNAME,
    pid,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (pid > 0 && isPidAlive(pid)) {
        killProcessTree(pid, "SIGTERM");
        // Resolve the instant the child is actually gone; only escalate to
        // SIGKILL if it overstays the grace window. (The prior code waited a
        // fixed STOP_GRACE_MS on every quit — that silent hang is what made the
        // app appear to need a second Quit click.)
        const deadline = Date.now() + STOP_GRACE_MS;
        while (Date.now() < deadline && isPidAlive(pid)) {
          await new Promise((r) => setTimeout(r, 50));
        }
        if (isPidAlive(pid)) killProcessTree(pid, "SIGKILL");
      }
      unlinkSafely(runtimePath(dataDir));
      unlinkSafely(pidfilePath(dataDir));
    },
  };
}
