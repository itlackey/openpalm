/**
 * Tests for lifecycle.ts — state factory, lifecycle helpers, compose builders,
 * caller normalization.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync
} from "node:fs";
import { join } from "node:path";

import {
  createState,
  applyInstall,
  applyUpdate,
  applyUninstall,
  updateStackEnvToLatestImageTag,
  buildComposeFileList,
  normalizeCaller,
  randomHex,
  writeStackSpec,
  CORE_SERVICES,
  OPTIONAL_SERVICES,
  type StackSpec,
} from "@openpalm/lib";
import { makeTempDir, makeTestState, trackDir, registerCleanup } from "./test-helpers.js";

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
  test("starts with core compose from stack/", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    // Create the core.compose.yml so it's found
    mkdirSync(join(state.homeDir, "stack"), { recursive: true });
    writeFileSync(join(state.homeDir, "stack", "core.compose.yml"), "services: {}");

    const files = buildComposeFileList(state);
    expect(files[0]).toBe(`${state.homeDir}/stack/core.compose.yml`);
  });

  test("includes addon overlays from stack/addons/", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    const stackDir = join(state.homeDir, "stack");
    const addonsDir = join(stackDir, "addons");
    mkdirSync(stackDir, { recursive: true });
    writeFileSync(join(stackDir, "core.compose.yml"), "services: {}");

    // Seed stack.yml with chat addon enabled via lib's writeStackSpec
    const chatSpec: StackSpec = {
      version: 2,
      capabilities: { llm: "test/model", embeddings: { provider: "test", model: "test", dims: 768 }, memory: { userId: "test" } },
      addons: { chat: true },
    };
    writeStackSpec(join(state.homeDir, "config"), chatSpec);

    // Create the addon compose file
    mkdirSync(join(addonsDir, "chat"), { recursive: true });
    writeFileSync(join(addonsDir, "chat", "compose.yml"), "services: {}");

    const files = buildComposeFileList(state);
    expect(files).toHaveLength(2);
    expect(files[1]).toContain("chat");
  });

  test("does not include removed overlays", () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    mkdirSync(join(state.homeDir, "stack"), { recursive: true });
    writeFileSync(join(state.homeDir, "stack", "core.compose.yml"), "services: {}");

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
    origEnv.OP_ADMIN_TOKEN = process.env.OP_ADMIN_TOKEN;
  });

  afterEach(() => {
    process.env.OP_HOME = origEnv.OP_HOME;
    process.env.OP_ADMIN_TOKEN = origEnv.OP_ADMIN_TOKEN;
  });

  test("reads OP_ADMIN_TOKEN from vault/stack/stack.env file", () => {
    const base = trackDir(makeTempDir());
    process.env.OP_HOME = base;
    delete process.env.OP_ADMIN_TOKEN;
    delete process.env.OP_ADMIN_TOKEN;

    const vaultDir = join(base, "vault");
    mkdirSync(join(vaultDir, "stack"), { recursive: true });
    writeFileSync(
      join(vaultDir, "stack", "stack.env"),
      "OP_ADMIN_TOKEN=file-token\n"
    );

    const state = createState();
    expect(state.adminToken).toBe("file-token");
  });

  test("uses explicit adminToken parameter over file/env", () => {
    const base = trackDir(makeTempDir());
    process.env.OP_HOME = base;
    process.env.OP_ADMIN_TOKEN = "env-token";

    const vaultDir = join(base, "vault");
    mkdirSync(join(vaultDir, "user"), { recursive: true });
    writeFileSync(join(vaultDir, "user", "user.env"), "OP_ADMIN_TOKEN=file-token\n");

    const state = createState("explicit-token");
    expect(state.adminToken).toBe("explicit-token");
  });

  test("initializes all core services as stopped", () => {
    const base = trackDir(makeTempDir());
    process.env.OP_HOME = base;

    const state = createState();
    for (const service of CORE_SERVICES) {
      expect(state.services[service]).toBe("stopped");
    }
  });
});

// ── Core Service Constants ──────────────────────────────────────────────

describe("CORE_SERVICES", () => {
  test("includes all expected core services", () => {
    expect(CORE_SERVICES).toContain("memory");
    expect(CORE_SERVICES).toContain("assistant");
    expect(CORE_SERVICES).toContain("guardian");
    expect(CORE_SERVICES).toContain("scheduler");
  });

  test("admin is an optional service, not core", () => {
    expect(CORE_SERVICES).not.toContain("admin");
    expect(OPTIONAL_SERVICES).toContain("admin");
    expect(OPTIONAL_SERVICES).toContain("docker-socket-proxy");
  });

  test("has exactly 4 core services", () => {
    expect(CORE_SERVICES).toHaveLength(4);
  });

  test("has exactly 2 optional services", () => {
    expect(OPTIONAL_SERVICES).toHaveLength(2);
  });
});

// ── Lifecycle State Transitions ─────────────────────────────────────────

describe("applyInstall", () => {
  test("marks all core services as running", async () => {
    const state = makeTestState();
    trackDir(state.homeDir);

    // Initialize services as stopped
    for (const service of CORE_SERVICES) {
      state.services[service] = "stopped";
    }

    // Create required dirs for writeRuntimeFiles
    mkdirSync(join(state.homeDir, "stack"), { recursive: true });
    mkdirSync(join(state.vaultDir), { recursive: true });

    await applyInstall(state);

    for (const service of CORE_SERVICES) {
      expect(state.services[service]).toBe("running");
    }
  });
});

describe("applyUpdate", () => {
  test("returns list of running services that were restarted", async () => {
    const state = makeTestState();
    trackDir(state.homeDir);
    state.services = { admin: "running", guardian: "running", memory: "stopped" };

    mkdirSync(join(state.homeDir, "stack"), { recursive: true });
    mkdirSync(join(state.vaultDir), { recursive: true });

    const result = await applyUpdate(state);
    expect(result.restarted).toContain("admin");
    expect(result.restarted).toContain("guardian");
    expect(result.restarted).not.toContain("memory");
  });
});

describe("applyUninstall", () => {
  test("stops all services", async () => {
    const state = makeTestState();
    trackDir(state.homeDir);
    state.services = { admin: "running", guardian: "running" };

    mkdirSync(join(state.homeDir, "stack"), { recursive: true });
    mkdirSync(join(state.vaultDir), { recursive: true });

    const result = await applyUninstall(state);
    expect(result.stopped).toContain("admin");
    expect(result.stopped).toContain("guardian");

    for (const status of Object.values(state.services)) {
      expect(status).toBe("stopped");
    }
  });
});

describe("updateStackEnvToLatestImageTag", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("updates OP_IMAGE_TAG in vault/stack/stack.env", async () => {
    const state = makeTestState();
    trackDir(state.homeDir);
    mkdirSync(join(state.vaultDir, "stack"), { recursive: true });
    writeFileSync(
      join(state.vaultDir, "stack", "stack.env"),
      "OP_IMAGE_NAMESPACE=openpalm\nOP_IMAGE_TAG=v0.1.0\n"
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [{ name: "latest" }, { name: "v0.7.7" }, { name: "v0.7.6" }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const result = await updateStackEnvToLatestImageTag(state);
    const updated = readFileSync(join(state.vaultDir, "stack", "stack.env"), "utf-8");

    expect(result.namespace).toBe("openpalm");
    expect(result.tag).toBe("v0.7.7");
    expect(updated).toContain("OP_IMAGE_TAG=v0.7.7");
  });

  test("throws when docker tag lookup fails", async () => {
    const state = makeTestState();
    trackDir(state.homeDir);
    mkdirSync(join(state.vaultDir, "stack"), { recursive: true });
    writeFileSync(join(state.vaultDir, "stack", "stack.env"), "OP_IMAGE_NAMESPACE=openpalm\n");

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad gateway", { status: 502 }));

    await expect(updateStackEnvToLatestImageTag(state)).rejects.toThrow("Docker tag lookup failed");
  });
});
