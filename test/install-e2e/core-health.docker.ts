/**
 * Install E2E: Core Health Gate
 *
 * Verifies that after setup completion, core services are running and
 * container healthchecks pass. This test uses the same compose overlay
 * as the happy-path test but additionally asserts compose ps state.
 *
 * Run:
 *   OPENPALM_RUN_DOCKER_STACK_TESTS=1 bun test ./test/install-e2e/core-health.docker.ts
 *
 * Or via package.json script:
 *   bun run test:install:core-health
 *
 * Requirements: Docker daemon running.
 */
import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveHostPort } from "../helpers/docker-compose-port.ts";
import { parseCoreHealth } from "./helpers/core-health.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const PROJECT_NAME = "openpalm-core-health-e2e";
const ADMIN_TOKEN = "test-e2e-health-token";
let ADMIN_PORT: number;

const dockerAvailable = await Bun.spawn(["docker", "info"], {
  stdout: "pipe", stderr: "pipe",
}).exited.then((code) => code === 0).catch(() => false);
const runDockerStackTests = dockerAvailable && Bun.env.OPENPALM_RUN_DOCKER_STACK_TESTS !== "0";

let tmpDir: string;
let composeTestFile: string;
let envFilePath: string;

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
  const stdout = (await new Response(proc.stdout).text()).trim();
  const stderr = (await new Response(proc.stderr).text()).trim();
  return { exitCode, stdout, stderr };
}

async function waitForHealth(url: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return true;
    } catch { /* not ready */ }
    await Bun.sleep(1000);
  }
  return false;
}

function api(path: string, init?: RequestInit) {
  return fetch(`http://127.0.0.1:${ADMIN_PORT}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      "x-admin-token": ADMIN_TOKEN,
    },
  });
}

function setupPost(path: string, body: unknown) {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify(body),
  });
}

function cmd(type: string, payload: Record<string, unknown> = {}) {
  return setupPost("/command", { type, payload });
}

beforeAll(async () => {
  if (!runDockerStackTests) return;

  tmpDir = mkdtempSync(join(tmpdir(), "openpalm-core-health-e2e-"));
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
    stateDir, join(stateDir, "caddy", "config"), join(stateDir, "caddy", "data"),
    join(stateDir, "automations"),
  ]) mkdirSync(d, { recursive: true });

  writeFileSync(join(stateDir, "system.env"), `ADMIN_TOKEN=${ADMIN_TOKEN}\n`, "utf8");
  for (const svc of ["gateway", "openmemory", "postgres", "qdrant", "assistant",
    "channel-chat", "channel-discord", "channel-voice", "channel-telegram"]) {
    writeFileSync(join(stateDir, `${svc}/.env`), "", "utf8");
  }
  writeFileSync(join(stateDir, "caddy.json"), JSON.stringify({
    admin: { disabled: true },
    apps: { http: { servers: { srv0: { listen: [":80"], routes: [{ handle: [{ handler: "static_response", body: "ok" }] }] } } } },
  }), "utf8");
  writeFileSync(join(configDir, "secrets.env"), "", "utf8");

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
    `CORE_READINESS_MAX_ATTEMPTS=2`,
    `CORE_READINESS_POLL_MS=500`,
    "",
  ].join("\n");
  writeFileSync(envFilePath, envContent, "utf8");

  composeTestFile = join(stateDir, "docker-compose.test.yml");
  const composeOverlay = `services:
  admin:
    build:
      context: .
      dockerfile: core/admin/Dockerfile
    ports:
      - "0:8100"
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
      CORE_READINESS_MAX_ATTEMPTS: "2"
      CORE_READINESS_POLL_MS: "500"

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

  console.log("[core-health-e2e] Building admin image...");
  const buildResult = await composeRun("build", "admin");
  if (buildResult.exitCode !== 0) {
    console.error("[core-health-e2e] Build failed:", buildResult.stderr);
    throw new Error("Docker build failed");
  }

  console.log("[core-health-e2e] Starting admin...");
  const upResult = await composeRun("up", "-d", "--force-recreate", "--no-deps", "admin");
  if (upResult.exitCode !== 0) {
    console.error("[core-health-e2e] Start failed:", upResult.stderr);
    throw new Error("Docker start failed");
  }

  const composeBaseArgs = [
    "-p", PROJECT_NAME, "--env-file", envFilePath,
    "-f", composeTestFile, "--project-directory", REPO_ROOT,
  ];
  ADMIN_PORT = await resolveHostPort(composeBaseArgs, "admin", 8100, REPO_ROOT);

  console.log(`[core-health-e2e] Admin on port ${ADMIN_PORT}`);
  const adminHealthy = await waitForHealth(`http://127.0.0.1:${ADMIN_PORT}/health`);
  if (!adminHealthy) {
    const logs = await composeRun("logs", "admin", "--tail=30");
    console.error("[core-health-e2e] Admin failed to start. Logs:\n", logs.stdout, logs.stderr);
    throw new Error("Admin container failed to become healthy");
  }
  console.log("[core-health-e2e] Admin is ready.");
}, 180_000);

afterAll(async () => {
  if (!runDockerStackTests || !tmpDir) return;
  console.log("[core-health-e2e] Tearing down...");
  await composeRun("down", "--remove-orphans", "--timeout", "5");
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}, 30_000);

// ── Tests ─────────────────────────────────────────────────
describe.skipIf(!runDockerStackTests)("install e2e: core health gate", () => {
  it("runs setup wizard to completion", async () => {
    await setupPost("/setup/step", { step: "welcome" });
    await cmd("setup.profile", { name: "Health Test", email: "h@t.local", password: ADMIN_TOKEN });
    await setupPost("/setup/step", { step: "profile" });
    await cmd("setup.service_instances", { anthropicApiKey: "sk-ant-test" });
    await setupPost("/setup/step", { step: "serviceInstances" });
    await cmd("setup.access_scope", { scope: "host" });
    await setupPost("/setup/step", { step: "accessScope" });
    await cmd("setup.channels", { channels: [] });
    await setupPost("/setup/step", { step: "channels" });
    await setupPost("/setup/step", { step: "security" });
    await setupPost("/setup/step", { step: "healthCheck" });

    const completeResp = await setupPost("/setup/complete", {});
    expect(completeResp.status).toBe(200);
    const body = await completeResp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  it("verifies compose ps shows running containers after setup", async () => {
    // Give containers a moment to start
    await Bun.sleep(2000);

    const psResult = await composeRun("ps", "--format", "json");
    expect(psResult.exitCode).toBe(0);

    const health = parseCoreHealth(psResult.stdout, ["admin"]);
    expect(health.running).toContain("admin");
  });

  it("admin healthcheck endpoint returns ok after setup", async () => {
    const resp = await api("/health");
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
  });

  it("setup.retry_core command returns readiness snapshot", async () => {
    const resp = await cmd("setup.retry_core");
    expect(resp.status).toBe(200);
    const body = await resp.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.data).toBeDefined();
    const data = body.data as Record<string, unknown>;
    expect(data.phase).toBeDefined();
  });
});
