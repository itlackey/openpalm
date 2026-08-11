/**
 * guardian.compose.api.yml — the opt-in overlay that carries the OpenAI-
 * compatible edge's ONE host publish, so the guardianOpenaiApi toggle's OFF
 * position means "no host listener" instead of "loopback with a fully
 * working edge behind it".
 *
 * Covers the overlay-inclusion gate (discoverStackOverlays,
 * config-persistence.ts). Content assertions for the overlay file itself
 * live in network-partitioning.test.ts / skeleton-guardrail.test.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverStackOverlays } from "./config-persistence.js";

let homeDir = "";

afterEach(() => {
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  homeDir = "";
});

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "openpalm-api-overlay-"));
  mkdirSync(join(dir, "system", "stack"), { recursive: true });
  mkdirSync(join(dir, "state"), { recursive: true });
  writeFileSync(join(dir, "system", "stack", "core.compose.yml"), "services: {}\n");
  return dir;
}

function writeStackEnv(dir: string, content: string): void {
  writeFileSync(join(dir, "state", "stack.env"), content);
}

function writeApiOverlay(dir: string): void {
  writeFileSync(join(dir, "system", "stack", "guardian.compose.api.yml"), "services: {}\n");
}

function includesOverlay(dir: string): boolean {
  return discoverStackOverlays(dir).some((f) => f.endsWith("guardian.compose.api.yml"));
}

describe("discoverStackOverlays — guardian.compose.api.yml inclusion", () => {
  test("excluded by default: toggle off, no api addon", () => {
    homeDir = makeHome();
    writeApiOverlay(homeDir);
    writeStackEnv(homeDir, "OP_ACCESS_OPENAI_API=false\n");
    expect(includesOverlay(homeDir)).toBe(false);
  });

  test("excluded with no stack.env at all — a fresh home publishes nothing", () => {
    homeDir = makeHome();
    writeApiOverlay(homeDir);
    expect(includesOverlay(homeDir)).toBe(false);
  });

  test("included when the guardianOpenaiApi toggle is on", () => {
    homeDir = makeHome();
    writeApiOverlay(homeDir);
    writeStackEnv(homeDir, "OP_ACCESS_OPENAI_API=true\n");
    expect(includesOverlay(homeDir)).toBe(true);
  });

  test("included when the api addon is enabled — the pre-toggle exposure alias keeps its loopback edge", () => {
    homeDir = makeHome();
    writeApiOverlay(homeDir);
    writeStackEnv(homeDir, "OP_ENABLED_ADDONS=api\nOP_ACCESS_OPENAI_API=false\n");
    expect(includesOverlay(homeDir)).toBe(true);
  });

  test("included via bind inference on a pre-intent row — a restored backup keeps its publish", () => {
    homeDir = makeHome();
    writeApiOverlay(homeDir);
    writeStackEnv(homeDir, "OP_API_BIND_ADDRESS=0.0.0.0\n");
    expect(includesOverlay(homeDir)).toBe(true);
  });

  test("double-gate: toggle on but overlay not seeded — no file, no entry", () => {
    homeDir = makeHome();
    writeStackEnv(homeDir, "OP_ACCESS_OPENAI_API=true\n");
    expect(includesOverlay(homeDir)).toBe(false);
  });

  test("a non-api addon does not include it", () => {
    homeDir = makeHome();
    writeApiOverlay(homeDir);
    writeStackEnv(homeDir, "OP_ENABLED_ADDONS=discord,gateway\n");
    expect(includesOverlay(homeDir)).toBe(false);
  });

  test("ordering: the overlay joins between the managed set and the user custom overlay", () => {
    homeDir = makeHome();
    writeApiOverlay(homeDir);
    writeStackEnv(homeDir, "OP_ACCESS_OPENAI_API=true\n");
    mkdirSync(join(homeDir, "config", "stack"), { recursive: true });
    writeFileSync(join(homeDir, "config", "stack", "custom.compose.yml"), "services: {}\n");

    const files = discoverStackOverlays(homeDir).map((f) => f.split("/").pop());
    expect(files.indexOf("guardian.compose.api.yml")).toBeGreaterThan(files.indexOf("core.compose.yml"));
    expect(files.indexOf("custom.compose.yml")).toBeGreaterThan(files.indexOf("guardian.compose.api.yml"));
  });
});
