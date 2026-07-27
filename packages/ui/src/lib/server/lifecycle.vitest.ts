/**
 * Tests for lifecycle.ts — state factory, lifecycle helpers, compose builders,
 * caller normalization.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

import {
  createState,
  applyInstall,
  applyUpdate,
  applyUninstall,
  buildComposeFileList,
  normalizeCaller,
  randomHex,
  CORE_SERVICES,
  readSecret,
} from "@openpalm/lib";
import { makeTempDir, makeTestState, trackDir, registerCleanup, seedSecretsEnv } from "./test-helpers.js";

registerCleanup();

// ── Pure Utility Functions ──────────────────────────────────────────────

describe("randomHex", () => {
  test("returns hex string of expected length", () => {
    const result = randomHex(16);
    expect(result).toHaveLength(32); // 16 bytes = 32 hex chars
    expect(result).toMatch(/^[a-f0-9]+$/);
  });

  test("returns different values on successive calls", () => {
    const a = randomHex(16);
    const b = randomHex(16);
    expect(a).not.toBe(b);
  });

  test("respects byte count parameter", () => {
    expect(randomHex(4)).toHaveLength(8);
    expect(randomHex(32)).toHaveLength(64);
    expect(randomHex(1)).toHaveLength(2);
  });
});

// ── Caller Normalization ────────────────────────────────────────────────

describe("normalizeCaller", () => {
  test("normalizes valid caller types", () => {
    expect(normalizeCaller("assistant")).toBe("assistant");
    expect(normalizeCaller("cli")).toBe("cli");
    expect(normalizeCaller("ui")).toBe("ui");
    expect(normalizeCaller("system")).toBe("system");
    expect(normalizeCaller("test")).toBe("test");
  });

  test("handles case-insensitive input", () => {
    expect(normalizeCaller("UI")).toBe("ui");
    expect(normalizeCaller("CLI")).toBe("cli");
    expect(normalizeCaller("System")).toBe("system");
  });

  test("trims whitespace", () => {
    expect(normalizeCaller("  ui  ")).toBe("ui");
  });

  test("returns 'unknown' for invalid callers", () => {
    expect(normalizeCaller("")).toBe("unknown");
    expect(normalizeCaller("browser")).toBe("unknown");
    expect(normalizeCaller("api")).toBe("unknown");
    expect(normalizeCaller("admin")).toBe("unknown");
  });

  test("returns 'unknown' for null", () => {
    expect(normalizeCaller(null)).toBe("unknown");
  });
});

// ── Build Compose File List ─────────────────────────────────────────────

describe("buildComposeFileList", () => {
  test("starts with core compose from config/stack/", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    // Create the core.compose.yml at the new path
    mkdirSync(state.stackDir, { recursive: true });
    writeFileSync(join(state.stackDir, "core.compose.yml"), "services: {}");

    const files = buildComposeFileList(state);
    expect(files[0]).toBe(`${state.stackDir}/core.compose.yml`);
  });

  test("includes fixed custom compose file", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    mkdirSync(state.stackDir, { recursive: true });
    writeFileSync(join(state.stackDir, "core.compose.yml"), "services: {}");
    // custom.compose.yml is USER-owned → config/stack, not system/stack.
    const userStackDir = join(state.homeDir, "config", "stack");
    mkdirSync(userStackDir, { recursive: true });
    writeFileSync(join(userStackDir, "custom.compose.yml"), "services: {}");

    const files = buildComposeFileList(state);
    expect(files).toHaveLength(2);
    expect(files[1]).toContain("custom.compose.yml");
  });

  test("does not include removed overlays", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    mkdirSync(state.stackDir, { recursive: true });
    writeFileSync(join(state.stackDir, "core.compose.yml"), "services: {}");

    const files = buildComposeFileList(state);
    expect(files).toHaveLength(1); // just core compose
    expect(files.some((f) => f.includes("local-models.yml"))).toBe(false);
  });
});

// ── createState (exercises private loaders) ─────────────────────────────

describe("createState", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    origEnv.OP_HOME = process.env.OP_HOME;
  });

  afterEach(() => {
    process.env.OP_HOME = origEnv.OP_HOME;
  });

  // Phase 4 (auth/proxy refactor): createState() no longer carries an
  // adminToken / assistantToken — login auth lives in
  // process.env.OP_UI_LOGIN_PASSWORD and is read per-request in helpers.ts.

  test("returns a state with the expected directory shape", () => {
    const base = trackDir(makeTempDir());
    process.env.OP_HOME = base;
    const state = createState();
    expect(state.homeDir).toBe(base);
    expect(state.configDir).toBeDefined();
    expect(state.stackDir).toBeDefined();
  });

  test('does not write secrets or mutate process env', () => {
    const base = trackDir(makeTempDir());
    process.env.OP_HOME = base;
    delete process.env.OP_UI_LOGIN_PASSWORD;

    const state = createState();

    expect(readSecret(state.stackDir, 'op_ui_login_password')).toBeNull();
    expect(process.env.OP_UI_LOGIN_PASSWORD).toBeUndefined();
  });

  test("seeds the assistant as stopped; guardian is gated to channels", () => {
    const base = trackDir(makeTempDir());
    process.env.OP_HOME = base;

    // No channel addon enabled → guardian is NOT an expected service (it mirrors
    // the deploy gating, so the Overview doesn't report it perpetually stopped).
    const state = createState();
    expect(state.services.assistant).toBe("stopped");
    expect(state.services.guardian).toBeUndefined();
  });
});

// ── Core Service Constants ──────────────────────────────────────────────

describe("CORE_SERVICES", () => {
  test("includes all expected core services", () => {
    expect(CORE_SERVICES).toContain("assistant");
    expect(CORE_SERVICES).toContain("guardian");
  });

  test("scheduler is not a separate service (folded into assistant)", () => {
    // Scheduler runs as a co-process inside the assistant container; it is
    // not a separately addressable compose service.
    expect(CORE_SERVICES).not.toContain("scheduler" as never);
  });

  test("admin is not a service (host binary, not a container)", () => {
    expect(CORE_SERVICES).not.toContain("admin");
  });

  test("has exactly 2 core services", () => {
    expect(CORE_SERVICES).toHaveLength(2);
  });
});

// ── Lifecycle State Transitions ─────────────────────────────────────────

describe("applyInstall", () => {
  beforeEach(() => {
    process.env.OP_SKIP_COMPOSE_PREFLIGHT = '1';
    // F1 wired reconcileHostOwnership (which shells out to docker) into
    // applyInstall/performUpgrade; skip it here so these unit tests don't do
    // real docker I/O and time out.
    process.env.OP_SKIP_OWNERSHIP_RECONCILE = '1';
  });

  afterEach(() => {
    delete process.env.OP_SKIP_COMPOSE_PREFLIGHT;
    delete process.env.OP_SKIP_OWNERSHIP_RECONCILE;
  });

  test("marks the assistant running on install (guardian gated to channels)", async () => {
    const state = makeTestState();
    trackDir(state.homeDir);
    process.env.OP_HOME = state.homeDir;

    state.services = { assistant: "stopped" };

    // Create required dirs and seed core compose for writeRuntimeFiles
    mkdirSync(state.stackDir, { recursive: true });
    writeFileSync(join(state.stackDir, "core.compose.yml"), "services: {}");
    // applyInstall runs applyHome (dirs, secrets, overwrite system/, seed once).
    // A stack.env supplies OP_IMAGE_NAMESPACE for image resolution.
    seedSecretsEnv(state.homeDir, "OP_IMAGE_NAMESPACE=openpalm\n");

    await applyInstall(state);

    expect(state.services.assistant).toBe("running");
    // No channel addon → reconcileCore must NOT force-activate guardian.
    expect(state.services.guardian).toBeUndefined();
    // applyInstall does a full home seed (overwrites the whole skeleton system/
    // tree, generates secrets) — real, cold-cache-heavy file I/O that can exceed
    // vitest's aggressive 5s default on a loaded CI runner. Give it headroom.
  }, 30_000);
});

describe("applyUpdate", () => {
  beforeEach(() => {
    process.env.OP_SKIP_COMPOSE_PREFLIGHT = '1';
    // F1 wired reconcileHostOwnership (which shells out to docker) into
    // applyInstall/performUpgrade; skip it here so these unit tests don't do
    // real docker I/O and time out.
    process.env.OP_SKIP_OWNERSHIP_RECONCILE = '1';
  });

  afterEach(() => {
    delete process.env.OP_SKIP_COMPOSE_PREFLIGHT;
    delete process.env.OP_SKIP_OWNERSHIP_RECONCILE;
  });

  test("preserves prior service state", async () => {
    const state = makeTestState();
    trackDir(state.homeDir);
    process.env.OP_HOME = state.homeDir;
    state.services = { admin: "running", guardian: "running", assistant: "stopped" };

    mkdirSync(state.stackDir, { recursive: true });
    writeFileSync(join(state.stackDir, "core.compose.yml"), "services: {}");
    // A stack.env supplies OP_IMAGE_NAMESPACE for image resolution.
    seedSecretsEnv(state.homeDir, "OP_IMAGE_NAMESPACE=openpalm\n");

    await applyUpdate(state);

    expect(state.services.admin).toBe("running");
    expect(state.services.guardian).toBe("running");
    expect(state.services.assistant).toBe("stopped");
  });
});

describe("applyUninstall", () => {
  beforeEach(() => {
    process.env.OP_SKIP_COMPOSE_PREFLIGHT = '1';
    // F1 wired reconcileHostOwnership (which shells out to docker) into
    // applyInstall/performUpgrade; skip it here so these unit tests don't do
    // real docker I/O and time out.
    process.env.OP_SKIP_OWNERSHIP_RECONCILE = '1';
  });

  afterEach(() => {
    delete process.env.OP_SKIP_COMPOSE_PREFLIGHT;
    delete process.env.OP_SKIP_OWNERSHIP_RECONCILE;
  });

  test("stops all services", async () => {
    const state = makeTestState();
    trackDir(state.homeDir);
    process.env.OP_HOME = state.homeDir;
    state.services = { admin: "running", guardian: "running" };

    mkdirSync(state.stackDir, { recursive: true });
    writeFileSync(join(state.stackDir, "core.compose.yml"), "services: {}");
    // A stack.env supplies OP_IMAGE_NAMESPACE for image resolution.
    seedSecretsEnv(state.homeDir, "OP_IMAGE_NAMESPACE=openpalm\n");

    const result = await applyUninstall(state);
    expect(result.stopped).toContain("admin");
    expect(result.stopped).toContain("guardian");

    for (const status of Object.values(state.services)) {
      expect(status).toBe("stopped");
    }
  });
});
