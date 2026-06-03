/**
 * Regression test for the host-akm.compose.yml overlay gating.
 *
 * The overlay is part of the bundled asset skeleton and may be materialized into
 * config/stack/ even when host AKM sharing is OFF. It references
 * `${OP_HOST_AKM_STASH}`, so including it in the compose file list without that
 * var set makes `docker compose` fail ("invalid spec: :/host-stash"), which
 * surfaced as "all containers offline" in the UI. discoverStackOverlays must
 * therefore gate the overlay on OP_HOST_AKM_STASH being set in stack.env — NOT
 * merely on the file existing.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverStackOverlays } from "./config-persistence.js";

let home = "";
let stackDir = "";
const savedEnv = process.env.OP_HOST_AKM_STASH;

function seedFixedOverlays(): void {
  for (const f of ["core.compose.yml", "services.compose.yml", "channels.compose.yml", "custom.compose.yml"]) {
    writeFileSync(join(stackDir, f), "services: {}\n");
  }
}
function writeStackEnv(content: string): void {
  mkdirSync(join(home, "knowledge", "env"), { recursive: true });
  writeFileSync(join(home, "knowledge", "env", "stack.env"), content);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "host-akm-gate-"));
  stackDir = join(home, "config", "stack");
  mkdirSync(stackDir, { recursive: true });
  delete process.env.OP_HOST_AKM_STASH;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.OP_HOST_AKM_STASH;
  else process.env.OP_HOST_AKM_STASH = savedEnv;
});

describe("discoverStackOverlays — host-akm gating", () => {
  test("EXCLUDES host-akm.compose.yml when the file exists but OP_HOST_AKM_STASH is unset", () => {
    seedFixedOverlays();
    writeFileSync(join(stackDir, "host-akm.compose.yml"), "services: {}\n");
    writeStackEnv("OP_IMAGE_TAG=x\n"); // no OP_HOST_AKM_STASH
    const files = discoverStackOverlays(stackDir, home);
    expect(files.some((f) => f.endsWith("host-akm.compose.yml"))).toBe(false);
    expect(files).toHaveLength(4);
  });

  test("INCLUDES host-akm.compose.yml when OP_HOST_AKM_STASH is set in stack.env", () => {
    seedFixedOverlays();
    writeFileSync(join(stackDir, "host-akm.compose.yml"), "services: {}\n");
    writeStackEnv("OP_HOST_AKM_STASH=/home/u/akm\n");
    const files = discoverStackOverlays(stackDir, home);
    expect(files.some((f) => f.endsWith("host-akm.compose.yml"))).toBe(true);
    expect(files[files.length - 1]).toContain("host-akm.compose.yml"); // appended after core
  });

  test("INCLUDES it when OP_HOST_AKM_STASH is set via process.env (no stack.env)", () => {
    seedFixedOverlays();
    writeFileSync(join(stackDir, "host-akm.compose.yml"), "services: {}\n");
    process.env.OP_HOST_AKM_STASH = "/home/u/akm";
    const files = discoverStackOverlays(stackDir, home);
    expect(files.some((f) => f.endsWith("host-akm.compose.yml"))).toBe(true);
  });

  test("derives OP_HOME from stackDir when homeDir arg is omitted", () => {
    seedFixedOverlays();
    writeFileSync(join(stackDir, "host-akm.compose.yml"), "services: {}\n");
    writeStackEnv("OP_HOST_AKM_STASH=/home/u/akm\n");
    const files = discoverStackOverlays(stackDir); // no homeDir
    expect(files.some((f) => f.endsWith("host-akm.compose.yml"))).toBe(true);
  });
});
