/**
 * Shared helpers for bun:test API integration tests.
 *
 * Provides server lifecycle management, temp directory setup,
 * and fetch wrappers equivalent to the Playwright helpers.
 */
import { spawnSync, spawn, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const UI_ROOT = resolve(import.meta.dir, "../..");

export const ADMIN_TOKEN = "test-token-e2e";

let port = 13500;
let serverProcess: ChildProcess | null = null;
let tmpDir: string | null = null;

/** Claim a unique port for this test file (call once at module level). */
export function claimPort(offset: number): void {
  port = 13500 + offset;
}

export function getBaseUrl(): string {
  return `http://localhost:${port}`;
}

export function getTmpDir(): string {
  if (!tmpDir) throw new Error("Server not started; call startServer() first");
  return tmpDir;
}

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openpalm-api-test-"));

  const dataDir = join(dir, "data", "admin");
  const configDir = join(dir, "config");
  const stateRoot = join(dir, "state");
  const cronDir = join(dir, "cron");
  const opencodeDir = join(dir, "data", "assistant", ".config", "opencode");
  const gatewayDir = join(stateRoot, "gateway");
  const openmemoryDir = join(stateRoot, "openmemory");
  const postgresDir = join(stateRoot, "postgres");
  const qdrantDir = join(stateRoot, "qdrant");
  const assistantDir = join(stateRoot, "assistant");

  for (const d of [
    dataDir,
    configDir,
    stateRoot,
    cronDir,
    opencodeDir,
    gatewayDir,
    openmemoryDir,
    postgresDir,
    qdrantDir,
    assistantDir,
  ]) {
    mkdirSync(d, { recursive: true });
  }

  writeFileSync(join(configDir, "secrets.env"), "", "utf8");
  writeFileSync(join(stateRoot, ".env"), "", "utf8");
  writeFileSync(join(stateRoot, "system.env"), "", "utf8");
  writeFileSync(join(gatewayDir, ".env"), "", "utf8");
  writeFileSync(join(openmemoryDir, ".env"), "", "utf8");
  writeFileSync(join(postgresDir, ".env"), "", "utf8");
  writeFileSync(join(qdrantDir, ".env"), "", "utf8");
  writeFileSync(join(assistantDir, ".env"), "", "utf8");
  writeFileSync(
    join(opencodeDir, "opencode.json"),
    '{\n  "plugin": []\n}\n',
    "utf8"
  );

  return dir;
}

function buildWebServerEnv(dir: string): Record<string, string> {
  const configDir = join(dir, "config");
  const stateRoot = join(dir, "state");

  return {
    PORT: String(port),
    ORIGIN: `http://localhost:${port}`,
    ADMIN_TOKEN,
    DATA_DIR: join(dir, "data", "admin"),
    OPENPALM_DATA_ROOT: join(dir, "data"),
    OPENPALM_STATE_ROOT: stateRoot,
    OPENPALM_CONFIG_ROOT: configDir,
    OPENCODE_CONFIG_PATH: join(
      dir,
      "data",
      "assistant",
      ".config",
      "opencode",
      "opencode.json"
    ),
    SECRETS_ENV_PATH: join(configDir, "secrets.env"),
    STACK_SPEC_PATH: join(configDir, "openpalm.yaml"),
    RUNTIME_ENV_PATH: join(stateRoot, ".env"),
    SYSTEM_ENV_PATH: join(stateRoot, "system.env"),
    COMPOSE_FILE_PATH: join(stateRoot, "docker-compose.yml"),
    CADDY_JSON_PATH: join(stateRoot, "caddy.json"),
    GATEWAY_ENV_PATH: join(stateRoot, "gateway", ".env"),
    OPENMEMORY_ENV_PATH: join(stateRoot, "openmemory", ".env"),
    POSTGRES_ENV_PATH: join(stateRoot, "postgres", ".env"),
    QDRANT_ENV_PATH: join(stateRoot, "qdrant", ".env"),
    ASSISTANT_ENV_PATH: join(stateRoot, "assistant", ".env"),
    COMPOSE_PROJECT_PATH: stateRoot,
    OPENPALM_COMPOSE_FILE: "docker-compose.yml",
    OPENPALM_COMPOSE_BIN: "/usr/bin/true",
  };
}

/**
 * Build the SvelteKit app (if not already built) and start the server.
 * Returns the temp directory path.
 */
export async function startServer(): Promise<string> {
  const buildIndex = join(UI_ROOT, "build", "index.js");
  if (!existsSync(buildIndex)) {
    const buildResult = spawnSync("bun", ["run", "build"], {
      cwd: UI_ROOT,
      stdio: "pipe",
    });
    if (buildResult.status !== 0) {
      throw new Error(
        `SvelteKit build failed: ${buildResult.stderr?.toString()}`
      );
    }
  }

  tmpDir = createTempDir();
  const env = buildWebServerEnv(tmpDir);

  serverProcess = spawn("bun", [buildIndex], {
    env: { ...process.env, ...env },
    stdio: "pipe",
  });

  // Wait for server to be ready
  const baseUrl = getBaseUrl();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (resp.ok) return tmpDir;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Server did not start within 30s");
}

/** Kill the server and clean up the temp directory. */
export function stopServer(): void {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill("SIGTERM");
    serverProcess = null;
  }
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  }
}

// ── Fetch wrappers ────────────────────────────────────────────

const AUTH_HEADERS: Record<string, string> = {
  "x-admin-token": ADMIN_TOKEN,
  "content-type": "application/json",
};

/** GET without auth */
export async function rawGet(path: string): Promise<Response> {
  return fetch(`${getBaseUrl()}${path}`);
}

/** GET with admin auth token */
export async function authedGet(path: string): Promise<Response> {
  return fetch(`${getBaseUrl()}${path}`, { headers: AUTH_HEADERS });
}

/** POST with admin auth token */
export async function authedPost(
  path: string,
  data: unknown
): Promise<Response> {
  return fetch(`${getBaseUrl()}${path}`, {
    method: "POST",
    headers: AUTH_HEADERS,
    body: JSON.stringify(data),
  });
}

/** POST to /command endpoint with type + payload */
export async function cmd(
  type: string,
  payload: Record<string, unknown> = {}
): Promise<Response> {
  return authedPost("/command", { type, payload });
}

/**
 * Run the minimal setup sequence so subsequent tests that require
 * a completed setup state can work independently.
 */
export async function runMinimalSetup(): Promise<void> {
  await authedPost("/setup/step", { step: "welcome" });
  await cmd("setup.profile", {
    name: "Taylor Palm",
    email: "taylor@example.com",
  });
  await authedPost("/setup/step", { step: "profile" });
  await authedPost("/setup/service-instances", {
    openmemory: "http://test:8765",
    psql: "",
    qdrant: "",
  });
  await authedPost("/setup/step", { step: "serviceInstances" });
  await authedPost("/setup/step", { step: "security" });
  await authedPost("/setup/channels", {
    channels: ["channel-chat"],
    channelConfigs: { "channel-chat": { CHAT_INBOUND_TOKEN: "test-token" } },
  });
  await authedPost("/setup/step", { step: "channels" });
  await authedPost("/setup/access-scope", { scope: "host" });
  await authedPost("/setup/step", { step: "healthCheck" });
  await authedPost("/setup/complete", {});
}
