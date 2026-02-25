/**
 * Install E2E: Setup Wizard Happy-Path
 *
 * Drives the setup wizard API in sequence against a real Docker-built admin
 * container with OPENPALM_TEST_MODE absent (compose apply runs for real).
 * Asserts completed: true and that unauthenticated requests get 401.
 *
 * Run:
 *   OPENPALM_RUN_DOCKER_STACK_TESTS=1 bun test ./test/install-e2e/happy-path.docker.ts
 *
 * Or via package.json script:
 *   bun run test:install:smoke
 *
 * Requirements: Docker daemon running.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const PROJECT_NAME = "openpalm-install-e2e";
const TIMEOUT = 15_000;
const ADMIN_TOKEN = "test-e2e-wizard-token"; // ≥8 chars, satisfies password validation
const ADMIN_PORT = 18300; // Non-conflicting with docker-stack tests (18200)

// ── Docker availability check ─────────────────────────────
const dockerAvailable = await Bun.spawn(["docker", "info"], {
  stdout: "pipe", stderr: "pipe",
}).exited.then((code) => code === 0).catch(() => false);
const runDockerStackTests = dockerAvailable && Bun.env.OPENPALM_RUN_DOCKER_STACK_TESTS !== "0";

// ── Temp directory state ──────────────────────────────────
let tmpDir: string;
let composeTestFile: string;
let envFilePath: string;

// ── Helper: run docker compose ────────────────────────────
function compose(...args: string[]) {
  return Bun.spawn(
    ["docker", "compose", "-p", PROJECT_NAME, "--env-file", envFilePath,
      "-f", composeTestFile, "--project-directory", REPO_ROOT, ...args],
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

// ── Helper: poll until healthy ────────────────────────────
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

// ── HTTP helpers ──────────────────────────────────────────
function api(path: string, opts?: RequestInit) {
  return fetch(`http://127.0.0.1:${ADMIN_PORT}${path}`, {
    ...opts,
    signal: AbortSignal.timeout(TIMEOUT),
  });
}

function authedJson(path: string, opts?: RequestInit) {
  return api(path, {
    ...opts,
    headers: {
      "content-type": "application/json",
      "x-admin-token": ADMIN_TOKEN,
      ...(opts?.headers as Record<string, string> ?? {}),
    },
  }).then(async (r) => ({ ok: r.ok, status: r.status, data: await r.json() as Record<string, unknown> }));
}

function setupPost(path: string, body: unknown) {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function cmd(type: string, payload: Record<string, unknown> = {}) {
  return setupPost("/command", { type, payload });
}

// ── beforeAll: build, start, wait ────────────────────────
beforeAll(async () => {
  if (!runDockerStackTests) return;

  // Create isolated temp directory tree
  tmpDir = mkdtempSync(join(tmpdir(), "openpalm-install-e2e-"));
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

  // Write system.env with initial ADMIN_TOKEN
  writeFileSync(join(stateDir, "system.env"), `ADMIN_TOKEN=${ADMIN_TOKEN}\n`, "utf8");

  // Write empty .env files for each service state dir
  for (const svc of ["gateway", "openmemory", "postgres", "qdrant", "assistant",
    "channel-chat", "channel-discord", "channel-voice", "channel-telegram"]) {
    writeFileSync(join(stateDir, `${svc}/.env`), "", "utf8");
  }

  // Write minimal caddy.json so caddy stub can start
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

  // Write empty secrets.env
  writeFileSync(join(configDir, "secrets.env"), "", "utf8");

  // Write .env file for compose interpolation
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

  // Write compose overlay:
  // - admin: real build, port exposed, volumes mounted, NO OPENPALM_TEST_MODE
  // - all SetupCoreServices: busybox stubs so compose up succeeds in setup.complete
  // Key: written to stateDir so it's accessible inside the container via same-path mount.
  // Key: OPENPALM_COMPOSE_FILE points admin's compose calls at this test overlay
  //      (with busybox stubs) rather than the generated docker-compose.yml (real images).
  composeTestFile = join(stateDir, "docker-compose.test.yml");
  const composeOverlay = `# Generated install-e2e overlay — hardcodes volume paths to temp dir.
# Key: OPENPALM_TEST_MODE is NOT set so setup.complete runs the real compose path.
# Key: volumes use identical host:container paths so STATE_ROOT paths are host-resolvable by compose.
# Key: OPENPALM_COMPOSE_FILE set to this file so admin's compose up uses busybox stubs.
services:
  admin:
    build:
      context: .
      dockerfile: core/admin/Dockerfile
    ports:
      - "${ADMIN_PORT}:8100"
    volumes:
      - .:/compose:ro
      - ${dataDir}:${dataDir}
      - ${configDir}:${configDir}
      - ${stateDir}:${stateDir}
      - /var/run/docker.sock:/var/run/docker.sock
    environment:
      OPENCODE_CORE_URL: "http://assistant:4096"
      PORT: "8100"
      COMPOSE_PROJECT_PATH: ${stateDir}
      OPENPALM_COMPOSE_FILE: docker-compose.test.yml
      ADMIN_TOKEN: "${ADMIN_TOKEN}"
      OPENPALM_DATA_ROOT: "${dataDir}"
      OPENPALM_CONFIG_ROOT: "${configDir}"
      OPENPALM_STATE_ROOT: "${stateDir}"
      OPENPALM_COMPOSE_BIN: docker
      OPENPALM_COMPOSE_SUBCOMMAND: compose
      OPENPALM_CONTAINER_SOCKET_URI: unix:///var/run/docker.sock
      OPENPALM_CONTAINER_SOCKET_PATH: /var/run/docker.sock
      OPENPALM_CONTAINER_SOCKET_IN_CONTAINER: /var/run/docker.sock
      OPENPALM_IMAGE_NAMESPACE: openpalm
      OPENPALM_IMAGE_TAG: latest

  assistant:
    image: busybox
    command: ["sleep", "infinity"]

  gateway:
    image: busybox
    command: ["sleep", "infinity"]

  openmemory:
    image: busybox
    command: ["sleep", "infinity"]

  openmemory-ui:
    image: busybox
    command: ["sleep", "infinity"]

  postgres:
    image: busybox
    command: ["sleep", "infinity"]

  qdrant:
    image: busybox
    command: ["sleep", "infinity"]

  caddy:
    image: busybox
    command: ["sleep", "infinity"]
`;
  writeFileSync(composeTestFile, composeOverlay, "utf8");

  // Build admin image
  console.log("[install-e2e] Building admin image...");
  const buildResult = await composeRun("build", "admin");
  if (buildResult.exitCode !== 0) {
    console.error("[install-e2e] Build failed:", buildResult.stderr);
    throw new Error("Docker build failed");
  }

  // Start admin (busybox stubs will be pulled/started on demand by setup.complete)
  console.log("[install-e2e] Starting admin...");
  const upResult = await composeRun("up", "-d", "--force-recreate", "--no-deps", "admin");
  if (upResult.exitCode !== 0) {
    console.error("[install-e2e] Start failed:", upResult.stderr);
    throw new Error("Docker start failed");
  }

  // Wait for admin to become healthy
  console.log("[install-e2e] Waiting for admin health...");
  const adminHealthy = await waitForHealth(`http://127.0.0.1:${ADMIN_PORT}/health`);
  if (!adminHealthy) {
    const logs = await composeRun("logs", "admin", "--tail=30");
    console.error("[install-e2e] Admin failed to start. Logs:\n", logs.stdout, logs.stderr);
    throw new Error("Admin container failed to become healthy");
  }
  console.log("[install-e2e] Admin is ready.");
}, 180_000);

// ── afterAll: tear down ───────────────────────────────────
afterAll(async () => {
  if (!runDockerStackTests || !tmpDir) return;

  console.log("[install-e2e] Tearing down...");
  await composeRun("down", "--remove-orphans", "--timeout", "5");

  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}, 30_000);

// ── Tests ─────────────────────────────────────────────────
describe.skipIf(!runDockerStackTests)("install e2e: setup wizard happy path", () => {
  it("GET /setup/status — first-boot state", async () => {
    const resp = await api("/setup/status");
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.completed).toBe(false);
    expect(body.firstBoot).toBe(true);
  });

  it("POST /setup/step welcome — marks welcome step complete", async () => {
    const resp = await setupPost("/setup/step", { step: "welcome" });
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    const state = body.state as Record<string, unknown>;
    const steps = state.steps as Record<string, unknown>;
    expect(steps.welcome).toBe(true);
  });

  it("POST /command setup.profile — saves name, email, password", async () => {
    const resp = await cmd("setup.profile", {
      name: "E2E Test User",
      email: "e2e@test.local",
      password: ADMIN_TOKEN,
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    const data = body.data as Record<string, unknown>;
    const state = data.state as Record<string, unknown>;
    const profile = state.profile as Record<string, unknown>;
    expect(profile.name).toBe("E2E Test User");

    // Mark profile step complete
    const stepResp = await setupPost("/setup/step", { step: "profile" });
    expect(stepResp.status).toBe(200);
  });

  it("POST /command setup.service_instances — anthropic key accepted", async () => {
    const resp = await cmd("setup.service_instances", {
      anthropicApiKey: "sk-ant-test-key-for-e2e",
    });
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);

    // Mark serviceInstances step complete
    const stepResp = await setupPost("/setup/step", { step: "serviceInstances" });
    expect(stepResp.status).toBe(200);
  });

  it("POST /command setup.access_scope — sets host scope", async () => {
    const resp = await cmd("setup.access_scope", { scope: "host" });
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    const data = body.data as Record<string, unknown>;
    expect(data.accessScope).toBe("host");

    // Mark accessScope step complete
    const stepResp = await setupPost("/setup/step", { step: "accessScope" });
    expect(stepResp.status).toBe(200);
  });

  it("POST /command setup.channels — empty selection accepted", async () => {
    const resp = await cmd("setup.channels", { channels: [] });
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);

    // Mark channels step complete
    const stepResp = await setupPost("/setup/step", { step: "channels" });
    expect(stepResp.status).toBe(200);
  });

  it("POST /setup/step security + healthCheck — bookkeeping steps complete", async () => {
    const secResp = await setupPost("/setup/step", { step: "security" });
    expect(secResp.status).toBe(200);
    const secBody = await secResp.json() as Record<string, unknown>;
    expect(secBody.ok).toBe(true);

    const hcResp = await setupPost("/setup/step", { step: "healthCheck" });
    expect(hcResp.status).toBe(200);
    const hcBody = await hcResp.json() as Record<string, unknown>;
    expect(hcBody.ok).toBe(true);
  });

  it("POST /command setup.complete — real compose path, returns completed: true", async () => {
    const resp = await cmd("setup.complete", {});
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    const data = body.data as Record<string, unknown>;
    expect(data.completed).toBe(true);
  });

  it("GET /setup/status (authed) — completed: true, firstBoot: false", async () => {
    // After setup completes, unauthenticated /setup/status returns 401
    const r = await authedJson("/setup/status");
    expect(r.status).toBe(200);
    expect(r.data.completed).toBe(true);
    expect(r.data.firstBoot).toBe(false);
  });

  it("protected endpoints reject unauthenticated requests after setup complete", async () => {
    for (const path of ["/state", "/secrets"]) {
      const resp = await api(path);
      expect(resp.status).toBe(401);
      const body = await resp.json() as Record<string, unknown>;
      expect(body.ok).toBe(false);
      expect(body.code).toBe("admin_token_required");
    }
  });
});
