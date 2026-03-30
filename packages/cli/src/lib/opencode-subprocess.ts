/**
 * OpenCode subprocess management for the setup wizard.
 *
 * Starts an OpenCode web server as a subprocess during `openpalm install`
 * so the wizard can query provider information and set API keys via the
 * OpenCode REST API.
 */
import { mkdirSync, mkdtempSync, symlinkSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export type OpenCodeSubprocess = {
  process: ReturnType<typeof Bun.spawn>;
  port: number;
  baseUrl: string;
  /** Poll /health until ready. Returns true if ready, false on timeout. */
  waitForReady: () => Promise<boolean>;
  /** Stop the subprocess gracefully. */
  stop: () => Promise<void>;
};

const DEFAULT_PORT = 14096;
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 500;
const STOP_TIMEOUT_MS = 5_000;

/**
 * Start an OpenCode subprocess for the wizard to talk to.
 *
 * Creates a temporary HOME directory structure with symlinks to the real
 * vault/config paths so OpenCode reads/writes auth.json at the right location.
 */
export async function startOpenCodeSubprocess(opts: {
  homeDir: string;
  configDir: string;
  vaultDir: string;
  dataDir: string;
  port?: number;
}): Promise<OpenCodeSubprocess> {
  const opencodeBin = Bun.which("opencode");
  if (!opencodeBin) {
    throw new Error("opencode binary not found on PATH");
  }

  const port = opts.port ?? (Number(process.env.OP_OPENCODE_WIZARD_PORT) || DEFAULT_PORT);
  const wizardHome = mkdtempSync(join(tmpdir(), "openpalm-wizard-"));

  // Build HOME directory structure for OpenCode
  const ocShareDir = join(wizardHome, ".local", "share", "opencode");
  const ocConfigDir = join(wizardHome, ".config", "opencode");
  const ocStateDir = join(wizardHome, ".local", "state", "opencode");

  mkdirSync(ocShareDir, { recursive: true });
  mkdirSync(ocConfigDir, { recursive: true });
  mkdirSync(ocStateDir, { recursive: true });

  // Symlink auth.json → real vault location
  const authJsonSrc = join(opts.vaultDir, "stack", "auth.json");
  const authJsonDst = join(ocShareDir, "auth.json");
  if (!existsSync(authJsonDst)) {
    symlinkSync(authJsonSrc, authJsonDst);
  }

  // Copy opencode.json config (not symlink — OpenCode may modify it)
  const configSrc = join(opts.configDir, "assistant", "opencode.json");
  const configDst = join(ocConfigDir, "opencode.json");
  if (!existsSync(configDst) && existsSync(configSrc)) {
    copyFileSync(configSrc, configDst);
  }

  const proc = Bun.spawn([opencodeBin, "web", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: { ...process.env, HOME: wizardHome },
    stdout: "ignore",
    stderr: "ignore",
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    process: proc,
    port,
    baseUrl,

    async waitForReady(): Promise<boolean> {
      const deadline = Date.now() + READY_TIMEOUT_MS;
      while (Date.now() < deadline) {
        try {
          // OpenCode has no /health endpoint — check /provider instead
          const res = await fetch(`${baseUrl}/provider`, { signal: AbortSignal.timeout(2000) });
          if (res.ok) return true;
        } catch {
          // not ready yet
        }
        await new Promise(r => setTimeout(r, READY_POLL_MS));
      }
      return false;
    },

    async stop(): Promise<void> {
      proc.kill("SIGTERM");
      const exited = Promise.race([
        proc.exited,
        new Promise(r => setTimeout(r, STOP_TIMEOUT_MS)),
      ]);
      await exited;
      if (!proc.killed) {
        proc.kill("SIGKILL");
      }
      // Clean up temp HOME directory
      try { rmSync(wizardHome, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}
