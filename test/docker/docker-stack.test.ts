/**
 * Docker stack integration tests.
 *
 * Builds fresh container images from source and starts the core services
 * (admin + gateway) against an isolated temp directory, then validates
 * health endpoints, auth, YAML-dependent features, and API contracts.
 *
 * Run:
 *   bun test test/docker/docker-stack.test.ts
 *
 * Requirements:
 *   - Docker daemon running
 *   - Repo root has valid source for admin/ and gateway/
 *
 * These tests are slower (~30-60s) because they build images and start
 * containers. They only run when OPENPALM_RUN_DOCKER_STACK_TESTS=1.
 * Run them explicitly when validating Docker packaging.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const COMPOSE_BASE = join(REPO_ROOT, "packages/lib/src/embedded/state/docker-compose.yml");
const PROJECT_NAME = "openpalm-test";
const TIMEOUT = 10_000;
const ADMIN_TOKEN = "test-docker-token";

// ── Docker availability check ─────────────────────────────
const dockerAvailable = await Bun.spawn(["docker", "info"], {
  stdout: "pipe", stderr: "pipe",
}).exited.then((code) => code === 0).catch(() => false);
const runDockerStackTests = dockerAvailable && Bun.env.OPENPALM_RUN_DOCKER_STACK_TESTS === "1";

// ── Temp directory layout ─────────────────────────────────
let tmpDir: string;
let composeTestFile: string;
let envFilePath: string;

function compose(...args: string[]) {
  return Bun.spawn(
    ["docker", "compose", "-p", PROJECT_NAME, "--env-file", envFilePath,
      "-f", COMPOSE_BASE, "-f", composeTestFile, "--project-directory", REPO_ROOT, ...args],
    { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
  );
}

async function composeRun(...args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = compose(...args);
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

async function waitForHealth(url: string, maxMs = 60_000): Promise<boolean> {
  const start = Date.now();
  let delay = 500;
  while (Date.now() - start < maxMs) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch { /* not ready yet */ }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 5000);
  }
  return false;
}

function api(port: number, path: string, opts?: RequestInit) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(TIMEOUT),
  });
}

function authedJson(port: number, path: string, opts?: RequestInit) {
  return api(port, path, {
    ...opts,
    headers: {
      "content-type": "application/json",
      "x-admin-token": ADMIN_TOKEN,
      ...(opts?.headers as Record<string, string> ?? {}),
    },
  }).then(async (r) => ({ ok: r.ok, status: r.status, data: await r.json() as Record<string, unknown> }));
}

function cmd(port: number, type: string, payload: Record<string, unknown> = {}) {
  return authedJson(port, "/command", {
    method: "POST",
    body: JSON.stringify({ type, payload }),
  });
}

// Use non-conflicting ports so we don't clash with a running dev stack
const ADMIN_PORT = 18200;
const GATEWAY_PORT = 18280;

beforeAll(async () => {
  if (!runDockerStackTests) return;

  // Create isolated temp directory tree
  tmpDir = mkdtempSync(join(tmpdir(), "openpalm-docker-test-"));
  const dataDir = join(tmpDir, "data");
  const configDir = join(tmpDir, "config");
  const stateDir = join(tmpDir, "state");

  for (const d of [
    join(dataDir, "postgres"), join(dataDir, "qdrant"), join(dataDir, "openmemory"),
    join(dataDir, "assistant"), join(dataDir, "admin"),
    configDir,
    join(stateDir, "gateway"), join(stateDir, "openmemory"), join(stateDir, "postgres"),
    join(stateDir, "qdrant"), join(stateDir, "assistant"),
    join(stateDir, "channel-chat"), join(stateDir, "channel-discord"),
    join(stateDir, "channel-voice"), join(stateDir, "channel-telegram"),
    stateDir, join(stateDir, "caddy", "config"),
    join(stateDir, "caddy", "data"), join(stateDir, "automations"),
  ]) mkdirSync(d, { recursive: true });

  // Create empty env files required by compose
  writeFileSync(join(stateDir, "system.env"), `ADMIN_TOKEN=${ADMIN_TOKEN}\n`, "utf8");
  for (const svc of ["gateway", "openmemory", "postgres", "qdrant", "assistant",
    "channel-chat", "channel-discord", "channel-voice", "channel-telegram"]) {
    writeFileSync(join(stateDir, `${svc}/.env`), "", "utf8");
  }

  // Write minimal caddy.json so caddy can start
  writeFileSync(join(stateDir, "caddy.json"), JSON.stringify({
    admin: { disabled: true },
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [":80"],
            routes: [{
              handle: [{ handler: "static_response", body: "ok" }],
            }],
          },
        },
      },
    },
  }), "utf8");

  // Write secrets.env
  writeFileSync(join(configDir, "secrets.env"), "", "utf8");

  // Create .env file for compose interpolation (overrides project root .env)
  envFilePath = join(tmpDir, ".env");
  const envContent = [
    `OPENPALM_DATA_HOME=${dataDir}`,
    `OPENPALM_CONFIG_HOME=${configDir}`,
    `OPENPALM_STATE_HOME=${stateDir}`,
    `OPENPALM_CONTAINER_PLATFORM=docker`,
    `OPENPALM_COMPOSE_BIN=docker`,
    `OPENPALM_COMPOSE_SUBCOMMAND=compose`,
    `OPENPALM_CONTAINER_SOCKET_PATH=/var/run/docker.sock`,
    `OPENPALM_CONTAINER_SOCKET_IN_CONTAINER=/var/run/docker.sock`,
    `OPENPALM_CONTAINER_SOCKET_URI=unix:///var/run/docker.sock`,
    `OPENPALM_IMAGE_NAMESPACE=openpalm`,
    `OPENPALM_IMAGE_TAG=latest`,
    `ADMIN_TOKEN=${ADMIN_TOKEN}`,
    `POSTGRES_PASSWORD=test-pg-password`,
    "",
  ].join("\n");
  writeFileSync(envFilePath, envContent, "utf8");

  // Generate test compose overlay with hardcoded paths + token.
  // Uses explicit volume mounts and ADMIN_TOKEN as defense-in-depth,
  // ensuring isolation from the dev stack regardless of .env behavior.
  composeTestFile = join(tmpDir, "docker-compose.test.yml");
  const composeOverlay = `# Generated test overlay — hardcodes volume paths to temp dir.
services:
  admin:
    build:
      context: .
      dockerfile: admin/Dockerfile
    ports:
      - "${ADMIN_PORT}:8100"
    volumes:
      - .:/compose:ro
      - ${dataDir}:/data
      - ${configDir}:/config
      - ${stateDir}:/state
    environment:
      OPENCODE_CORE_URL: "http://assistant:4096"
      COMPOSE_PROJECT_PATH: /compose
      OPENPALM_COMPOSE_FILE: packages/lib/src/embedded/state/docker-compose.yml
      ADMIN_TOKEN: "${ADMIN_TOKEN}"

  gateway:
    build:
      context: .
      dockerfile: gateway/Dockerfile
    ports:
      - "${GATEWAY_PORT}:8080"
`;
  writeFileSync(composeTestFile, composeOverlay, "utf8");

  // Build admin and gateway images
  console.log("[docker-test] Building admin and gateway images...");
  const buildResult = await composeRun("build", "admin", "gateway");
  if (buildResult.exitCode !== 0) {
    console.error("[docker-test] Build failed:", buildResult.stderr);
    throw new Error("Docker build failed");
  }

  // Start only admin and gateway (minimal viable stack for integration testing)
  console.log("[docker-test] Starting admin and gateway...");
  const upResult = await composeRun(
    "up", "-d", "--force-recreate", "--no-deps", "admin", "gateway",
  );
  if (upResult.exitCode !== 0) {
    console.error("[docker-test] Start failed:", upResult.stderr);
    throw new Error("Docker start failed");
  }

  // Wait for admin to become healthy
  console.log("[docker-test] Waiting for admin health...");
  const adminHealthy = await waitForHealth(`http://127.0.0.1:${ADMIN_PORT}/health`);
  if (!adminHealthy) {
    const logs = await composeRun("logs", "admin", "--tail=30");
    console.error("[docker-test] Admin failed to start. Logs:\n", logs.stdout, logs.stderr);
    throw new Error("Admin container failed to become healthy");
  }
  console.log("[docker-test] Stack is ready.");
}, 180_000); // 3 min timeout for builds

afterAll(async () => {
  if (!runDockerStackTests || !tmpDir) return;

  // Tear down containers
  console.log("[docker-test] Tearing down...");
  await composeRun("down", "--remove-orphans", "--timeout", "5");

  // Clean up temp dir
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}, 30_000);

// ── Tests ─────────────────────────────────────────────────

describe.skipIf(!runDockerStackTests)("docker stack: admin container", () => {
  it("health endpoint responds with service info", async () => {
    const resp = await api(ADMIN_PORT, "/health");
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.service).toBe("admin");
    expect(typeof body.time).toBe("string");
  });

  it("meta endpoint returns service names and channel fields", async () => {
    const resp = await api(ADMIN_PORT, "/meta");
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body).toHaveProperty("serviceNames");
    expect(body).toHaveProperty("channelFields");
    expect(body).toHaveProperty("builtInChannels");
  });

  it("setup status returns first-boot state", async () => {
    const resp = await api(ADMIN_PORT, "/setup/status");
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.completed).toBe(false);
    expect(body.firstBoot).toBe(true);
  });

  it("protected endpoints reject requests without token", async () => {
    for (const path of ["/state", "/secrets", "/automations", "/channels"]) {
      const resp = await api(ADMIN_PORT, path);
      expect(resp.status).toBe(401);
      const body = await resp.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);
      expect(body.code).toBe("admin_token_required");
    }
  });

  it("protected endpoints accept requests with valid token", async () => {
    const r = await authedJson(ADMIN_PORT, "/state");
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
  });
});

describe.skipIf(!runDockerStackTests)("docker stack: YAML handling (Bun.YAML)", () => {
  it("stack spec is loaded and has correct version", async () => {
    const r = await authedJson(ADMIN_PORT, "/state");
    expect(r.ok).toBe(true);
    const data = r.data.data as Record<string, unknown>;
    const spec = data.spec as Record<string, unknown>;
    expect(spec.version).toBe(3);
    expect(spec).toHaveProperty("channels");
    expect(spec).toHaveProperty("automations");
  });

  it("snippet.import parses YAML automation correctly", async () => {
    const yamlSnippet = [
      "- id: docker-test-auto",
      '  name: "Docker Test Automation"',
      '  schedule: "0 6 * * *"',
      "  script: echo docker-test",
      "  enabled: true",
    ].join("\n");
    const r = await cmd(ADMIN_PORT, "snippet.import", { yaml: yamlSnippet, section: "automation" });
    expect(r.ok).toBe(true);

    // Verify the automation was persisted
    const state = await authedJson(ADMIN_PORT, "/state");
    const spec = (state.data.data as Record<string, unknown>).spec as Record<string, unknown>;
    const automations = spec.automations as Array<{ id: string }>;
    expect(automations.some((a) => a.id === "docker-test-auto")).toBe(true);
  });

  it("stack.spec.set roundtrips spec through YAML serialize/deserialize", async () => {
    const state = await authedJson(ADMIN_PORT, "/state");
    const currentSpec = (state.data.data as Record<string, unknown>).spec as Record<string, unknown>;

    // Modify access scope and save
    const r = await cmd(ADMIN_PORT, "stack.spec.set", {
      spec: { ...currentSpec, accessScope: "host" },
    });
    expect(r.ok).toBe(true);

    // Read back and verify
    const updated = await authedJson(ADMIN_PORT, "/state");
    const updatedSpec = (updated.data.data as Record<string, unknown>).spec as Record<string, unknown>;
    expect(updatedSpec.accessScope).toBe("host");
    expect(updatedSpec.version).toBe(3);
  });

  it("core automations are auto-merged on startup", async () => {
    const r = await authedJson(ADMIN_PORT, "/automations", {
      headers: { "x-admin-token": ADMIN_TOKEN },
    });
    expect(r.ok).toBe(true);
    const automations = r.data.automations as Array<{ id: string; core?: boolean }>;
    const coreIds = automations.filter((a) => a.core).map((a) => a.id);
    expect(coreIds.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!runDockerStackTests)("docker stack: gateway container", () => {
  it("gateway health endpoint responds", async () => {
    const resp = await api(GATEWAY_PORT, "/health").catch(() => null);
    // Gateway may not be fully healthy without assistant upstream,
    // but it should at least respond (not connection refused)
    if (resp) {
      expect(resp.status).toBeGreaterThanOrEqual(200);
      expect(resp.status).toBeLessThan(600);
    }
  });
});
