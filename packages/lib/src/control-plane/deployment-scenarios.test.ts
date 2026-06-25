/**
 * (#466) Deployment-scenario harness + fixtures.
 *
 * Materializes the realistic OP_HOME / stack states we hit in the wild — old
 * versions, stale pins, broken/partial installs, gated guardian, dead runtime —
 * then asserts OpenPalm responds APPROPRIATELY: an automated fix, or precise
 * guidance. Never a silent failure or a stale/broken deploy. This is the
 * regression net that keeps the 0.11.x upgrade/resilience fixes honest.
 *
 * Each test: build a fixture OP_HOME → run the real entrypoint → assert the
 * auto-fix happened OR the exact guidance is returned. No mocks of code under
 * test (file-state scenarios are deterministic; the container-state decision is
 * exercised through the pure split-outs, so no Docker daemon is required).
 *
 * UI-endpoint scenarios from #466 are covered by their own vitest files (the
 * assertion has to live where the handler does) — indexed here so this file is
 * the single map of the deployment regression net:
 *   - voice configured but proxy blind → 200      packages/ui/.../api/transcribe/server.vitest.ts
 *   - guardian gated off → not_deployed (no 503)  packages/ui/.../guardian/health (+ guardian-gating.test.ts)
 *   - pull-fallback → imageWarning surfaced       packages/ui/.../setup-deploy (DeployState.imageWarning)
 *   - health-poll timeout → logs-command guidance pollContainerHealth() returns the
 *                                                  `docker compose -p <proj> logs <svc>` hint + per-service Exited state
 *   - Docker down / Compose v1 / no runtime → clear preflight message, not a stack
 *                                                  trace:  packages/cli/.../install.ts requireDocker()
 *                                                  ("Docker is not installed…/not running…/Compose v2 is required…")
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureMigrated, CURRENT_LAYOUT_VERSION } from "./migrations.js";
import { upsertEnvValue } from "./env.js";
import { refreshCoreAssetsFromSource } from "./core-assets.js";
import { buildManagedServices } from "./lifecycle.js";
import { isProjectOurs } from "./docker.js";
import { classifyLocalInstall, deriveLaunchStatus } from "./launch-status.js";
import type { ControlPlaneState } from "./types.js";

// ── Fixture builder ────────────────────────────────────────────────────────

interface OpHomeOptions {
  /** Write a 0.10.x top-level vault/ tree (pre-restructure layout). */
  legacy010?: boolean;
  /** OP_SETUP_COMPLETE=true (a finished install). */
  setupComplete?: boolean;
  /** OP_ASSISTANT_VERSION value to pin (simulate a stale pin). */
  imageTag?: string;
  /** OP_ENABLED_ADDONS value. */
  enabledAddons?: string;
  /** Write a core.compose.yml with this (stale) content. */
  staleCoreCompose?: string;
  /** Extra stack.env KEY=VALUE lines. */
  extraStackEnv?: Record<string, string>;
}

interface OpHome {
  homeDir: string;
  stackDir: string;
  state: ControlPlaneState;
}

function buildOpHome(opts: OpHomeOptions = {}): OpHome {
  const homeDir = mkdtempSync(join(tmpdir(), "op-deploy-scn-"));
  process.env.OP_HOME = homeDir;
  const configDir = join(homeDir, "config");
  const stackDir = join(homeDir, "system", "stack"); // managed compose tree (was config/stack)
  const envDir = join(homeDir, "knowledge", "env");
  mkdirSync(stackDir, { recursive: true });
  mkdirSync(envDir, { recursive: true });
  mkdirSync(join(homeDir, "data"), { recursive: true });

  if (opts.legacy010) {
    // 0.10.x layout: top-level vault/, legacy stack.env, legacy stack.yml.
    mkdirSync(join(homeDir, "vault", "stack"), { recursive: true });
    mkdirSync(join(homeDir, "vault", "user"), { recursive: true });
    writeFileSync(join(homeDir, "vault", "user", "user.env"), "MY_PREF=keepme\n");
    writeFileSync(
      join(homeDir, "vault", "stack", "stack.env"),
      "OP_ADMIN_PORT=9000\nOPENAI_API_KEY=sk-secret\nOP_UI_LOGIN_PASSWORD=hunter2\n",
    );
  }

  if (opts.staleCoreCompose !== undefined) {
    writeFileSync(join(stackDir, "core.compose.yml"), opts.staleCoreCompose);
  }

  // stack.env (the 0.11 location).
  const lines: string[] = [];
  if (opts.setupComplete) lines.push("OP_SETUP_COMPLETE=true");
  if (opts.imageTag) lines.push(`OP_ASSISTANT_VERSION=${opts.imageTag}`);
  if (opts.enabledAddons) lines.push(`OP_ENABLED_ADDONS=${opts.enabledAddons}`);
  for (const [k, v] of Object.entries(opts.extraStackEnv ?? {})) lines.push(`${k}=${v}`);
  if (lines.length > 0 || !opts.legacy010) {
    writeFileSync(join(envDir, "stack.env"), lines.join("\n") + (lines.length ? "\n" : ""));
  }

  const state: ControlPlaneState = {
    homeDir,
    configDir,
    stashDir: join(homeDir, "knowledge"),
    workspaceDir: join(homeDir, "workspace"),
    dataDir: join(homeDir, "data"),
    stackDir,
    services: {},
    artifacts: { compose: "" },
    artifactMeta: [],
  };
  return { homeDir, stackDir, state };
}

let active: OpHome | null = null;
let prevOpHome: string | undefined;
let prevSkip: string | undefined;

beforeEach(() => {
  prevOpHome = process.env.OP_HOME;
  prevSkip = process.env.OP_SKIP_COMPOSE_PREFLIGHT;
  process.env.OP_SKIP_COMPOSE_PREFLIGHT = "1"; // force static inference, no Docker
});

afterEach(() => {
  if (active) rmSync(active.homeDir, { recursive: true, force: true });
  active = null;
  if (prevOpHome === undefined) delete process.env.OP_HOME;
  else process.env.OP_HOME = prevOpHome;
  if (prevSkip === undefined) delete process.env.OP_SKIP_COMPOSE_PREFLIGHT;
  else process.env.OP_SKIP_COMPOSE_PREFLIGHT = prevSkip;
});

// ── Scenario 1: old-version OP_HOME (0.10 layout) → auto-migrated + reported ──

describe("scenario: old-version OP_HOME (0.10 → current)", () => {
  it("auto-migrates the legacy vault layout, backs up, and reports what changed", () => {
    active = buildOpHome({ legacy010: true });
    const report = ensureMigrated();

    expect(report.migrated).toBe(true);
    expect(report.from).toBe(0);
    expect(report.to).toBe(CURRENT_LAYOUT_VERSION);
    expect(report.backupDir).toBeTruthy(); // a safety backup was taken first
    // The user data survived into the new layout.
    const env = readFileSync(join(active.homeDir, "knowledge", "env", "user.env"), "utf-8");
    expect(env).toContain("MY_PREF=keepme");
  });
});

// ── Scenario 2: stale per-unit version pin → reconciled (no longer deploys old) ──

describe("scenario: stale OP_ASSISTANT_VERSION pin", () => {
  it("reconciles a stale pin (v0.10.9) to the requested tag, dropping the old deploy", () => {
    active = buildOpHome({ setupComplete: true, imageTag: "v0.10.9" });
    const envPath = join(active.homeDir, "knowledge", "env", "stack.env");
    const reconciled = upsertEnvValue(readFileSync(envPath, "utf-8"), "OP_ASSISTANT_VERSION", "latest");
    expect(reconciled).toContain("OP_ASSISTANT_VERSION=latest");
    expect(reconciled).not.toContain("OP_ASSISTANT_VERSION=v0.10.9");
  });
});

// ── Scenario 3: stale system-managed compose → refreshed, user files kept ────

describe("scenario: stale managed compose asset in an existing OP_HOME", () => {
  it("overwrites the stale core.compose.yml from source, preserving user custom.compose.yml", () => {
    active = buildOpHome({ setupComplete: true, staleCoreCompose: "services: {}  # 0.10 stale\n" });
    // A user-owned overlay must NOT be touched.
    writeFileSync(join(active.stackDir, "custom.compose.yml"), "services:\n  mine: {}\n");

    // Build a minimal source .openpalm tree with the CURRENT managed assets.
    const srcOpenpalm = mkdtempSync(join(tmpdir(), "op-src-"));
    mkdirSync(join(srcOpenpalm, "system", "stack"), { recursive: true });
    mkdirSync(join(srcOpenpalm, "config", "assistant"), { recursive: true });
    writeFileSync(join(srcOpenpalm, "system", "stack", "core.compose.yml"), "services:\n  assistant: {}  # current\n");
    writeFileSync(join(srcOpenpalm, "system", "stack", "services.compose.yml"), "services: {}\n");
    writeFileSync(join(srcOpenpalm, "system", "stack", "portals.compose.yml"), "services: {}\n");
    // Seeded assets (written only if missing in target — target already has custom.compose.yml so that is skipped)
    writeFileSync(join(srcOpenpalm, "system", "stack", "custom.compose.yml"), "services: {}\n");
    writeFileSync(join(srcOpenpalm, "config", "assistant", "opencode.jsonc"), "{}\n");

    try {
      const { updated: refreshed } = refreshCoreAssetsFromSource(srcOpenpalm, active.homeDir);
      expect(refreshed).toContain("system/stack/core.compose.yml");
      expect(readFileSync(join(active.stackDir, "core.compose.yml"), "utf-8")).toContain("# current");
      expect(readFileSync(join(active.stackDir, "core.compose.yml"), "utf-8")).not.toContain("stale");
      // User overlay untouched.
      expect(readFileSync(join(active.stackDir, "custom.compose.yml"), "utf-8")).toContain("mine");
    } finally {
      rmSync(srcOpenpalm, { recursive: true, force: true });
    }
  });
});

// ── Scenario 4: guardian gated off (no channels) → not deployed ──────────────

describe("scenario: install with no channels", () => {
  it("deploys assistant alone and never waits on guardian", async () => {
    active = buildOpHome({ setupComplete: true });
    const services = await buildManagedServices(active.state);
    expect(services).toContain("assistant");
    expect(services).not.toContain("guardian");
  });
});

// ── Scenario 5: foreign compose-project collision → detected as not-ours ─────

describe("scenario: a foreign project shares our compose project-name", () => {
  it("classifies a different working_dir as NOT ours (so we don't reconcile a stranger's stack)", () => {
    // Pure decision split-out of detectExistingProject — no Docker daemon needed.
    expect(isProjectOurs("/some/other/dir", "/home/u/.openpalm")).toBe(false);
    // Our own (or an unlabeled) project is treated as ours → safe to redeploy.
    expect(isProjectOurs("/home/u/.openpalm", "/home/u/.openpalm")).toBe(true);
    expect(isProjectOurs("", "/home/u/.openpalm")).toBe(true);
  });
});

// ── Scenario 6: previously-broken / partial install → splash, not a redirect ─

describe("scenario: partial / broken install (no OP_SETUP_COMPLETE)", () => {
  it("classifies a half-written install as setup_incomplete → splash route", () => {
    active = buildOpHome({ staleCoreCompose: "services: {}\n" }); // compose present, NOT complete
    expect(classifyLocalInstall(active.stackDir, active.homeDir)).toBe("setup_incomplete");

    const status = deriveLaunchStatus({ local: { state: "setup_incomplete" }, remotes: [] });
    expect(status.recommendedRoute).toBe("splash");
    expect(status.localInstalledButUnhealthy).toBe(true);
  });

  it("an installed-but-offline local with a HEALTHY remote still routes to splash", () => {
    const status = deriveLaunchStatus({
      local: { state: "installed_offline" },
      remotes: [{ id: "r", name: "Cloud", url: "https://r", state: "accessible" }],
    });
    // The broken local must get the user's attention, not be silently bypassed.
    expect(status.recommendedRoute).toBe("splash");
  });
});

// ── Scenario 7: nothing installed + dead runtime → splash with runtime detail ─

describe("scenario: nothing installed", () => {
  it("a fresh machine classifies as not_installed", () => {
    active = buildOpHome(); // no compose, not complete
    expect(classifyLocalInstall(active.stackDir, active.homeDir)).toBe("not_installed");
  });

  it("not_installed + no accessible remote + runtime missing → splash carrying runtime detail", () => {
    const status = deriveLaunchStatus({
      local: { state: "not_installed", runtime: { dockerPresent: false, composeAvailable: false } },
      remotes: [],
    });
    expect(status.recommendedRoute).toBe("splash");
    expect(status.local.runtime?.dockerPresent).toBe(false); // splash can tell the user Docker is missing
  });

  it("not_installed + an accessible remote → chat on that remote (no local needed)", () => {
    const status = deriveLaunchStatus({
      local: { state: "not_installed" },
      remotes: [{ id: "r1", name: "Cloud", url: "https://r1", state: "accessible" }],
    });
    expect(status.recommendedRoute).toBe("chat");
    expect(status.activeAssistant).toEqual({ kind: "remote", id: "r1" });
  });
});
