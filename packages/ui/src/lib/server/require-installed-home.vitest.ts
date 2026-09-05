/**
 * (#684) The host-admin existing-install gate.
 *
 * Same shared lib guard the CLI's `ensureValidState` uses, so a wrong OP_HOME
 * fails identically on both surfaces — before any Docker call or managed-home
 * write. Applied to every host-admin route whose prerequisite is an existing
 * installation; `install` deliberately does not use it.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requireInstalledHome } from "./helpers.js";

describe("requireInstalledHome", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "require-installed-home-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function markInstalled(): void {
    mkdirSync(join(dir, "system", "stack"), { recursive: true });
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state", "stack.env"), "OP_SETUP_COMPLETE=true\n");
  }

  test("refuses a home nothing was installed to, naming the path in the envelope", async () => {
    const response = requireInstalledHome(dir, "req-1");
    expect(response).not.toBeNull();
    expect(response?.status).toBe(409);
    const body = await response!.json();
    expect(body.error).toBe("not_an_openpalm_home");
    expect(body.message).toBe(`Not an OpenPalm home: ${dir}`);
    expect(body.details.home).toBe(dir);
  });

  test("returns null for a completed install, so the route proceeds", () => {
    markInstalled();
    expect(requireInstalledHome(dir, "req-2")).toBeNull();
  });

  test("lets an interrupted install through — setup_incomplete is still a home", () => {
    mkdirSync(join(dir, "system", "stack"), { recursive: true });
    writeFileSync(join(dir, "system", "stack", "core.compose.yml"), "services: {}");
    mkdirSync(join(dir, "state"), { recursive: true });
    writeFileSync(join(dir, "state", "stack.env"), "OP_SETUP_COMPLETE=false\n");
    expect(requireInstalledHome(dir, "req-3")).toBeNull();
  });
});
