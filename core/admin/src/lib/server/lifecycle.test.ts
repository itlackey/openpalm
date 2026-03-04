/**
 * Tests for lifecycle.ts — state factory, lifecycle helpers, compose builders,
 * caller/action validation.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  existsSync
} from "node:fs";
import { join } from "node:path";

import {
  createState,
  applyInstall,
  applyUpdate,
  applyUninstall,
  buildComposeFileList,
  normalizeCaller,
  isAllowedAction
} from "./lifecycle.js";
import { randomHex } from "./staging.js";
import { CORE_SERVICES } from "./types.js";
import { makeTempDir, makeTestState, trackDir, registerCleanup, seedConfigChannels } from "./test-helpers.js";

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

// ── Action Validation ───────────────────────────────────────────────────

describe("isAllowedAction", () => {
  test("allows documented actions from api-spec.md", () => {
    const validActions = [
      "install", "update", "upgrade", "uninstall",
      "containers.list", "containers.up",
      "containers.down", "containers.restart",
      "channels.list", "channels.install", "channels.uninstall",
      "extensions.list",
      "artifacts.list", "artifacts.get", "artifacts.manifest",
      "audit.list",
      "accessScope.get", "accessScope.set",
      "connections.get", "connections.patch", "connections.status"
    ];
    for (const action of validActions) {
      expect(isAllowedAction(action)).toBe(true);
    }
  });

  test("rejects invalid actions", () => {
    expect(isAllowedAction("")).toBe(false);
    expect(isAllowedAction("destroy")).toBe(false);
    expect(isAllowedAction("INSTALL")).toBe(false);
    expect(isAllowedAction("admin.delete")).toBe(false);
  });
});

// ── Build Compose File List ─────────────────────────────────────────────

describe("buildComposeFileList", () => {
  test("starts with core compose from artifacts dir", () => {
    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);

    const files = buildComposeFileList(state);
    expect(files[0]).toBe(`${state.stateDir}/artifacts/docker-compose.yml`);
  });

  test("includes staged channel overlays", () => {
    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);

    const channelsDir = join(state.stateDir, "artifacts", "channels");
    mkdirSync(channelsDir, { recursive: true });
    writeFileSync(join(channelsDir, "chat.yml"), "services: {}");

    const files = buildComposeFileList(state);
    expect(files).toHaveLength(2);
    expect(files[1]).toContain("chat.yml");
  });

  test("includes local-models.yml overlay when staged", () => {
    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);

    const artifactsDir = join(state.stateDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "local-models.yml"), "models: {}");

    const files = buildComposeFileList(state);
    expect(files).toContain(join(artifactsDir, "local-models.yml"));
  });

  test("omits local-models.yml overlay when not staged", () => {
    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);

    const files = buildComposeFileList(state);
    expect(files).toHaveLength(1); // just core compose
    expect(files.some((f) => f.includes("local-models.yml"))).toBe(false);
  });
});

// ── createState (exercises private loaders) ─────────────────────────────

describe("createState", () => {
  const origEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    origEnv.OPENPALM_CONFIG_HOME = process.env.OPENPALM_CONFIG_HOME;
    origEnv.OPENPALM_STATE_HOME = process.env.OPENPALM_STATE_HOME;
    origEnv.OPENPALM_DATA_HOME = process.env.OPENPALM_DATA_HOME;
    origEnv.ADMIN_TOKEN = process.env.ADMIN_TOKEN;
  });

  afterEach(() => {
    process.env.OPENPALM_CONFIG_HOME = origEnv.OPENPALM_CONFIG_HOME;
    process.env.OPENPALM_STATE_HOME = origEnv.OPENPALM_STATE_HOME;
    process.env.OPENPALM_DATA_HOME = origEnv.OPENPALM_DATA_HOME;
    process.env.ADMIN_TOKEN = origEnv.ADMIN_TOKEN;
  });

  test("loads persisted channel secrets from stack.env", () => {
    const base = trackDir(makeTempDir());
    process.env.OPENPALM_CONFIG_HOME = join(base, "config");
    process.env.OPENPALM_STATE_HOME = join(base, "state");
    process.env.OPENPALM_DATA_HOME = join(base, "data");
    delete process.env.ADMIN_TOKEN;

    const dataDir = join(base, "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, "stack.env"),
      "# Stack config\nCHANNEL_CHAT_SECRET=abc123\nCHANNEL_DISCORD_SECRET=def456\n"
    );

    const state = createState();
    expect(state.channelSecrets.chat).toBe("abc123");
    expect(state.channelSecrets.discord).toBe("def456");
  });

  test("reads ADMIN_TOKEN from secrets.env file", () => {
    const base = trackDir(makeTempDir());
    process.env.OPENPALM_CONFIG_HOME = join(base, "config");
    process.env.OPENPALM_STATE_HOME = join(base, "state");
    process.env.OPENPALM_DATA_HOME = join(base, "data");
    delete process.env.ADMIN_TOKEN;

    mkdirSync(join(base, "config"), { recursive: true });
    writeFileSync(
      join(base, "config", "secrets.env"),
      "ADMIN_TOKEN=file-token\nOPENAI_API_KEY=sk-test\n"
    );

    const state = createState();
    expect(state.adminToken).toBe("file-token");
  });

  test("uses explicit adminToken parameter over file/env", () => {
    const base = trackDir(makeTempDir());
    process.env.OPENPALM_CONFIG_HOME = join(base, "config");
    process.env.OPENPALM_STATE_HOME = join(base, "state");
    process.env.OPENPALM_DATA_HOME = join(base, "data");
    process.env.ADMIN_TOKEN = "env-token";

    mkdirSync(join(base, "config"), { recursive: true });
    writeFileSync(join(base, "config", "secrets.env"), "ADMIN_TOKEN=file-token\n");

    const state = createState("explicit-token");
    expect(state.adminToken).toBe("explicit-token");
  });

  test("initializes all core services as stopped", () => {
    const base = trackDir(makeTempDir());
    process.env.OPENPALM_CONFIG_HOME = join(base, "config");
    process.env.OPENPALM_STATE_HOME = join(base, "state");
    process.env.OPENPALM_DATA_HOME = join(base, "data");

    const state = createState();
    for (const service of CORE_SERVICES) {
      expect(state.services[service]).toBe("stopped");
    }
  });
});

// ── Core Service Constants ──────────────────────────────────────────────

describe("CORE_SERVICES", () => {
  test("includes all expected services", () => {
    expect(CORE_SERVICES).toContain("caddy");
    expect(CORE_SERVICES).toContain("openmemory");
    expect(CORE_SERVICES).toContain("openmemory-ui");
    expect(CORE_SERVICES).toContain("assistant");
    expect(CORE_SERVICES).toContain("guardian");
    expect(CORE_SERVICES).toContain("admin");
  });

  test("has exactly 6 core services", () => {
    expect(CORE_SERVICES).toHaveLength(6);
  });
});

// ── Lifecycle State Transitions ─────────────────────────────────────────

describe("applyInstall", () => {
  test("marks all core services as running", () => {
    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);

    // Initialize services as stopped
    for (const service of CORE_SERVICES) {
      state.services[service] = "stopped";
    }

    // Create required dirs for persistArtifacts
    mkdirSync(join(state.configDir, "channels"), { recursive: true });
    mkdirSync(join(state.stateDir, "artifacts"), { recursive: true });
    mkdirSync(join(state.stateDir, "channels"), { recursive: true });
    mkdirSync(join(state.stateDir, "secrets"), { recursive: true });
    mkdirSync(join(state.dataDir, "caddy"), { recursive: true });

    applyInstall(state);

    for (const service of CORE_SERVICES) {
      expect(state.services[service]).toBe("running");
    }
  });
});

describe("applyUpdate", () => {
  test("returns list of running services that were restarted", () => {
    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);
    state.services = { admin: "running", guardian: "running", openmemory: "stopped" };

    mkdirSync(join(state.configDir, "channels"), { recursive: true });
    mkdirSync(join(state.stateDir, "artifacts"), { recursive: true });
    mkdirSync(join(state.stateDir, "channels"), { recursive: true });
    mkdirSync(join(state.stateDir, "secrets"), { recursive: true });
    mkdirSync(join(state.dataDir, "caddy"), { recursive: true });

    const result = applyUpdate(state);
    expect(result.restarted).toContain("admin");
    expect(result.restarted).toContain("guardian");
    expect(result.restarted).not.toContain("openmemory");
  });
});

describe("applyUninstall", () => {
  test("stops all services", () => {
    const state = makeTestState();
    trackDir(state.stateDir);
    trackDir(state.configDir);
    trackDir(state.dataDir);
    state.services = { admin: "running", guardian: "running" };

    mkdirSync(join(state.configDir, "channels"), { recursive: true });
    mkdirSync(join(state.stateDir, "artifacts"), { recursive: true });
    mkdirSync(join(state.stateDir, "channels"), { recursive: true });
    mkdirSync(join(state.stateDir, "secrets"), { recursive: true });
    mkdirSync(join(state.dataDir, "caddy"), { recursive: true });

    const result = applyUninstall(state);
    expect(result.stopped).toContain("admin");
    expect(result.stopped).toContain("guardian");

    for (const status of Object.values(state.services)) {
      expect(status).toBe("stopped");
    }
  });
});
