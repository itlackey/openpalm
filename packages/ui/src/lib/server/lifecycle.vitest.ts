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
  CORE_SERVICES,
} from "@openpalm/lib";
import { makeTempDir, makeTestState, trackDir, registerCleanup , stackEnvFor} from "./test-helpers.js";

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
    writeFileSync(join(state.stackDir, "custom.compose.yml"), "services: {}");

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
  });

  afterEach(() => {
    delete process.env.OP_SKIP_COMPOSE_PREFLIGHT;
  });

  test("marks the assistant running on install (guardian gated to channels)", async () => {
    const state = makeTestState();
    trackDir(state.homeDir);
    process.env.OP_HOME = state.homeDir;

    state.services = { assistant: "stopped" };

    // Create required dirs and seed core compose for writeRuntimeFiles
    mkdirSync(state.stackDir, { recursive: true });
    writeFileSync(join(state.stackDir, "core.compose.yml"), "services: {}");

    await applyInstall(state);

    expect(state.services.assistant).toBe("running");
    // No channel addon → reconcileCore must NOT force-activate guardian.
    expect(state.services.guardian).toBeUndefined();
  });
});

describe("applyUpdate", () => {
  beforeEach(() => {
    process.env.OP_SKIP_COMPOSE_PREFLIGHT = '1';
  });

  afterEach(() => {
    delete process.env.OP_SKIP_COMPOSE_PREFLIGHT;
  });

  test("returns list of running services that were restarted", async () => {
    const state = makeTestState();
    trackDir(state.homeDir);
    process.env.OP_HOME = state.homeDir;
    state.services = { admin: "running", guardian: "running", assistant: "stopped" };

    mkdirSync(state.stackDir, { recursive: true });
    writeFileSync(join(state.stackDir, "core.compose.yml"), "services: {}");

    const result = await applyUpdate(state);
    expect(result.restarted).toContain("admin");
    expect(result.restarted).toContain("guardian");
    expect(result.restarted).not.toContain("assistant");
  });
});

describe("applyUninstall", () => {
  beforeEach(() => {
    process.env.OP_SKIP_COMPOSE_PREFLIGHT = '1';
  });

  afterEach(() => {
    delete process.env.OP_SKIP_COMPOSE_PREFLIGHT;
  });

  test("stops all services", async () => {
    const state = makeTestState();
    trackDir(state.homeDir);
    process.env.OP_HOME = state.homeDir;
    state.services = { admin: "running", guardian: "running" };

    mkdirSync(state.stackDir, { recursive: true });
    writeFileSync(join(state.stackDir, "core.compose.yml"), "services: {}");

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

  test("updates OP_IMAGE_TAG in knowledge/env/stack.env", async () => {
    const state = makeTestState();
    trackDir(state.homeDir);
    mkdirSync(join(state.stashDir, "env"), { recursive: true });
    writeFileSync(
      stackEnvFor(state.stackDir),
      "OP_IMAGE_NAMESPACE=openpalm\nOP_IMAGE_TAG=v0.1.0\n"
    );

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [{ name: "latest" }, { name: "v1.0.0" }, { name: "v0.7.7" }, { name: "v0.7.6" }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const result = await updateStackEnvToLatestImageTag(state);
    const updated = readFileSync(stackEnvFor(state.stackDir), "utf-8");

    expect(result.namespace).toBe("openpalm");
    expect(result.tag).toBe("v0.7.7");
    expect(updated).toContain("OP_IMAGE_TAG=v0.7.7");
    expect(updated).toContain('OP_ASSISTANT_IMAGE_TAG=v0.7.7');
    expect(updated).toContain('OP_GUARDIAN_IMAGE_TAG=v0.7.7');
    expect(updated).toContain('OP_CHANNEL_IMAGE_TAG=v0.7.7');
  });

  test('uses the running OpenPalm major when OP_IMAGE_TAG is non-semver', async () => {
    const state = makeTestState();
    trackDir(state.homeDir);
    mkdirSync(join(state.stashDir, 'env'), { recursive: true });
    writeFileSync(
      stackEnvFor(state.stackDir),
      'OP_IMAGE_NAMESPACE=openpalm\nOP_IMAGE_TAG=latest\n'
    );

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [{ name: 'v1.0.0' }, { name: 'v0.12.0' }, { name: 'v0.11.9' }]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );

    const result = await updateStackEnvToLatestImageTag(state);
    const updated = readFileSync(stackEnvFor(state.stackDir), 'utf-8');

    expect(result.tag).toBe('v0.12.0');
    expect(updated).toContain('OP_IMAGE_TAG=v0.12.0');
    expect(updated).toContain('OP_ASSISTANT_IMAGE_TAG=v0.12.0');
  });

  test('falls back lagging guardian/channel images to their newest published tag (#477)', async () => {
    const state = makeTestState();
    trackDir(state.homeDir);
    mkdirSync(join(state.stashDir, 'env'), { recursive: true });
    mkdirSync(join(state.stackDir), { recursive: true });
    writeFileSync(
      stackEnvFor(state.stackDir),
      'OP_IMAGE_NAMESPACE=openpalm\nOP_IMAGE_TAG=v0.11.0\nOP_ENABLED_ADDONS=discord\n',
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/assistant/tags?page_size=')) {
        return new Response(
          JSON.stringify({ results: [{ name: 'v0.11.3' }, { name: 'v0.11.0' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/assistant/tags/v0.11.3')) {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/guardian/tags/v0.11.3') || url.includes('/channel/tags/v0.11.3')) {
        return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/guardian/tags?page_size=') || url.includes('/channel/tags?page_size=')) {
        return new Response(
          JSON.stringify({ results: [{ name: 'v0.11.0' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const result = await updateStackEnvToLatestImageTag(state);
    expect(result.tag).toBe('v0.11.3');
    const updated = readFileSync(stackEnvFor(state.stackDir), 'utf-8');
    expect(updated).toContain('OP_IMAGE_TAG=v0.11.3');
    expect(updated).toContain('OP_ASSISTANT_IMAGE_TAG=v0.11.3');
    expect(updated).toContain('OP_GUARDIAN_IMAGE_TAG=v0.11.0');
    expect(updated).toContain('OP_CHANNEL_IMAGE_TAG=v0.11.0');
  });

  test('refuses to advance when a required image has no usable published tag', async () => {
    const state = makeTestState();
    trackDir(state.homeDir);
    mkdirSync(join(state.stashDir, 'env'), { recursive: true });
    mkdirSync(join(state.stackDir), { recursive: true });
    writeFileSync(
      stackEnvFor(state.stackDir),
      'OP_IMAGE_NAMESPACE=openpalm\nOP_IMAGE_TAG=v0.11.0\nOP_ENABLED_ADDONS=discord\n',
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/assistant/tags?page_size=')) {
        return new Response(
          JSON.stringify({ results: [{ name: 'v0.11.3' }, { name: 'v0.11.0' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/assistant/tags/v0.11.3')) {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('/guardian/tags/v0.11.3') || url.includes('/channel/tags/v0.11.3')) {
        return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      }
      // No published tags at all for guardian/channel
      return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await expect(updateStackEnvToLatestImageTag(state)).rejects.toThrow(/no published tag found for guardian/);
    expect(readFileSync(stackEnvFor(state.stackDir), 'utf-8')).toContain('OP_IMAGE_TAG=v0.11.0');
  });

  test("throws when docker tag lookup fails", async () => {
    const state = makeTestState();
    trackDir(state.homeDir);
    mkdirSync(join(state.stashDir, "env"), { recursive: true });
    writeFileSync(stackEnvFor(state.stackDir), "OP_IMAGE_NAMESPACE=openpalm\n");

    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("bad gateway", { status: 502 }));

    await expect(updateStackEnvToLatestImageTag(state)).rejects.toThrow("Docker tag lookup failed");
  });
});
